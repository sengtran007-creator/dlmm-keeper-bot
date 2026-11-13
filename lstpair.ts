/**
 * LST-pair mode (BOT_MODE=lst_pair): unhedged Meteora DLMM LP in JupSOL-JitoSOL (pool 5cvcHrD2…), SOL-denominated.
 *
 *  - Entry (flat, no LST, not paused): swap at most LST_MAX_USDC_IN of the wallet's USDC into ~50/50 JupSOL/JitoSOL
 *    via Jupiter (slippage-capped), buy any SOL shortfall for the position rent, open ONE tight Spot position at
 *    active ± LST_BIN_HALF_WIDTH bins. Rebalances only ever swap JupSOL↔JitoSOL — USDC is never touched again.
 *  - Rebalance: active bin outside the range for LST_OOR_TICKS consecutive ticks and LST_REBALANCE_COOLDOWN_SEC
 *    since the last one → withdraw+claim+close, swap the excess side to ~50/50, reopen around the live bin.
 *  - Depeg guard: pool price vs the stake-pool fair ratio (JupSOL rate / JitoSOL rate) off by > LST_DEPEG_MAX_PCT
 *    for 2 consecutive ticks → close and exit to LST_DEPEG_EXIT_TO (SOL default | USDC | HOLD), then pause.
 *  - Never opens a second position; adopts an existing one at boot. Gas reserve (GAS_RESERVE_LAMPORTS, 0.12 SOL) is
 *    never spent on liquidity. Telegram: /status /pause /resume /emergency_exit (close + all LST → USDC, pause).
 *  - Ledger: LST_* rows + hourly SNAPSHOT to GOOGLE_SHEET_WEBHOOK_URL with equity/P&L in USD and SOL vs this test's
 *    own baseline (gas excluded). Pin the baseline with LST_BASELINE_USD / LST_BASELINE_SOL / LST_GAS_BASELINE_SOL.
 */
import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import bs58 from "bs58";
import axios from "axios";
import dotenv from "dotenv";
import { MoneyLock } from "./moneylock";
import { positionHasLiquidity } from "./multipool";
import { resolveLanded, LandedStatus } from "./feesweep";
import { classifySwapFailure, nextSlippageBps, normalizeJupiterBase, swapRetryDelayMs } from "./jupretry";
import { TxSendError, shortTxError } from "./txretry";
import {
  checkDepeg, decideRebalance, fairPriceYPerX, parseDepegExit, parsePausedEnv, pickPosition, pnl,
  rebalanceSwap, stakePoolRate, testEquity, tightRange, usdcToDeploy, Equity,
} from "./lstlogic";

dotenv.config();

