import DLMM, {
  StrategyType,
  DEFAULT_BIN_PER_POSITION,
  getVariableFee,
} from "@meteora-ag/dlmm";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import bs58 from "bs58";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// ==================== ENVIRONMENT CONFIGURATION ====================
function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Environment variable ${key} is required but not set.`);
  }
  return value;
}

const RPC_URL = process.env.RPC_URL?.trim() || process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
const BOT_PRIVATE_KEY = requireEnv("BOT_PRIVATE_KEY");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim() || "";
// Optional: sheet logging disabled when unset (no hardcoded webhook in source).
const GOOGLE_SHEET_WEBHOOK_URL = process.env.GOOGLE_SHEET_WEBHOOK_URL?.trim() || "";
// Required: fee harvest destination. Fail fast — silent sweeps to a wrong/missing vault are worse.
const REVENUE_WALLET_PUBKEY = requireEnv("REVENUE_WALLET_PUBKEY");
// Optional startup baseline override (USD). If unset, computed from wallet equity after pool init.
const BASELINE_USD_ENV = process.env.BASELINE_USD?.trim() || "";

// Public Meteora SOL-USDC ~10bps DLMM pool + well-known mints (safe to keep in source).
const SOL_USDC_POOL = new PublicKey("BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const LP_REVENUE_VAULT = new PublicKey(REVENUE_WALLET_PUBKEY);

const PRICE_DECIMAL_FACTOR = 1000;

// Gas reserve sizing (defaults):
//   Position rent ≈ 0.057 SOL (SDK POSITION_FEE), bin-array rent ≈ 0.071 (often already live on SOL-USDC),
//   WSOL ATA ≈ 0.002, priority+base fees for a deploy/close/swap burst ≈ 0.01–0.02.
//   Steady-state (arrays exist, position rent recycled on close) needs ~0.08–0.10 SOL.
//   Default 0.12 SOL leaves headroom for one unexpected bin-array create + fee spike.
const GAS_RESERVE_LAMPORTS = Number(process.env.GAS_RESERVE_LAMPORTS ?? 120_000_000); // 0.12 SOL
const GAS_WARN_LAMPORTS = Number(process.env.GAS_WARN_LAMPORTS ?? 80_000_000); // 0.08 SOL
// Fraction of idle wallet capital to deploy into the grid (overrides regime capitalDeployPct). Default 100%.
const DEPLOY_PCT = Math.min(1, Math.max(0, Number(process.env.DEPLOY_PCT ?? 1)));
const MIN_SWAP_USD = Number(process.env.MIN_SWAP_USD ?? 10);
const TOPUP_MIN_USD = Number(process.env.TOPUP_MIN_USD ?? 20);
const TOPUP_COOLDOWN_SEC = Math.max(60, Number(process.env.TOPUP_COOLDOWN_SEC ?? 900));
const SNAPSHOT_INTERVAL_SEC = Math.max(60, Number(process.env.SNAPSHOT_INTERVAL_SEC ?? 3600));

// Jupiter Swap API base (lite free tier). Override with JUPITER_API_BASE or set JUPITER_API_KEY for api.jup.ag.
const JUPITER_API_BASE = (process.env.JUPITER_API_BASE?.trim() || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, "");
const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim() || "";
const JUPITER_SLIPPAGE_BPS = Number(process.env.JUPITER_SLIPPAGE_BPS ?? 50);

// Gate 2: max allowed *variable* fee in basis points before re-entry is blocked.
// (Not variableFeeControl — that is a static pool config constant, often ~40000.)
const GATE2_MAX_VARIABLE_FEE_BPS = Number(process.env.GATE2_MAX_VARIABLE_FEE_BPS ?? 15);

// Hard stop: max drawdown on mark-to-market equity vs entry (fraction, e.g. 0.05 = 5%).
const MAX_DRAWDOWN_PCT = Number(process.env.MAX_DRAWDOWN_PCT ?? 0.05);
// Below-range soft recenter: consecutive keeper ticks with spot < lowestBinPrice before recycle.
const BELOW_RANGE_TICKS = Math.max(1, Number(process.env.BELOW_RANGE_TICKS ?? 3));
// Min seconds between below-range (or TP) recenters that reopen a grid without a hard stop.
const RECENTER_COOLDOWN_SEC = Math.max(0, Number(process.env.RECENTER_COOLDOWN_SEC ?? 1800));
// Optional attach overrides when restarting against an already-open position.
const ENTRY_SPOT_USD_ENV = process.env.ENTRY_SPOT_USD?.trim() || "";
const ENTRY_EQUITY_USD_ENV = process.env.ENTRY_EQUITY_USD?.trim() || "";

// Meteora initializePosition width = maxBinId - minBinId + 1 must be in [1, DEFAULT_BIN_PER_POSITION].
const MAX_POSITION_WIDTH = DEFAULT_BIN_PER_POSITION.toNumber(); // 70

// ==================== SYSTEM STATE ====================
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(BOT_PRIVATE_KEY));

let dlmmPoolInstance: DLMM | null = null;
let activePositionPubkey: PublicKey | null = null;
let lowestBinPrice = 0;
let highestBinPrice = 0;
let inCooldownUntil = 0;
let lastSweepTime = Math.floor(Date.now() / 1000);
let isDeploying = false;
let isBotPaused = false;
let isLiquidating = false;
/** True while any unwind path (circuit breaker / take-profit / emergency) is in flight. */
let isExiting = false;
/** Prevents overlapping setInterval keeper ticks (async re-entrancy). */
let keeperTickRunning = false;
let deployedCapitalBaselineUsd = 0;
let lastExitPriceUsd = 0;
/** Spot USD at position entry (deploy or attach). Hard price-stop is measured from this, not range bottom. */
let entrySpotUsd = 0;
/** Mark-to-market equity USD at entry. Equity stop uses entryEquityUsd * (1 - MAX_DRAWDOWN_PCT). */
let entryEquityUsd = 0;
/** Consecutive keeper ticks with spot below lowestBinPrice (out of range downside). */
let belowRangeTickCount = 0;
/** Unix seconds of last soft recenter (below-range or take-profit recycle). */
let lastRecenterAt = 0;
let lastTopupAt = 0;
let lastSnapshotAt = 0;
/** In-memory cumulative fees claimed (USD) this process lifetime — sheet is source of truth long-term. */
let cumulativeFeesUsd = 0;
let cumulativeSweptUsd = 0;
let cumulativeGasSol = 0;

// ==================== NOTIFICATIONS & LOGS ====================
async function notify(msg: string) {
  console.log(msg);
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID.trim(),
      text: msg,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err: any) {
    try {
      const plainText = msg.replace(/<[^>]*>/g, "");
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID.trim(),
        text: plainText,
        disable_web_page_preview: true,
      });
    } catch (fallbackErr: any) {
      console.error("[TELEGRAM SEND FAILED]:", fallbackErr.response?.data || fallbackErr.message);
    }
  }
}

let sheetLoggingWarned = false;

/** Pacific time label for ledger rows (America/Los_Angeles). */
function formatTimestampPt(d: Date = new Date()): string {
  try {
    return d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour12: false });
  } catch {
    return d.toISOString();
  }
}

type LedgerEventName =
  | "BOOT"
  | "ATTACH"
  | "DEPLOY"
  | "TOPUP"
  | "SWAP"
  | "FEE_CLAIM"
  | "FEE_SWEEP"
  | "RECENTER"
  | "TAKE_PROFIT"
  | "CIRCUIT_BREAKER"
  | "HARD_STOP"
  | "EMERGENCY_EXIT"
  | "CLOSE"
  | "SNAPSHOT"
  | "ERROR"
  | string;

interface LedgerFields {
  event: LedgerEventName;
  regime?: string;
  spot_usd?: number;
  position_pubkey?: string;
  range_low?: number;
  range_high?: number;
  position_value_usd?: number;
  wallet_value_usd?: number;
  total_equity_usd?: number;
  entry_spot?: number;
  entry_equity?: number;
  unrealized_pnl_usd?: number;
  realized_pnl_usd?: number;
  fees_claimed_usd?: number;
  cumulative_fees_usd?: number;
  swept_to_revenue_usd?: number;
  gas_fee_sol?: number;
  gas_fee_usd?: number;
  tx_sig?: string;
  notes?: string;
  is_estimate?: boolean;
  // SWAP extras
  swap_direction?: string;
  swap_in_amount?: number;
  swap_out_amount?: number;
  swap_out_quoted?: number;
  slippage_bps?: number;
  swap_usd?: number;
  // legacy-compatible aliases (old Apps Script)
  gross_revenue_usd?: number;
  net_pnl_usd?: number;
  swept_usd?: number;
  tx_signature?: string;
  event_type?: string;
  [key: string]: any;
}

/** Native SOL + WSOL ATA + USDC ATA snapshot for the bot wallet. */
async function snapshotWalletBalances(): Promise<{
  nativeLamports: number;
  wsolRaw: number;
  usdcRaw: number;
  /** Effective SOL (native + WSOL) in lamports. */
  solEffectiveLamports: number;
}> {
  const nativeLamports = await connection.getBalance(wallet.publicKey);
  let wsolRaw = 0;
  let usdcRaw = 0;
  try {
    const wsolAta = await getAssociatedTokenAddress(WSOL_MINT, wallet.publicKey);
    wsolRaw = Number((await getAccount(connection, wsolAta)).amount);
  } catch {}
  try {
    const usdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    usdcRaw = Number((await getAccount(connection, usdcAta)).amount);
  } catch {}
  return {
    nativeLamports,
    wsolRaw,
    usdcRaw,
    solEffectiveLamports: nativeLamports + wsolRaw,
  };
}

interface TxWalletDeltas {
  ok: boolean;
  feeLamports: number | null;
  /** post-pre native lamports for the wallet account index */
  nativeLamportsDelta: number;
  wsolRawDelta: number;
  usdcRawDelta: number;
  /** native + WSOL delta (economic SOL change before attributing fee) */
  solEffectiveDelta: number;
}

/**
 * Parse confirmed tx meta for this wallet: fee, native balance delta, WSOL/USDC token deltas.
 * Falls back to ok=false if the tx cannot be fetched.
 */
async function fetchTxWalletDeltas(sig: string): Promise<TxWalletDeltas> {
  const empty: TxWalletDeltas = {
    ok: false,
    feeLamports: null,
    nativeLamportsDelta: 0,
    wsolRawDelta: 0,
    usdcRawDelta: 0,
    solEffectiveDelta: 0,
  };
  if (!sig || sig === "N/A" || sig === "ON-CHAIN") return empty;
  try {
    const tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const meta = tx?.meta;
    if (!meta) return empty;

    const walletStr = wallet.publicKey.toBase58();
    const message: any = tx.transaction.message;
    let accountKeys: string[] = [];
    try {
      if (typeof message.getAccountKeys === "function") {
        const compiled = message.getAccountKeys({
          accountKeysFromLookups: meta.loadedAddresses ?? undefined,
        });
        const staticKeys: PublicKey[] = compiled.staticAccountKeys ?? [];
        const writable = meta.loadedAddresses?.writable ?? [];
        const readonly = meta.loadedAddresses?.readonly ?? [];
        accountKeys = [...staticKeys, ...writable, ...readonly].map((k: PublicKey) => k.toBase58());
      } else if (Array.isArray(message.accountKeys)) {
        accountKeys = message.accountKeys.map((k: any) =>
          typeof k === "string" ? k : (k.pubkey?.toBase58?.() ?? k.toBase58?.() ?? String(k))
        );
      }
    } catch (e: any) {
      console.warn("[TX META] accountKeys resolve:", e?.message || e);
    }

    let walletIdx = accountKeys.indexOf(walletStr);
    if (walletIdx < 0) walletIdx = 0; // fee payer fallback

    const preBal = meta.preBalances?.[walletIdx] ?? 0;
    const postBal = meta.postBalances?.[walletIdx] ?? 0;
    const nativeLamportsDelta = Number(postBal) - Number(preBal);
    const feeLamports = typeof meta.fee === "number" ? meta.fee : null;

    const sumToken = (arr: typeof meta.preTokenBalances, mintStr: string): number => {
      let total = 0;
      for (const b of arr || []) {
        if (b.mint !== mintStr) continue;
        // Prefer owner match; if owner missing, still count (legacy meta)
        if (b.owner && b.owner !== walletStr) continue;
        total += Number(b.uiTokenAmount?.amount ?? 0);
      }
      return total;
    };

    const wsolMint = WSOL_MINT.toBase58();
    const usdcMint = USDC_MINT.toBase58();
    const wsolRawDelta = sumToken(meta.postTokenBalances, wsolMint) - sumToken(meta.preTokenBalances, wsolMint);
    const usdcRawDelta = sumToken(meta.postTokenBalances, usdcMint) - sumToken(meta.preTokenBalances, usdcMint);

    return {
      ok: true,
      feeLamports,
      nativeLamportsDelta,
      wsolRawDelta,
      usdcRawDelta,
      solEffectiveDelta: nativeLamportsDelta + wsolRawDelta,
    };
  } catch (err: any) {
    console.warn("[TX META]", sig.slice(0, 8), err?.message || err);
    return empty;
  }
}

async function getTxFeeSol(sig: string): Promise<number | null> {
  const d = await fetchTxWalletDeltas(sig);
  return d.feeLamports != null ? d.feeLamports / 1e9 : null;
}

/** Refuse to send when native SOL is below gas reserve (+ optional buffer for the next fee). */
async function ensureGasReserve(extraLamports: number = 5_000_000): Promise<boolean> {
  const bal = await connection.getBalance(wallet.publicKey);
  if (bal < GAS_RESERVE_LAMPORTS + extraLamports) {
    console.warn(
      `[GAS] Native SOL ${(bal / 1e9).toFixed(4)} below reserve+buffer ` +
        `${((GAS_RESERVE_LAMPORTS + extraLamports) / 1e9).toFixed(4)} — aborting tx path`
    );
    return false;
  }
  return true;
}

/**
 * Structured ledger post to GOOGLE_SHEET_WEBHOOK_URL.
 * Non-blocking for the keeper: errors are swallowed after one retry.
 * Also includes legacy fields (event_type, gross_revenue_usd, ...) so older doPost handlers keep working.
 */
async function emitLedger(fields: LedgerFields): Promise<void> {
  if (!GOOGLE_SHEET_WEBHOOK_URL) {
    if (!sheetLoggingWarned) {
      console.warn("[SHEET] GOOGLE_SHEET_WEBHOOK_URL unset — sheet logging disabled.");
      sheetLoggingWarned = true;
    }
    return;
  }
  const now = new Date();
  const payload: Record<string, any> = {
    schema_version: 2,
    timestamp_iso: now.toISOString(),
    timestamp_pt: formatTimestampPt(now),
    // legacy
    timestamp: now.toISOString().replace("T", " ").substring(0, 19),
    pool_name: "SOL-USDC 10bps",
    event_type: fields.event_type || fields.event,
    ...fields,
    entry_spot: fields.entry_spot ?? (entrySpotUsd || undefined),
    entry_equity: fields.entry_equity ?? (entryEquityUsd || undefined),
    cumulative_fees_usd: fields.cumulative_fees_usd ?? cumulativeFeesUsd,
    position_pubkey: fields.position_pubkey ?? (activePositionPubkey ? activePositionPubkey.toBase58() : ""),
    range_low: fields.range_low ?? (lowestBinPrice || undefined),
    range_high: fields.range_high ?? (highestBinPrice || undefined),
  };
  if (payload.tx_sig && !payload.tx_signature) payload.tx_signature = payload.tx_sig;
  if (payload.swept_to_revenue_usd != null && payload.swept_usd == null) payload.swept_usd = payload.swept_to_revenue_usd;
  if (payload.realized_pnl_usd != null && payload.net_pnl_usd == null) payload.net_pnl_usd = payload.realized_pnl_usd;
  if (payload.fees_claimed_usd != null && payload.gross_revenue_usd == null) payload.gross_revenue_usd = payload.fees_claimed_usd;

  const postOnce = () =>
    axios.post(GOOGLE_SHEET_WEBHOOK_URL, payload, { timeout: 12000 });
  try {
    await postOnce();
  } catch (err1: any) {
    try {
      await new Promise((r) => setTimeout(r, 750));
      await postOnce();
    } catch (err2: any) {
      console.error("[SHEET LOG ERROR]:", err2?.message || err1?.message);
    }
  }
}

/** Backward-compatible wrapper used by older call sites. */
async function logSheet(
  eventType: string,
  grossRevenueUsd: number,
  netPnlUsd: number,
  sweptUsd: number,
  txSignature: string,
  notes: string = ""
) {
  await emitLedger({
    event: eventType,
    event_type: eventType,
    gross_revenue_usd: grossRevenueUsd,
    net_pnl_usd: netPnlUsd,
    swept_usd: sweptUsd,
    swept_to_revenue_usd: sweptUsd,
    realized_pnl_usd: netPnlUsd,
    fees_claimed_usd: grossRevenueUsd,
    tx_sig: txSignature,
    tx_signature: txSignature,
    notes,
    is_estimate: true,
  });
}

// ==================== DETERMINISTIC BIN PRICE HELPER ====================
function calculateBinPriceUsd(activeSpotUsd: number, activeBinId: number, targetBinId: number, binStepBps: number = 10): number {
  try {
    const binDiff = targetBinId - activeBinId;
    return activeSpotUsd * Math.pow(1 + binStepBps / 10000, binDiff);
  } catch {
    return 0;
  }
}

// ==================== GATE 2 VOLATILITY HELPER ====================
/**
 * Gate 2 previously compared `lbPair.parameters.variableFeeControl` (a STATIC pool
 * config knob, often ~40000) to `baseFactor * 1.5` (~15). That comparison can never
 * pass, so re-entry stayed blocked forever ("40000 > 15").
 *
 * Correct signal: runtime `vParameters.volatilityAccumulator`, converted into the
 * *variable fee rate* via Meteora's formula (see docs):
 *   variableFee = ceil(variableFeeControl * (volAcc * binStep)^2 / 1e11)
 * in FEE_PRECISION units where 1e9 = 100%, so 1 bps = 1e5.
 * We gate on variable-fee bps <= GATE2_MAX_VARIABLE_FEE_BPS (env, default 15).
 */
function getGate2VolatilityState(dlmmPool: DLMM): {
  volAcc: number;
  variableFeeBps: number;
  thresholdBps: number;
  passed: boolean;
  detail: string;
} {
  const lbPair = (dlmmPool as any).lbPair;
  const volAcc = Number(lbPair?.vParameters?.volatilityAccumulator ?? 0);
  const binStep = Number(lbPair?.binStep ?? 10);
  const sParameters = lbPair?.parameters;
  const vParameters = lbPair?.vParameters;
  let variableFeeBps = 0;
  if (sParameters && vParameters) {
    try {
      const feeRaw = getVariableFee(binStep, sParameters, vParameters);
      variableFeeBps = Number(feeRaw.toString()) / 1e5; // FEE_PRECISION → bps
    } catch (err: any) {
      console.warn("[Gate2] getVariableFee failed:", err?.message || err);
    }
  }
  const thresholdBps = GATE2_MAX_VARIABLE_FEE_BPS;
  const passed = variableFeeBps <= thresholdBps;
  const detail = passed
    ? `✅ Passed (${variableFeeBps.toFixed(2)} bps ≤ ${thresholdBps} bps, volAcc=${volAcc})`
    : `⏳ High Volatility (${variableFeeBps.toFixed(2)} bps > ${thresholdBps} bps, volAcc=${volAcc})`;
  return { volAcc, variableFeeBps, thresholdBps, passed, detail };
}

/** Clamp bid/ask bins so inclusive width (max-min+1) ≤ DEFAULT_BIN_PER_POSITION (70). */
function clampBinRange(
  activeBinId: number,
  bidBins: number,
  askBins: number
): { minBinId: number; maxBinId: number; bidBins: number; askBins: number; width: number } {
  let bid = Math.max(0, Math.floor(bidBins));
  let ask = Math.max(0, Math.floor(askBins));
  // Inclusive width = bid + ask + 1 (active bin counted once).
  let width = bid + ask + 1;
  if (width > MAX_POSITION_WIDTH) {
    const budget = MAX_POSITION_WIDTH - 1; // bins excluding active
    const totalSide = Math.max(1, bid + ask);
    bid = Math.max(0, Math.floor((budget * bid) / totalSide));
    ask = Math.max(0, budget - bid);
    width = bid + ask + 1;
    console.warn(
      `[BIN CLAMP] Regime width exceeded ${MAX_POSITION_WIDTH}; clamped to bid=${bid} ask=${ask} (width=${width})`
    );
  }
  if (width < 1) {
    bid = 0;
    ask = 0;
    width = 1;
  }
  const minBinId = activeBinId - bid;
  const maxBinId = activeBinId + ask;
  return { minBinId, maxBinId, bidBins: bid, askBins: ask, width };
}

function gasBufferLabel(lamports: number): string {
  if (lamports >= GAS_RESERVE_LAMPORTS) return `🟢 Healthy (≥${(GAS_RESERVE_LAMPORTS / 1e9).toFixed(2)} SOL)`;
  if (lamports >= GAS_WARN_LAMPORTS) return `🟡 OK reserve (${(lamports / 1e9).toFixed(3)} SOL; warn<${(GAS_WARN_LAMPORTS / 1e9).toFixed(2)})`;
  return `⚠️ Low (<${(GAS_WARN_LAMPORTS / 1e9).toFixed(2)} SOL)`;
}

// ==================== EQUITY / STOP HELPERS ====================
/** Wallet liquid USD: USDC ATA + native SOL + WSOL ATA, marked at spot. */
async function getWalletLiquidEquityUsd(spotUsd: number): Promise<{ usdcUsd: number; solUsd: number; totalUsd: number }> {
  let usdcUsd = 0;
  let solLamports = await connection.getBalance(wallet.publicKey);
  try {
    const usdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    const usdcAcc = await getAccount(connection, usdcAta);
    usdcUsd = Number(usdcAcc.amount) / 1e6;
  } catch {}
  try {
    const wsolAta = await getAssociatedTokenAddress(WSOL_MINT, wallet.publicKey);
    const wsolAcc = await getAccount(connection, wsolAta);
    solLamports += Number(wsolAcc.amount);
  } catch {}
  const solUsd = (solLamports / 1e9) * spotUsd;
  return { usdcUsd, solUsd, totalUsd: usdcUsd + solUsd };
}

/** Position inventory + unclaimed fees in USD (X=SOL, Y=USDC). */
function getPositionInventoryUsd(pos: any, spotUsd: number): number {
  const pd = pos?.positionData;
  if (!pd) return 0;
  const x = Number(pd.totalXAmount?.toString?.() ?? pd.totalXAmount ?? 0) / 1e9;
  const y = Number(pd.totalYAmount?.toString?.() ?? pd.totalYAmount ?? 0) / 1e6;
  const feeX = Number(pd.feeX?.toString?.() ?? pd.feeX ?? 0) / 1e9;
  const feeY = Number(pd.feeY?.toString?.() ?? pd.feeY ?? 0) / 1e6;
  return (x + feeX) * spotUsd + (y + feeY);
}

/** Full mark-to-market: open position (if any) + wallet liquids. */
async function getMarkToMarketEquityUsd(dlmmPool: DLMM, spotUsd: number): Promise<number> {
  const walletEq = await getWalletLiquidEquityUsd(spotUsd);
  let posUsd = 0;
  try {
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    for (const pos of userPositions) {
      posUsd += getPositionInventoryUsd(pos, spotUsd);
    }
  } catch (err: any) {
    console.warn("[MTM] position probe failed:", err?.message || err);
  }
  return Number((walletEq.totalUsd + posUsd).toFixed(2));
}

function priceStopFromEntry(floorStopPct: number): number {
  if (!(entrySpotUsd > 0)) return 0;
  return entrySpotUsd * (1 - floorStopPct);
}

function equityStopFromEntry(): number {
  if (!(entryEquityUsd > 0)) return 0;
  return entryEquityUsd * (1 - MAX_DRAWDOWN_PCT);
}

function formatFloorStopLine(floorStopPct: number): string {
  const pStop = priceStopFromEntry(floorStopPct);
  const eStop = equityStopFromEntry();
  if (!(entrySpotUsd > 0)) return "N/A (no entry)";
  const pct = (floorStopPct * 100).toFixed(1);
  const dd = (MAX_DRAWDOWN_PCT * 100).toFixed(1);
  return (
    `$${(pStop || 0).toFixed(2)} (−${pct}% vs entry $${entrySpotUsd.toFixed(2)})` +
    (eStop > 0 ? ` | equity ≤ $${eStop.toFixed(2)} (−${dd}% vs $${entryEquityUsd.toFixed(2)})` : "")
  );
}

function clearEntryState() {
  entrySpotUsd = 0;
  entryEquityUsd = 0;
  belowRangeTickCount = 0;
}

async function recordEntryAfterOpen(dlmmPool: DLMM, spotUsd: number, note: string) {
  entrySpotUsd = spotUsd;
  try {
    entryEquityUsd = await getMarkToMarketEquityUsd(dlmmPool, spotUsd);
  } catch {
    entryEquityUsd = deployedCapitalBaselineUsd || 0;
  }
  console.log(`[ENTRY] ${note} spot=$${entrySpotUsd.toFixed(2)} equity=$${entryEquityUsd.toFixed(2)}`);
}



// ==================== RESILIENT CANDLE FETCHER ====================
async function fetchRecent15mKlines(): Promise<number[][] | null> {
  const urls = [
    "https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=15m&limit=3",
    "https://api.binance.us/api/v3/klines?symbol=SOLUSDT&interval=15m&limit=3",
  ];

  for (const url of urls) {
    try {
      const res = await axios.get(url, { timeout: 4000 });
      if (res.data && Array.isArray(res.data) && res.data.length >= 3) {
        return res.data;
      }
    } catch {}
  }
  return null;
}

// ==================== MACRO REGIME SENTINEL ====================
export type MarketRegime = "BULL_EXPANSION" | "RANGE_CHOP" | "BEAR_DEFENSIVE";

export interface RegimeConfig {
  regime: MarketRegime;
  score: number;
  bidBins: number;
  askBins: number;
  floorStopPct: number;
  cooldownSec: number;
  capitalDeployPct: number;
  details: {
    solPrice: number;
    sma200: number;
    fundingAnnual: number;
    turnoverRatio: number;
  };
}

class MacroSentinel {
  private lastEvaluationTime: number = 0;
  private cachedConfig: RegimeConfig | null = null;

  async evaluateRegime(dlmmPoolAddress: string, force: boolean = false): Promise<RegimeConfig> {
    const now = Math.floor(Date.now() / 1000);
    if (!force && this.cachedConfig && now - this.lastEvaluationTime < 3600) {
      return this.cachedConfig;
    }

    try {
      const [cgRes, hlRes] = await Promise.all([
        axios.get("https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=200&interval=daily", { timeout: 8000 }),
        axios.post("https://api.hyperliquid.xyz/info", { type: "predictedFundings" }, { timeout: 8000 }),
      ]);

      const prices: number[] = cgRes.data.prices.map((p: any) => p[1]);
      const currentSolPrice = prices[prices.length - 1];
      const sma200 = prices.reduce((a, b) => a + b, 0) / prices.length;
      const isAbove200Sma = currentSolPrice > sma200;

      let fundingAnnual = 10.0;
      try {
        const solEntry = hlRes.data.find((item: any) => item[0] === "SOL");
        if (solEntry && solEntry[1]?.[0]?.[1]?.fundingRate) {
          const hlFundingRate = parseFloat(solEntry[1][0][1].fundingRate);
          fundingAnnual = hlFundingRate * 24 * 365 * 100;
        }
      } catch {}

      let score = 50;
      score += isAbove200Sma ? 25 : -25;
      if (fundingAnnual > 5 && fundingAnnual < 40) score += 25;
      else if (fundingAnnual <= 0) score -= 25;

      let regime: MarketRegime = "RANGE_CHOP";
      let bidBins = 30;
      let askBins = 30;
      let floorStopPct = 0.05;
      let cooldownSec = 3600;
      let capitalDeployPct = 0.85;

      if (score >= 70) {
        regime = "BULL_EXPANSION";
        bidBins = 25;
        askBins = 35;
        floorStopPct = 0.04;
        cooldownSec = 1800;
        capitalDeployPct = 0.85;
      } else if (score < 40) {
        regime = "BEAR_DEFENSIVE";
        bidBins = 45;
        askBins = 15;
        floorStopPct = 0.06;
        cooldownSec = 14400;
        capitalDeployPct = 0.60;
      }

      this.cachedConfig = {
        regime,
        score,
        bidBins,
        askBins,
        floorStopPct,
        cooldownSec,
        capitalDeployPct,
        details: { solPrice: currentSolPrice, sma200, fundingAnnual, turnoverRatio: 0.15 },
      };

      this.lastEvaluationTime = now;
      return this.cachedConfig;
    } catch (err: any) {
      if (this.cachedConfig) return this.cachedConfig;
      return {
        regime: "BULL_EXPANSION",
        score: 65,
        bidBins: 25,
        askBins: 35,
        floorStopPct: 0.04,
        cooldownSec: 1800,
        capitalDeployPct: 0.85,
        details: { solPrice: 110, sma200: 105, fundingAnnual: 10, turnoverRatio: 0.15 },
      };
    }
  }
}

const macroSentinel = new MacroSentinel();

// ==================== JUPITER SWAP EXECUTION ====================
interface SwapResult {
  sig: string;
  inAmount: number;
  outAmountQuoted: number;
  outAmountActual: number | null;
  direction: string;
  inMint: string;
  outMint: string;
  slippageBps: number;
  usdNotional: number;
  isEstimate: boolean;
}

async function executeJupiterSwap(
  inputMint: PublicKey,
  outputMint: PublicKey,
  amountLamports: string,
  spotUsdForNotional: number = 0
): Promise<SwapResult> {
  const empty: SwapResult = {
    sig: "",
    inAmount: Number(amountLamports) || 0,
    outAmountQuoted: 0,
    outAmountActual: null,
    direction: `${inputMint.toBase58().slice(0, 4)}→${outputMint.toBase58().slice(0, 4)}`,
    inMint: inputMint.toBase58(),
    outMint: outputMint.toBase58(),
    slippageBps: JUPITER_SLIPPAGE_BPS,
    usdNotional: 0,
    isEstimate: true,
  };
  try {
    // quote-api.jup.ag/v6 is dead (ENOTFOUND). Current Swap API: lite-api.jup.ag/swap/v1 (or api.jup.ag/swap/v1 + key).
    const headers: Record<string, string> = { Accept: "application/json" };
    if (JUPITER_API_KEY) headers["x-api-key"] = JUPITER_API_KEY;

    const quoteUrl =
      `${JUPITER_API_BASE}/quote?inputMint=${inputMint.toBase58()}` +
      `&outputMint=${outputMint.toBase58()}&amount=${amountLamports}` +
      `&slippageBps=${JUPITER_SLIPPAGE_BPS}&restrictIntermediateTokens=true`;
    const quoteRes = await axios.get(quoteUrl, { timeout: 10000, headers });
    const quoteResponse = quoteRes.data;
    if (!quoteResponse || quoteResponse.error || !quoteResponse.outAmount) {
      throw new Error(`Bad Jupiter quote: ${JSON.stringify(quoteResponse)?.slice(0, 200)}`);
    }

    const inAmountQuoted = Number(quoteResponse.inAmount || amountLamports);
    const outQuoted = Number(quoteResponse.outAmount);
    const inIsSol = inputMint.equals(WSOL_MINT);
    const outIsSol = outputMint.equals(WSOL_MINT);
    const inIsUsdc = inputMint.equals(USDC_MINT);
    const outIsUsdc = outputMint.equals(USDC_MINT);

    // Keep a fee buffer so the swap itself cannot drain the gas reserve.
    if (!(await ensureGasReserve(5_000_000))) {
      throw new Error("SOL below gas reserve — refusing Jupiter swap");
    }

    const swapRes = await axios.post(
      `${JUPITER_API_BASE}/swap`,
      {
        quoteResponse,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      },
      { timeout: 10000, headers: { ...headers, "Content-Type": "application/json" } }
    );

    const { swapTransaction } = swapRes.data;
    if (!swapTransaction) {
      throw new Error(`Bad Jupiter swap response: ${JSON.stringify(swapRes.data)?.slice(0, 200)}`);
    }

    const preSnap = await snapshotWalletBalances();
    const swapTxBuf = Buffer.from(swapTransaction, "base64");
    const vtx = VersionedTransaction.deserialize(swapTxBuf);
    vtx.sign([wallet]);

    const txid = await connection.sendTransaction(vtx, { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(txid, "confirmed");

    const meta = await fetchTxWalletDeltas(txid);
    const postSnap = await snapshotWalletBalances();

    let inAmountActual = inAmountQuoted;
    let outAmountActual: number | null = outQuoted;
    let feeLamports = meta.feeLamports;
    let isEstimate = true;

    if (meta.ok) {
      // Prefer tx meta deltas. SOL legs use effective SOL (native + WSOL);
      // fee is paid from native so for SOL→USDC the SOL decrease includes fee —
      // subtract fee from the SOL leg so "in" reflects swapped amount, not gas.
      if (inIsSol && outIsUsdc) {
        // solEffectiveDelta is negative (spent); usdcRawDelta positive
        const solSpent = Math.max(0, -(meta.solEffectiveDelta) - (meta.feeLamports ?? 0));
        inAmountActual = solSpent > 0 ? solSpent : Math.max(0, -(meta.solEffectiveDelta));
        outAmountActual = Math.max(0, meta.usdcRawDelta);
      } else if (inIsUsdc && outIsSol) {
        inAmountActual = Math.max(0, -(meta.usdcRawDelta));
        // SOL received: effective increase + fee (fee came from received SOL or reserve)
        const solGot = meta.solEffectiveDelta + (meta.feeLamports ?? 0);
        outAmountActual = Math.max(0, solGot > 0 ? solGot : meta.solEffectiveDelta);
      } else {
        // Generic: use absolute mint deltas
        if (inIsSol) inAmountActual = Math.max(0, -(meta.solEffectiveDelta) - (meta.feeLamports ?? 0));
        else if (inIsUsdc) inAmountActual = Math.max(0, -(meta.usdcRawDelta));
        if (outIsSol) outAmountActual = Math.max(0, meta.solEffectiveDelta + (meta.feeLamports ?? 0));
        else if (outIsUsdc) outAmountActual = Math.max(0, meta.usdcRawDelta);
      }
      isEstimate = false;
    } else {
      // Fallback: RPC pre/post snapshots around the confirmed swap
      const solDelta = postSnap.solEffectiveLamports - preSnap.solEffectiveLamports;
      const usdcDelta = postSnap.usdcRaw - preSnap.usdcRaw;
      const nativeFeeApprox = Math.max(0, preSnap.nativeLamports - postSnap.nativeLamports - Math.max(0, -solDelta));
      if (inIsSol && outIsUsdc) {
        inAmountActual = Math.max(0, -solDelta);
        outAmountActual = Math.max(0, usdcDelta);
      } else if (inIsUsdc && outIsSol) {
        inAmountActual = Math.max(0, -usdcDelta);
        outAmountActual = Math.max(0, solDelta);
      }
      feeLamports = feeLamports ?? (nativeFeeApprox > 0 ? nativeFeeApprox : null);
      // RPC pre/post snapshots are real balances (not quotes) — only pure-quote residual stays estimate.
      if ((inAmountActual > 0 || (outAmountActual ?? 0) > 0)) {
        isEstimate = false;
      } else {
        // No observable delta — keep quote amounts, mark estimate
        inAmountActual = inAmountQuoted;
        outAmountActual = outQuoted;
        isEstimate = true;
      }
    }

    const feeSol = feeLamports != null ? feeLamports / 1e9 : null;
    if (feeSol != null) cumulativeGasSol += feeSol;

    // Realized slippage vs quote (positive = worse fill than quote)
    let realizedSlippageBps = JUPITER_SLIPPAGE_BPS;
    if (outQuoted > 0 && outAmountActual != null && outAmountActual > 0) {
      realizedSlippageBps = Math.round(((outQuoted - outAmountActual) / outQuoted) * 10_000);
    }

    let usdNotional = 0;
    if (spotUsdForNotional > 0) {
      if (inIsSol) usdNotional = (inAmountActual / 1e9) * spotUsdForNotional;
      else if (inIsUsdc) usdNotional = inAmountActual / 1e6;
      else if (outIsSol && outAmountActual != null) usdNotional = (outAmountActual / 1e9) * spotUsdForNotional;
      else if (outAmountActual != null) usdNotional = outAmountActual / 1e6;
    }

    const direction = inIsSol ? "SOL→USDC" : outIsSol ? "USDC→SOL" : `${inputMint.toBase58().slice(0, 4)}→${outputMint.toBase58().slice(0, 4)}`;
    const result: SwapResult = {
      sig: txid,
      inAmount: inAmountActual,
      outAmountQuoted: outQuoted,
      outAmountActual,
      direction,
      inMint: inputMint.toBase58(),
      outMint: outputMint.toBase58(),
      slippageBps: realizedSlippageBps,
      usdNotional,
      isEstimate,
    };

    const inUi = inIsSol ? inAmountActual / 1e9 : inAmountActual / 1e6;
    const outUi = outAmountActual == null ? 0 : outIsSol ? outAmountActual / 1e9 : outAmountActual / 1e6;
    const outQuotedUi = outIsSol ? outQuoted / 1e9 : outQuoted / 1e6;

    void emitLedger({
      event: "SWAP",
      swap_direction: direction,
      swap_in_amount: inUi,
      swap_out_amount: outUi,
      swap_out_quoted: outQuotedUi,
      slippage_bps: realizedSlippageBps,
      swap_usd: usdNotional,
      gas_fee_sol: feeSol ?? undefined,
      gas_fee_usd: feeSol != null && spotUsdForNotional > 0 ? feeSol * spotUsdForNotional : undefined,
      tx_sig: txid,
      is_estimate: isEstimate,
      notes: isEstimate
        ? "Jupiter swap (quote only — no meta/snapshot deltas)"
        : (meta.ok
            ? "Jupiter swap (actuals from tx meta pre/post balances)"
            : "Jupiter swap (actuals from RPC pre/post balance snapshots)"),
    });

    return result;
  } catch (err: any) {
    console.error("[JUPITER SWAP ERROR]:", err.response?.data || err.message);
    void emitLedger({
      event: "ERROR",
      notes: `Jupiter swap failed: ${err?.message || err}`,
      is_estimate: true,
    });
    return empty;
  }
}

// ==================== PROFIT SWEEP TO LP REVENUE ====================
async function sweepRevenueToVault(dlmmPool: DLMM): Promise<number> {
  try {
    if (!activePositionPubkey) return 0;
    await dlmmPool.refetchStates();

    const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    const revUsdcAta = await getAssociatedTokenAddress(USDC_MINT, LP_REVENUE_VAULT);

    const preClaim = await snapshotWalletBalances();
    let usdcBefore = BigInt(preClaim.usdcRaw);

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const targetPos = userPositions.find((p: any) => p.publicKey.equals(activePositionPubkey!));
    if (!targetPos) return 0;

    const claimSigs: string[] = [];
    try {
      if (!(await ensureGasReserve(5_000_000))) {
        console.warn("[FEE] Skipping claim — SOL below gas reserve");
        return 0;
      }
      const claimTx = await (dlmmPool as any).claimSwapFee({
        owner: wallet.publicKey,
        position: targetPos,
      });

      if (Array.isArray(claimTx)) {
        for (const tx of claimTx) {
          const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
          claimSigs.push(sig);
        }
      } else if (claimTx) {
        const sig = await sendAndConfirmTransaction(connection, claimTx, [wallet]);
        claimSigs.push(sig);
      }
    } catch (claimErr: any) {
      if (claimErr?.message?.includes("No fee to claim") || claimErr?.message?.includes("0x1771")) {
        return 0;
      }
      throw claimErr;
    }

    const postClaim = await snapshotWalletBalances();
    // Prefer summed tx-meta deltas across claim sigs; fall back to snapshot.
    let claimedSolLamports = 0;
    let claimedUsdcRaw = 0;
    let claimFeeLamports = 0;
    let claimActual = false;
    for (const sig of claimSigs) {
      const d = await fetchTxWalletDeltas(sig);
      if (d.ok) {
        claimedSolLamports += Math.max(0, d.solEffectiveDelta + (d.feeLamports ?? 0)); // fee paid from wallet; gross claim ≈ delta+fee if claim only adds SOL
        // More reliable: positive effective SOL after adding back fee paid
        claimedUsdcRaw += Math.max(0, d.usdcRawDelta);
        claimFeeLamports += d.feeLamports ?? 0;
        claimActual = true;
      }
    }
    if (!claimActual) {
      claimedSolLamports = Math.max(0, postClaim.solEffectiveLamports - preClaim.solEffectiveLamports);
      claimedUsdcRaw = Math.max(0, postClaim.usdcRaw - preClaim.usdcRaw);
    } else {
      // Reconcile: if meta under-counted (fee attribution), prefer max(meta, snapshot)
      const snapSol = Math.max(0, postClaim.solEffectiveLamports - preClaim.solEffectiveLamports);
      const snapUsdc = Math.max(0, postClaim.usdcRaw - preClaim.usdcRaw);
      if (snapSol > claimedSolLamports) claimedSolLamports = snapSol;
      if (snapUsdc > claimedUsdcRaw) claimedUsdcRaw = snapUsdc;
    }

    const surplusSolToSwap = Math.max(0, postClaim.nativeLamports - GAS_RESERVE_LAMPORTS);
    // FEE_CLAIM: fee X (SOL) + fee Y (USDC). SOL USD left for SWAP/FEE_SWEEP when converted.
    if (claimedSolLamports > 0 || claimedUsdcRaw > 0) {
      if (claimFeeLamports > 0) cumulativeGasSol += claimFeeLamports / 1e9;
      void emitLedger({
        event: "FEE_CLAIM",
        fees_claimed_usd: claimedUsdcRaw / 1e6,
        gas_fee_sol: claimFeeLamports > 0 ? claimFeeLamports / 1e9 : undefined,
        tx_sig: claimSigs.join(",") || undefined,
        notes: `feeX(SOL)=${(claimedSolLamports / 1e9).toFixed(6)} feeY(USDC)=${(claimedUsdcRaw / 1e6).toFixed(6)}`,
        is_estimate: !claimActual,
      });
    }

    if (claimedSolLamports >= 5_000_000 && surplusSolToSwap >= 5_000_000) {
      const swapAmount = Math.min(claimedSolLamports, surplusSolToSwap);
      try {
        await notify(`🔄 Swapping ${(swapAmount / 1e9).toFixed(4)} claimed fee SOL to USDC...`);
        await executeJupiterSwap(WSOL_MINT, USDC_MINT, swapAmount.toString(), 0);
      } catch (swapErr: any) {
        console.error("Fee SOL-to-USDC swap note:", swapErr.message);
      }
    }

    const finalUsdcAcc = await getAccount(connection, botUsdcAta);
    const freshlyClaimedUsdc = finalUsdcAcc.amount > usdcBefore ? (finalUsdcAcc.amount - usdcBefore) : 0n;

    if (freshlyClaimedUsdc >= 50_000n) {
      const sweepTx = new Transaction().add(
        createTransferCheckedInstruction(
          botUsdcAta,
          USDC_MINT,
          revUsdcAta,
          wallet.publicKey,
          freshlyClaimedUsdc,
          6
        )
      );
      const sig = await sendAndConfirmTransaction(connection, sweepTx, [wallet]);
      const sweptAmountUsd = Number(freshlyClaimedUsdc) / 1e6;

      await notify(
        `💰 <b>[FEE SWEEP]</b> Harvested & Swept <b>$${sweptAmountUsd.toFixed(2)} USDC</b> to LP Revenue!\n` +
        `• Destination: <code>${LP_REVENUE_VAULT.toBase58()}</code>\n` +
        `• Tx: <code>${sig}</code>`
      );
      const sweepMeta = await fetchTxWalletDeltas(sig);
      const sweptUsdFinal = sweepMeta.ok
        ? Math.max(0, -(sweepMeta.usdcRawDelta)) / 1e6
        : sweptAmountUsd;
      const feeSol = sweepMeta.feeLamports != null ? sweepMeta.feeLamports / 1e9 : await getTxFeeSol(sig);
      cumulativeFeesUsd += sweptUsdFinal;
      cumulativeSweptUsd += sweptUsdFinal;
      if (feeSol != null) cumulativeGasSol += feeSol;
      await emitLedger({
        event: "FEE_SWEEP",
        fees_claimed_usd: sweptUsdFinal,
        swept_to_revenue_usd: sweptUsdFinal,
        cumulative_fees_usd: cumulativeFeesUsd,
        gas_fee_sol: feeSol ?? undefined,
        tx_sig: sig,
        notes: "Claimed fees converted/swept to REVENUE_WALLET_PUBKEY",
        is_estimate: !sweepMeta.ok,
      });
      return sweptUsdFinal;
    }
  } catch (err: any) {
    if (!err.message?.includes("No fee to claim")) {
      console.error("[FEE SWEEP ERROR]:", err.message);
    }
  }
  return 0;
}

// ==================== MANUAL & AUTOMATED TEARDOWN ====================
interface CloseReclaimResult {
  ok: boolean;
  sigs: string[];
  solReceivedLamports: number;
  usdcReceivedRaw: number;
  feeLamports: number;
  isEstimate: boolean;
}

async function closePositionAndReclaim(dlmmPool: DLMM): Promise<CloseReclaimResult> {
  const empty: CloseReclaimResult = { ok: false, sigs: [], solReceivedLamports: 0, usdcReceivedRaw: 0, feeLamports: 0, isEstimate: true };
  try {
    await dlmmPool.refetchStates();
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    if (userPositions.length === 0) return { ...empty, ok: true, isEstimate: false };

    const pre = await snapshotWalletBalances();
    const sigs: string[] = [];

    for (const pos of userPositions) {
      try {
        // Re-check on-chain ownership before each close to avoid AccountOwnedByWrongProgram
        // after a concurrent exit already closed the account (owner becomes System Program).
        const info = await connection.getAccountInfo(pos.publicKey);
        if (!info || info.owner.equals(SystemProgram.programId) || info.data.length === 0) {
          console.warn(`[CLOSE] Skipping ${pos.publicKey.toBase58()}: already closed/absent`);
          continue;
        }

        if (!(await ensureGasReserve(5_000_000))) {
          console.warn("[CLOSE] Aborting further closes — SOL below gas reserve");
          break;
        }

        const closeTx = await (dlmmPool as any).closePosition({
          owner: wallet.publicKey,
          position: pos,
        });

        if (Array.isArray(closeTx)) {
          for (const tx of closeTx) {
            sigs.push(await sendAndConfirmTransaction(connection, tx, [wallet]));
          }
        } else if (closeTx) {
          sigs.push(await sendAndConfirmTransaction(connection, closeTx, [wallet]));
        }
      } catch (closeErr: any) {
        const msg = closeErr?.message || String(closeErr);
        // Benign if a racing exit already closed it.
        if (/AccountOwnedByWrongProgram|3007|0xbbf|already been closed/i.test(msg)) {
          console.warn("[CLOSE] Position already gone (benign race):", msg.slice(0, 160));
          continue;
        }
        console.error("Close position error:", msg);
      }
    }

    const post = await snapshotWalletBalances();
    let solReceived = Math.max(0, post.solEffectiveLamports - pre.solEffectiveLamports);
    let usdcReceived = Math.max(0, post.usdcRaw - pre.usdcRaw);
    let feeLamports = 0;
    let anyMeta = false;
    for (const sig of sigs) {
      const d = await fetchTxWalletDeltas(sig);
      if (d.ok) {
        anyMeta = true;
        feeLamports += d.feeLamports ?? 0;
      }
    }
    if (feeLamports > 0) cumulativeGasSol += feeLamports / 1e9;

    void emitLedger({
      event: "CLOSE",
      tx_sig: sigs.join(",") || undefined,
      gas_fee_sol: feeLamports > 0 ? feeLamports / 1e9 : undefined,
      notes: `Close reclaim: +SOL=${(solReceived / 1e9).toFixed(6)} +USDC=${(usdcReceived / 1e6).toFixed(6)}`,
      wallet_value_usd: undefined,
      is_estimate: sigs.length > 0 ? !anyMeta : false,
      // stash raw legs in swap_* columns for sheet visibility
      swap_in_amount: solReceived / 1e9,
      swap_out_amount: usdcReceived / 1e6,
      swap_direction: "CLOSE→wallet",
    });

    return {
      ok: true,
      sigs,
      solReceivedLamports: solReceived,
      usdcReceivedRaw: usdcReceived,
      feeLamports,
      isEstimate: !anyMeta,
    };
  } catch (err: any) {
    console.error("[CLOSE RECLAIM ERROR]:", err.message);
    return empty;
  }
}

// ==================== IDLE TOP-UP INTO EXISTING POSITION ====================
/**
 * If idle wallet capital (USDC + SOL above reserve + WSOL) exceeds TOPUP_MIN_USD,
 * rebalance inventory to the live position's bid/ask ratio and addLiquidityByStrategy
 * into the EXISTING position (no close). Runs after fee sweep in the keeper so it
 * does not capture USDC that sweepRevenueToVault is about to send to the revenue wallet.
 */
async function topUpExistingPosition(dlmmPool: DLMM): Promise<void> {
  if (!activePositionPubkey || isDeploying || isExiting || isLiquidating || isBotPaused) return;
  const now = Math.floor(Date.now() / 1000);
  if (now - lastTopupAt < TOPUP_COOLDOWN_SEC) return;
  isDeploying = true;
  try {
    await dlmmPool.refetchStates();
    const activeBin = await dlmmPool.getActiveBin();
    const spotPriceUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;
    if (lowestBinPrice > 0 && spotPriceUsd < lowestBinPrice) return; // about to soft-recenter
    if (highestBinPrice > 0 && spotPriceUsd >= highestBinPrice) return; // about to take-profit

    // Unwrap stranded WSOL so idle SOL is native (same as deploy).
    const botWsolAta = await getAssociatedTokenAddress(WSOL_MINT, wallet.publicKey);
    try {
      const wsolAcc = await getAccount(connection, botWsolAta);
      if (wsolAcc && Number(wsolAcc.amount) > 0) {
        const unwrapTx = new Transaction().add(
          createCloseAccountInstruction(botWsolAta, wallet.publicKey, wallet.publicKey)
        );
        await sendAndConfirmTransaction(connection, unwrapTx, [wallet]);
      }
    } catch {}

    const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    let usdcUsd = 0;
    try {
      usdcUsd = Number((await getAccount(connection, botUsdcAta)).amount) / 1e6;
    } catch {}
    const solLamports = await connection.getBalance(wallet.publicKey);
    const idleSolLamports = Math.max(0, solLamports - GAS_RESERVE_LAMPORTS);
    const idleSolUsd = (idleSolLamports / 1e9) * spotPriceUsd;
    const idleUsd = usdcUsd + idleSolUsd;
    if (idleUsd < TOPUP_MIN_USD) return;

    const config = await macroSentinel.evaluateRegime(SOL_USDC_POOL.toBase58());
    const totalBins = Math.max(1, config.bidBins + config.askBins);
    const askRatio = config.askBins / totalBins;
    const bidRatio = config.bidBins / totalBins;
    const targetAskUsd = idleUsd * askRatio;
    const targetBidUsd = idleUsd * bidRatio;

    const solSurplusUsd = idleSolUsd - targetAskUsd;
    if (solSurplusUsd > MIN_SWAP_USD) {
      const sellLamports = Math.floor((solSurplusUsd / spotPriceUsd) * 1e9);
      await executeJupiterSwap(WSOL_MINT, USDC_MINT, sellLamports.toString(), spotPriceUsd);
    } else if (-solSurplusUsd > MIN_SWAP_USD) {
      const buyUsd = Math.min(usdcUsd, -solSurplusUsd);
      if (buyUsd > MIN_SWAP_USD) {
        await executeJupiterSwap(USDC_MINT, WSOL_MINT, Math.floor(buyUsd * 1e6).toString(), spotPriceUsd);
      }
    }

    const solBal2 = await connection.getBalance(wallet.publicKey);
    const addSolLamports = Math.max(0, Math.min(solBal2 - GAS_RESERVE_LAMPORTS, Math.floor((targetAskUsd / spotPriceUsd) * 1e9)));
    let addUsdcRaw = 0;
    try {
      addUsdcRaw = Math.floor(Math.min(Number((await getAccount(connection, botUsdcAta)).amount) / 1e6, targetBidUsd) * 1e6);
    } catch {}
    if (addSolLamports < 1_000_000 && addUsdcRaw < 100_000) return; // dust

    // Use the live position's on-chain bin range (not a new clamp around spot).
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const pos = userPositions.find((p: any) => p.publicKey.equals(activePositionPubkey!)) || userPositions[0];
    if (!pos) return;
    const minBinId = Number(pos.positionData.lowerBinId);
    const maxBinId = Number(pos.positionData.upperBinId);

    if (!(await ensureGasReserve(5_000_000))) {
      console.warn("[TOPUP] Abort — SOL below gas reserve");
      return;
    }
    // Refuse if depositing SOL would leave us under reserve (belt and suspenders).
    if (solBal2 - addSolLamports < GAS_RESERVE_LAMPORTS) {
      console.warn("[TOPUP] Abort — deposit would breach gas reserve");
      return;
    }
    if (isExiting || isLiquidating || isBotPaused) {
      console.warn("[TOPUP] Abort — exit/pause lock set mid-flight");
      return;
    }

    const preAdd = await snapshotWalletBalances();
    const addSigs: string[] = [];
    const addTx = await (dlmmPool as any).addLiquidityByStrategy({
      positionPubKey: activePositionPubkey,
      user: wallet.publicKey,
      totalXAmount: new BN(addSolLamports),
      totalYAmount: new BN(addUsdcRaw),
      strategy: {
        minBinId,
        maxBinId,
        strategyType: StrategyType.Spot,
      },
    });
    if (Array.isArray(addTx)) {
      for (const tx of addTx) addSigs.push(await sendAndConfirmTransaction(connection, tx, [wallet]));
    } else if (addTx) {
      addSigs.push(await sendAndConfirmTransaction(connection, addTx, [wallet]));
    }
    const postAdd = await snapshotWalletBalances();

    // Actual deposited = wallet decrease (SOL effective + USDC), fee-aware via meta when possible.
    let depositedSol = Math.max(0, preAdd.solEffectiveLamports - postAdd.solEffectiveLamports);
    let depositedUsdc = Math.max(0, preAdd.usdcRaw - postAdd.usdcRaw);
    let addFee = 0;
    let addActual = false;
    for (const sig of addSigs) {
      const d = await fetchTxWalletDeltas(sig);
      if (d.ok) {
        addActual = true;
        addFee += d.feeLamports ?? 0;
        // Prefer meta: SOL spent ≈ -(solEffectiveDelta) - fee (fee is not liquidity)
        const solSpent = Math.max(0, -(d.solEffectiveDelta) - (d.feeLamports ?? 0));
        const usdcSpent = Math.max(0, -(d.usdcRawDelta));
        if (solSpent > 0) depositedSol = solSpent;
        if (usdcSpent > 0) depositedUsdc = usdcSpent;
      }
    }
    if (addFee > 0) cumulativeGasSol += addFee / 1e9;
    // Snapshot path includes fee in SOL decrease — subtract fee if we know it
    if (!addActual && addFee === 0) {
      // leave snapshot deltas as-is; mark estimate
    } else if (!addActual) {
      depositedSol = Math.max(0, depositedSol - addFee);
    }

    lastTopupAt = now;
    const addedUsd = (depositedSol / 1e9) * spotPriceUsd + depositedUsdc / 1e6;
    deployedCapitalBaselineUsd = Number((deployedCapitalBaselineUsd + addedUsd).toFixed(2));
    await notify(
      `➕ <b>[TOP-UP]</b> Added ~$${addedUsd.toFixed(2)} idle capital to <code>${activePositionPubkey.toBase58()}</code>\n` +
      `• SOL: ${(depositedSol / 1e9).toFixed(4)} | USDC: $${(depositedUsdc / 1e6).toFixed(2)}`
    );
    await emitLedger({
      event: "TOPUP",
      regime: config.regime,
      spot_usd: spotPriceUsd,
      position_value_usd: addedUsd,
      wallet_value_usd: idleUsd - addedUsd,
      gas_fee_sol: addFee > 0 ? addFee / 1e9 : undefined,
      tx_sig: addSigs.join(",") || undefined,
      notes: `Top-up $${addedUsd.toFixed(2)} (SOL=${(depositedSol / 1e9).toFixed(6)} USDC=${(depositedUsdc / 1e6).toFixed(6)})`,
      is_estimate: !addActual,
    });
  } catch (err: any) {
    console.error("[TOPUP ERROR]:", err?.message || err);
    void emitLedger({ event: "ERROR", notes: `Top-up failed: ${err?.message || err}`, is_estimate: true });
  } finally {
    isDeploying = false;
  }
}

// ==================== GATE 4: POSITION DEPLOYMENT ====================
async function deployAsymmetricPosition(dlmmPool: DLMM) {
  if (isDeploying || isBotPaused || isExiting || isLiquidating) return;
  isDeploying = true;

  try {
    await dlmmPool.refetchStates();
    const activeBin = await dlmmPool.getActiveBin();
    const spotPriceUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;
    const config = await macroSentinel.evaluateRegime(SOL_USDC_POOL.toBase58());

    // Unwrap any stranded WSOL back to native SOL first. The Meteora SDK wraps
    // totalXAmount from NATIVE lamports itself (and unwraps leftovers afterwards),
    // so SOL must sit in the native balance, not in the WSOL ATA.
    const botWsolAta = await getAssociatedTokenAddress(WSOL_MINT, wallet.publicKey);
    try {
      const wsolAcc = await getAccount(connection, botWsolAta);
      if (wsolAcc) {
        const unwrapTx = new Transaction().add(
          createCloseAccountInstruction(botWsolAta, wallet.publicKey, wallet.publicKey)
        );
        await sendAndConfirmTransaction(connection, unwrapTx, [wallet]);
        console.log(`[WSOL] Unwrapped ${(Number(wsolAcc.amount) / 1e9).toFixed(4)} WSOL to native SOL.`);
      }
    } catch {}

    const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    let usdcBalanceUnits = 0;
    try {
      const acc = await getAccount(connection, botUsdcAta);
      usdcBalanceUnits = Number(acc.amount) / 1e6;
    } catch {}

    // Idle capital = USDC + native SOL above gas reserve (WSOL already unwrapped above).
    const preSolBal = await connection.getBalance(wallet.publicKey);
    const existingSolUsd = (Math.max(0, preSolBal - GAS_RESERVE_LAMPORTS) / 1e9) * spotPriceUsd;
    const totalWorkingCapital = usdcBalanceUnits + existingSolUsd;
    // DEPLOY_PCT overrides regime capitalDeployPct (default 1.0 = deploy ~100% idle).
    const targetDeployCapital = totalWorkingCapital * DEPLOY_PCT;

    const totalBins = Math.max(1, config.bidBins + config.askBins);
    const askRatio = config.askBins / totalBins;
    const bidRatio = config.bidBins / totalBins;
    const targetAskUsd = targetDeployCapital * askRatio;
    const targetBidUsdcUsd = targetDeployCapital * bidRatio;

    // Net inventory rebalance: swap only the difference, either direction.
    let swapSig = "";
    const solSurplusUsd = existingSolUsd - targetAskUsd; // >0 means too much SOL
    if (solSurplusUsd > MIN_SWAP_USD) {
      const sellLamports = Math.floor((solSurplusUsd / spotPriceUsd) * 1e9);
      await notify(`🔄 Rebalancing $${solSurplusUsd.toFixed(2)} SOL → USDC for bid inventory...`);
      const _swap = await executeJupiterSwap(WSOL_MINT, USDC_MINT, sellLamports.toString(), spotPriceUsd);
      swapSig = _swap.sig;
      if (!swapSig) throw new Error("Jupiter SOL→USDC rebalance failed. Aborting deployment.");
    } else if (-solSurplusUsd > MIN_SWAP_USD) {
      const buyUsd = Math.min(usdcBalanceUnits, -solSurplusUsd);
      if (buyUsd > MIN_SWAP_USD) {
        await notify(`🔄 Rebalancing $${buyUsd.toFixed(2)} USDC → SOL for ask inventory...`);
        const _swap = await executeJupiterSwap(USDC_MINT, WSOL_MINT, Math.floor(buyUsd * 1e6).toString(), spotPriceUsd);
        swapSig = _swap.sig;
        if (!swapSig) throw new Error("Jupiter USDC→SOL rebalance failed. Aborting deployment.");
      }
    }

    const solBal = await connection.getBalance(wallet.publicKey);
    if (solBal < GAS_RESERVE_LAMPORTS + 5_000_000) {
      throw new Error(`SOL ${(solBal / 1e9).toFixed(4)} below gas reserve after rebalance — refusing deploy`);
    }
    const targetAskLamports = Math.floor((targetAskUsd / spotPriceUsd) * 1e9);
    const usableSolLamports = Math.max(0, Math.min(solBal - GAS_RESERVE_LAMPORTS, targetAskLamports));
    // NOTE: no manual WSOL wrap — SDK wraps totalXAmount from native SOL.
    if (usableSolLamports <= 0 && targetAskUsd > MIN_SWAP_USD) {
      throw new Error("No SOL above gas reserve available for ask inventory");
    }

    const activeBinIdNum = Number(activeBin.binId);
    const clamped = clampBinRange(activeBinIdNum, config.bidBins, config.askBins);
    const minBinId = clamped.minBinId;
    const maxBinId = clamped.maxBinId;
    const newPositionKeypair = Keypair.generate();

    const postSwapUsdcAcc = await getAccount(connection, botUsdcAta);
    const availableUsdcUnits = Number(postSwapUsdcAcc.amount) / 1e6;
    const finalBidUsdcUnits = Math.min(availableUsdcUnits, targetBidUsdcUsd);
    const usableUsdcRaw = Math.floor(finalBidUsdcUnits * 1e6);

    if (!(await ensureGasReserve(5_000_000))) {
      throw new Error("SOL below gas reserve — refusing position create");
    }
    // Re-check exit locks: a CB/TP/emergency may have started after we passed the entry guard.
    if (isExiting || isLiquidating || isBotPaused) {
      throw new Error("Abort deploy — exit/pause lock set mid-flight");
    }

    const preDeploy = await snapshotWalletBalances();
    const deploySigs: string[] = [];
    const createPositionTx = await (dlmmPool as any).initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPositionKeypair.publicKey,
      user: wallet.publicKey,
      totalXAmount: new BN(usableSolLamports),
      totalYAmount: new BN(usableUsdcRaw),
      strategy: {
        maxBinId,
        minBinId,
        strategyType: StrategyType.Spot,
      },
    });

    if (Array.isArray(createPositionTx)) {
      for (const tx of createPositionTx) {
        deploySigs.push(await sendAndConfirmTransaction(connection, tx, [wallet, newPositionKeypair]));
      }
    } else {
      deploySigs.push(await sendAndConfirmTransaction(connection, createPositionTx, [wallet, newPositionKeypair]));
    }
    const postDeploy = await snapshotWalletBalances();

    let depositedSol = Math.max(0, preDeploy.solEffectiveLamports - postDeploy.solEffectiveLamports);
    let depositedUsdc = Math.max(0, preDeploy.usdcRaw - postDeploy.usdcRaw);
    let deployFee = 0;
    let deployActual = false;
    for (const sig of deploySigs) {
      const d = await fetchTxWalletDeltas(sig);
      if (d.ok) {
        deployActual = true;
        deployFee += d.feeLamports ?? 0;
        const solSpent = Math.max(0, -(d.solEffectiveDelta) - (d.feeLamports ?? 0));
        const usdcSpent = Math.max(0, -(d.usdcRawDelta));
        // Sum across multi-tx creates
        if (solSpent > 0 || usdcSpent > 0) {
          // first meta wins for single-tx; for multi-tx accumulate from snapshot instead
        }
      }
    }
    if (deploySigs.length > 1 || !deployActual) {
      // Multi-tx or meta miss: use full pre/post snapshot (includes fees in SOL leg)
      depositedSol = Math.max(0, preDeploy.solEffectiveLamports - postDeploy.solEffectiveLamports - deployFee);
      depositedUsdc = Math.max(0, preDeploy.usdcRaw - postDeploy.usdcRaw);
      if (!deployActual) deployActual = false;
      else {
        // snapshot with known fee → treat as actual for sheet purposes
        deployActual = true;
      }
    } else if (deployActual && deploySigs.length === 1) {
      const d = await fetchTxWalletDeltas(deploySigs[0]);
      depositedSol = Math.max(0, -(d.solEffectiveDelta) - (d.feeLamports ?? 0));
      depositedUsdc = Math.max(0, -(d.usdcRawDelta));
    }
    if (deployFee > 0) cumulativeGasSol += deployFee / 1e9;

    // Post-deploy must still hold the gas reserve
    if (postDeploy.nativeLamports < GAS_RESERVE_LAMPORTS) {
      console.warn(
        `[DEPLOY] WARNING: native SOL ${(postDeploy.nativeLamports / 1e9).toFixed(4)} < reserve after open — rent/fees ate into buffer`
      );
    }

    activePositionPubkey = newPositionKeypair.publicKey;
    lowestBinPrice = calculateBinPriceUsd(spotPriceUsd, activeBin.binId, minBinId, 10);
    highestBinPrice = calculateBinPriceUsd(spotPriceUsd, activeBin.binId, maxBinId, 10);
    belowRangeTickCount = 0;

    const deployedSolValueUsd = (depositedSol / 1e9) * spotPriceUsd;
    const deployedUsdcValueUsd = depositedUsdc / 1e6;
    // Fall back to intended amounts if deltas look empty (shouldn't happen)
    const baselineFallback = (usableSolLamports / 1e9) * spotPriceUsd + usableUsdcRaw / 1e6;
    deployedCapitalBaselineUsd = Number(
      ((depositedSol > 0 || depositedUsdc > 0) ? deployedSolValueUsd + deployedUsdcValueUsd : baselineFallback).toFixed(2)
    );
    if (entrySpotUsd > 0) {
      console.log(`[ENTRY] Recenter deploy: keeping original entry spot=$${entrySpotUsd.toFixed(2)} equity=$${entryEquityUsd.toFixed(2)}`);
    } else {
      await recordEntryAfterOpen(dlmmPool, spotPriceUsd, "deploy");
    }

    const allSigs = [swapSig, ...deploySigs].filter(Boolean).join(",") || "ON-CHAIN";
    await notify(
      `✅ <b>[GRID DEPLOYED - ${config.regime}]</b>\n` +
      `• Position: <code>${activePositionPubkey.toBase58()}</code>\n` +
      `• Spot / Entry: $${spotPriceUsd.toFixed(2)}\n` +
      `• Range: $${lowestBinPrice.toFixed(2)} ➔ $${highestBinPrice.toFixed(2)}\n` +
      `• Floor Stop: ${formatFloorStopLine(config.floorStopPct)}\n` +
      `• Baseline Capital: <b>$${deployedCapitalBaselineUsd.toFixed(2)} USDC</b>`
    );
    await emitLedger({
      event: "DEPLOY",
      regime: config.regime,
      spot_usd: spotPriceUsd,
      position_value_usd: deployedCapitalBaselineUsd,
      total_equity_usd: deployedCapitalBaselineUsd,
      gas_fee_sol: deployFee > 0 ? deployFee / 1e9 : undefined,
      tx_sig: allSigs,
      notes: `Grid deployed (${config.regime}) DEPLOY_PCT=${DEPLOY_PCT} SOL=${(depositedSol / 1e9).toFixed(6)} USDC=${(depositedUsdc / 1e6).toFixed(6)}`,
      is_estimate: !deployActual && !(depositedSol > 0 || depositedUsdc > 0),
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error("Deployment failed:", msg);
    const abortedForExit = /Abort deploy — exit\/pause lock/i.test(msg);
    if (!abortedForExit) {
      await notify(`⚠️ [DEPLOYMENT FAILED] ${msg}. Standing by.`);
      inCooldownUntil = Math.floor(Date.now() / 1000) + 600;
      void emitLedger({ event: "ERROR", notes: `Deploy failed: ${msg}`, is_estimate: true });
    } else {
      console.warn("[DEPLOY] Aborted cleanly for exit/pause lock (no cooldown).");
    }
  } finally {
    isDeploying = false;
  }
}

// ==================== MANUAL EMERGENCY EXIT ====================
async function executeFullEmergencyExit(dlmmPool: DLMM) {
  if (isExiting) {
    await notify("⏳ Emergency exit already in progress.");
    return;
  }
  isExiting = true;
  isLiquidating = true;
  isBotPaused = true;
  try {
  await notify("🚨 <b>[EMERGENCY EXIT INITIATED]</b> Closing all positions and liquidating to 100% USDC...");

  if (activePositionPubkey) {
    await sweepRevenueToVault(dlmmPool);
  }
  await closePositionAndReclaim(dlmmPool);

  const solBal = await connection.getBalance(wallet.publicKey);
  const dumpSolLamports = Math.floor(solBal - GAS_RESERVE_LAMPORTS);
  let swapSig = "";

  if (dumpSolLamports > 0.05 * 1e9) {
    const _swap = await executeJupiterSwap(WSOL_MINT, USDC_MINT, dumpSolLamports.toString());
    swapSig = _swap.sig;
  }

  const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
  let postLiquidationUsdc = 0;
  try {
    const accAfter = await getAccount(connection, botUsdcAta);
    postLiquidationUsdc = Number(accAfter.amount) / 1e6;
  } catch {}

  const realizedDrawdownUsd = Number((postLiquidationUsdc - deployedCapitalBaselineUsd).toFixed(2));
  const pnlSign = realizedDrawdownUsd >= 0 ? "+$" : "-$";

  activePositionPubkey = null;
  lowestBinPrice = 0;
  highestBinPrice = 0;
  clearEntryState();
  
  await dlmmPool.refetchStates();
  const activeBin = await dlmmPool.getActiveBin();
  lastExitPriceUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;

  await notify(
    `🛡️ <b>[EMERGENCY EXIT COMPLETE]</b> Bot is paused. Funds held in USDC.\n` +
    `• Recovered: $${postLiquidationUsdc.toFixed(2)}\n` +
    `• Net PnL: ${pnlSign}${Math.abs(realizedDrawdownUsd).toFixed(2)}\n` +
    `• Tx: <code>${swapSig || "N/A"}</code>`
  );
  await emitLedger({
    event: "EMERGENCY_EXIT",
    realized_pnl_usd: realizedDrawdownUsd,
    tx_sig: swapSig || "N/A",
    notes: `Manual Emergency Exit. Net PnL: ${pnlSign}${Math.abs(realizedDrawdownUsd).toFixed(2)}`,
    is_estimate: false,
  });
  
  deployedCapitalBaselineUsd = postLiquidationUsdc;
  } finally {
    isExiting = false;
    isLiquidating = false;
  }
}

// ==================== RESILIENT TELEGRAM COMMAND LISTENER ====================
async function listenTelegramCommands() {
  if (!TELEGRAM_BOT_TOKEN) return;

  let offset = 0;
  console.log("🤖 Telegram Interactive Command Listener active.");

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=15`;
      const response = await axios.get(url, { timeout: 20000 });
      const updates = response.data?.result || [];

      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || !msg.text) continue;

        const incomingChatId = String(msg.chat.id);
        if (TELEGRAM_CHAT_ID && incomingChatId !== TELEGRAM_CHAT_ID.trim()) continue;

        const text = msg.text.trim().toLowerCase();

        if (text === "/start" || text === "/help" || text === "help") {
          const helpMsg =
            `🛠 <b>DLMM Automated Keeper Commands</b>\n\n` +
            `• <b>/status</b> - Spot price, verified range, stops, and live 4-Gate breakdown\n` +
            `• <b>/regime</b> - Live Macro Sentinel regime, 200-SMA, and funding metrics\n` +
            `• <b>/balance</b> - Liquid balances & gas reserve safety check\n` +
            `• <b>/harvest</b> - Trigger an immediate swap-fee sweep to LP Revenue\n` +
            `• <b>/emergency_exit</b> - Pull liquidity, swap 100% to USDC, and pause\n` +
            `• <b>/pause</b> - Freeze automated redeployments\n` +
            `• <b>/resume</b> - Unpause bot and resume strategy loops`;
          await notify(helpMsg);
        } else if (text === "/regime") {
          await notify("🔍 Querying Macro Sentinel feeds...");
          const config = await macroSentinel.evaluateRegime(SOL_USDC_POOL.toBase58(), true);
          const rMsg =
            `🌐 <b>Macro Sentinel State</b>\n\n` +
            `• <b>Regime:</b> <code>${config.regime}</code> (Score: <b>${config.score}/100</b>)\n` +
            `• <b>SOL Spot:</b> $${config.details.solPrice.toFixed(2)} (200-SMA: $${config.details.sma200.toFixed(2)})\n` +
            `• <b>Trend:</b> ${config.details.solPrice > config.details.sma200 ? "🟢 Above 200-SMA" : "🔴 Below 200-SMA"}\n` +
            `• <b>Perp Funding:</b> ${config.details.fundingAnnual.toFixed(1)}% APR\n` +
            `• <b>Active Profile:</b> -${(config.bidBins * 0.1).toFixed(1)}% Bids / +${(config.askBins * 0.1).toFixed(1)}% Asks\n` +
            `• <b>Target Deploy:</b> ${(DEPLOY_PCT * 100).toFixed(0)}% (env DEPLOY_PCT; regime table kept for bins/stops)`;
          await notify(rMsg);
        } else if (text === "/emergency_exit") {
          if (dlmmPoolInstance) await executeFullEmergencyExit(dlmmPoolInstance);
        } else if (text === "/pause") {
          isBotPaused = true;
          await notify("⏸️ <b>[PAUSED]</b> Deployments frozen. Standing by in current state.");
        } else if (text === "/resume") {
          isBotPaused = false;
          inCooldownUntil = 0;
          await notify("▶️ <b>[RESUMED]</b> Keeper active. Re-centering liquidity grid...");
          if (dlmmPoolInstance && !activePositionPubkey) {
            await deployAsymmetricPosition(dlmmPoolInstance);
          }
        } else if (text === "/balance" || text === "balance" || text === "bal") {
          const rawSolBal = await connection.getBalance(wallet.publicKey);
          const solBal = (rawSolBal / 1e9).toFixed(4);

          let usdcBal = "0.00";
          try {
            const usdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
            const usdcAcc = await getAccount(connection, usdcAta);
            usdcBal = (Number(usdcAcc.amount) / 1e6).toFixed(2);
          } catch {}

          const balMsg =
            `💳 <b>LP Capital Wallet Overview</b>\n\n` +
            `• <b>Address:</b> <code>${wallet.publicKey.toBase58()}</code>\n` +
            `• <b>Liquid SOL:</b> ${solBal} SOL\n` +
            `• <b>Liquid USDC:</b> $${usdcBal} USDC\n` +
            `• <b>Tracked Baseline:</b> $${deployedCapitalBaselineUsd.toFixed(2)} USDC\n` +
            `• <b>Bot State:</b> ${isBotPaused ? "⏸️ PAUSED" : "🟢 ACTIVE"}\n` +
            `• <b>Gas Buffer:</b> ${gasBufferLabel(rawSolBal)}`;
          await notify(balMsg);
        } else if (text === "/status" || text === "status") {
          if (!dlmmPoolInstance) continue;

          await dlmmPoolInstance.refetchStates();
          const activeBin = await dlmmPoolInstance.getActiveBin();
          const currentPrice = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;
          const config = await macroSentinel.evaluateRegime(SOL_USDC_POOL.toBase58());

          const { userPositions } = await dlmmPoolInstance.getPositionsByUserAndLbPair(wallet.publicKey);
          const hasActivePosition = userPositions.length > 0;

          if (hasActivePosition) {
            const pos = userPositions.find((p: any) => activePositionPubkey && p.publicKey.equals(activePositionPubkey)) || userPositions[0];
            activePositionPubkey = pos.publicKey;
            lowestBinPrice = calculateBinPriceUsd(currentPrice, activeBin.binId, pos.positionData.lowerBinId, 10);
            highestBinPrice = calculateBinPriceUsd(currentPrice, activeBin.binId, pos.positionData.upperBinId, 10);
          } else {
            activePositionPubkey = null;
            lowestBinPrice = 0;
            highestBinPrice = 0;
          }

          const rangeDisplay = hasActivePosition
            ? `$${lowestBinPrice.toFixed(2)} ➔ $${highestBinPrice.toFixed(2)}`
            : "None (Liquidated to 100% USDC)";
          const stopDisplay = hasActivePosition ? formatFloorStopLine(config.floorStopPct) : "N/A";

          const nowSec = Math.floor(Date.now() / 1000);
          let gateTelemetry = "";

          if (isBotPaused) {
            gateTelemetry = "⏸️ <b>PAUSED:</b> Deployments frozen by operator.";
          } else if (hasActivePosition) {
            gateTelemetry = "🟢 <b>Active:</b> Monitoring open on-chain grid.";
          } else {
            const g1Remaining = Math.max(0, inCooldownUntil - nowSec);
            const g1Passed = g1Remaining === 0;

            // Gate 2: live variable-fee bps (NOT static variableFeeControl).
            const gate2 = getGate2VolatilityState(dlmmPoolInstance);
            const g2Passed = gate2.passed;

            let g3Passed = false;
            let g3Detail = "";
            const isVReclaim = lastExitPriceUsd > 0 && currentPrice >= (lastExitPriceUsd * 1.01);

            const klines = await fetchRecent15mKlines();
            if (klines && klines.length >= 3) {
              const low2 = parseFloat(klines[1][3].toString());
              const low3 = parseFloat(klines[2][3].toString());
              const minLow = Math.min(parseFloat(klines[0][3].toString()), low2, low3);
              const isConsolidating = (currentPrice > minLow) && (low3 >= low2);

              if (isConsolidating) {
                g3Passed = true;
                g3Detail = `Consolidation (L3: $${low3.toFixed(2)} >= L2: $${low2.toFixed(2)})`;
              } else if (isVReclaim) {
                g3Passed = true;
                g3Detail = `V-Reclaim (+${(((currentPrice - lastExitPriceUsd) / lastExitPriceUsd) * 100).toFixed(1)}%)`;
              } else {
                g3Detail = `Descending (L3: $${low3.toFixed(2)} < L2: $${low2.toFixed(2)})`;
              }
            } else {
              if (isVReclaim) {
                g3Passed = true;
                g3Detail = "V-Reclaim Active (API fallback)";
              } else {
                g3Detail = "Awaiting candle confirmation (API limited)";
              }
            }

            const g1Status = g1Passed ? "✅ Passed" : `⏳ Locked (${g1Remaining}s left)`;
            const g2Status = gate2.detail;
            const g3Status = g3Passed ? `✅ Passed (${g3Detail})` : `⏳ Blocked (${g3Detail})`;
            const g4Status = (g1Passed && g2Passed && g3Passed) ? "🚀 Armed (Deploying next tick)" : "⏳ Awaiting Gates 1-3";

            gateTelemetry =
              `🛡️ <b>Re-Entry Gate Radar (100% USDC):</b>\n` +
              `  • <b>Gate 1 (Time Lock):</b> ${g1Status}\n` +
              `  • <b>Gate 2 (Fee Volatility):</b> ${g2Status}\n` +
              `  • <b>Gate 3 (Price Structure):</b> ${g3Status}\n` +
              `  • <b>Gate 4 (Execution):</b> ${g4Status}`;
          }

          const statusMsg =
            `📊 <b>DLMM Keeper Status</b>\n\n` +
            `• <b>Regime:</b> <code>${config.regime}</code>\n` +
            `• <b>Spot:</b> $${currentPrice.toFixed(2)}\n` +
            `• <b>Exact On-Chain Range:</b> ${rangeDisplay}\n` +
            `• <b>Floor Stop:</b> ${stopDisplay}\n` +
            `• <b>Tracked Baseline:</b> $${deployedCapitalBaselineUsd.toFixed(2)}\n` +
            `• <b>Position NFT:</b> <code>${activePositionPubkey ? activePositionPubkey.toBase58() : "None (Holding Cash)"}</code>\n\n` +
            `${gateTelemetry}`;
          await notify(statusMsg);
        } else if (text === "/harvest" || text === "harvest" || text === "sweep") {
          if (!dlmmPoolInstance || !activePositionPubkey) {
            await notify("⚠️ Cannot harvest: No active open DLMM position detected.");
            continue;
          }
          await notify("⏳ Checking and sweeping fees to USDC...");
          const sweptAmount = await sweepRevenueToVault(dlmmPoolInstance);
          if (sweptAmount > 0) {
            await notify(`✅ Sweep complete: $${sweptAmount.toFixed(2)} USDC sent to LP Revenue.`);
          } else {
            await notify("ℹ️ No surplus fees available to sweep.");
          }
        }
      }
    } catch (err: any) {
      if (err.response?.status === 409) {
        // Common during Railway rolling deploys when old+new both poll getUpdates.
        console.error("❌ [TELEGRAM 409 CONFLICT] Duplicate bot instance detected. Backing off 30s...");
        await new Promise((resolve) => setTimeout(resolve, 30000));
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// ==================== MAIN LIFECYCLE CONTROLLER ====================
async function runKeeper() {
  await notify("🚀 DLMM Automated Keeper initialized on Railway.");
  void emitLedger({ event: "BOOT", notes: "Keeper process started", is_estimate: true });
  dlmmPoolInstance = await DLMM.create(connection, SOL_USDC_POOL);

  // Baseline: BASELINE_USD env, else live wallet equity (USDC + native SOL + WSOL ATA)*spot.
  try {
    if (BASELINE_USD_ENV && Number(BASELINE_USD_ENV) > 0) {
      deployedCapitalBaselineUsd = Number(BASELINE_USD_ENV);
    } else {
      const activeBin = await dlmmPoolInstance.getActiveBin();
      const spotUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;
      // Include open position inventory so boot baseline isn't understated while LPing.
      deployedCapitalBaselineUsd = await getMarkToMarketEquityUsd(dlmmPoolInstance, spotUsd);
    }
  } catch (err: any) {
    console.warn("[BASELINE] Equity probe failed:", err?.message || err);
    if (BASELINE_USD_ENV && Number(BASELINE_USD_ENV) > 0) {
      deployedCapitalBaselineUsd = Number(BASELINE_USD_ENV);
    } else {
      throw new Error("Unable to derive startup baseline. Set BASELINE_USD or ensure RPC + USDC ATA are reachable.");
    }
  }

  listenTelegramCommands().catch((e) => console.error("Command listener error:", e));

  const { userPositions } = await dlmmPoolInstance.getPositionsByUserAndLbPair(wallet.publicKey);
  const config = await macroSentinel.evaluateRegime(SOL_USDC_POOL.toBase58());

  if (userPositions.length > 0) {
    // Attach to existing on-chain position — do NOT open a second grid on restart/redeploy.
    const activePos = userPositions[0];
    activePositionPubkey = activePos.publicKey;

    const activeBin = await dlmmPoolInstance.getActiveBin();
    const spotPriceUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;

    lowestBinPrice = calculateBinPriceUsd(spotPriceUsd, activeBin.binId, activePos.positionData.lowerBinId, 10);
    highestBinPrice = calculateBinPriceUsd(spotPriceUsd, activeBin.binId, activePos.positionData.upperBinId, 10);
    belowRangeTickCount = 0;

    if (ENTRY_SPOT_USD_ENV && Number(ENTRY_SPOT_USD_ENV) > 0) {
      entrySpotUsd = Number(ENTRY_SPOT_USD_ENV);
    } else {
      entrySpotUsd = spotPriceUsd;
      console.warn(
        `[ENTRY] ENTRY_SPOT_USD unset on attach — using current spot $${spotPriceUsd.toFixed(2)} as entry (entry reset on restart).`
      );
    }
    if (ENTRY_EQUITY_USD_ENV && Number(ENTRY_EQUITY_USD_ENV) > 0) {
      entryEquityUsd = Number(ENTRY_EQUITY_USD_ENV);
    } else {
      entryEquityUsd = await getMarkToMarketEquityUsd(dlmmPoolInstance, spotPriceUsd);
      console.warn(
        `[ENTRY] ENTRY_EQUITY_USD unset on attach — using current MTM $${entryEquityUsd.toFixed(2)} as entry equity (entry reset on restart).`
      );
    }

    await notify(
      `🔗 <b>[ATTACHED TO LIVE ON-CHAIN POSITION]</b>\n` +
      `• Position: <code>${activePositionPubkey.toBase58()}</code>\n` +
      `• Regime: <code>${config.regime}</code>\n` +
      `• Spot: $${spotPriceUsd.toFixed(2)} (entry $${entrySpotUsd.toFixed(2)})\n` +
      `• Exact Range: $${lowestBinPrice.toFixed(2)} ➔ $${highestBinPrice.toFixed(2)}\n` +
      `• Floor Stop: ${formatFloorStopLine(config.floorStopPct)}\n` +
      `• Baseline Capital: $${deployedCapitalBaselineUsd.toFixed(2)}`
    );
    void emitLedger({
      event: "ATTACH",
      regime: config.regime,
      spot_usd: spotPriceUsd,
      total_equity_usd: deployedCapitalBaselineUsd,
      entry_spot: entrySpotUsd,
      entry_equity: entryEquityUsd,
      notes: `Attached to ${activePositionPubkey.toBase58()}`,
      is_estimate: false,
    });
  } else {
    // STANDBY IN CASH: Do NOT deploy blindly on boot
    lowestBinPrice = 0;
    highestBinPrice = 0;
    activePositionPubkey = null;
    clearEntryState();
    const activeBin = await dlmmPoolInstance.getActiveBin();
    lastExitPriceUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR; // Anchor price to prevent premature Gate 3 bypass
    await notify(`🟢 <b>[BOOTED IN 100% USDC]</b> Baseline: $${deployedCapitalBaselineUsd.toFixed(2)}. Standing by for Gate 1-3 clearance.`);
  }

  // Master Strategy Polling Loop (Every 15s)
  setInterval(async () => {
    // Skip overlapping ticks — setInterval does not await the previous callback.
    if (keeperTickRunning) return;
    keeperTickRunning = true;
    try {
      if (isBotPaused || isExiting) return;

      const now = Math.floor(Date.now() / 1000);
      if (now < inCooldownUntil) return;

      await dlmmPoolInstance!.refetchStates();
      const activeBin = await dlmmPoolInstance!.getActiveBin();
      const currentPrice = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;

      const currentConfig = await macroSentinel.evaluateRegime(SOL_USDC_POOL.toBase58());

      if (now - lastSweepTime > 86400) {
        await sweepRevenueToVault(dlmmPoolInstance!);
        lastSweepTime = now;
      }

      // Idle top-up AFTER sweep so we do not absorb USDC about to be sent to revenue wallet.
      if (activePositionPubkey) {
        await topUpExistingPosition(dlmmPoolInstance!);
      }

      if (now - lastSnapshotAt >= SNAPSHOT_INTERVAL_SEC) {
        lastSnapshotAt = now;
        try {
          const mtm = await getMarkToMarketEquityUsd(dlmmPoolInstance!, currentPrice);
          const walletEq = await getWalletLiquidEquityUsd(currentPrice);
          let posUsd = Math.max(0, mtm - walletEq.totalUsd);
          const uPnL = entryEquityUsd > 0 ? mtm - entryEquityUsd : 0;
          await emitLedger({
            event: "SNAPSHOT",
            regime: currentConfig.regime,
            spot_usd: currentPrice,
            position_value_usd: posUsd,
            wallet_value_usd: walletEq.totalUsd,
            total_equity_usd: mtm,
            unrealized_pnl_usd: uPnL,
            cumulative_fees_usd: cumulativeFeesUsd,
            notes: "Periodic equity snapshot",
            is_estimate: false,
          });
        } catch (snapErr: any) {
          console.warn("[SNAPSHOT]", snapErr?.message || snapErr);
        }
      }

      // Re-entry evaluation if parked in 100% USDC
      if (!activePositionPubkey) {
        // Gate 2: live variable-fee bps from volatilityAccumulator (see getGate2VolatilityState).
        const gate2 = getGate2VolatilityState(dlmmPoolInstance!);
        if (gate2.passed) {
          let isConsolidating = false;
          let isVReclaim = lastExitPriceUsd > 0 && currentPrice >= (lastExitPriceUsd * 1.01);
          
          const klines = await fetchRecent15mKlines();
          if (klines && klines.length >= 3) {
            const low1 = parseFloat(klines[0][3].toString());
            const low2 = parseFloat(klines[1][3].toString());
            const low3 = parseFloat(klines[2][3].toString());
            const minLow = Math.min(low1, low2, low3);
            isConsolidating = (currentPrice > minLow) && (low3 >= low2);
          }

          // Gate 3: Require consolidation base or confirmed V-reclaim
          if (isConsolidating || isVReclaim) {
            await notify(`✅ <b>[GATE 3 CLEARED]</b> ${gate2.detail}. Price base confirmed. Re-centering grid...`);
            await deployAsymmetricPosition(dlmmPoolInstance!);
          }
        }
        return;
      }

      // ---- Hard stops: measured from ENTRY (not range bottom) ----
      const priceStop = priceStopFromEntry(currentConfig.floorStopPct);
      const equityStop = equityStopFromEntry();
      let liveEquityUsd = 0;
      let equityStopHit = false;
      if (equityStop > 0 && activePositionPubkey) {
        try {
          liveEquityUsd = await getMarkToMarketEquityUsd(dlmmPoolInstance!, currentPrice);
          equityStopHit = liveEquityUsd <= equityStop;
        } catch (eqErr: any) {
          console.warn("[STOP] equity MTM failed:", eqErr?.message || eqErr);
        }
      }
      const priceStopHit = entrySpotUsd > 0 && priceStop > 0 && currentPrice <= priceStop;

      if (priceStopHit || equityStopHit) {
        // Atomic in-flight lock: set BEFORE any await to stop double-trigger races.
        if (isLiquidating || isExiting || isDeploying || now < inCooldownUntil) return;
        isLiquidating = true;
        isExiting = true;

        inCooldownUntil = now + currentConfig.cooldownSec;
        const targetPos = activePositionPubkey;
        activePositionPubkey = null;
        lowestBinPrice = 0;
        highestBinPrice = 0;
        belowRangeTickCount = 0;

        const stopReason = priceStopHit
          ? `spot $${currentPrice.toFixed(2)} ≤ entry stop $${priceStop.toFixed(2)} (−${(currentConfig.floorStopPct * 100).toFixed(1)}% vs entry $${entrySpotUsd.toFixed(2)})`
          : `equity $${liveEquityUsd.toFixed(2)} ≤ $${equityStop.toFixed(2)} (−${(MAX_DRAWDOWN_PCT * 100).toFixed(1)}% vs entry equity $${entryEquityUsd.toFixed(2)})`;

        try {
          await notify(
            `🚨 <b>[CIRCUIT BREAKER TRIGGERED]</b> ${stopReason}\n` +
            `• Closing position and liquidating inventory to 100% USDC...`
          );

          if (dlmmPoolInstance && targetPos) {
            try {
              await sweepRevenueToVault(dlmmPoolInstance);
            } catch (sweepErr: any) {
              console.warn("Pre-close fee sweep note:", sweepErr.message);
            }
          }

          if (dlmmPoolInstance) {
            await closePositionAndReclaim(dlmmPoolInstance);
          }

          const solBal = await connection.getBalance(wallet.publicKey);
          const dumpSolLamports = Math.floor(solBal - GAS_RESERVE_LAMPORTS);
          let swapSig = "";

          if (dumpSolLamports > 0.05 * 1e9) {
            try {
              const _swap = await executeJupiterSwap(WSOL_MINT, USDC_MINT, dumpSolLamports.toString());
    swapSig = _swap.sig;
            } catch (swapErr: any) {
              console.error("Emergency Jupiter swap note:", swapErr.message);
            }
          }

          const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
          let postLiquidationUsdc = 0;
          try {
            const accAfter = await getAccount(connection, botUsdcAta);
            postLiquidationUsdc = Number(accAfter.amount) / 1e6;
          } catch {}

          const realizedDrawdownUsd = Number((postLiquidationUsdc - deployedCapitalBaselineUsd).toFixed(2));
          const drawdownPct = deployedCapitalBaselineUsd > 0
            ? ((realizedDrawdownUsd / deployedCapitalBaselineUsd) * 100).toFixed(2)
            : "0.00";

          lastExitPriceUsd = currentPrice;
          clearEntryState();

          await notify(
            `🛡️ <b>[CIRCUIT BREAKER COMPLETE]</b>\n` +
            `• Liquidated Balance: <b>$${postLiquidationUsdc.toFixed(2)} USDC</b>\n` +
            `• Realized Drawdown: <b>-$${Math.abs(realizedDrawdownUsd).toFixed(2)} (${drawdownPct}%)</b>\n` +
            `• Cooldown: Locked for ${currentConfig.cooldownSec / 60} minutes\n` +
            `• Swap Tx: <code>${swapSig || "N/A"}</code>`
          );

          await emitLedger({
            event: "CIRCUIT_BREAKER",
            spot_usd: currentPrice,
            realized_pnl_usd: realizedDrawdownUsd,
            total_equity_usd: postLiquidationUsdc,
            tx_sig: swapSig || "N/A",
            notes: `Stop: ${stopReason}. Ending USDC: $${postLiquidationUsdc.toFixed(2)} (${drawdownPct}%)`,
            is_estimate: false,
          });

          deployedCapitalBaselineUsd = postLiquidationUsdc;
        } finally {
          isLiquidating = false;
          isExiting = false;
        }
        return;
      }

      // ---- Soft recenter: below range for N ticks (NO SOL→USDC dump) ----
      if (lowestBinPrice > 0 && currentPrice < lowestBinPrice) {
        belowRangeTickCount += 1;
      } else {
        belowRangeTickCount = 0;
      }

      if (
        belowRangeTickCount >= BELOW_RANGE_TICKS &&
        !isExiting &&
        !isLiquidating &&
        !isDeploying &&
        now >= lastRecenterAt + RECENTER_COOLDOWN_SEC
      ) {
        isExiting = true;
        try {
          await notify(
            `↩️ <b>[BELOW-RANGE RECENTER]</b> Spot $${currentPrice.toFixed(2)} < range floor $${lowestBinPrice.toFixed(2)} ` +
            `for ${belowRangeTickCount} ticks. Closing & redeploying around spot (keeping SOL — no dump)...`
          );
          void emitLedger({
            event: "RECENTER",
            spot_usd: currentPrice,
            notes: `Below-range soft recenter after ${belowRangeTickCount} ticks (no SOL dump)`,
            is_estimate: true,
          });
          try {
            await sweepRevenueToVault(dlmmPoolInstance!);
          } catch (sweepErr: any) {
            console.warn("Below-range fee sweep note:", sweepErr.message);
          }
          await closePositionAndReclaim(dlmmPoolInstance!);
          activePositionPubkey = null;
          lowestBinPrice = 0;
          highestBinPrice = 0;
          // Keep the ORIGINAL entry spot/equity across recenters so the hard stop
          // cannot ratchet down with each recenter in a downtrend.
          lastRecenterAt = now;
          belowRangeTickCount = 0;
          // Release the exit lock first: deployAsymmetricPosition() bails out while isExiting is true.
          isExiting = false;
          // Redeploy reuses native SOL via deployAsymmetricPosition SOL-aware path (no forced USDC dump).
          await deployAsymmetricPosition(dlmmPoolInstance!);
        } finally {
          isExiting = false;
        }
        return;
      }

      // Take-Profit Upper Bound Recycling
      if (highestBinPrice > 0 && currentPrice >= highestBinPrice) {
        if (isExiting || isLiquidating || isDeploying) return;
        if (now < lastRecenterAt + RECENTER_COOLDOWN_SEC) return;
        isExiting = true;
        try {
        await notify(`🎯 <b>[TAKE-PROFIT]</b> Price ($${currentPrice.toFixed(2)}) cleared upper bins! Sweeping fees and unwinding...`);
        
        await sweepRevenueToVault(dlmmPoolInstance!);
        await closePositionAndReclaim(dlmmPoolInstance!);
        
        const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
        let postTpUsdc = 0;
        try {
          const acc = await getAccount(connection, botUsdcAta);
          postTpUsdc = Number(acc.amount) / 1e6;
        } catch {}

        const realizedGainUsd = Number((postTpUsdc - deployedCapitalBaselineUsd).toFixed(2));
        const pnlSign = realizedGainUsd >= 0 ? "+$" : "-$";
        const gainPct = deployedCapitalBaselineUsd > 0 ? ((realizedGainUsd / deployedCapitalBaselineUsd) * 100).toFixed(2) : "0.00";
        
        lastExitPriceUsd = currentPrice;

        await notify(
          `📈 <b>[REBALANCING GRID]</b>\n` +
          `• Capital Returned: $${postTpUsdc.toFixed(2)}\n` +
          `• Net PnL: ${pnlSign}${Math.abs(realizedGainUsd).toFixed(2)} (${realizedGainUsd >= 0 ? "+" : ""}${gainPct}%)\n` +
          `Recycling grid higher...`
        );
        
        if (realizedGainUsd !== 0) {
          await emitLedger({
            event: "TAKE_PROFIT",
            spot_usd: currentPrice,
            realized_pnl_usd: realizedGainUsd,
            notes: `Grid cleared upper bound at $${currentPrice.toFixed(2)}. Net PnL: ${pnlSign}${Math.abs(realizedGainUsd).toFixed(2)}`,
            is_estimate: true,
          });
        }

        activePositionPubkey = null;
        lowestBinPrice = 0;
        highestBinPrice = 0;
        clearEntryState();
        lastRecenterAt = now;
        // Release the exit lock first: deployAsymmetricPosition() bails out while isExiting is true.
        isExiting = false;
        await deployAsymmetricPosition(dlmmPoolInstance!);
        } finally {
          isExiting = false;
        }
      }
    } catch (err: any) {
      console.error("[Keeper Loop Error]:", err.message);
    } finally {
      keeperTickRunning = false;
    }
  }, 15000);
}

runKeeper().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