// ---------------------------------------------------------------- config
const env = (k: string) => process.env[k]?.trim() || "";
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k]?.trim() ? v : d;
};
const BOT_PRIVATE_KEY = env("BOT_PRIVATE_KEY");
if (!BOT_PRIVATE_KEY) throw new Error("BOT_PRIVATE_KEY missing");
const RPC_URL = env("RPC_URL") || env("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com";
const TELEGRAM_BOT_TOKEN = env("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = env("TELEGRAM_CHAT_ID");
const TELEGRAM_API_BASE = (env("TELEGRAM_API_BASE") || "https://api.telegram.org").replace(/\/$/, "");
const SHEET_URL = env("GOOGLE_SHEET_WEBHOOK_URL");
const JUP_BASE = normalizeJupiterBase(process.env.JUPITER_API_BASE);
const JUP_KEY = env("JUPITER_API_KEY");
const POOL = new PublicKey(env("LST_POOL_ADDRESS") || "5cvcHrD2uh2CXhmZnMHsTVWJW1qtyikVaN3MCJNaCKMh");
const SOL_USD_POOL = new PublicKey(env("SOL_USD_POOL") || "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y");
const INSTANCE = env("INSTANCE_LABEL") || "JupSOL-JitoSOL";
const DRY_RUN = parsePausedEnv(process.env.LST_DRY_RUN); // read-only: logs decisions, sends nothing
const HALF_WIDTH = Math.max(0, Math.min(10, Math.floor(num("LST_BIN_HALF_WIDTH", 1))));
const TICK_SEC = Math.max(15, num("LST_TICK_SEC", 60));
const OOR_TICKS = Math.max(1, num("LST_OOR_TICKS", 3));
const REBALANCE_COOLDOWN_SEC = Math.max(0, num("LST_REBALANCE_COOLDOWN_SEC", 1800));
const DEPEG_MAX_PCT = Math.max(0.05, num("LST_DEPEG_MAX_PCT", 0.5));
const DEPEG_CONFIRM_TICKS = Math.max(1, num("LST_DEPEG_CONFIRM_TICKS", 2));
const DEPEG_EXIT_TO = parseDepegExit(process.env.LST_DEPEG_EXIT_TO);
const SLIPPAGE_BPS = Math.max(1, num("LST_SWAP_SLIPPAGE_BPS", 30));
const SLIPPAGE_MAX_BPS = Math.max(SLIPPAGE_BPS, num("LST_SWAP_SLIPPAGE_MAX_BPS", 100));
const MIN_SWAP_SOL = Math.max(0.001, num("LST_MIN_SWAP_SOL", 0.02));
const DEPLOY_SLIPPAGE_PCT = Math.max(0.01, num("LST_DEPLOY_SLIPPAGE_PCT", 0.05)); // 5 bins at 1 bp/bin
const GAS_RESERVE_LAMPORTS = num("GAS_RESERVE_LAMPORTS", 120_000_000);
const OPEN_COST_LAMPORTS = num("LST_OPEN_COST_LAMPORTS", 50_000_000); // position rent ~0.0419 + fees headroom
const FEE_FLOOR_LAMPORTS = num("TX_FEE_FLOOR_LAMPORTS", 10_000_000);
const MAX_USDC_IN_RAW = Math.floor(Math.max(0, num("LST_MAX_USDC_IN", 0)) * 1e6);
const SNAPSHOT_SEC = Math.max(300, num("SNAPSHOT_INTERVAL_SEC", 3600));
const PIN_POSITION = env("LST_POSITION_PUBKEY");
const BASELINE_USD_PIN = num("LST_BASELINE_USD", 0);
const BASELINE_SOL_PIN = num("LST_BASELINE_SOL", 0);
const GAS_BASELINE_SOL_PIN = num("LST_GAS_BASELINE_SOL", -1);
const BOOT_PAUSED = parsePausedEnv(process.env.BOT_PAUSED);

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
/** mint → SPL stake pool account (rate = total_lamports / pool_token_supply). */
const STAKE_POOLS: Record<string, PublicKey> = {
  jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: new PublicKey("8VpRhuxa7sUUepdY3kQiTmX9rS5vx4WgaXiAnXq4KCtr"),
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: new PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb"),
};

const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(BOT_PRIVATE_KEY));
/** Read-side owner. Only a DRY_RUN may read another wallet (LST_DRY_RUN_OWNER) to simulate against real balances; it never signs. */
const owner: PublicKey = DRY_RUN && env("LST_DRY_RUN_OWNER") ? new PublicKey(env("LST_DRY_RUN_OWNER")) : wallet.publicKey;
const lock = new MoneyLock();

// ---------------------------------------------------------------- state
let pool: DLMM;
let solUsdPool: DLMM;
let X: PublicKey, Y: PublicKey;
let decimals = 9;
let paused = BOOT_PAUSED;
let positionKey: PublicKey | null = null;
let rangeMin = 0, rangeMax = 0;
let oorTicks = 0;
let depegTicks = 0;
let lastRebalanceSec = 0;
let lastSnapshotSec = 0;
let baseline: Equity | null = BASELINE_USD_PIN > 0 && BASELINE_SOL_PIN > 0 ? { usd: BASELINE_USD_PIN, sol: BASELINE_SOL_PIN } : null;
let gasBaselineSol = GAS_BASELINE_SOL_PIN >= 0 ? GAS_BASELINE_SOL_PIN : -1;
let usdcExcludedUi = num("LST_USDC_EXCLUDED", 0); // USDC left in the wallet outside the test
let cumFeesSol = 0;
let rebalances = 0;
let busy = false;

// ---------------------------------------------------------------- utils
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const ptNow = () => new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour12: false });
function redact(s: string): string {
  let out = String(s);
  for (const secret of [BOT_PRIVATE_KEY, TELEGRAM_BOT_TOKEN, JUP_KEY]) if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "bot[redacted]");
}
async function notify(msg: string) {
  const text = `[${INSTANCE}] ${redact(msg)}`;
  console.log(text.replace(/<[^>]*>/g, ""));
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }, { timeout: 10000 });
  } catch {
    try {
      await axios.post(`${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text: text.replace(/<[^>]*>/g, "") }, { timeout: 10000 });
    } catch (e: any) {
      console.error("[TELEGRAM] send failed:", redact(e?.message || String(e)));
    }
  }
}
async function ledger(event: string, fields: Record<string, any> = {}) {
  if (!SHEET_URL) return;
  const now = new Date();
  const payload: Record<string, any> = {
    schema_version: 2, timestamp_iso: now.toISOString(), timestamp_pt: ptNow(),
    timestamp: now.toISOString().replace("T", " ").substring(0, 19),
    pool_name: "JupSOL-JitoSOL", instance: INSTANCE, pool_address: POOL.toBase58(), bin_step: pool?.lbPair?.binStep,
    event, event_type: event, test_id: "lst-jupsol-jitosol-2026-11", dry_run: DRY_RUN || undefined,
    position_pubkey: positionKey?.toBase58() || "", range_low: rangeMin || undefined, range_high: rangeMax || undefined,
    baseline_usd: baseline?.usd, baseline_sol: baseline?.sol, cumulative_fees_sol: cumFeesSol, rebalances,
    ...fields,
  };
  if (typeof payload.notes === "string") payload.notes = redact(payload.notes);
  for (let i = 0; i < 2; i++) {
    try {
      await axios.post(SHEET_URL, payload, { timeout: 12000 });
      return;
    } catch (e: any) {
      if (i) console.error("[SHEET] post failed:", redact(e?.message || String(e)));
      else await sleep(750);
    }
  }
}

// ---------------------------------------------------------------- chain reads
async function stakeRates(): Promise<{ x: number; y: number }> {
  const [a, b] = await connection.getMultipleAccountsInfo([STAKE_POOLS[X.toBase58()], STAKE_POOLS[Y.toBase58()]]);
  if (!a || !b) throw new Error("stake pool account read failed");
  return { x: stakePoolRate(a.data as Buffer), y: stakePoolRate(b.data as Buffer) };
}
async function solUsd(): Promise<number> {
  await solUsdPool.refetchStates();
  const ab = await solUsdPool.getActiveBin();
  const p = Number(ab.pricePerToken);
  if (!(p > 5 && p < 5000)) throw new Error(`implausible SOL/USD ${p}`);
  return p;
}
async function tokenBalRaw(mint: PublicKey): Promise<number> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  try {
    const b = await connection.getTokenAccountBalance(ata, "confirmed");
    return Number(b.value.amount);
  } catch (e: any) {
    if (/could not find account|Invalid param: could not find/i.test(String(e?.message || e))) return 0;
    throw e;
  }
}
interface WalletState { usdcRaw: number; xRaw: number; yRaw: number; nativeLamports: number }
async function walletState(): Promise<WalletState> {
  const [usdcRaw, xRaw, yRaw, nativeLamports] = await Promise.all([tokenBalRaw(USDC_MINT), tokenBalRaw(X), tokenBalRaw(Y), connection.getBalance(owner, "confirmed")]);
  return { usdcRaw, xRaw, yRaw, nativeLamports };
}
async function livePositions(): Promise<any[]> {
  const { userPositions } = await pool.getPositionsByUserAndLbPair(owner);
  return userPositions || [];
}
/** Position token amounts incl. unclaimed fees (UI units) + rent lamports. */
async function positionHoldings(): Promise<{ x: number; y: number; feeX: number; feeY: number; rentSol: number }> {
  if (!positionKey) return { x: 0, y: 0, feeX: 0, feeY: 0, rentSol: 0 };
  const p: any = await pool.getPosition(positionKey);
  const d = p.positionData;
  const s = 10 ** decimals;
  const info = await connection.getAccountInfo(positionKey);
  return {
    x: Number(d.totalXAmount) / s, y: Number(d.totalYAmount) / s,
    feeX: Number(d.feeX?.toString?.() ?? 0) / s, feeY: Number(d.feeY?.toString?.() ?? 0) / s,
    rentSol: (info?.lamports ?? 0) / 1e9,
  };
}
async function measure(): Promise<{ eq: Equity; w: WalletState; rates: { x: number; y: number }; solUsd: number; pos: Awaited<ReturnType<typeof positionHoldings>> }> {
  const [w, rates, px, pos] = await Promise.all([walletState(), stakeRates(), solUsd(), positionHoldings()]);
  const s = 10 ** decimals;
  const usdcIn = Math.max(0, w.usdcRaw / 1e6 - usdcExcludedUi);
  const eq = testEquity({
    usdc: usdcIn, xTokens: w.xRaw / s + pos.x + pos.feeX, yTokens: w.yRaw / s + pos.y + pos.feeY,
    solPerX: rates.x, solPerY: rates.y, nativeSol: w.nativeLamports / 1e9, rentSol: pos.rentSol,
    gasBaselineSol: gasBaselineSol >= 0 ? gasBaselineSol : w.nativeLamports / 1e9, solUsd: px,
  });
  return { eq, w, rates, solUsd: px, pos };
}

// ---------------------------------------------------------------- tx sending
function isPreflightRejection(err: any): boolean {
  return /simulation failed|preflight|blockhash not found|insufficient (funds|lamports)/i.test(String(err?.message || err || ""));
}
async function confirmOrResolve(sig: string, blockhash: string, lvbh: number, sendErr: any): Promise<LandedStatus> {
  if (sendErr && isPreflightRejection(sendErr)) return "not_landed";
  if (!sendErr) {
    try {
      const c = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight: lvbh }, "confirmed");
      return c?.value?.err ? "failed" : "landed";
    } catch { /* fall through to chain check */ }
  }
  return resolveLanded(sig, lvbh, {
    getStatus: async (x) => {
      const v = (await connection.getSignatureStatuses([x], { searchTransactionHistory: true }))?.value?.[0];
      return v ? { err: v.err, confirmationStatus: v.confirmationStatus ?? null } : null;
    },
    getBlockHeight: () => connection.getBlockHeight("confirmed"),
    sleep,
  }, { pollMs: 2000, maxWaitMs: 150_000 });
}
async function sendTx(tx: Transaction | VersionedTransaction, signers: Keypair[], label: string): Promise<string> {
  if (DRY_RUN) throw new Error(`DRY_RUN: refusing to send ${label}`);
  const native = await connection.getBalance(wallet.publicKey, "confirmed");
  if (native < FEE_FLOOR_LAMPORTS) throw new Error(`insufficient funds: native SOL ${native / 1e9} below fee floor`);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  let raw: Uint8Array, sig: string;
  if (tx instanceof VersionedTransaction) {
    tx.message.recentBlockhash = blockhash;
    tx.sign(signers);
    sig = bs58.encode(tx.signatures[0]);
    raw = tx.serialize();
  } else {
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = wallet.publicKey;
    tx.sign(...signers);
    sig = bs58.encode(tx.signature!);
    raw = tx.serialize();
  }
  let sendErr: any = null;
  try {
    await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed" });
  } catch (e) { sendErr = e; }
  const rl = sendErr && /\b429\b|too many requests/i.test(String(sendErr?.message || sendErr));
  const st: LandedStatus = rl ? "not_landed" : await confirmOrResolve(sig, blockhash, lastValidBlockHeight, sendErr);
  if (st === "landed") return sig;
  throw new TxSendError(redact(`${label} tx ${sig.slice(0, 8)}… ${st}${sendErr ? ": " + shortTxError(sendErr, 300) : ""}`), st, sig);
}

// ---------------------------------------------------------------- Jupiter
let lastJupAt = 0;
async function paceJup() {
  const gap = JUP_KEY ? 1050 : 2100;
  const wait = lastJupAt + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastJupAt = Date.now();
}
/** Swap with slippage-capped re-quotes; never retries a tx whose fate is unknown. Returns sig or throws. */
async function jupSwap(inMint: PublicKey, outMint: PublicKey, amountRaw: number, label: string): Promise<{ sig: string; outQuoted: number }> {
  if (!(amountRaw > 0)) throw new Error(`${label}: zero amount`);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (JUP_KEY) headers["x-api-key"] = JUP_KEY;
  let slip = SLIPPAGE_BPS;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let attemptedSig = "";
    let landed: LandedStatus | undefined;
    let httpStatus: number | undefined;
    try {
      await paceJup();
      const q = (await axios.get(`${JUP_BASE}/quote?inputMint=${inMint.toBase58()}&outputMint=${outMint.toBase58()}&amount=${Math.floor(amountRaw)}&slippageBps=${slip}&restrictIntermediateTokens=true`, { timeout: 10000, headers })).data;
      if (!q?.outAmount) throw new Error(`Bad Jupiter quote: ${JSON.stringify(q)?.slice(0, 160)}`);
      const impact = Number(q.priceImpactPct || 0) * 100;
      if (impact > SLIPPAGE_MAX_BPS / 100) throw new Error(`Bad Jupiter quote: price impact ${impact.toFixed(3)}% > cap`);
      if (DRY_RUN) {
        console.log(`[DRY_RUN] ${label}: would swap ${amountRaw} ${inMint.toBase58().slice(0, 4)}→${outMint.toBase58().slice(0, 4)} quoted out ${q.outAmount} impact ${impact.toFixed(4)}% slip ${slip}bps`);
        return { sig: "DRY_RUN", outQuoted: Number(q.outAmount) };
      }
      await paceJup();
      const sw = (await axios.post(`${JUP_BASE}/swap`, { quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }, { timeout: 10000, headers: { ...headers, "Content-Type": "application/json" } })).data;
      if (!sw?.swapTransaction) throw new Error(`Bad Jupiter swap response`);
      const vtx = VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction, "base64"));
      vtx.sign([wallet]);
      const sig = bs58.encode(vtx.signatures[0]);
      attemptedSig = sig;
      const lvbh = Number(sw.lastValidBlockHeight) > 0 ? Number(sw.lastValidBlockHeight) : (await connection.getBlockHeight("confirmed")) + 300;
      let sendErr: any = null;
      try { await connection.sendTransaction(vtx, { skipPreflight: false, maxRetries: 3 }); } catch (e) { sendErr = e; }
      landed = await confirmOrResolve(sig, vtx.message.recentBlockhash, lvbh, sendErr);
      if (landed !== "landed") throw new Error(`swap tx ${sig} ${landed}${sendErr ? " " + shortTxError(sendErr, 200) : ""}`);
      console.log(`[SWAP] ${label} ${sig} (slip cap ${slip} bps)`);
      return { sig, outQuoted: Number(q.outAmount) };
    } catch (e: any) {
      httpStatus = e?.response?.status;
      const msg = redact(e?.message || String(e));
      const kind = classifySwapFailure({ message: msg, httpStatus, attemptedSig, landedStatus: landed });
      console.warn(`[SWAP] ${label} attempt ${attempt} failed (${kind}): ${msg.slice(0, 200)}`);
      if (kind === "fatal" || kind === "unsafe" || attempt === 3) throw new Error(`${label} swap failed (${kind}): ${msg.slice(0, 200)}`);
      if (kind === "slippage") {
        const next = nextSlippageBps(slip, SLIPPAGE_MAX_BPS);
        if (next <= slip) throw new Error(`${label}: slippage above ${slip} bps cap`);
        slip = next;
      } else await sleep(kind === "ratelimit" ? 5000 * attempt : swapRetryDelayMs(attempt));
    }
  }
  throw new Error(`${label}: unreachable`);
}

// ---------------------------------------------------------------- position ops
async function closePosition(why: string): Promise<string[]> {
  if (!positionKey) return [];
  const sigs: string[] = [];
  const p: any = await pool.getPosition(positionKey);
  const s = 10 ** decimals;
  const r = await stakeRates();
  cumFeesSol += (Number(p.positionData.feeX?.toString?.() ?? 0) / s) * r.x + (Number(p.positionData.feeY?.toString?.() ?? 0) / s) * r.y;
  const hasLiq = positionHasLiquidity(p.positionData);
  const txs = hasLiq
    ? await (pool as any).removeLiquidity({ user: wallet.publicKey, position: positionKey, fromBinId: Number(p.positionData.lowerBinId), toBinId: Number(p.positionData.upperBinId), bps: new BN(10_000), shouldClaimAndClose: true })
    : await (pool as any).closePosition({ owner: wallet.publicKey, position: p });
  for (const tx of Array.isArray(txs) ? txs : [txs]) sigs.push(await sendTx(tx, [wallet], `close (${why})`));
  // verify closed
  for (let i = 0; i < 5; i++) {
    if (!(await connection.getAccountInfo(positionKey))) break;
    await sleep(2000);
  }
  if (await connection.getAccountInfo(positionKey)) throw new Error(`position ${positionKey.toBase58()} still open after close`);
  await ledger("LST_CLOSE", { tx_sig: sigs.join(","), notes: why });
  positionKey = null;
  rangeMin = rangeMax = 0;
  return sigs;
}

/** Open the single position with all wallet X/Y around the live active bin. */
async function openPosition(label: string): Promise<string[]> {
  const existing = await livePositions();
  if (existing.length) throw new Error(`refusing to open: ${existing.length} live position(s) already exist`);
  const w = await walletState();
  if (w.nativeLamports < GAS_RESERVE_LAMPORTS + OPEN_COST_LAMPORTS - 10_000_000)
    throw new Error(`native SOL ${(w.nativeLamports / 1e9).toFixed(4)} below reserve+open cost — not opening`);
  await pool.refetchStates();
  const ab = await pool.getActiveBin();
  const { minBinId, maxBinId } = tightRange(ab.binId, HALF_WIDTH);
  const posKp = Keypair.generate();
  const tx = await (pool as any).initializePositionAndAddLiquidityByStrategy({
    positionPubKey: posKp.publicKey, user: wallet.publicKey,
    totalXAmount: new BN(w.xRaw), totalYAmount: new BN(w.yRaw),
    strategy: { minBinId, maxBinId, strategyType: StrategyType.Spot },
    slippage: DEPLOY_SLIPPAGE_PCT,
  });
  const sigs: string[] = [];
  try {
    for (const t of Array.isArray(tx) ? tx : [tx]) sigs.push(await sendTx(t, [wallet, posKp], label));
  } catch (e) {
    // Late landing: adopt rather than double.
    if (await connection.getAccountInfo(posKp.publicKey)) {
      positionKey = posKp.publicKey;
      rangeMin = minBinId; rangeMax = maxBinId;
      await notify(`⚠️ open reported an error but position <code>${posKp.publicKey.toBase58()}</code> exists — adopted.`);
    }
    throw e;
  }
  positionKey = posKp.publicKey;
  rangeMin = minBinId; rangeMax = maxBinId;
  oorTicks = 0;
  return sigs;
}

async function swapToBalance(label: string) {
  const w = await walletState();
  const r = await stakeRates();
  const sw = rebalanceSwap(w.xRaw, w.yRaw, r.x, r.y, decimals, 0.5, MIN_SWAP_SOL);
  if (!sw) return null;
  const res = sw.sell === "X" ? await jupSwap(X, Y, sw.amountRaw, `${label} JupSOL→JitoSOL`) : await jupSwap(Y, X, sw.amountRaw, `${label} JitoSOL→JupSOL`);
  await ledger("LST_SWAP", { tx_sig: res.sig, notes: `${label}: sold ${sw.sell} ${(sw.amountRaw / 10 ** decimals).toFixed(6)} (~${sw.solValue.toFixed(4)} SOL)` });
  return res.sig;
}

// ---------------------------------------------------------------- flows
async function entry() {
  const w = await walletState();
  const usdcRaw = usdcToDeploy(w.usdcRaw, MAX_USDC_IN_RAW);
  if (usdcRaw < 20e6 && w.xRaw + w.yRaw === 0) {
    console.log(`[ENTRY] nothing to deploy (USDC usable ${(usdcRaw / 1e6).toFixed(2)}; LST_MAX_USDC_IN=${MAX_USDC_IN_RAW / 1e6})`);
    return;
  }
  // Baseline measured right before entry (gas excluded): USDC that goes in + any LST already held.
  usdcExcludedUi = (w.usdcRaw - usdcRaw) / 1e6;
  if (gasBaselineSol < 0) gasBaselineSol = w.nativeLamports / 1e9;
  const m0 = await measure();
  if (!baseline) {
    baseline = { ...m0.eq };
    await notify(
      `📏 <b>[LST BASELINE]</b> $${baseline.usd.toFixed(2)} = ${baseline.sol.toFixed(6)} SOL @ $${m0.solUsd.toFixed(2)} (gas ${gasBaselineSol.toFixed(6)} SOL excluded; USDC outside test ${usdcExcludedUi.toFixed(2)}).\n` +
        `Pin it: LST_BASELINE_USD=${baseline.usd.toFixed(2)} LST_BASELINE_SOL=${baseline.sol.toFixed(6)} LST_GAS_BASELINE_SOL=${gasBaselineSol.toFixed(6)} LST_USDC_EXCLUDED=${usdcExcludedUi.toFixed(6)}`
    );
    await ledger("LST_BASELINE", { equity_usd: baseline.usd, equity_sol: baseline.sol, sol_usd: m0.solUsd, gas_baseline_sol: gasBaselineSol, usdc_in: usdcRaw / 1e6, usdc_excluded: usdcExcludedUi, notes: "JupSOL-JitoSOL test baseline (gas excluded)" });
  }
  let remaining = usdcRaw;
  // Rent/gas shortfall bought from the test's USDC (counts as test capital, refunded as SOL on close).
  const holdback = GAS_RESERVE_LAMPORTS + OPEN_COST_LAMPORTS;
  if (w.nativeLamports < holdback && remaining > 0) {
    const needSol = (holdback - w.nativeLamports) / 1e9 + 0.002;
    const usdcForSol = Math.ceil(needSol * m0.solUsd * 1e6 * 1.01);
    if (usdcForSol < remaining) {
      const r = await jupSwap(USDC_MINT, WSOL_MINT, usdcForSol, "entry USDC→SOL (rent)");
      await ledger("LST_SWAP", { tx_sig: r.sig, notes: `USDC ${(usdcForSol / 1e6).toFixed(2)} → SOL for position rent/gas holdback` });
      remaining -= usdcForSol;
    }
  }
  if (remaining > 0) {
    const half = Math.floor(remaining / 2);
    const a = await jupSwap(USDC_MINT, X, half, "entry USDC→JupSOL");
    const b = await jupSwap(USDC_MINT, Y, remaining - half, "entry USDC→JitoSOL");
    await ledger("LST_SWAP", { tx_sig: `${a.sig},${b.sig}`, notes: `entry: USDC ${(remaining / 1e6).toFixed(2)} → ~50/50 JupSOL/JitoSOL` });
  }
  if (DRY_RUN) {
    const ab = await pool.getActiveBin();
    const r = tightRange(ab.binId, HALF_WIDTH);
    console.log(`[DRY_RUN] would open Spot position bins ${r.minBinId}..${r.maxBinId} (active ${ab.binId})`);
    return;
  }
  await sleep(2000);
  await swapToBalance("entry trim");
  const sigs = await openPosition("open");
  lastRebalanceSec = nowSec();
  const m1 = await measure();
  await notify(`🟢 <b>[LST OPEN]</b> <code>${positionKey!.toBase58()}</code> bins ${rangeMin}..${rangeMax} | equity $${m1.eq.usd.toFixed(2)} / ${m1.eq.sol.toFixed(6)} SOL\nPin: LST_POSITION_PUBKEY=${positionKey!.toBase58()}`);
  await ledger("LST_DEPLOY", { tx_sig: sigs.join(","), equity_usd: m1.eq.usd, equity_sol: m1.eq.sol, sol_usd: m1.solUsd });
}

async function rebalance(reason: string) {
  const closeSigs = await closePosition(`rebalance: ${reason}`);
  await sleep(1500);
  const swapSig = await swapToBalance("rebalance");
  const openSigs = await openPosition("reopen");
  rebalances++;
  lastRebalanceSec = nowSec();
  const m = await measure();
  await notify(`🔁 <b>[LST REBALANCE]</b> ${reason} → bins ${rangeMin}..${rangeMax} | equity $${m.eq.usd.toFixed(2)} / ${m.eq.sol.toFixed(6)} SOL`);
  await ledger("LST_REBALANCE", { tx_sig: [...closeSigs, swapSig, ...openSigs].filter(Boolean).join(","), equity_usd: m.eq.usd, equity_sol: m.eq.sol, sol_usd: m.solUsd, notes: reason });
}

async function exitAll(target: "SOL" | "USDC" | "HOLD", why: string) {
  paused = true; // stays paused until /resume or restart (set BOT_PAUSED=true before restarting)
  const sigs = await closePosition(why);
  await sleep(1500);
  const w = await walletState();
  if (target !== "HOLD") {
    const out = target === "USDC" ? USDC_MINT : WSOL_MINT;
    for (const [mint, raw, n] of [[X, w.xRaw, "JupSOL"], [Y, w.yRaw, "JitoSOL"]] as [PublicKey, number, string][]) {
      if (raw <= 0) continue;
      try { sigs.push((await jupSwap(mint, out, raw, `exit ${n}→${target}`)).sig); }
      catch (e: any) { await notify(`⚠️ exit swap ${n}→${target} failed: ${redact(e?.message || e).slice(0, 160)} — tokens kept in wallet.`); }
    }
  }
  const m = await measure();
  const p = baseline ? pnl(m.eq, baseline) : null;
  await notify(`🛡️ <b>[LST EXIT → ${target}]</b> ${why}. Bot PAUSED. Equity $${m.eq.usd.toFixed(2)} / ${m.eq.sol.toFixed(6)} SOL` + (p ? ` | P&L ${p.usd >= 0 ? "+" : ""}$${p.usd.toFixed(2)} (${p.usdPct.toFixed(2)}%), ${p.sol >= 0 ? "+" : ""}${p.sol.toFixed(6)} SOL (${p.solPct.toFixed(2)}%)` : "") + `\nSet BOT_PAUSED=true before any restart.`);
  await ledger(target === "USDC" && /emergency/i.test(why) ? "EMERGENCY_EXIT" : "LST_EXIT", { tx_sig: sigs.join(","), equity_usd: m.eq.usd, equity_sol: m.eq.sol, sol_usd: m.solUsd, pnl_usd: p?.usd, pnl_sol: p?.sol, notes: why });
}

async function snapshot(force = false) {
  if (!force && nowSec() - lastSnapshotSec < SNAPSHOT_SEC) return;
  lastSnapshotSec = nowSec();
  const m = await measure();
  if (!baseline) return;
  const p = pnl(m.eq, baseline);
  const ab = await pool.getActiveBin();
  const fair = fairPriceYPerX(m.rates.x, m.rates.y);
  const dp = checkDepeg(Number(ab.pricePerToken), fair, DEPEG_MAX_PCT);
  await ledger("SNAPSHOT", {
    equity_usd: m.eq.usd, equity_sol: m.eq.sol, pnl_usd: p.usd, pnl_sol: p.sol, pnl_pct: p.usdPct, pnl_sol_pct: p.solPct,
    sol_usd: m.solUsd, active_bin: ab.binId, pool_price: Number(ab.pricePerToken), fair_price: fair, depeg_pct: dp.deviationPct,
    unclaimed_fees_sol: m.pos.feeX * m.rates.x + m.pos.feeY * m.rates.y, in_range: ab.binId >= rangeMin && ab.binId <= rangeMax,
    native_sol: m.w.nativeLamports / 1e9,
  });
}

async function statusText(): Promise<string> {
  const m = await measure();
  const ab = await pool.getActiveBin();
  const fair = fairPriceYPerX(m.rates.x, m.rates.y);
  const dp = checkDepeg(Number(ab.pricePerToken), fair, DEPEG_MAX_PCT);
  const p = baseline ? pnl(m.eq, baseline) : null;
  return `📊 <b>[LST STATUS]</b> ${paused ? "⏸️ PAUSED" : "▶️ active"}${DRY_RUN ? " (DRY_RUN)" : ""}\n` +
    `• Position: ${positionKey ? `<code>${positionKey.toBase58()}</code> bins ${rangeMin}..${rangeMax}` : "none"} | active ${ab.binId}\n` +
    `• Pool ${Number(ab.pricePerToken).toFixed(6)} vs fair ${fair.toFixed(6)} (${dp.deviationPct.toFixed(3)}%)\n` +
    `• Equity $${m.eq.usd.toFixed(2)} / ${m.eq.sol.toFixed(6)} SOL @ $${m.solUsd.toFixed(2)}\n` +
    (p ? `• P&L ${p.usd >= 0 ? "+" : ""}$${p.usd.toFixed(2)} (${p.usdPct.toFixed(2)}%) | ${p.sol >= 0 ? "+" : ""}${p.sol.toFixed(6)} SOL (${p.solPct.toFixed(2)}%) vs baseline $${baseline!.usd.toFixed(2)} / ${baseline!.sol.toFixed(6)} SOL\n` : "• Baseline: not set\n") +
    `• Unclaimed fees ≈ ${(m.pos.feeX * m.rates.x + m.pos.feeY * m.rates.y).toFixed(6)} SOL | claimed ${cumFeesSol.toFixed(6)} SOL | rebalances ${rebalances}\n` +
    `• Native SOL ${(m.w.nativeLamports / 1e9).toFixed(4)} (reserve ${(GAS_RESERVE_LAMPORTS / 1e9).toFixed(2)})`;
}

// ---------------------------------------------------------------- tick
async function tick() {
  if (busy) return;
  busy = true;
  try {
    await pool.refetchStates();
    const ab = await pool.getActiveBin();
    const rates = await stakeRates();
    const fair = fairPriceYPerX(rates.x, rates.y);
    const dp = checkDepeg(Number(ab.pricePerToken), fair, DEPEG_MAX_PCT);
    depegTicks = dp.depegged ? depegTicks + 1 : 0;

    // keep the one-position invariant fresh
    const live = await livePositions();
    if (live.length > 1) await notify(`🚨 ${live.length} live positions in this pool for the wallet — managing one, never opening more.`);
    if (!positionKey && live.length) {
      const { adopt } = pickPosition(live, PIN_POSITION);
      positionKey = adopt!.publicKey;
      rangeMin = Number(adopt!.positionData.lowerBinId); rangeMax = Number(adopt!.positionData.upperBinId);
      await notify(`🧭 adopted position <code>${positionKey.toBase58()}</code> bins ${rangeMin}..${rangeMax}`);
    } else if (positionKey && !live.some((p: any) => p.publicKey.equals(positionKey))) {
      await notify(`⚠️ position <code>${positionKey.toBase58()}</code> no longer on chain — flat.`);
      positionKey = null;
    }

    if (paused) return;
    if (depegTicks >= DEPEG_CONFIRM_TICKS && (positionKey || DEPEG_EXIT_TO !== "HOLD")) {
      await notify(`🚨 <b>[DEPEG GUARD]</b> pool ${Number(ab.pricePerToken).toFixed(6)} vs fair ${fair.toFixed(6)} = ${dp.deviationPct.toFixed(3)}% (> ${DEPEG_MAX_PCT}%) for ${depegTicks} ticks — exiting to ${DEPEG_EXIT_TO}.`);
      if (!DRY_RUN) await lock.run("depeg exit", () => exitAll(DEPEG_EXIT_TO, `depeg ${dp.deviationPct.toFixed(3)}%`));
      else paused = true;
      return;
    }
    if (dp.depegged) return; // wait for confirmation, no new entries/rebalances meanwhile

    if (!positionKey) {
      await lock.run("entry", () => entry());
      return;
    }
    const d = decideRebalance({ activeBinId: ab.binId, minBinId: rangeMin, maxBinId: rangeMax, outOfRangeTicks: oorTicks, requiredTicks: OOR_TICKS, nowSec: nowSec(), lastRebalanceSec, cooldownSec: REBALANCE_COOLDOWN_SEC });
    oorTicks = d.outOfRangeTicks;
    if (!d.inRange) console.log(`[RANGE] active ${ab.binId} outside ${rangeMin}..${rangeMax}: ${d.reason}`);
    if (d.rebalance) {
      if (DRY_RUN) console.log(`[DRY_RUN] would rebalance: ${d.reason}`);
      else await lock.run("rebalance", () => rebalance(`active ${ab.binId} outside ${rangeMin}..${rangeMax}`));
    }
    await snapshot();
  } catch (e: any) {
    const msg = redact(e?.message || String(e)).slice(0, 300);
    console.error("[TICK]", msg);
    if (!/429|too many requests|timeout/i.test(msg)) {
      await notify(`⚠️ tick error: ${msg}`);
      await ledger("ERROR", { notes: msg });
    }
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------- telegram
async function telegramLoop() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  let offset = 0;
  // Drop the backlog: a stale /emergency_exit or /resume from before this boot must not fire.
  try {
    const r = await axios.get(`${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/getUpdates`, { params: { timeout: 0, offset: -1 }, timeout: 10000 });
    const last = r.data?.result?.slice(-1)[0];
    if (last) offset = last.update_id + 1;
  } catch { /* ignore */ }
  for (;;) {
    try {
      const r = await axios.get(`${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/getUpdates`, { params: { timeout: 30, offset }, timeout: 40000 });
      for (const u of r.data?.result || []) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text || String(msg.chat?.id) !== TELEGRAM_CHAT_ID) continue;
        const text = String(msg.text).trim().split(/\s+/)[0].split("@")[0].toLowerCase();
        try {
          if (text === "/status" || text === "/bal" || text === "/balance") await notify(await statusText());
          else if (text === "/pause") { paused = true; await notify("⏸️ <b>[PAUSED]</b> No entries/rebalances/depeg exits. Position (if any) stays open."); }
          else if (text === "/resume") { paused = false; oorTicks = 0; depegTicks = 0; await notify("▶️ <b>[RESUMED]</b>"); }
          else if (text === "/emergency_exit") { paused = true; await notify("🚨 <b>[EMERGENCY EXIT]</b> closing and swapping all JupSOL/JitoSOL → USDC…"); await lock.run("/emergency_exit", () => exitAll("USDC", "emergency exit (Telegram)")); }
          else if (text === "/help") await notify("Commands: /status /pause /resume /emergency_exit");
        } catch (e: any) {
          await notify(`⚠️ ${text} failed: ${redact(e?.message || String(e)).slice(0, 200)}`);
        }
      }
    } catch (e: any) {
      if (/409|Conflict/.test(String(e?.message))) console.warn("[TELEGRAM] another poller is active (409)");
      await sleep(5000);
    }
  }
}

// ---------------------------------------------------------------- main
export async function main() {
  pool = await DLMM.create(connection, POOL);
  solUsdPool = await DLMM.create(connection, SOL_USD_POOL);
  X = pool.lbPair.tokenXMint;
  Y = pool.lbPair.tokenYMint;
  decimals = pool.tokenX.mint.decimals;
  if (!STAKE_POOLS[X.toBase58()] || !STAKE_POOLS[Y.toBase58()] || pool.tokenY.mint.decimals !== decimals)
    throw new Error("LST mode supports only the JupSOL/JitoSOL pool (unknown stake pool / decimals)");
  const live = await livePositions();
  if (live.length) {
    const { adopt, extras } = pickPosition(live, PIN_POSITION);
    positionKey = adopt!.publicKey;
    rangeMin = Number(adopt!.positionData.lowerBinId); rangeMax = Number(adopt!.positionData.upperBinId);
    if (extras.length) await notify(`🚨 ${extras.length} extra position(s) found — not managed: ${extras.map((p) => p.publicKey.toBase58()).join(", ")}`);
  }
  lastRebalanceSec = positionKey ? nowSec() : 0;
  await notify(
    `🚀 <b>[LST MODE BOOT]</b> pool <code>${POOL.toBase58()}</code> (bin step ${pool.lbPair.binStep}) | ±${HALF_WIDTH} bin | ` +
      `OOR ${OOR_TICKS}×${TICK_SEC}s, cooldown ${REBALANCE_COOLDOWN_SEC}s | depeg ${DEPEG_MAX_PCT}% → ${DEPEG_EXIT_TO} | USDC cap $${(MAX_USDC_IN_RAW / 1e6).toFixed(2)} | ` +
      `${paused ? "PAUSED (BOT_PAUSED)" : "active"}${DRY_RUN ? " | DRY_RUN" : ""} | position ${positionKey ? positionKey.toBase58() : "none"} | baseline ${baseline ? `$${baseline.usd.toFixed(2)} / ${baseline.sol.toFixed(6)} SOL (pinned)` : "unset (measured at entry)"}`
  );
  if (positionKey && !baseline) await notify("⚠️ Position exists but no LST_BASELINE_* pins — P&L will be measured from now (provisional). Set the pins from the original BASELINE row.");
  if (positionKey && !baseline) { const m = await measure(); baseline = m.eq; }
  void telegramLoop();
  await tick();
  await snapshot(true);
  setInterval(() => void tick(), TICK_SEC * 1000);
}

if (require.main === module) {
  main().catch(async (e) => {
    await notify(`💥 LST mode crashed at boot: ${redact(e?.message || String(e)).slice(0, 300)}`);
    process.exit(1);
  });
}
