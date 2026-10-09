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
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { randomInt } from "crypto";
import { BN } from "@coral-xyz/anchor";
import bs58 from "bs58";
import axios from "axios";
import dotenv from "dotenv";
import {
  RegimeSentinel,
  REGIME_PROFILES,
  DEFAULT_REGIME,
  EntryStopLock,
  MarketRegime,
  lockFromRegime,
  resolveAttachStopLock,
  priceStopFromLock,
  entryPinLine,
} from "./regime";
import {
  positionHasLiquidity,
  calculateBinPriceUsd,
  resolveRangeBins,
  ResolvedRange,
  gate2ThresholdBps,
  volatilityMovePct,
  sanitizeInstanceLabel,
  withInstancePrefix,
  parseBoolEnv,
  parseOptionalInt,
  KNOWN_SOL_USDC_POOLS,
  DEFAULT_POOL_ADDRESS,
} from "./multipool";
import {
  MEMO_PROGRAM_ID,
  LandedStatus,
  SweepMemo,
  buildSweepMemo,
  decideCatchup,
  feeClaimLedgerFields,
  parseSweepTx,
  resolveLanded,
  solSweepLamports,
} from "./feesweep";
import {
  ATA_RENT_LAMPORTS,
  TRANSFER_OUT_CONFIRM_TTL_MS,
  TRANSFER_OUT_FEATURE_EPOCH_UNIX,
  TransferConfirmations,
  TransferOutHistory,
  TransferRequest,
  addToHistory,
  applyTransferOut,
  baselineWithTransfersOut,
  buildTransferOutMemo,
  checkTransferPreconditions,
  effectivePinnedEntryEquity,
  emptyTransferOutHistory,
  parseConfirmCommand,
  parseTransferAllowlist,
  parseTransferOutCommand,
  parseTransferOutTx,
  parseUserIds,
  planTransferOut,
  resolveMaxEquityPct,
  resolveMaxUsd,
  revalidateQuotedPlan,
  signatureHasTransferOutMemo,
} from "./transferout";

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
// ---- Capital baseline for P&L reporting (NOT used by any stop / trading decision) ----
// The baseline is capital CONTRIBUTED to the LP wallet. Internal moves (top-ups, deploys,
// recenters, swaps, wrap/unwrap, closes) never change it. Fee sweeps to the revenue wallet
// are tracked separately and added back, so they never show up as a loss.
//   P&L = live equity + swept to revenue − (STARTING_CAPITAL_USD + NET_DEPOSITS_USD)
// STARTING_CAPITAL_USD: authoritative starting capital (USD). BASELINE_USD is a legacy alias.
// If neither is set, falls back to mark-to-market equity at boot (P&L is then "since boot").
function parseOptionalUsd(key: string, allowNegative = false): number | null {
  const raw = process.env[key]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || (!allowNegative && n < 0)) {
    console.warn(`[CONFIG] Ignoring invalid ${key}=${JSON.stringify(raw)} (expected a ${allowNegative ? "" : "non-negative "}number)`);
    return null;
  }
  return n;
}
const STARTING_CAPITAL_USD_ENV = (() => {
  const v = parseOptionalUsd("STARTING_CAPITAL_USD");
  if (v != null && v > 0) return v;
  const legacy = parseOptionalUsd("BASELINE_USD");
  return legacy != null && legacy > 0 ? legacy : null;
})();
// Net external capital flows AFTER the starting capital: deposits − withdrawals (may be negative).
// Fee sweeps to REVENUE_WALLET_PUBKEY are NOT withdrawals — do not include them here.
const NET_DEPOSITS_USD = parseOptionalUsd("NET_DEPOSITS_USD", true) ?? 0;
// FALLBACK for USD already swept to the revenue wallet before this boot. The bot now derives this
// on-chain at boot (sum of LP-wallet → revenue-ATA USDC transfers); this env is used only if that
// scan fails or is incomplete. Only applied when STARTING_CAPITAL_USD/BASELINE_USD is set.
const PRIOR_SWEPT_USD = parseOptionalUsd("PRIOR_SWEPT_USD") ?? 0;

// ---- Fee-sweep schedule (survives restarts) ----
const SWEEP_INTERVAL_SEC = Math.max(3600, Number(process.env.SWEEP_INTERVAL_SEC ?? 86400));
// When a due sweep moves nothing (no/low fees, gas reserve, error), retry after this long instead of every tick.
const SWEEP_RETRY_SEC = Math.max(300, Number(process.env.SWEEP_RETRY_SEC ?? 3600));
// Fallback last-sweep time (unix seconds) if the on-chain lookup finds nothing or fails.
const LAST_SWEEP_UNIX_ENV = (() => {
  const v = parseOptionalUsd("LAST_SWEEP_UNIX");
  return v != null && v > 1_600_000_000 ? Math.floor(v) : null;
})();
// Max signatures scanned (each) on the revenue USDC ATA and the revenue wallet at boot.
const SWEEP_SCAN_MAX_SIGS = Math.max(100, Number(process.env.SWEEP_SCAN_MAX_SIGS ?? 2000));

// ---- Pool / instance (multi-pool) ----
// POOL_ADDRESS: Meteora SOL-USDC DLMM pool to LP in. Default = the original 10 bps pool, so an unset env
// keeps the existing bot unchanged. The bin step is read from the pool at boot (lbPair.binStep).
const POOL_ADDRESS = process.env.POOL_ADDRESS?.trim() || DEFAULT_POOL_ADDRESS;
const SOL_USDC_POOL = (() => {
  try {
    return new PublicKey(POOL_ADDRESS);
  } catch {
    throw new Error(`POOL_ADDRESS is not a valid public key: ${JSON.stringify(POOL_ADDRESS)}`);
  }
})();
/** Pool bin step (bps). Label-only guess until boot reads lbPair.binStep (authoritative). */
let poolBinStep = KNOWN_SOL_USDC_POOLS[POOL_ADDRESS]?.binStep ?? 0;
function poolName(): string {
  return poolBinStep > 0 ? `SOL-USDC ${poolBinStep}bps` : "SOL-USDC";
}
// INSTANCE_LABEL (alias BOT_NAME): tags Telegram messages and ledger rows so two bots can share a chat
// and a sheet. Unset = no prefix and an empty `instance` column (the original bot's rows/messages).
const INSTANCE_LABEL = sanitizeInstanceLabel(process.env.INSTANCE_LABEL || process.env.BOT_NAME);
// TELEGRAM_COMMANDS_ENABLED=false: send notifications only, never poll getUpdates. Use it on a second
// instance that shares the first one's TELEGRAM_BOT_TOKEN (two pollers on one token → HTTP 409).
const TELEGRAM_COMMANDS_ENABLED = parseBoolEnv(process.env.TELEGRAM_COMMANDS_ENABLED, true);
// Range overrides for NEW positions (this pool's bins). Unset = regime profile, converted from 10 bps bins
// to the same price width on this pool's bin step, clamped to the 70-bin position limit.
const BID_BINS_ENV = parseOptionalInt(process.env.BID_BINS);
const ASK_BINS_ENV = parseOptionalInt(process.env.ASK_BINS);
const RANGE_WIDTH_PCT_ENV = (() => {
  const v = parseOptionalUsd("RANGE_WIDTH_PCT");
  return v != null && v > 0 ? v : null;
})();
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

// ---- Claimed fee SOL handling (sweepRevenueToVault) ----
// After a claim the fee SOL is swapped to USDC via Jupiter (FEE_SOL_SWAP_ATTEMPTS attempts; a retry only
// happens once the previous signature is proven NOT to have landed). If the swap fails or is skipped
// (gas gate, too small), the claimed SOL is sent natively to REVENUE_WALLET_PUBKEY instead — never taking
// the LP wallet below GAS_RESERVE_LAMPORTS + FEE_SOL_SWEEP_MARGIN_LAMPORTS (+ tx fee).
const FEE_SOL_SWAP_ATTEMPTS = Math.min(3, Math.max(1, Number(process.env.FEE_SOL_SWAP_ATTEMPTS ?? 2)));
const FEE_SOL_SWAP_MIN_LAMPORTS = Math.max(0, Number(process.env.FEE_SOL_SWAP_MIN_LAMPORTS ?? 5_000_000)); // 0.005 SOL
const FEE_SOL_SWEEP_MIN_LAMPORTS = Math.max(100_000, Number(process.env.FEE_SOL_SWEEP_MIN_LAMPORTS ?? 1_000_000)); // 0.001 SOL
const FEE_SOL_SWEEP_MARGIN_LAMPORTS = Math.max(0, Number(process.env.FEE_SOL_SWEEP_MARGIN_LAMPORTS ?? 5_000_000)); // 0.005 SOL
/** Budget for the native transfer's own fee (base 5000 + small priority headroom). */
const SOL_TRANSFER_FEE_LAMPORTS = 10_000;
// ---- One-time catch-up sweep of fee SOL left in the LP wallet (e.g. Oct 9 2026: 0.017390554 SOL) ----
// Runs once, CATCHUP_SOL_SWEEP_DELAY_SEC after boot (≥120s so any tx sent by a previous process has either
// landed or expired before the guard scan). Guard: the transfer carries an on-chain memo
// "dlmm-keeper:catchup-sol-sweep id=<CATCHUP_SOL_SWEEP_ID> …"; if a tx from the LP wallet with that memo
// already exists on the revenue wallet, nothing is sent. Fails closed if the scan fails or is incomplete.
const CATCHUP_SOL_SWEEP_LAMPORTS = Math.max(0, Math.floor(Number(process.env.CATCHUP_SOL_SWEEP_LAMPORTS ?? 0) || 0));
const CATCHUP_SOL_SWEEP_ID = (process.env.CATCHUP_SOL_SWEEP_ID?.trim() || "2026-10-09").replace(/[^A-Za-z0-9_.\-]/g, "").slice(0, 32);
// Hard ceiling 0.1 SOL regardless of env (typo guard); default cap 0.05 SOL.
const CATCHUP_SOL_SWEEP_MAX_LAMPORTS = Math.min(100_000_000, Math.max(0, Number(process.env.CATCHUP_SOL_SWEEP_MAX_LAMPORTS ?? 50_000_000)));
const CATCHUP_SOL_SWEEP_DELAY_SEC = Math.max(120, Number(process.env.CATCHUP_SOL_SWEEP_DELAY_SEC ?? 180));

// Gate 2: max allowed *variable* fee in basis points before re-entry is blocked.
// (Not variableFeeControl — that is a static pool config constant, often ~40000.)
// Unset = 15 bps on the 10 bps pool, scaled by the pool's variableFeeControl elsewhere (same volatility
// tolerance on any bin step — see gate2ThresholdBps in multipool.ts).
const GATE2_MAX_VARIABLE_FEE_BPS_ENV = parseOptionalUsd("GATE2_MAX_VARIABLE_FEE_BPS");

// Hard stop: max drawdown on mark-to-market equity vs entry (fraction, e.g. 0.05 = 5%).
const MAX_DRAWDOWN_PCT = Number(process.env.MAX_DRAWDOWN_PCT ?? 0.05);
// Below-range soft recenter: consecutive keeper ticks with spot < lowestBinPrice before recycle.
const BELOW_RANGE_TICKS = Math.max(1, Number(process.env.BELOW_RANGE_TICKS ?? 3));
// Min seconds between below-range (or TP) recenters that reopen a grid without a hard stop.
const RECENTER_COOLDOWN_SEC = Math.max(0, Number(process.env.RECENTER_COOLDOWN_SEC ?? 1800));
// Optional entry PIN for restarts. Applied ONLY at boot-attach and ONLY when the attached
// position pubkey equals ENTRY_POSITION_PUBKEY. After a take-profit / recenter / new deploy the
// position pubkey changes, so a stale pin is ignored automatically (with a warning) on the next boot.
const ENTRY_SPOT_USD_ENV = process.env.ENTRY_SPOT_USD?.trim() || "";
const ENTRY_EQUITY_USD_ENV = process.env.ENTRY_EQUITY_USD?.trim() || "";
const ENTRY_POSITION_PUBKEY_ENV = process.env.ENTRY_POSITION_PUBKEY?.trim() || "";
// Optional price-stop % pin (fraction, e.g. 0.05). Same rules as ENTRY_SPOT_USD: applied only at
// boot-attach when ENTRY_POSITION_PUBKEY matches. Unpinned attach → RANGE_CHOP 5% (not the live regime).
const ENTRY_STOP_PCT_ENV = process.env.ENTRY_STOP_PCT?.trim() || "";

// ---- Read guard (stop safety). Thresholds of the stops themselves are unchanged. ----
// Consecutive suspicious reads required before a suspicious value is accepted as real.
const SUSPECT_CONFIRM_TICKS = Math.max(2, Number(process.env.SUSPECT_CONFIRM_TICKS ?? 3));
// One-tick spot move larger than this vs the last good spot is treated as a suspect read.
const SPOT_JUMP_MAX_PCT = Number(process.env.SPOT_JUMP_MAX_PCT ?? 0.2);
// Position value drop larger than this in one tick while spot moved < POS_DROP_SPOT_MOVE_PCT is a suspect read.
const POS_DROP_MAX_PCT = Number(process.env.POS_DROP_MAX_PCT ?? 0.5);
const POS_DROP_SPOT_MOVE_PCT = Number(process.env.POS_DROP_SPOT_MOVE_PCT ?? 0.05);
// Telegram alert when a stop has had no trustworthy read for this long while a position is open.
const STOP_BLIND_ALERT_SEC = Math.max(60, Number(process.env.STOP_BLIND_ALERT_SEC ?? 300));
// At most one ERROR ledger row per this many seconds for failed reads.
const READ_ERROR_LEDGER_SEC = Math.max(60, Number(process.env.READ_ERROR_LEDGER_SEC ?? 900));

// Meteora initializePosition width = maxBinId - minBinId + 1 must be in [1, DEFAULT_BIN_PER_POSITION].
const MAX_POSITION_WIDTH = DEFAULT_BIN_PER_POSITION.toNumber(); // 70

// ==================== SYSTEM STATE ====================
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(BOT_PRIVATE_KEY));

// ---- /transfer_out (allow-listed, confirmed transfer of funds out of the LP wallet; see transferout.ts) ----
// TRANSFER_OUT_ALLOWLIST: exactly ONE destination wallet (public key). Unset/invalid = command disabled.
// The destination never comes from Telegram. Needs TELEGRAM_CHAT_ID; optional TRANSFER_OUT_USER_IDS
// (Telegram user ids allowed to request/confirm). Caps: TRANSFER_OUT_MAX_USD (default 600, hard ceiling 5000)
// and TRANSFER_OUT_MAX_EQUITY_PCT of live equity (default 60). SOL leg never takes native SOL below
// GAS_RESERVE_LAMPORTS + TRANSFER_OUT_SOL_MARGIN_LAMPORTS (default 0.01 SOL) + tx fee (+ destination ATA rent).
// Accounting: each transfer carries an on-chain memo; at boot the total is re-derived from chain and subtracted
// from an env capital baseline (do NOT also put it in NET_DEPOSITS_USD). TRANSFER_OUT_PRIOR_USD is a fallback
// used only if that scan fails / is incomplete.
const TRANSFER_OUT = parseTransferAllowlist(process.env.TRANSFER_OUT_ALLOWLIST, {
  lpWallet: wallet.publicKey.toBase58(),
  revenueWallet: LP_REVENUE_VAULT.toBase58(),
  isValidPubkey: (x) => {
    try {
      return PublicKey.isOnCurve(new PublicKey(x).toBytes());
    } catch {
      return false;
    }
  },
});
const TRANSFER_OUT_MAX_USD = resolveMaxUsd(process.env.TRANSFER_OUT_MAX_USD);
const TRANSFER_OUT_MAX_EQUITY_PCT = resolveMaxEquityPct(process.env.TRANSFER_OUT_MAX_EQUITY_PCT);
const TRANSFER_OUT_USER_IDS = parseUserIds(process.env.TRANSFER_OUT_USER_IDS);
const TRANSFER_OUT_SOL_MARGIN_LAMPORTS = Math.max(0, Number(process.env.TRANSFER_OUT_SOL_MARGIN_LAMPORTS ?? 10_000_000));
const TRANSFER_OUT_PRIOR_USD = parseOptionalUsd("TRANSFER_OUT_PRIOR_USD") ?? 0;
const TRANSFER_OUT_SCAN_MAX_SIGS = Math.max(200, Number(process.env.TRANSFER_OUT_SCAN_MAX_SIGS ?? 5000));

let dlmmPoolInstance: DLMM | null = null;
let activePositionPubkey: PublicKey | null = null;
let lowestBinPrice = 0;
let highestBinPrice = 0;
let inCooldownUntil = 0;
/** Unix seconds of the last successful fee sweep. Set at boot from chain (else LAST_SWEEP_UNIX, else boot time). */
let lastSweepTime = Math.floor(Date.now() / 1000);
let lastSweepSource = "boot time (not yet resolved)";
/** When a due sweep moved nothing, don't retry before this time (avoids a claim attempt every 15s tick). */
let nextSweepRetryAt = 0;
/** USD swept to the revenue wallet before this boot (on-chain scan, else PRIOR_SWEPT_USD fallback). */
let priorSweptUsd = PRIOR_SWEPT_USD;
let priorSweptSource = PRIOR_SWEPT_USD > 0 ? "env PRIOR_SWEPT_USD" : "none";
let isDeploying = false;
let isBotPaused = false;
/** Set by /withdraw_pct: liquidity was pulled into the wallet for an external transfer. /resume re-bases entry equity. */
let partialWithdrawPending = false;
/** USD moved out by /transfer_out: before this boot (chain, else TRANSFER_OUT_PRIOR_USD) + this process. */
let priorTransferOutUsd = 0;
let priorTransferOutSource = "none";
let transferOutHistory: TransferOutHistory = emptyTransferOutHistory();
let transferredOutThisProcessUsd = 0;
interface QuotedTransfer {
  req: TransferRequest;
  usdcRaw: number;
  lamports: number;
  usd: number;
  spot: number;
  needsAta: boolean;
}
const transferConfirmations = new TransferConfirmations<QuotedTransfer>(TRANSFER_OUT_CONFIRM_TTL_MS);
let isLiquidating = false;
/** True while any unwind path (circuit breaker / take-profit / emergency) is in flight. */
let isExiting = false;
/** Prevents overlapping setInterval keeper ticks (async re-entrancy). */
let keeperTickRunning = false;
/**
 * Capital contributed (USD) — set ONCE at boot (env or boot equity). Reporting only:
 * no stop, take-profit, recenter or sizing decision reads it. Never mutated by
 * top-ups, deploys, recenters, swaps, closes, take-profit, circuit breaker or emergency exit.
 */
let capitalBaselineUsd = 0;
/** "env" when STARTING_CAPITAL_USD/BASELINE_USD is set, else "boot-equity". */
let capitalBaselineSource: "env" | "boot-equity" = "boot-equity";
let lastExitPriceUsd = 0;
/** Spot USD at position entry (deploy or attach). Hard price-stop is measured from this, not range bottom. */
let entrySpotUsd = 0;
/** Mark-to-market equity USD at entry. Equity stop uses entryEquityUsd * (1 - MAX_DRAWDOWN_PCT). */
let entryEquityUsd = 0;
/**
 * Price-stop % (+ post-stop cooldown and the regime they came from) LOCKED for the life of the current
 * position: captured from the regime at deploy, or ENTRY_STOP_PCT / RANGE 5% at attach. Kept across
 * below-range recenters (like entry spot/equity); cleared with entry state. Regime changes never move it.
 */
let entryStopLock: EntryStopLock | null = null;
/** Consecutive keeper ticks with spot below lowestBinPrice (out of range downside). */
let belowRangeTickCount = 0;
/** Unix seconds of last soft recenter (below-range or take-profit recycle). */
let lastRecenterAt = 0;
let lastTopupAt = 0;
let lastSnapshotAt = 0;
/** In-memory cumulative fees claimed (USD) this process lifetime — sheet is source of truth long-term. */
let cumulativeFeesUsd = 0;
let cumulativeSweptUsd = 0;
/** USD swept to revenue since the current entry (reset with entry state). Used so per-cycle P&L isn't reduced by sweeps. */
let sweptSinceEntryUsd = 0;
let cumulativeGasSol = 0;
/** Serializes native SOL transfers to the revenue wallet (fee sweep fallback vs one-time catch-up). */
let solTransferInFlight = false;
let catchupSentThisProcess = false;

// ---- Read-guard state ----
/** Set when entry equity could not be measured at attach; filled on the first good equity read. */
let entryEquityPending = false;
/** Set when the boot-equity baseline could not be measured; filled on the first good equity read. */
let capitalBaselinePending = false;
let lastGoodSpotUsd = 0;
let spotSuspectTicks = 0;
let lastGoodPosKey = "";
let lastGoodPosUsd = 0;
let lastGoodPosSpotUsd = 0;
let posSuspectTicks = 0;
/** Unix seconds of the last tick where each stop was evaluated on a trustworthy read. */
let lastPriceStopEvalAt = Math.floor(Date.now() / 1000);
let lastEquityStopEvalAt = Math.floor(Date.now() / 1000);
let stopBlindAlerted = false;
let lastReadFailureReason = "";
let lastReadErrorLedgerAt = 0;

// ==================== NOTIFICATIONS & LOGS ====================
/**
 * Strip URLs / keys from free text before it leaves the process (Telegram, sheet).
 * RPC error messages can embed the full RPC URL including its API key.
 */
function redactSecrets(text: string): string {
  let out = String(text ?? "");
  for (const secret of [RPC_URL, TELEGRAM_BOT_TOKEN, GOOGLE_SHEET_WEBHOOK_URL]) {
    if (secret && secret.length >= 8) out = out.split(secret).join("<redacted>");
  }
  out = out.replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi, "<url>");
  out = out.replace(/((?:api[-_]?key|token|secret)=)[^&\s"']+/gi, "$1<redacted>");
  return out;
}

async function notify(rawMsg: string) {
  const msg = withInstancePrefix(redactSecrets(rawMsg), INSTANCE_LABEL);
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

// Closes / liquidity withdrawals and fee claims don't spend the reserve (a close refunds ~0.057 SOL rent),
// so they only need enough native SOL for fees + temporary ATA rent. Deploy and top-up leave native SOL at
// ≈ the reserve minus rent/fees, so requiring reserve + buffer here used to block every claim and close
// (stops, recenter, take-profit, emergency exit) after a top-up or deploy.
const TX_FEE_FLOOR_LAMPORTS = Math.max(1_000_000, Number(process.env.TX_FEE_FLOOR_LAMPORTS ?? 10_000_000)); // 0.01 SOL

/** Risk-reducing / SOL-neutral txs (close, withdraw, claim): only require a small fee floor. */
async function ensureTxFeeFloor(context: string): Promise<boolean> {
  const bal = await connection.getBalance(wallet.publicKey);
  if (bal < TX_FEE_FLOOR_LAMPORTS) {
    console.warn(`[GAS] ${context}: native SOL ${(bal / 1e9).toFixed(4)} below fee floor ${(TX_FEE_FLOOR_LAMPORTS / 1e9).toFixed(4)} — aborting`);
    return false;
  }
  return true;
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
    pool_name: poolName(),
    instance: INSTANCE_LABEL,
    pool_address: POOL_ADDRESS,
    bin_step: poolBinStep || undefined,
    event_type: fields.event_type || fields.event,
    ...fields,
    entry_spot: fields.entry_spot ?? (entrySpotUsd || undefined),
    entry_equity: fields.entry_equity ?? (entryEquityUsd || undefined),
    cumulative_fees_usd: fields.cumulative_fees_usd ?? cumulativeFeesUsd,
    position_pubkey: fields.position_pubkey ?? (activePositionPubkey ? activePositionPubkey.toBase58() : ""),
    range_low: fields.range_low ?? (lowestBinPrice || undefined),
    range_high: fields.range_high ?? (highestBinPrice || undefined),
  };
  if (typeof payload.notes === "string") payload.notes = redactSecrets(payload.notes);
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

// Bin price helper: calculateBinPriceUsd(spot, activeBinId, targetBinId, poolBinStep) in multipool.ts.

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
 * We gate on variable-fee bps <= GATE2_MAX_VARIABLE_FEE_BPS (env), else the default: 15 bps on the
 * 10 bps pool, scaled by the pool's variableFeeControl on other pools (same volatility tolerance).
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
  const binStep = Number(lbPair?.binStep ?? poolBinStep);
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
  const thresholdBps = gate2ThresholdBps(GATE2_MAX_VARIABLE_FEE_BPS_ENV, Number(sParameters?.variableFeeControl ?? 0)).bps;
  const passed = variableFeeBps <= thresholdBps;
  const move = volatilityMovePct(volAcc, binStep);
  const moveNote = binStep === 10 ? "" : `, ≈${move.toFixed(2)}% move`;
  const detail = passed
    ? `✅ Passed (${variableFeeBps.toFixed(2)} bps ≤ ${thresholdBps} bps, volAcc=${volAcc}${moveNote})`
    : `⏳ High Volatility (${variableFeeBps.toFixed(2)} bps > ${thresholdBps} bps, volAcc=${volAcc}${moveNote})`;
  return { volAcc, variableFeeBps, thresholdBps, passed, detail };
}

/** Bid/ask bins for a NEW position under `profile` (env overrides → regime profile scaled to this bin step; ≤70 wide). */
function rangeForProfile(profile: { bidBins: number; askBins: number }): ResolvedRange {
  return resolveRangeBins(
    profile.bidBins,
    profile.askBins,
    poolBinStep,
    { bidBins: BID_BINS_ENV, askBins: ASK_BINS_ENV, widthPct: RANGE_WIDTH_PCT_ENV },
    MAX_POSITION_WIDTH
  );
}

function gasBufferLabel(lamports: number): string {
  if (lamports >= GAS_RESERVE_LAMPORTS) return `🟢 Healthy (≥${(GAS_RESERVE_LAMPORTS / 1e9).toFixed(2)} SOL)`;
  if (lamports >= GAS_WARN_LAMPORTS) return `🟡 OK reserve (${(lamports / 1e9).toFixed(3)} SOL; warn<${(GAS_WARN_LAMPORTS / 1e9).toFixed(2)})`;
  return `⚠️ Low (<${(GAS_WARN_LAMPORTS / 1e9).toFixed(2)} SOL)`;
}

// ==================== EQUITY / STOP HELPERS ====================
function isValidSpot(p: number): boolean {
  return typeof p === "number" && Number.isFinite(p) && p > 0;
}

/** A missing ATA is a legitimate zero balance; any other token-account error is a failed read. */
function isTokenAccountMissing(err: any): boolean {
  const name = String(err?.name || err?.constructor?.name || "");
  return /TokenAccountNotFound/i.test(name);
}

interface WalletProbe {
  ok: boolean;
  reason?: string;
  usdcUsd?: number;
  solUsd?: number;
  totalUsd?: number;
}

/** Wallet liquid USD (USDC ATA + native SOL + WSOL ATA at spot). Returns ok:false on ANY failed read. */
async function probeWalletEquity(spotUsd: number): Promise<WalletProbe> {
  if (!isValidSpot(spotUsd)) return { ok: false, reason: `invalid spot ${spotUsd}` };
  try {
    let solLamports = await connection.getBalance(wallet.publicKey);
    let usdcRaw = 0;
    const usdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    try {
      usdcRaw = Number((await getAccount(connection, usdcAta)).amount);
    } catch (e: any) {
      if (!isTokenAccountMissing(e)) throw e;
    }
    const wsolAta = await getAssociatedTokenAddress(WSOL_MINT, wallet.publicKey);
    try {
      solLamports += Number((await getAccount(connection, wsolAta)).amount);
    } catch (e: any) {
      if (!isTokenAccountMissing(e)) throw e;
    }
    const usdcUsd = usdcRaw / 1e6;
    const solUsd = (solLamports / 1e9) * spotUsd;
    const totalUsd = usdcUsd + solUsd;
    if (!Number.isFinite(totalUsd)) return { ok: false, reason: "wallet read produced non-finite value" };
    return { ok: true, usdcUsd, solUsd, totalUsd };
  } catch (err: any) {
    return { ok: false, reason: `wallet read failed: ${err?.message || err}` };
  }
}

/** Wallet liquid USD. Throws on a failed read (callers fall back explicitly). */
async function getWalletLiquidEquityUsd(spotUsd: number): Promise<{ usdcUsd: number; solUsd: number; totalUsd: number }> {
  const w = await probeWalletEquity(spotUsd);
  if (!w.ok) throw new Error(w.reason);
  return { usdcUsd: w.usdcUsd!, solUsd: w.solUsd!, totalUsd: w.totalUsd! };
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

interface EquityProbe {
  ok: boolean;
  /** Set when ok === false. */
  reason?: string;
  totalUsd?: number;
  walletUsd?: number;
  positionsUsd?: number;
  /** Value of the expected (active) position, or 0 when none expected. */
  activePositionUsd?: number;
  positionCount?: number;
}

function numField(v: any): number {
  if (v == null) return NaN;
  return Number(v?.toString?.() ?? v);
}

/**
 * Full mark-to-market (open positions + wallet) that NEVER silently degrades to wallet-only.
 * ok:false on: invalid spot, wallet RPC error, position RPC error/timeout, the expected open
 * position missing from the result (null read), or a position with missing/non-finite amounts
 * (partial read).
 */
async function probeEquity(dlmmPool: DLMM, spotUsd: number, expectedPosition: PublicKey | null): Promise<EquityProbe> {
  if (!isValidSpot(spotUsd)) return { ok: false, reason: `invalid spot ${spotUsd}` };
  const w = await probeWalletEquity(spotUsd);
  if (!w.ok) return { ok: false, reason: w.reason };
  let userPositions: any[];
  try {
    ({ userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey));
  } catch (err: any) {
    return { ok: false, reason: `position read failed: ${err?.message || err}` };
  }
  if (!Array.isArray(userPositions)) return { ok: false, reason: "position read returned no list" };
  let positionsUsd = 0;
  let activePositionUsd = 0;
  let activeFound = false;
  for (const pos of userPositions) {
    const pd = pos?.positionData;
    const key = pos?.publicKey?.toBase58?.() ?? "?";
    if (!pd) return { ok: false, reason: `position ${key.slice(0, 8)} has no positionData (partial read)` };
    const x = numField(pd.totalXAmount);
    const y = numField(pd.totalYAmount);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, reason: `position ${key.slice(0, 8)} amounts missing/non-finite (partial read)` };
    }
    const v = getPositionInventoryUsd(pos, spotUsd);
    if (!Number.isFinite(v) || v < 0) return { ok: false, reason: `position ${key.slice(0, 8)} value ${v} invalid` };
    positionsUsd += v;
    if (expectedPosition && pos.publicKey?.equals?.(expectedPosition)) {
      activeFound = true;
      activePositionUsd = v;
    }
  }
  if (expectedPosition && !activeFound) {
    return {
      ok: false,
      reason: `open position ${expectedPosition.toBase58().slice(0, 8)} missing from read (${userPositions.length} returned)`,
    };
  }
  return {
    ok: true,
    totalUsd: Number((w.totalUsd + positionsUsd).toFixed(2)),
    walletUsd: w.totalUsd,
    positionsUsd,
    activePositionUsd,
    positionCount: userPositions.length,
  };
}

/** Full mark-to-market. Throws on any failed/partial read (never returns wallet-only by accident). */
async function getMarkToMarketEquityUsd(dlmmPool: DLMM, spotUsd: number): Promise<number> {
  const p = await probeEquity(dlmmPool, spotUsd, activePositionPubkey);
  if (!p.ok) throw new Error(p.reason);
  return p.totalUsd;
}

/** Retry a probe a few times (boot/attach only — the keeper loop just retries next tick). */
async function probeEquityWithRetry(dlmmPool: DLMM, spotUsd: number, expected: PublicKey | null, attempts = 3): Promise<EquityProbe> {
  let last: EquityProbe = { ok: false, reason: "not attempted" };
  for (let i = 0; i < attempts; i++) {
    last = await probeEquity(dlmmPool, spotUsd, expected);
    if (last.ok) return last;
    console.warn(`[READ] equity probe attempt ${i + 1}/${attempts} failed: ${last.reason}`);
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

/**
 * Plausibility filter for spot used by stops / TP / recenter. Rejects zero/NaN, and a one-tick
 * jump > SPOT_JUMP_MAX_PCT vs the last good spot until it persists SUSPECT_CONFIRM_TICKS ticks.
 */
function vetSpot(spotUsd: number): { ok: boolean; reason?: string } {
  if (!isValidSpot(spotUsd)) return { ok: false, reason: `invalid spot ${spotUsd}` };
  if (lastGoodSpotUsd > 0) {
    const move = Math.abs(spotUsd / lastGoodSpotUsd - 1);
    if (move > SPOT_JUMP_MAX_PCT) {
      spotSuspectTicks += 1;
      if (spotSuspectTicks < SUSPECT_CONFIRM_TICKS) {
        return {
          ok: false,
          reason: `spot $${spotUsd.toFixed(2)} moved ${(move * 100).toFixed(1)}% vs last good $${lastGoodSpotUsd.toFixed(2)} in one tick (suspect ${spotSuspectTicks}/${SUSPECT_CONFIRM_TICKS})`,
        };
      }
      console.warn(`[READ] Accepting spot $${spotUsd.toFixed(2)} after ${spotSuspectTicks} consecutive confirming reads.`);
    }
  }
  spotSuspectTicks = 0;
  lastGoodSpotUsd = spotUsd;
  return { ok: true };
}

/**
 * Plausibility filter for the equity-stop read. Requires an ok probe; rejects an open position read
 * as $0; rejects a > POS_DROP_MAX_PCT one-tick drop in position value while spot moved
 * < POS_DROP_SPOT_MOVE_PCT until it persists SUSPECT_CONFIRM_TICKS ticks.
 */
function vetEquityProbe(p: EquityProbe, spotUsd: number): { ok: boolean; reason?: string; totalUsd?: number } {
  if (!p.ok) return { ok: false, reason: p.reason || "unknown read failure" };
  const key = activePositionPubkey ? activePositionPubkey.toBase58() : "";
  if (!key) return { ok: true, totalUsd: p.totalUsd };
  if (!(p.activePositionUsd > 0)) {
    return { ok: false, reason: `open position ${key.slice(0, 8)} read as $0 (bad read)` };
  }
  if (lastGoodPosKey === key && lastGoodPosUsd > 0 && lastGoodPosSpotUsd > 0) {
    const drop = 1 - p.activePositionUsd / lastGoodPosUsd;
    const spotMove = Math.abs(spotUsd / lastGoodPosSpotUsd - 1);
    if (drop > POS_DROP_MAX_PCT && spotMove < POS_DROP_SPOT_MOVE_PCT) {
      posSuspectTicks += 1;
      if (posSuspectTicks < SUSPECT_CONFIRM_TICKS) {
        return {
          ok: false,
          reason:
            `position value $${p.activePositionUsd.toFixed(2)} dropped ${(drop * 100).toFixed(1)}% vs last good ` +
            `$${lastGoodPosUsd.toFixed(2)} while spot moved ${(spotMove * 100).toFixed(1)}% (suspect ${posSuspectTicks}/${SUSPECT_CONFIRM_TICKS})`,
        };
      }
      console.warn(`[READ] Accepting position value $${p.activePositionUsd.toFixed(2)} after ${posSuspectTicks} consecutive confirming reads.`);
    }
  }
  posSuspectTicks = 0;
  lastGoodPosKey = key;
  lastGoodPosUsd = p.activePositionUsd;
  lastGoodPosSpotUsd = spotUsd;
  return { ok: true, totalUsd: p.totalUsd };
}

/** Log every failed read; emit at most one ERROR ledger row per READ_ERROR_LEDGER_SEC. */
function noteReadFailure(what: string, rawReason: string, nowSec: number) {
  const reason = redactSecrets(rawReason).slice(0, 300);
  lastReadFailureReason = `${what}: ${reason}`;
  console.warn(`[READ GUARD] ${what} skipped this tick — ${reason}`);
  if (nowSec - lastReadErrorLedgerAt >= READ_ERROR_LEDGER_SEC) {
    lastReadErrorLedgerAt = nowSec;
    void emitLedger({ event: "ERROR", notes: `Read guard: ${what} skipped — ${reason}`, is_estimate: true });
  }
}

/** Reset read-guard references when a (new) position becomes active (attach / deploy / resume). */
function markStopsArmed() {
  const now = Math.floor(Date.now() / 1000);
  lastPriceStopEvalAt = now;
  lastEquityStopEvalAt = now;
  posSuspectTicks = 0;
  lastGoodPosKey = "";
  lastGoodPosUsd = 0;
  lastGoodPosSpotUsd = 0;
}

/** Watchdog: alert if a stop has been blind (no trustworthy read) for STOP_BLIND_ALERT_SEC. Independent of the keeper tick. */
async function checkStopBlindness() {
  const now = Math.floor(Date.now() / 1000);
  if (!activePositionPubkey || isBotPaused || isExiting || isLiquidating) return;
  const priceBlind = now - lastPriceStopEvalAt;
  const equityBlind = entryEquityUsd > 0 || entryEquityPending ? now - lastEquityStopEvalAt : 0;
  const worst = Math.max(priceBlind, equityBlind);
  if (worst >= STOP_BLIND_ALERT_SEC && !stopBlindAlerted) {
    stopBlindAlerted = true;
    const which = [
      priceBlind >= STOP_BLIND_ALERT_SEC ? `price stop ${Math.round(priceBlind / 60)}m` : "",
      equityBlind >= STOP_BLIND_ALERT_SEC ? `equity stop ${Math.round(equityBlind / 60)}m` : "",
    ].filter(Boolean).join(", ");
    await notify(
      `⚠️ <b>[STOPS BLIND]</b> No trustworthy on-chain read for: ${which}. Stops are NOT being evaluated.\n` +
      `• Position: <code>${activePositionPubkey.toBase58()}</code>\n` +
      `• Last error: ${escapeHtml(lastReadFailureReason || "keeper tick not completing")}\n` +
      `• Check RPC / Railway logs. Use /emergency_exit if you need to unwind manually.`
    );
    void emitLedger({ event: "ERROR", notes: `Stops blind: ${which}. Last: ${lastReadFailureReason}`, is_estimate: true });
  } else if (worst < STOP_BLIND_ALERT_SEC && stopBlindAlerted) {
    stopBlindAlerted = false;
    await notify("✅ <b>[STOPS RESTORED]</b> On-chain reads healthy again; price and equity stops are being evaluated.");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Locked price-stop fraction for the current position (RANGE 5% if somehow unset). */
function lockedStopPct(): number {
  return entryStopLock && entryStopLock.stopPct > 0 ? entryStopLock.stopPct : REGIME_PROFILES[DEFAULT_REGIME].floorStopPct;
}

function lockedCooldownSec(): number {
  return entryStopLock && entryStopLock.cooldownSec > 0 ? entryStopLock.cooldownSec : REGIME_PROFILES[DEFAULT_REGIME].cooldownSec;
}

function stopLockLabel(): string {
  if (!entryStopLock) return `${(lockedStopPct() * 100).toFixed(1)}% (default — no lock yet)`;
  return `${(entryStopLock.stopPct * 100).toFixed(1)}% locked (${entryStopLock.source})`;
}

function priceStopFromEntry(): number {
  return priceStopFromLock(entrySpotUsd, entryStopLock);
}

function equityStopFromEntry(): number {
  if (!(entryEquityUsd > 0)) return 0;
  return entryEquityUsd * (1 - MAX_DRAWDOWN_PCT);
}

function formatFloorStopLine(): string {
  const floorStopPct = lockedStopPct();
  const pStop = priceStopFromEntry();
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
  sweptSinceEntryUsd = 0;
  entryStopLock = null;
}

/**
 * @param fallbackEquityUsd used only if the MTM probe throws (previously the per-deploy
 *   baseline, i.e. the USD value just deposited — preserved so stop behavior is unchanged).
 */
async function recordEntryAfterOpen(
  dlmmPool: DLMM,
  spotUsd: number,
  note: string,
  fallbackEquityUsd: number,
  regime: MarketRegime
) {
  entrySpotUsd = spotUsd;
  entryStopLock = lockFromRegime(regime, note);
  sweptSinceEntryUsd = 0;
  entryEquityPending = false;
  const p = await probeEquityWithRetry(dlmmPool, spotUsd, activePositionPubkey, 2);
  if (p.ok) {
    entryEquityUsd = p.totalUsd;
  } else {
    // Same fallback as before (USD just deposited); a failed read can no longer yield wallet-only equity.
    console.warn(`[ENTRY] equity probe failed (${p.reason}) — using deployed value $${(fallbackEquityUsd || 0).toFixed(2)}`);
    entryEquityUsd = fallbackEquityUsd || 0;
  }
  console.log(`[ENTRY] ${note} spot=$${entrySpotUsd.toFixed(2)} equity=$${entryEquityUsd.toFixed(2)} stop ${stopLockLabel()}`);
}

// ==================== FEE-SWEEP CLOCK (on-chain, survives restarts) ====================
function formatUnixPt(unixSec: number): string {
  return `${formatTimestampPt(new Date(unixSec * 1000))} PT`;
}

/** Human label for the next scheduled sweep (PT). */
function nextSweepLabel(): string {
  const now = Math.floor(Date.now() / 1000);
  const due = lastSweepTime + SWEEP_INTERVAL_SEC;
  const at = Math.max(due, nextSweepRetryAt);
  const last = `last ${formatUnixPt(lastSweepTime)} (${lastSweepSource})`;
  if (at <= now) return `due now (first eligible tick) — ${last}`;
  return `${formatUnixPt(at)}${nextSweepRetryAt > due ? " (retry after a sweep that moved nothing)" : ""} — ${last}`;
}

interface SweepHistory {
  ok: boolean;
  reason?: string;
  /** False if the signature cap was hit or any transaction could not be fetched (total may be low). */
  complete: boolean;
  lastSweepUnix: number | null;
  lastSweepSig: string | null;
  totalSweptUsd: number;
  sweepCount: number;
  scannedSigs: number;
  /** Native SOL sent LP → revenue (part of totalSweptUsd at its USD value). */
  solSweptLamports?: number;
  solSweptUsd?: number;
  /** Catch-up ids found in LP-signed memos on chain (one-time catch-up guard). */
  catchupIds?: Set<string>;
}

/** SOL/USD 1m close at a past unix time (Hyperliquid candles) — only for SOL sweeps without a bot memo. */
async function historicalSolUsd(unixSec: number): Promise<number | null> {
  try {
    const startTime = (unixSec - 120) * 1000;
    const endTime = (unixSec + 60) * 1000;
    const res = await axios.post(
      "https://api.hyperliquid.xyz/info",
      { type: "candleSnapshot", req: { coin: "SOL", interval: "1m", startTime, endTime } },
      { timeout: 8000 }
    );
    const candles: any[] = Array.isArray(res.data) ? res.data : [];
    const before = candles.filter((c) => Number(c.t) <= unixSec * 1000);
    const c = before.length ? before[before.length - 1] : candles[0];
    const px = Number(c?.c);
    return isValidSpot(px) ? px : null;
  } catch {
    return null;
  }
}

async function listSignatures(address: PublicKey): Promise<{ sigs: { signature: string; err: any }[]; complete: boolean }> {
  const sigs: { signature: string; err: any }[] = [];
  let before: string | undefined;
  let complete = false;
  while (sigs.length < SWEEP_SCAN_MAX_SIGS) {
    const limit = Math.min(1000, SWEEP_SCAN_MAX_SIGS - sigs.length);
    const page = await connection.getSignaturesForAddress(address, { before, limit }, "confirmed");
    sigs.push(...page);
    if (page.length < limit) {
      complete = true;
      break;
    }
    before = page[page.length - 1].signature;
  }
  return { sigs, complete };
}

/**
 * Scan the revenue wallet's USDC ATA AND the revenue wallet itself for sweeps signed by this LP wallet:
 * USDC transfers LP-ATA → revenue-ATA (raw USDC = USD) and native SOL transfers LP → revenue wallet
 * (USD from the bot's sweep memo written at send time = lamports × pool spot then; memo-less SOL transfers
 * fall back to the Hyperliquid 1m close at blockTime, else the scan is marked incomplete).
 * Returns last sweep time, cumulative USD and the catch-up ids already done.
 */
async function scanSweepHistoryOnChain(): Promise<SweepHistory> {
  const empty: SweepHistory = {
    ok: false, complete: false, lastSweepUnix: null, lastSweepSig: null, totalSweptUsd: 0, sweepCount: 0, scannedSigs: 0,
  };
  try {
    const lpWallet = wallet.publicKey.toBase58();
    const lpUsdcAta = (await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey)).toBase58();
    const revUsdcAtaKey = await getAssociatedTokenAddress(USDC_MINT, LP_REVENUE_VAULT);
    const revUsdcAta = revUsdcAtaKey.toBase58();
    const ctx = { lpWallet, revWallet: LP_REVENUE_VAULT.toBase58(), lpUsdcAta, revUsdcAta, usdcMint: USDC_MINT.toBase58() };

    const ataList = await listSignatures(revUsdcAtaKey);
    const walletList = await listSignatures(LP_REVENUE_VAULT);
    const uniq = new Map<string, { signature: string; err: any }>();
    for (const x of [...ataList.sigs, ...walletList.sigs]) if (!uniq.has(x.signature)) uniq.set(x.signature, x);
    const sigs = [...uniq.values()];

    const res: SweepHistory = {
      ...empty, ok: true, complete: ataList.complete && walletList.complete, scannedSigs: sigs.length,
      solSweptLamports: 0, solSweptUsd: 0, catchupIds: new Set<string>(),
    };
    let totalRaw = 0;
    let solUsd = 0;
    const candidates = sigs.filter((x) => !x.err);
    const BATCH = 10;
    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      const txs = await connection.getParsedTransactions(
        batch.map((x) => x.signature),
        { maxSupportedTransactionVersion: 0, commitment: "confirmed" }
      );
      // Batch responses are not guaranteed to be in request order: take signature + blockTime
      // from the returned transaction itself, never from the batch position.
      const seen = new Set<string>();
      for (const tx of txs as any[]) {
        if (!tx) continue;
        const sig: string | undefined = tx.transaction?.signatures?.[0];
        if (!sig || seen.has(sig)) continue;
        seen.add(sig);
        // parseSweepTx only counts transfers SIGNED by this LP wallet (USDC: authority = LP wallet, source = LP ATA;
        // SOL: LP wallet signer) — another instance sweeping to the same revenue wallet signs from a different
        // wallet and is ignored, so per-instance swept totals never double count.
        const p = parseSweepTx(tx, ctx);
        if (p.memo?.kind === "catchup-sol-sweep" && p.memo.id) res.catchupIds!.add(p.memo.id);
        if (p.usdcRaw <= 0 && p.solLamports <= 0) continue;
        const bt: number | null = tx.blockTime ?? null;
        if (p.usdcRaw > 0) totalRaw += p.usdcRaw;
        if (p.solLamports > 0) {
          let usd = p.solUsdFromMemo;
          if (usd == null && bt) {
            const px = await historicalSolUsd(bt);
            if (px != null) usd = (p.solLamports / 1e9) * px;
          }
          if (usd == null) {
            res.complete = false; // unpriced SOL sweep — total understated
            console.warn(`[SWEEP] SOL sweep ${sig.slice(0, 8)}… (${p.solLamports} lamports) could not be priced`);
          } else {
            solUsd += usd;
          }
          res.solSweptLamports! += p.solLamports;
        }
        res.sweepCount += 1;
        if (bt && (res.lastSweepUnix == null || bt > res.lastSweepUnix)) {
          res.lastSweepUnix = bt;
          res.lastSweepSig = sig;
        }
      }
      if (seen.size < batch.length) res.complete = false; // pruned/unavailable — total may be understated
    }
    res.solSweptUsd = Number(solUsd.toFixed(6));
    res.totalSweptUsd = Number((totalRaw / 1e6 + solUsd).toFixed(6));
    return res;
  } catch (err: any) {
    return { ...empty, reason: redactSecrets(String(err?.message || err)).slice(0, 200) };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Resolve the sweep clock + prior-swept total from chain. Safe to call again later (background retry):
 * chain overrides a fallback clock (env / boot time) but never an in-process sweep with an older time,
 * and the prior total subtracts sweeps already counted in-process (no double count).
 */
async function resolveSweepStateFromChain(context: string): Promise<boolean> {
  let h: SweepHistory;
  try {
    h = await withTimeout(scanSweepHistoryOnChain(), 45_000, "sweep history scan");
  } catch (err: any) {
    h = { ok: false, complete: false, lastSweepUnix: null, lastSweepSig: null, totalSweptUsd: 0, sweepCount: 0, scannedSigs: 0,
      reason: redactSecrets(String(err?.message || err)) };
  }
  if (!h.ok) {
    console.warn(`[SWEEP] On-chain sweep history unavailable (${context}): ${h.reason}`);
    return false;
  }
  if (h.lastSweepUnix != null && h.lastSweepUnix > 0) {
    if (lastSweepSource !== "in-process sweep" || h.lastSweepUnix > lastSweepTime) {
      lastSweepTime = h.lastSweepUnix;
      lastSweepSource = `on-chain ${h.lastSweepSig ? h.lastSweepSig.slice(0, 8) + "…" : ""}`.trim();
    }
  }
  if (h.complete) {
    const prior = Math.max(0, Number((h.totalSweptUsd - cumulativeSweptUsd).toFixed(6)));
    if (PRIOR_SWEPT_USD > 0 && Math.abs(PRIOR_SWEPT_USD - h.totalSweptUsd) > 0.01) {
      console.warn(
        `[SWEEP] PRIOR_SWEPT_USD=${PRIOR_SWEPT_USD} differs from on-chain total $${h.totalSweptUsd.toFixed(2)} — using on-chain (env is fallback only).`
      );
    }
    priorSweptUsd = prior;
    priorSweptSource = `on-chain (${h.sweepCount} sweeps)`;
  } else {
    console.warn(
      `[SWEEP] On-chain sweep scan incomplete (${h.scannedSigs} sigs, cap ${SWEEP_SCAN_MAX_SIGS} or unavailable txs) — ` +
        `keeping prior swept $${priorSweptUsd.toFixed(2)} (${priorSweptSource}).`
    );
  }
  console.log(
    `[SWEEP] ${context}: on-chain sweeps=${h.sweepCount} total=$${h.totalSweptUsd.toFixed(2)} ` +
      `(incl. ${((h.solSweptLamports ?? 0) / 1e9).toFixed(6)} SOL = $${(h.solSweptUsd ?? 0).toFixed(2)}) (scanned ${h.scannedSigs} sigs${h.complete ? "" : ", incomplete"}) | ` +
      `prior swept $${priorSweptUsd.toFixed(2)} [${priorSweptSource}] | next sweep: ${nextSweepLabel()}`
  );
  return true;
}

/** Boot: resolve from chain; on failure use LAST_SWEEP_UNIX or boot time, and retry the scan in the background. */
async function initSweepClock(): Promise<void> {
  const ok = await resolveSweepStateFromChain("boot");
  if (ok && lastSweepSource.startsWith("on-chain")) return;
  if (!ok || lastSweepSource.startsWith("boot")) {
    if (LAST_SWEEP_UNIX_ENV != null) {
      lastSweepTime = LAST_SWEEP_UNIX_ENV;
      lastSweepSource = "env LAST_SWEEP_UNIX";
    } else {
      lastSweepSource = ok ? "boot time (no on-chain sweep found)" : "boot time (on-chain lookup failed)";
    }
    console.warn(`[SWEEP] Sweep clock source: ${lastSweepSource} | next sweep: ${nextSweepLabel()}`);
  }
  if (!ok) {
    // Retry in the background so frequent restarts + a flaky RPC can't postpone sweeps forever.
    let attempts = 0;
    const retry = async () => {
      attempts += 1;
      const done = await resolveSweepStateFromChain(`background retry ${attempts}`);
      if (!done && attempts < 8) setTimeout(retry, 15 * 60 * 1000);
    };
    setTimeout(retry, 15 * 60 * 1000);
  }
}

/** Logs the exact env values that would pin the CURRENT entry across a restart. */
function logEntryPinHint() {
  if (!activePositionPubkey || !(entrySpotUsd > 0)) return;
  console.log(
    `[ENTRY] To keep this entry across restarts set: ` +
      entryPinLine(activePositionPubkey.toBase58(), entrySpotUsd, entryEquityUsd, entryStopLock)
  );
}

// ==================== CAPITAL BASELINE / P&L (reporting only) ====================
/** Swept to revenue that counts toward P&L vs the capital baseline. */
function sweptForPnlUsd(): number {
  // Prior sweeps only make sense against an env (true starting capital) baseline;
  // a boot-equity baseline already excludes everything swept before boot.
  return (capitalBaselineSource === "env" ? priorSweptUsd : 0) + cumulativeSweptUsd;
}

/** Net P&L vs contributed capital: equity + swept to revenue − baseline. NaN while the baseline is pending. */
function totalPnlUsd(equityUsd: number): number {
  if (capitalBaselinePending || !Number.isFinite(equityUsd)) return NaN;
  return Number((equityUsd + sweptForPnlUsd() - capitalBaselineUsd).toFixed(2));
}

function fmtSignedUsd(v: number): string {
  if (!Number.isFinite(v)) return "n/a";
  return `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
}

function fmtPct(num: number, den: number): string {
  if (!(den > 0) || !Number.isFinite(num)) return "n/a";
  const p = (num / den) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

function capitalBaselineLabel(): string {
  if (capitalBaselinePending) return "pending (equity at boot unreadable; set STARTING_CAPITAL_USD)";
  if (capitalBaselineSource === "env") {
    const outUsd = priorTransferOutUsd + transferredOutThisProcessUsd;
    const parts = [`starting $${(capitalBaselineUsd - NET_DEPOSITS_USD + outUsd).toFixed(2)}`];
    if (NET_DEPOSITS_USD !== 0) parts.push(`net deposits ${fmtSignedUsd(NET_DEPOSITS_USD)}`);
    if (outUsd > 0) parts.push(`transferred out −$${outUsd.toFixed(2)}`);
    return `$${capitalBaselineUsd.toFixed(2)} (${parts.join(", ")})`;
  }
  return `$${capitalBaselineUsd.toFixed(2)} (equity at boot — set STARTING_CAPITAL_USD for true PnL)`;
}

/**
 * Per-position-cycle realized P&L: exit equity + fees swept since entry − entry equity.
 * Top-ups are equity-neutral, so they do not distort this.
 */
function cycleRealizedPnlUsd(exitEquityUsd: number, entryEqUsd: number, sweptDuringCycleUsd: number): number | null {
  if (!(entryEqUsd > 0)) return null;
  return Number((exitEquityUsd + sweptDuringCycleUsd - entryEqUsd).toFixed(2));
}

/** Common P&L fields for ledger rows (extra keys are ignored by the v2.1 Apps Script). */
function pnlLedgerExtras(equityUsd: number | null): Record<string, number | string | undefined> {
  return {
    capital_baseline_usd: capitalBaselineUsd || undefined,
    capital_baseline_source: capitalBaselineSource,
    cumulative_swept_usd: Number(sweptForPnlUsd().toFixed(2)),
    total_pnl_usd: equityUsd != null && capitalBaselineUsd > 0 && !capitalBaselinePending ? totalPnlUsd(equityUsd) : undefined,
  };
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
// Classifier, hysteresis and failure handling live in regime.ts (pure, unit-tested).
// Regime drives bin shape for NEW deploys only; the price stop of an open position is locked at entry.
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const regimeSentinel = new RegimeSentinel(
  {
    fetchCoinGecko: async () =>
      (await axios.get("https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=200&interval=daily", { timeout: 8000 })).data,
    fetchFundingHistory: async (startTime: number) =>
      (await axios.post(HL_INFO_URL, { type: "fundingHistory", coin: "SOL", startTime }, { timeout: 8000 })).data,
    fetchPredictedFundings: async () => (await axios.post(HL_INFO_URL, { type: "predictedFundings" }, { timeout: 8000 })).data,
    fetchDailyCandles: async (startTime: number, endTime: number) =>
      (await axios.post(HL_INFO_URL, { type: "candleSnapshot", req: { coin: "SOL", interval: "1d", startTime, endTime } }, { timeout: 8000 }))
        .data,
    fetchCandles: async (startTime: number, endTime: number) =>
      (await axios.post(HL_INFO_URL, { type: "candleSnapshot", req: { coin: "SOL", interval: "1h", startTime, endTime } }, { timeout: 8000 }))
        .data,
  },
  { fmtTime: (sec: number) => formatUnixPt(sec), log: (line: string) => console.log(line) }
);

const macroSentinel = {
  /** Cached (1h; 30 min while a switch is pending; 5 min backoff after a failure). */
  evaluateRegime: (_pool: string, force = false) => regimeSentinel.evaluate(force),
};

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
  /** Set when a tx was signed (and maybe sent) but did not confirm as landed. */
  attemptedSig?: string;
  /** "landed" on success; on failure: not_landed / failed (safe to retry) or unknown (do NOT retry). */
  landedStatus?: LandedStatus;
}

function isPreflightRejection(err: any): boolean {
  const m = String(err?.message || err || "");
  return /simulation failed|preflight|blockhash not found|insufficient (funds|lamports)/i.test(m);
}

/**
 * Wait for a sent signature: blockhash-based confirm; on timeout/error, poll status until it is confirmed or
 * its blockhash has expired (then it can never land). "unknown" = could not prove either way.
 */
async function confirmOrResolveLanded(
  sig: string,
  blockhash: string,
  lastValidBlockHeight: number,
  sendErr: any
): Promise<LandedStatus> {
  if (sendErr && isPreflightRejection(sendErr)) return "not_landed"; // RPC rejected it before broadcast
  if (!sendErr) {
    try {
      const c = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      return c?.value?.err ? "failed" : "landed";
    } catch (err: any) {
      console.warn(`[TX] confirm ${sig.slice(0, 8)}… did not resolve (${err?.message || err}) — checking chain`);
    }
  }
  return resolveLanded(sig, lastValidBlockHeight, {
    getStatus: async (x) => {
      const r = await connection.getSignatureStatuses([x], { searchTransactionHistory: true });
      const v = r?.value?.[0];
      return v ? { err: v.err, confirmationStatus: v.confirmationStatus ?? null } : null;
    },
    getBlockHeight: () => connection.getBlockHeight("confirmed"),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }, { pollMs: 2000, maxWaitMs: 150_000 });
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
  let attemptedSig = "";
  let landedStatus: LandedStatus | undefined;
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

    // Expiry bound for "did it land?": Jupiter returns lastValidBlockHeight; else a conservative
    // current height + 300 (blockhash validity is 150 blocks from when Jupiter fetched it).
    const jupLvbh = Number(swapRes.data?.lastValidBlockHeight);
    const lastValidBlockHeight =
      Number.isFinite(jupLvbh) && jupLvbh > 0 ? jupLvbh : (await connection.getBlockHeight("confirmed")) + 300;
    // Signature is known before sending, so a send/confirm error never loses track of the tx.
    const txid = bs58.encode(vtx.signatures[0]);
    attemptedSig = txid;
    let sendErr: any = null;
    try {
      await connection.sendTransaction(vtx, { skipPreflight: false, maxRetries: 3 });
    } catch (e: any) {
      sendErr = e;
    }
    landedStatus = await confirmOrResolveLanded(txid, vtx.message.recentBlockhash, lastValidBlockHeight, sendErr);
    if (landedStatus !== "landed") {
      throw new Error(
        `swap tx ${txid} ${landedStatus}` +
          (landedStatus === "unknown" ? " (could not prove it landed or expired — not retrying)" : "") +
          (sendErr ? ` (send error: ${sendErr?.message || sendErr})` : "")
      );
    }

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
      attemptedSig: txid,
      landedStatus: "landed",
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
      tx_sig: attemptedSig || undefined,
      is_estimate: true,
    });
    // Nothing signed yet (quote / gas gate / API error) → nothing can land → safe to retry.
    return { ...empty, attemptedSig: attemptedSig || undefined, landedStatus: attemptedSig ? (landedStatus ?? "unknown") : "not_landed" };
  }
}

// ==================== PROFIT SWEEP TO LP REVENUE ====================
/** Any successful sweep (scheduled, /harvest, stop, TP, recenter, emergency, SOL or USDC) restarts the 24h clock. */
function markSweptNow() {
  lastSweepTime = Math.floor(Date.now() / 1000);
  lastSweepSource = "in-process sweep";
  nextSweepRetryAt = 0;
}

interface SolTransferResult {
  status: LandedStatus | "skipped";
  sig: string;
  lamports: number;
  usd: number;
  reason?: string;
}

/**
 * Native SOL → REVENUE_WALLET_PUBKEY (destination from config only — never from tx history; a lookalike
 * poisoning address dusts this wallet). Adds a memo with the USD value at send time so the boot-time
 * on-chain swept total can value it. Logs a FEE_SWEEP row and updates swept totals when it lands.
 * Re-checks the gas floor right before sending.
 */
async function sendSolToRevenue(
  requestedLamports: number,
  spotUsd: number,
  memo: Omit<SweepMemo, "usd" | "spot">,
  ledgerNote: string
): Promise<SolTransferResult> {
  const skipped = (reason: string): SolTransferResult => ({ status: "skipped", sig: "", lamports: 0, usd: 0, reason });
  if (solTransferInFlight) return skipped("another SOL transfer is in flight");
  if (!isValidSpot(spotUsd)) return skipped(`invalid spot ${spotUsd}`);
  if (LP_REVENUE_VAULT.equals(wallet.publicKey)) return skipped("revenue wallet == LP wallet");
  solTransferInFlight = true;
  try {
    const native = await connection.getBalance(wallet.publicKey, "confirmed");
    const size = solSweepLamports({
      requestedLamports,
      nativeLamports: native,
      gasReserveLamports: GAS_RESERVE_LAMPORTS,
      marginLamports: FEE_SOL_SWEEP_MARGIN_LAMPORTS,
      txFeeLamports: SOL_TRANSFER_FEE_LAMPORTS,
      minLamports: memo.kind === "catchup-sol-sweep" ? requestedLamports : FEE_SOL_SWEEP_MIN_LAMPORTS,
    });
    if (size.lamports <= 0) return skipped(size.reason);
    const lamports = size.lamports;
    const usd = Number(((lamports / 1e9) * spotUsd).toFixed(6));
    const memoText = buildSweepMemo({ ...memo, lamports, usd, spot: spotUsd });

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight })
      .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: LP_REVENUE_VAULT, lamports }))
      .add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from(memoText, "utf8") }));
    tx.sign(wallet);
    const sig = bs58.encode(tx.signature!);
    let sendErr: any = null;
    try {
      await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    } catch (e: any) {
      sendErr = e;
    }
    const status = await confirmOrResolveLanded(sig, blockhash, lastValidBlockHeight, sendErr);
    if (status !== "landed") {
      void emitLedger({
        event: "ERROR",
        tx_sig: sig,
        notes: `Native SOL sweep ${status}: ${(lamports / 1e9).toFixed(9)} SOL (${memo.kind})${sendErr ? ` send error: ${sendErr?.message || sendErr}` : ""}`,
        is_estimate: true,
      });
      return { status, sig, lamports: 0, usd: 0, reason: status };
    }
    const feeSol = await getTxFeeSol(sig);
    if (feeSol != null) cumulativeGasSol += feeSol;
    cumulativeSweptUsd += usd;
    sweptSinceEntryUsd += usd;
    markSweptNow();
    await emitLedger({
      event: "FEE_SWEEP",
      spot_usd: spotUsd,
      // fees_claimed_usd intentionally omitted: fees are counted once, on the FEE_CLAIM row.
      swept_to_revenue_usd: usd,
      cumulative_fees_usd: cumulativeFeesUsd,
      gas_fee_sol: feeSol ?? undefined,
      gas_fee_usd: feeSol != null ? feeSol * spotUsd : undefined,
      tx_sig: sig,
      sol_swept: lamports / 1e9,
      notes:
        `Native SOL sweep to REVENUE_WALLET_PUBKEY: ${(lamports / 1e9).toFixed(9)} SOL @ $${spotUsd.toFixed(4)} = $${usd.toFixed(6)}. ` +
        ledgerNote,
      is_estimate: false,
    });
    return { status, sig, lamports, usd };
  } catch (err: any) {
    return skipped(`error: ${redactSecrets(String(err?.message || err)).slice(0, 160)}`);
  } finally {
    solTransferInFlight = false;
  }
}

/**
 * Claimed fee SOL → revenue. 1) Jupiter SOL→USDC (FEE_SOL_SWAP_ATTEMPTS; retry only when the previous
 * signature is proven not landed / failed). 2) If the swap failed or was skipped, send the SOL natively.
 * A swap whose outcome is "unknown" stops everything (no retry, no transfer) to avoid moving it twice.
 */
async function sweepClaimedFeeSol(
  claimedSolLamports: number,
  spotUsd: number
): Promise<{ mode: "swap" | "transfer" | "kept" | "none"; solUsd: number; line: string }> {
  const solUi = (claimedSolLamports / 1e9).toFixed(6);
  let swapNote = "";
  const native = await connection.getBalance(wallet.publicKey, "confirmed");
  // executeJupiterSwap itself requires native ≥ reserve + 0.005 SOL before swapping.
  const swapAmount = Math.min(claimedSolLamports, Math.max(0, native - GAS_RESERVE_LAMPORTS - FEE_SOL_SWEEP_MARGIN_LAMPORTS));
  if (swapAmount >= FEE_SOL_SWAP_MIN_LAMPORTS) {
    for (let attempt = 1; attempt <= FEE_SOL_SWAP_ATTEMPTS; attempt++) {
      await notify(`🔄 Swapping ${(swapAmount / 1e9).toFixed(4)} claimed fee SOL to USDC (attempt ${attempt}/${FEE_SOL_SWAP_ATTEMPTS})...`);
      const r = await executeJupiterSwap(WSOL_MINT, USDC_MINT, swapAmount.toString(), isValidSpot(spotUsd) ? spotUsd : 0);
      if (r.sig) {
        const outUsdc = (r.outAmountActual ?? r.outAmountQuoted) / 1e6;
        return {
          mode: "swap",
          solUsd: 0, // proceeds are swept with the USDC leg
          line: `• SOL: ${(r.inAmount / 1e9).toFixed(6)} SOL swapped → ${outUsdc.toFixed(6)} USDC (in the USDC sweep above; tx <code>${r.sig}</code>)`,
        };
      }
      if (r.landedStatus === "unknown" || r.landedStatus === "landed") {
        const msg =
          `⚠️ Fee SOL swap ${r.attemptedSig ?? ""} status ${r.landedStatus} — NOT retrying and NOT sending SOL natively ` +
          `(avoids moving it twice). Check the signature; leftover fee SOL stays in the LP wallet.`;
        return { mode: "kept", solUsd: 0, line: `• SOL: ${solUi} SOL kept in LP wallet — ${msg}` };
      }
      swapNote = `Jupiter swap ${r.landedStatus ?? "failed"} after ${attempt} attempt(s)`;
      if (attempt < FEE_SOL_SWAP_ATTEMPTS) await new Promise((res) => setTimeout(res, 3000));
    }
  } else {
    swapNote =
      claimedSolLamports < FEE_SOL_SWAP_MIN_LAMPORTS
        ? `swap skipped (below ${(FEE_SOL_SWAP_MIN_LAMPORTS / 1e9).toFixed(3)} SOL)`
        : `swap skipped (gas gate: wallet ${(native / 1e9).toFixed(4)} SOL)`;
  }

  const t = await sendSolToRevenue(claimedSolLamports, spotUsd, { kind: "fee-sol-sweep" }, `Fee SOL fallback (${swapNote}).`);
  if (t.status === "landed") {
    return {
      mode: "transfer",
      solUsd: t.usd,
      line: `• SOL: <b>${(t.lamports / 1e9).toFixed(6)} SOL</b> sent natively ($${t.usd.toFixed(2)} @ $${spotUsd.toFixed(2)}; ${swapNote}) tx <code>${t.sig}</code>`,
    };
  }
  return {
    mode: "kept",
    solUsd: 0,
    line: `• SOL: ${solUi} SOL kept in LP wallet (${swapNote}; native transfer ${t.status}${t.reason && t.reason !== t.status ? `: ${t.reason}` : ""})`,
  };
}

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
      if (!(await ensureTxFeeFloor("fee claim"))) {
        console.warn("[FEE] Skipping claim — SOL below fee floor");
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

    // Spot for valuing the SOL half (pool active bin, else the last good spot).
    let claimSpotUsd = NaN;
    try {
      const ab = await dlmmPool.getActiveBin();
      claimSpotUsd = Number(ab.price) * PRICE_DECIMAL_FACTOR;
    } catch {}
    if (!isValidSpot(claimSpotUsd)) claimSpotUsd = lastGoodSpotUsd;

    // FEE_CLAIM: both halves, valued once (fees_claimed_usd = USDC + SOL × spot). The dashboard counts
    // fees from FEE_CLAIM rows only; FEE_SWEEP rows carry swept_to_revenue_usd and no fees_claimed_usd.
    const claimFields = feeClaimLedgerFields(claimedUsdcRaw, claimedSolLamports, claimSpotUsd);
    if (claimedSolLamports > 0 || claimedUsdcRaw > 0) {
      if (claimFeeLamports > 0) cumulativeGasSol += claimFeeLamports / 1e9;
      cumulativeFeesUsd += claimFields.fees_claimed_usd;
      void emitLedger({
        event: "FEE_CLAIM",
        spot_usd: isValidSpot(claimSpotUsd) ? claimSpotUsd : undefined,
        fees_claimed_usd: claimFields.fees_claimed_usd,
        cumulative_fees_usd: cumulativeFeesUsd,
        // extra fields (ignored by the v2.1 Apps Script; kept for future columns / logs)
        fees_sol: claimFields.fees_sol,
        fees_usdc: claimFields.fees_usdc,
        fees_sol_usd: claimFields.fees_sol_usd,
        gas_fee_sol: claimFeeLamports > 0 ? claimFeeLamports / 1e9 : undefined,
        tx_sig: claimSigs.join(",") || undefined,
        notes: claimFields.notes,
        is_estimate: !claimActual,
      });
    }

    // ---- SOL half: Jupiter swap (with safe retry), else native transfer to the revenue wallet ----
    const solLeg = claimedSolLamports > 0
      ? await sweepClaimedFeeSol(claimedSolLamports, claimSpotUsd)
      : { mode: "none" as const, solUsd: 0, line: "" };

    // ---- USDC half (+ Jupiter proceeds of the fee SOL) ----
    let usdcSweptUsd = 0;
    let usdcSweepSig = "";
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
      usdcSweepSig = sig;
      const sweptAmountUsd = Number(freshlyClaimedUsdc) / 1e6;
      const sweepMeta = await fetchTxWalletDeltas(sig);
      usdcSweptUsd = sweepMeta.ok
        ? Math.max(0, -(sweepMeta.usdcRawDelta)) / 1e6
        : sweptAmountUsd;
      const feeSol = sweepMeta.feeLamports != null ? sweepMeta.feeLamports / 1e9 : await getTxFeeSol(sig);
      cumulativeSweptUsd += usdcSweptUsd;
      sweptSinceEntryUsd += usdcSweptUsd;
      markSweptNow();
      if (feeSol != null) cumulativeGasSol += feeSol;
      await emitLedger({
        event: "FEE_SWEEP",
        // fees_claimed_usd intentionally omitted: fees are counted once, on the FEE_CLAIM row.
        swept_to_revenue_usd: usdcSweptUsd,
        cumulative_fees_usd: cumulativeFeesUsd,
        gas_fee_sol: feeSol ?? undefined,
        tx_sig: sig,
        notes:
          `USDC fee sweep to REVENUE_WALLET_PUBKEY: ${usdcSweptUsd.toFixed(6)} USDC` +
          (solLeg.mode === "swap" ? " (claimed USDC + Jupiter proceeds of fee SOL)" : " (claimed USDC)"),
        is_estimate: !sweepMeta.ok,
      });
    }

    const solSweptUsd = solLeg.mode === "transfer" ? solLeg.solUsd : 0;
    const totalSweptUsd = Number((usdcSweptUsd + solSweptUsd).toFixed(6));
    if (claimedSolLamports > 0 || claimedUsdcRaw > 0 || totalSweptUsd > 0) {
      const lines = [
        `💰 <b>[FEE SWEEP]</b> Claimed <b>$${claimFields.fees_claimed_usd.toFixed(2)}</b> in fees ` +
          `(${claimFields.fees_usdc.toFixed(6)} USDC + ${claimFields.fees_sol.toFixed(6)} SOL ≈ $${claimFields.fees_sol_usd.toFixed(2)}` +
          `${isValidSpot(claimSpotUsd) ? ` @ $${claimSpotUsd.toFixed(2)}` : ""})`,
        usdcSweptUsd > 0
          ? `• USDC → revenue: <b>$${usdcSweptUsd.toFixed(2)}</b> (tx <code>${usdcSweepSig}</code>)`
          : `• USDC → revenue: nothing swept (below $0.05 or no new USDC)`,
      ];
      if (solLeg.line) lines.push(solLeg.line);
      lines.push(`• Total swept to revenue now: <b>$${totalSweptUsd.toFixed(2)}</b>`);
      lines.push(`• Destination: <code>${LP_REVENUE_VAULT.toBase58()}</code>`);
      await notify(lines.join("\n"));
    }
    if (totalSweptUsd > 0) return totalSweptUsd;
  } catch (err: any) {
    if (!err.message?.includes("No fee to claim")) {
      console.error("[FEE SWEEP ERROR]:", err.message);
    }
  }
  return 0;
}

// ==================== MANUAL & AUTOMATED TEARDOWN ====================
interface CloseReclaimResult {
  /** True only when no position is left open in this pool (verified by a re-read). */
  ok: boolean;
  /** Positions still open after the attempt (empty when ok). */
  remaining: PublicKey[];
  sigs: string[];
  solReceivedLamports: number;
  usdcReceivedRaw: number;
  feeLamports: number;
  isEstimate: boolean;
}

async function closePositionAndReclaim(dlmmPool: DLMM): Promise<CloseReclaimResult> {
  const empty: CloseReclaimResult = { ok: false, remaining: [], sigs: [], solReceivedLamports: 0, usdcReceivedRaw: 0, feeLamports: 0, isEstimate: true };
  try {
    await dlmmPool.refetchStates();
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    if (userPositions.length === 0) return { ...empty, ok: true, remaining: [], isEstimate: false };

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

        if (!(await ensureTxFeeFloor("close"))) {
          console.warn("[CLOSE] Aborting further closes — SOL below fee floor");
          break;
        }

        // closePosition (closePosition2) only closes an EMPTY position — on a funded one it fails with
        // NonEmptyPosition (6030). Withdraw 100% + claim fees + close in one SDK call when it holds liquidity.
        const closeTx = positionHasLiquidity(pos.positionData)
          ? await (dlmmPool as any).removeLiquidity({
              user: wallet.publicKey,
              position: pos.publicKey,
              fromBinId: Number(pos.positionData.lowerBinId),
              toBinId: Number(pos.positionData.upperBinId),
              bps: new BN(10_000),
              shouldClaimAndClose: true,
            })
          : await (dlmmPool as any).closePosition({
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

    // Verify on chain: anything still open means the close did NOT happen (callers must not redeploy
    // on top of it or treat the funds as liquidated).
    let remaining: PublicKey[] = [];
    try {
      await dlmmPool.refetchStates();
      const after = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      remaining = (after.userPositions || []).map((p: any) => p.publicKey);
    } catch (verifyErr: any) {
      console.warn("[CLOSE] post-close verification read failed:", verifyErr?.message || verifyErr);
    }
    if (remaining.length > 0) {
      const keys = remaining.map((k) => k.toBase58()).join(", ");
      console.error(`[CLOSE] INCOMPLETE — still open: ${keys}`);
      await notify(
        `⚠️ <b>[CLOSE INCOMPLETE]</b> ${remaining.length} position(s) still open after close attempt: <code>${keys}</code>. ` +
          `Keeping it tracked; no redeploy on top of it. Check Railway logs.`
      );
      void emitLedger({ event: "ERROR", notes: `Close incomplete; still open: ${keys}`, is_estimate: true });
    }

    return {
      ok: remaining.length === 0,
      remaining,
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

/**
 * After a close that left a position open: track it again (range from chain) so stops keep running
 * on it and nothing gets deployed on top of it. Entry state is left as-is.
 */
async function reattachAfterFailedClose(dlmmPool: DLMM, close: CloseReclaimResult, fallback: PublicKey | null): Promise<void> {
  const key = close.remaining[0] ?? fallback;
  if (!key) return;
  activePositionPubkey = key;
  try {
    await dlmmPool.refetchStates();
    const activeBin = await dlmmPool.getActiveBin();
    const spot = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;
    const pos = await dlmmPool.getPosition(key);
    if (isValidSpot(spot) && pos?.positionData) {
      lowestBinPrice = calculateBinPriceUsd(spot, activeBin.binId, pos.positionData.lowerBinId, poolBinStep);
      highestBinPrice = calculateBinPriceUsd(spot, activeBin.binId, pos.positionData.upperBinId, poolBinStep);
    }
  } catch (err: any) {
    console.warn("[CLOSE] re-attach range read failed:", err?.message || err);
  }
  belowRangeTickCount = 0;
  markStopsArmed();
  console.warn(`[CLOSE] Re-attached to still-open position ${key.toBase58()}`);
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
    if (!isValidSpot(spotPriceUsd)) {
      console.warn(`[TOPUP] Skipping — invalid spot read ${spotPriceUsd}`);
      return;
    }
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

    // Split follows the regime LOCKED at entry (the shape the position was opened with), not the live
    // regime: idle capital tops up the existing bins, and a regime flip shouldn't trigger rebalancing swaps.
    const splitRegime: MarketRegime = entryStopLock?.regime ?? DEFAULT_REGIME;
    const config = { regime: splitRegime, ...REGIME_PROFILES[splitRegime] };
    const splitRange = rangeForProfile(config);
    const totalBins = Math.max(1, splitRange.bidBins + splitRange.askBins);
    const askRatio = splitRange.askBins / totalBins;
    const bidRatio = splitRange.bidBins / totalBins;
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
    // Wallet → position move is equity-neutral: capitalBaselineUsd and entryEquityUsd are
    // intentionally NOT changed (those funds were already counted in equity).
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
    if (!isValidSpot(spotPriceUsd)) throw new Error(`Invalid spot read ${spotPriceUsd} — refusing deploy`);
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

    const range = rangeForProfile(config);
    if (range.clamped || range.source !== "regime profile") console.log(`[RANGE] ${range.bidBins}/${range.askBins} bins (${range.source})`);
    const totalBins = Math.max(1, range.bidBins + range.askBins);
    const askRatio = range.askBins / totalBins;
    const bidRatio = range.bidBins / totalBins;
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
    const minBinId = activeBinIdNum - range.bidBins;
    const maxBinId = activeBinIdNum + range.askBins;
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
    lowestBinPrice = calculateBinPriceUsd(spotPriceUsd, activeBin.binId, minBinId, poolBinStep);
    highestBinPrice = calculateBinPriceUsd(spotPriceUsd, activeBin.binId, maxBinId, poolBinStep);
    belowRangeTickCount = 0;
    markStopsArmed();

    const deployedSolValueUsd = (depositedSol / 1e9) * spotPriceUsd;
    const deployedUsdcValueUsd = depositedUsdc / 1e6;
    // Fall back to intended amounts if deltas look empty (shouldn't happen)
    const intendedDeployUsd = (usableSolLamports / 1e9) * spotPriceUsd + usableUsdcRaw / 1e6;
    // USD moved wallet → position by THIS deploy. Internal move: does NOT touch capitalBaselineUsd.
    const deployedValueUsd = Number(
      ((depositedSol > 0 || depositedUsdc > 0) ? deployedSolValueUsd + deployedUsdcValueUsd : intendedDeployUsd).toFixed(2)
    );
    if (entrySpotUsd > 0) {
      console.log(`[ENTRY] Recenter deploy: keeping original entry spot=$${entrySpotUsd.toFixed(2)} equity=$${entryEquityUsd.toFixed(2)}`);
    } else {
      await recordEntryAfterOpen(dlmmPool, spotPriceUsd, "deploy", deployedValueUsd, config.regime);
    }
    if (!entryStopLock) entryStopLock = resolveAttachStopLock("", false).lock; // defensive: never run unlocked
    logEntryPinHint();
    let postDeployEquityUsd: number | null = null;
    try {
      postDeployEquityUsd = await getMarkToMarketEquityUsd(dlmmPool, spotPriceUsd);
    } catch {}

    const allSigs = [swapSig, ...deploySigs].filter(Boolean).join(",") || "ON-CHAIN";
    await notify(
      `✅ <b>[GRID DEPLOYED - ${config.regime}]</b>\n` +
      `• Position: <code>${activePositionPubkey.toBase58()}</code>\n` +
      `• Spot / Entry: $${spotPriceUsd.toFixed(2)}\n` +
      `• Range: $${lowestBinPrice.toFixed(2)} ➔ $${highestBinPrice.toFixed(2)}\n` +
      `• Floor Stop: ${formatFloorStopLine()}\n` +
      `• Stop lock: ${stopLockLabel()}\n` +
      `• Deployed: <b>$${deployedValueUsd.toFixed(2)}</b>` +
      (postDeployEquityUsd != null ? ` | Equity: $${postDeployEquityUsd.toFixed(2)}` : "") + `\n` +
      `• Capital Baseline: ${capitalBaselineLabel()}`
    );
    await emitLedger({
      event: "DEPLOY",
      regime: config.regime,
      spot_usd: spotPriceUsd,
      position_value_usd: deployedValueUsd,
      total_equity_usd: postDeployEquityUsd ?? deployedValueUsd,
      ...pnlLedgerExtras(postDeployEquityUsd),
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

// ==================== MANUAL PARTIAL WITHDRAWAL ====================
/**
 * /withdraw_pct N: PAUSE the bot, then withdraw N% of the open position's liquidity (every bin, position
 * stays open) into the LP wallet so the operator can move it out (e.g. to fund a second instance).
 * The bot stays paused (no stops, top-ups or recenters) until /resume or a restart:
 *  - /resume re-bases entry equity to live equity (so the equity stop can't fire on the transfer out);
 *    any funds still in the wallet get topped back in.
 *  - /transfer_out (allow-listed, confirmed) moves the funds and records the capital withdrawal on chain, so
 *    no env edit is needed for P&L; a transfer done by hand instead needs NET_DEPOSITS_USD = −(USD moved out)
 *    and ENTRY_EQUITY_USD removed/updated before a restart.
 */
async function withdrawPartial(dlmmPool: DLMM, pct: number): Promise<void> {
  if (!activePositionPubkey) {
    await notify("⚠️ /withdraw_pct: no open position.");
    return;
  }
  if (!(pct >= 1 && pct <= 90)) {
    await notify("⚠️ Usage: /withdraw_pct N (1–90). Use /emergency_exit to close everything.");
    return;
  }
  if (isExiting || isLiquidating || isDeploying) {
    await notify("⏳ /withdraw_pct: another position action is in flight — try again in a minute.");
    return;
  }
  isBotPaused = true;
  isExiting = true;
  try {
    await notify(`⏸️ <b>[PAUSED]</b> Withdrawing ${pct}% of the position's liquidity to the wallet...`);
    if (!(await ensureTxFeeFloor("partial withdraw"))) {
      await notify("⚠️ /withdraw_pct aborted — native SOL below fee floor. Bot stays PAUSED; /resume to continue.");
      return;
    }
    await dlmmPool.refetchStates();
    const pos = await dlmmPool.getPosition(activePositionPubkey);
    const pre = await snapshotWalletBalances();
    const txs = await (dlmmPool as any).removeLiquidity({
      user: wallet.publicKey,
      position: activePositionPubkey,
      fromBinId: Number(pos.positionData.lowerBinId),
      toBinId: Number(pos.positionData.upperBinId),
      bps: new BN(Math.round(pct * 100)),
      shouldClaimAndClose: false,
    });
    const sigs: string[] = [];
    for (const tx of Array.isArray(txs) ? txs : [txs]) sigs.push(await sendAndConfirmTransaction(connection, tx, [wallet]));
    const post = await snapshotWalletBalances();
    const activeBin = await dlmmPool.getActiveBin();
    const spot = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;
    const solOut = Math.max(0, post.solEffectiveLamports - pre.solEffectiveLamports) / 1e9;
    const usdcOut = Math.max(0, post.usdcRaw - pre.usdcRaw) / 1e6;
    const usd = solOut * spot + usdcOut;
    partialWithdrawPending = true;
    await notify(
      `💸 <b>[PARTIAL WITHDRAW ${pct}%]</b> Moved to wallet: ${solOut.toFixed(4)} SOL + $${usdcOut.toFixed(2)} USDC (≈ $${usd.toFixed(2)} @ $${spot.toFixed(2)}).\n` +
        (TRANSFER_OUT.enabled
          ? `• Bot is <b>PAUSED</b> (stops OFF). Next: <code>/transfer_out 100%</code> (or a USD amount) → /confirm CODE, then /resume.\n`
          : `• Bot is <b>PAUSED</b> (stops OFF). Transfer the funds out now (keep ≥ ${(GAS_RESERVE_LAMPORTS / 1e9).toFixed(2)} SOL here).\n` +
            `• Then either /resume (entry equity re-based to live equity) or redeploy with NET_DEPOSITS_USD and ENTRY_EQUITY_USD updated.\n`) +
        `• Tx: <code>${sigs.join(",")}</code>`
    );
    void emitLedger({
      event: "PARTIAL_WITHDRAW",
      spot_usd: spot,
      position_value_usd: usd,
      tx_sig: sigs.join(","),
      swap_in_amount: solOut,
      swap_out_amount: usdcOut,
      swap_direction: "POSITION→wallet",
      notes: `Partial withdraw ${pct}% to LP wallet (≈ $${usd.toFixed(2)}); bot paused for external transfer`,
      is_estimate: false,
    });
  } catch (err: any) {
    const msg = redactSecrets(String(err?.message || err)).slice(0, 300);
    console.error("[PARTIAL WITHDRAW ERROR]:", msg);
    await notify(`⚠️ <b>[PARTIAL WITHDRAW FAILED]</b> ${escapeHtml(msg)}. Bot stays PAUSED; /resume to continue.`);
  } finally {
    isExiting = false;
  }
}

// ==================== /transfer_out (allow-listed, confirmed) ====================
/**
 * Boot: re-derive every /transfer_out this LP wallet made (on-chain memo + actual transfers), so the capital
 * baseline and a stale ENTRY_EQUITY_USD pin stay right across restarts without env edits. Scans the LP wallet's
 * signatures back to the feature epoch; only signatures whose memo carries the transfer-out tag are fetched.
 * Runs whether or not TRANSFER_OUT_ALLOWLIST is set (unsetting it after a transfer must not change P&L).
 */
async function initTransferOutHistory(): Promise<void> {
  const h = emptyTransferOutHistory();
  const work = (async () => {
    const lpWallet = wallet.publicKey.toBase58();
    const lpUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey).toBase58();
    const ctx = {
      lpWallet,
      lpUsdcAta,
      usdcMint: USDC_MINT.toBase58(),
      usdcAtaOf: (owner: string) => getAssociatedTokenAddressSync(USDC_MINT, new PublicKey(owner), true).toBase58(),
    };
    let before: string | undefined;
    const hits: string[] = [];
    while (h.scannedSigs < TRANSFER_OUT_SCAN_MAX_SIGS) {
      const limit = Math.min(1000, TRANSFER_OUT_SCAN_MAX_SIGS - h.scannedSigs);
      const page = await connection.getSignaturesForAddress(wallet.publicKey, { before, limit }, "confirmed");
      h.scannedSigs += page.length;
      let reachedEpoch = false;
      for (const x of page) {
        if (x.blockTime != null && x.blockTime < TRANSFER_OUT_FEATURE_EPOCH_UNIX) {
          reachedEpoch = true;
          break;
        }
        if (signatureHasTransferOutMemo(x)) hits.push(x.signature);
      }
      if (reachedEpoch || page.length < limit) {
        h.complete = true;
        break;
      }
      before = page[page.length - 1].signature;
    }
    for (let i = 0; i < hits.length; i += 10) {
      const txs = await connection.getParsedTransactions(hits.slice(i, i + 10), { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      for (const tx of txs) {
        const t = parseTransferOutTx(tx, ctx);
        if (t) addToHistory(h, t);
      }
    }
    h.ok = true;
  })();
  try {
    await Promise.race([work, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 45s")), 45_000))]);
  } catch (err: any) {
    h.ok = false;
    console.warn(`[TRANSFER_OUT] history scan failed: ${redactSecrets(String(err?.message || err))}`);
  }
  transferOutHistory = h;
  if (h.ok && h.complete) {
    priorTransferOutUsd = h.totalUsd;
    priorTransferOutSource = h.count > 0 ? `on-chain (${h.count} transfer${h.count === 1 ? "" : "s"})` : "none";
  } else {
    priorTransferOutUsd = Math.max(h.ok ? h.totalUsd : 0, TRANSFER_OUT_PRIOR_USD);
    priorTransferOutSource = h.ok ? "on-chain scan INCOMPLETE (max of partial and TRANSFER_OUT_PRIOR_USD)" : "env TRANSFER_OUT_PRIOR_USD (scan failed)";
    if (priorTransferOutUsd === 0) console.warn("[TRANSFER_OUT] history not fully verified and TRANSFER_OUT_PRIOR_USD unset — assuming $0 transferred out.");
  }
  console.log(
    `[TRANSFER_OUT] ${TRANSFER_OUT.enabled ? `enabled → ${TRANSFER_OUT.address} (cap $${TRANSFER_OUT_MAX_USD} / ${TRANSFER_OUT_MAX_EQUITY_PCT}% of equity)` : `disabled (${TRANSFER_OUT.reason})`}` +
      ` | prior transferred out $${priorTransferOutUsd.toFixed(2)} (${priorTransferOutSource}; ${h.scannedSigs} sigs scanned)`
  );
}

function transferGate(chatId: string, userId: string) {
  return checkTransferPreconditions({
    enabled: TRANSFER_OUT.enabled,
    disabledReason: TRANSFER_OUT.reason,
    chatIdConfigured: !!TELEGRAM_CHAT_ID,
    chatMatches: !!TELEGRAM_CHAT_ID && chatId === TELEGRAM_CHAT_ID.trim(),
    userAllowed: TRANSFER_OUT_USER_IDS.size === 0 || TRANSFER_OUT_USER_IDS.has(userId),
    paused: isBotPaused,
    partialWithdrawPending,
    hasOpenPosition: !!activePositionPubkey,
    busy: isExiting || isLiquidating || isDeploying || solTransferInFlight,
  });
}

/** Fresh inputs for sizing: balances, spot, live equity, whether the destination USDC account must be created. */
async function transferInputs(): Promise<{ usdcRaw: number; nativeLamports: number; spotUsd: number; equityUsd: number | null; needsAta: boolean }> {
  if (!dlmmPoolInstance || !TRANSFER_OUT.address) throw new Error("not ready");
  await dlmmPoolInstance.refetchStates();
  const ab = await dlmmPoolInstance.getActiveBin();
  const spotUsd = Number(ab.price) * PRICE_DECIMAL_FACTOR;
  const bal = await snapshotWalletBalances();
  const pr = await probeEquityWithRetry(dlmmPoolInstance, spotUsd, activePositionPubkey, 2);
  const destAta = getAssociatedTokenAddressSync(USDC_MINT, new PublicKey(TRANSFER_OUT.address), true);
  const needsAta = !(await connection.getAccountInfo(destAta, "confirmed"));
  return { usdcRaw: bal.usdcRaw, nativeLamports: bal.nativeLamports, spotUsd, equityUsd: pr.ok ? pr.totalUsd ?? null : null, needsAta };
}

function sizingParams(inp: { needsAta: boolean }) {
  return {
    gasReserveLamports: GAS_RESERVE_LAMPORTS,
    marginLamports: TRANSFER_OUT_SOL_MARGIN_LAMPORTS,
    txFeeLamports: SOL_TRANSFER_FEE_LAMPORTS,
    ataRentLamports: inp.needsAta ? ATA_RENT_LAMPORTS : 0,
    maxUsd: TRANSFER_OUT_MAX_USD,
    maxEquityPct: TRANSFER_OUT_MAX_EQUITY_PCT,
  };
}

/** Step 1: `/transfer_out <usd|pct%> [usdc]` → exact quote + one-time code (nothing is sent). */
async function handleTransferOutRequest(rawText: string, chatId: string, userId: string): Promise<void> {
  const gate = transferGate(chatId, userId);
  if (!gate.ok) {
    if (gate.reason !== "wrong chat") await notify(`⛔ /transfer_out refused: ${escapeHtml(gate.reason)}`);
    return;
  }
  const cmd = parseTransferOutCommand(rawText);
  if (!cmd.ok) {
    await notify(`⚠️ ${escapeHtml((cmd as { error: string }).error)}`);
    return;
  }
  try {
    const inp = await transferInputs();
    if (!isValidSpot(inp.spotUsd)) throw new Error(`invalid spot ${inp.spotUsd}`);
    const plan = planTransferOut({ req: (cmd as { req: TransferRequest }).req, usdcRaw: inp.usdcRaw, nativeLamports: inp.nativeLamports, spotUsd: inp.spotUsd, equityUsd: inp.equityUsd, ...sizingParams(inp) });
    if (!plan.ok) {
      await notify(`⛔ /transfer_out refused: ${escapeHtml(plan.reason)}`);
      return;
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    transferConfirmations.create(
      { req: (cmd as { req: TransferRequest }).req, usdcRaw: plan.usdcRaw, lamports: plan.lamports, usd: plan.usd, spot: inp.spotUsd, needsAta: inp.needsAta },
      chatId, userId, Date.now(), code
    );
    await notify(
      `🔐 <b>[TRANSFER OUT — CONFIRM]</b>\n` +
        `• To (allow-list): <code>${TRANSFER_OUT.address}</code>\n` +
        `• Amount: $${(plan.usdcRaw / 1e6).toFixed(2)} USDC + ${(plan.lamports / 1e9).toFixed(6)} SOL ≈ <b>$${plan.usd.toFixed(2)}</b> @ $${inp.spotUsd.toFixed(2)}\n` +
        `• LP wallet keeps ${(plan.remainingLamports / 1e9).toFixed(4)} SOL native (floor ${(plan.floorLamports / 1e9).toFixed(4)})` +
        (inp.needsAta ? `; incl. 0.00204 SOL to create the destination USDC account` : "") + `\n` +
        `• Transferable now: $${plan.transferableUsd.toFixed(2)} | caps: $${TRANSFER_OUT_MAX_USD} and ${TRANSFER_OUT_MAX_EQUITY_PCT}% of equity ($${(inp.equityUsd ?? 0).toFixed(2)})\n` +
        `Reply <code>/confirm ${code}</code> within ${Math.round(TRANSFER_OUT_CONFIRM_TTL_MS / 1000)}s to send, or /cancel.`
    );
  } catch (err: any) {
    await notify(`⚠️ /transfer_out failed to quote: ${escapeHtml(redactSecrets(String(err?.message || err)).slice(0, 200))}`);
  }
}

/** Step 2: `/confirm <code>` → re-check everything, send exactly the quoted amounts, adjust accounting. */
async function handleTransferOutConfirm(rawText: string, chatId: string, userId: string): Promise<void> {
  if (!TRANSFER_OUT.enabled || !TELEGRAM_CHAT_ID || chatId !== TELEGRAM_CHAT_ID.trim()) return;
  const code = parseConfirmCommand(rawText);
  if (!code) {
    await notify("⚠️ Usage: /confirm 123456");
    return;
  }
  const c = transferConfirmations.confirm(code, chatId, userId, Date.now());
  if (!c.ok) {
    const why: Record<string, string> = {
      none: "nothing pending", expired: "code expired — run /transfer_out again", wrong_chat: "wrong chat",
      wrong_user: "only the user who requested it can confirm", wrong_code: "wrong code",
      too_many_attempts: "too many wrong codes — request cancelled",
    };
    await notify(`⛔ /confirm refused: ${why[(c as { reason: string }).reason]}`);
    return;
  }
  const gate = transferGate(chatId, userId);
  if (!gate.ok) {
    await notify(`⛔ /confirm refused: ${escapeHtml(gate.reason)}`);
    return;
  }
  await executeTransferOut((c as { pending: { plan: QuotedTransfer } }).pending.plan);
}

async function executeTransferOut(q: QuotedTransfer): Promise<void> {
  if (!TRANSFER_OUT.address) return;
  const dest = new PublicKey(TRANSFER_OUT.address);
  solTransferInFlight = true;
  try {
    const inp = await transferInputs();
    const v = revalidateQuotedPlan(
      { usdcRaw: q.usdcRaw, lamports: q.lamports },
      { usdcRaw: inp.usdcRaw, nativeLamports: inp.nativeLamports, spotUsd: inp.spotUsd, equityUsd: inp.equityUsd, ...sizingParams(inp) }
    );
    if (!v.ok) {
      await notify(`⛔ /transfer_out not sent: ${escapeHtml(v.reason)}. Nothing moved — run /transfer_out again.`);
      return;
    }
    const usd = v.usd;
    const eqAfter = entryEquityUsd > 0 ? Math.max(0, entryEquityUsd - usd) : undefined;
    const memoText = buildTransferOutMemo({
      to: dest.toBase58(), usd, usdcRaw: q.usdcRaw, lamports: q.lamports, spot: inp.spotUsd,
      pos: activePositionPubkey?.toBase58() || "none", eqAfter,
    });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight });
    if (q.usdcRaw > 0) {
      const srcAta = getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey);
      const destAta = getAssociatedTokenAddressSync(USDC_MINT, dest, true);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, destAta, dest, USDC_MINT));
      tx.add(createTransferCheckedInstruction(srcAta, USDC_MINT, destAta, wallet.publicKey, BigInt(q.usdcRaw), 6));
    }
    if (q.lamports > 0) tx.add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: dest, lamports: q.lamports }));
    tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from(memoText, "utf8") }));
    tx.sign(wallet);
    const sig = bs58.encode(tx.signature!);
    let sendErr: any = null;
    try {
      await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    } catch (e: any) {
      sendErr = e;
    }
    const status = await confirmOrResolveLanded(sig, blockhash, lastValidBlockHeight, sendErr);
    if (status !== "landed") {
      const detail = sendErr ? ` (${escapeHtml(redactSecrets(String(sendErr?.message || sendErr)).slice(0, 160))})` : "";
      await notify(
        status === "unknown"
          ? `⚠️ <b>[TRANSFER OUT UNKNOWN]</b> <code>${sig}</code> did not confirm in time. Check Solscan BEFORE retrying. ` +
              `Accounting not changed now; if it landed, the next boot picks it up from chain.${detail}`
          : `⚠️ <b>[TRANSFER OUT FAILED]</b> ${status}${detail}. Nothing moved. Bot stays PAUSED.`
      );
      void emitLedger({ event: "ERROR", tx_sig: sig, notes: `TRANSFER_OUT ${status}: $${usd.toFixed(2)} to ${dest.toBase58()}`, is_estimate: true });
      return;
    }
    const feeSol = await getTxFeeSol(sig);
    if (feeSol != null) cumulativeGasSol += feeSol;
    const before = { capitalBaselineUsd, entryEquityUsd };
    const next = applyTransferOut({ capitalBaselineUsd, entryEquityUsd, transferredOutUsd: transferredOutThisProcessUsd }, usd);
    capitalBaselineUsd = next.capitalBaselineUsd;
    entryEquityUsd = next.entryEquityUsd;
    transferredOutThisProcessUsd = next.transferredOutUsd;
    await notify(
      `✅ <b>[TRANSFER OUT]</b> $${(q.usdcRaw / 1e6).toFixed(2)} USDC + ${(q.lamports / 1e9).toFixed(6)} SOL ≈ <b>$${usd.toFixed(2)}</b> → <code>${dest.toBase58()}</code>\n` +
        `• Capital baseline $${before.capitalBaselineUsd.toFixed(2)} → $${capitalBaselineUsd.toFixed(2)} (recorded on chain; no NET_DEPOSITS_USD change needed)\n` +
        `• Entry equity $${before.entryEquityUsd.toFixed(2)} → $${entryEquityUsd.toFixed(2)}` +
        (ENTRY_EQUITY_USD_ENV ? ` — ENTRY_EQUITY_USD is pinned: set it to ${entryEquityUsd.toFixed(2)} (or delete it) at your next env edit` : "") + `\n` +
        `• Bot still <b>PAUSED</b>. /resume re-bases entry equity to live equity and resumes stops.\n` +
        `• Tx: <code>${sig}</code>`
    );
    await emitLedger({
      event: "TRANSFER_OUT",
      spot_usd: inp.spotUsd,
      transfer_out_usd: usd,
      transfer_out_usdc: q.usdcRaw / 1e6,
      transfer_out_sol: q.lamports / 1e9,
      transfer_to: dest.toBase58(),
      capital_baseline_usd: capitalBaselineUsd,
      gas_fee_sol: feeSol ?? undefined,
      gas_fee_usd: feeSol != null ? feeSol * inp.spotUsd : undefined,
      tx_sig: sig,
      notes: `Transfer out to allow-listed wallet: ${(q.usdcRaw / 1e6).toFixed(6)} USDC + ${(q.lamports / 1e9).toFixed(9)} SOL @ $${inp.spotUsd.toFixed(4)} = $${usd.toFixed(2)} (capital withdrawal, not a fee sweep)`,
      is_estimate: false,
    });
  } catch (err: any) {
    await notify(`⚠️ <b>[TRANSFER OUT ERROR]</b> ${escapeHtml(redactSecrets(String(err?.message || err)).slice(0, 200))}. Bot stays PAUSED.`);
  } finally {
    solTransferInFlight = false;
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
  const exitClose = await closePositionAndReclaim(dlmmPool);
  if (!exitClose.ok) {
    await reattachAfterFailedClose(dlmmPool, exitClose, activePositionPubkey);
    await notify(
      "🚨 <b>[EMERGENCY EXIT INCOMPLETE]</b> Position could not be closed — bot stays PAUSED (no SOL dump). " +
        "Retry /emergency_exit or withdraw in the Meteora UI."
    );
    return;
  }

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

  // Capture cycle entry BEFORE clearing entry state (per-cycle realized P&L).
  const cycleEntryEquityUsd = entryEquityUsd;
  const cycleSweptUsd = sweptSinceEntryUsd;

  activePositionPubkey = null;
  lowestBinPrice = 0;
  highestBinPrice = 0;
  clearEntryState();
  
  await dlmmPool.refetchStates();
  const activeBin = await dlmmPool.getActiveBin();
  lastExitPriceUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;

  // Exit equity = full wallet (USDC + SOL gas reserve), same basis as entry equity.
  let exitEquityUsd = postLiquidationUsdc;
  try {
    exitEquityUsd = Number((await getWalletLiquidEquityUsd(lastExitPriceUsd)).totalUsd.toFixed(2));
  } catch {}
  const cyclePnl = cycleRealizedPnlUsd(exitEquityUsd, cycleEntryEquityUsd, cycleSweptUsd);
  const totalPnl = totalPnlUsd(exitEquityUsd);
  const cyclePnlText = cyclePnl != null
    ? `${fmtSignedUsd(cyclePnl)} (${fmtPct(cyclePnl, cycleEntryEquityUsd)} vs entry equity $${cycleEntryEquityUsd.toFixed(2)})`
    : "n/a (no entry recorded)";

  await notify(
    `🛡️ <b>[EMERGENCY EXIT COMPLETE]</b> Bot is paused. Funds held in USDC.\n` +
    `• Recovered: $${postLiquidationUsdc.toFixed(2)} USDC (equity $${exitEquityUsd.toFixed(2)})\n` +
    `• Cycle PnL: ${cyclePnlText}\n` +
    `• Net PnL vs capital: ${fmtSignedUsd(totalPnl)} (${fmtPct(totalPnl, capitalBaselineUsd)} of ${capitalBaselineLabel()}, incl. $${sweptForPnlUsd().toFixed(2)} swept)\n` +
    `• Tx: <code>${swapSig || "N/A"}</code>`
  );
  await emitLedger({
    event: "EMERGENCY_EXIT",
    realized_pnl_usd: cyclePnl ?? undefined,
    total_equity_usd: exitEquityUsd,
    entry_equity: cycleEntryEquityUsd || undefined,
    ...pnlLedgerExtras(exitEquityUsd),
    tx_sig: swapSig || "N/A",
    notes: `Manual Emergency Exit. Cycle PnL: ${cyclePnlText}. Net PnL vs capital: ${fmtSignedUsd(totalPnl)}`,
    is_estimate: false,
  });
  } finally {
    isExiting = false;
    isLiquidating = false;
  }
}

// ==================== RESILIENT TELEGRAM COMMAND LISTENER ====================
async function listenTelegramCommands() {
  if (!TELEGRAM_BOT_TOKEN) return;
  if (!TELEGRAM_COMMANDS_ENABLED) {
    console.log("🤖 Telegram commands DISABLED (TELEGRAM_COMMANDS_ENABLED=false) — notifications only, no getUpdates polling.");
    return;
  }

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
            `• <b>/withdraw_pct N</b> - Pause and withdraw N% of the position to the wallet (for a transfer out)\n` +
            (TRANSFER_OUT.enabled
              ? `• <b>/transfer_out &lt;usd|pct%&gt; [usdc]</b> - Send withdrawn funds to the allow-listed wallet <code>${TRANSFER_OUT.address}</code> (then /confirm CODE within 60s; /cancel)\n`
              : "") +
            `• <b>/pause</b> - Freeze automated redeployments\n` +
            `• <b>/resume</b> - Unpause bot and resume strategy loops`;
          await notify(helpMsg);
        } else if (text === "/regime") {
          await notify("🔍 Querying Macro Sentinel feeds...");
          const config = await macroSentinel.evaluateRegime(SOL_USDC_POOL.toBase58(), true);
          const d = config.details;
          const haveRead = config.score != null;
          const rMsg =
            `🌐 <b>Macro Sentinel State</b>\n\n` +
            `• <b>Regime:</b> <code>${config.regime}</code>${config.provisional ? " (provisional)" : ""} — ${config.source}\n` +
            `• <b>Score:</b> ${haveRead ? `<b>${config.score!.toFixed(1)}</b> (BULL ≥90, BEAR <35) → raw ${config.rawRegime}` : "n/a (no good read yet)"}\n` +
            (haveRead
              ? `• <b>Trend:</b> ${d.trendPts >= 0 ? "+" : ""}${d.trendPts.toFixed(1)} — ` +
                (d.trendKnown
                  ? `$${d.solPrice.toFixed(2)} vs SMA200 $${d.sma200.toFixed(2)} (${d.trendLongPts >= 0 ? "+" : ""}${d.trendLongPts.toFixed(1)}), ` +
                    (Number.isFinite(d.sma50)
                      ? `vs SMA50 $${d.sma50.toFixed(2)} (${d.trendMedPts >= 0 ? "+" : ""}${d.trendMedPts.toFixed(1)}), ` +
                        `cross ${(((d.sma50 / d.sma200) - 1) * 100).toFixed(1)}% (${d.crossPts >= 0 ? "+" : ""}${d.crossPts.toFixed(1)})`
                      : `SMA50 unknown (0)`) +
                    ` — ${escapeHtml(d.smaSource)}`
                  : `unknown → neutral (${escapeHtml(d.smaSource)})`) + `\n` +
                `• <b>Funding:</b> ${d.fundingPts >= 0 ? "+" : ""}${d.fundingPts.toFixed(1)} — ` +
                (d.fundingKnown ? `${d.fundingAnnual.toFixed(2)}% APR (${escapeHtml(d.fundingSource)})` : "unknown → neutral") + `\n` +
                `• <b>Direction:</b> ${d.dirPts >= 0 ? "+" : ""}${d.dirPts.toFixed(1)} — ` +
                (d.directionKnown
                  ? `vs EMA20(1h) ${d.emaGapPct.toFixed(2)}%, 4h ${d.mom4hPct.toFixed(2)}%, 24h ${d.mom24hPct.toFixed(2)}%`
                  : "unknown → neutral") + `\n`
              : "") +
            (config.holdReason ? `• <b>Hysteresis:</b> ${escapeHtml(config.holdReason)}\n` : "") +
            (config.lastFailure ? `• <b>Last error:</b> ${escapeHtml(redactSecrets(config.lastFailure))}\n` : "") +
            `• <b>Price stop (open position):</b> ${activePositionPubkey ? stopLockLabel() : "N/A"}\n` +
            (() => {
              const r = rangeForProfile(config);
              return `• <b>Active Profile:</b> -${r.bidPct.toFixed(1)}% Bids / +${r.askPct.toFixed(1)}% Asks (${r.bidBins}/${r.askBins} bins @ ${poolBinStep} bps${r.source === "regime profile" ? "" : `; ${escapeHtml(r.source)}`})\n`;
            })() +
            `• <b>Target Deploy:</b> ${(DEPLOY_PCT * 100).toFixed(0)}% (env DEPLOY_PCT; regime table kept for bins/stops)`;
          await notify(rMsg);
        } else if (text.startsWith("/transfer_out")) {
          await handleTransferOutRequest(String(msg.text), incomingChatId, String(msg.from?.id ?? ""));
        } else if (text.startsWith("/confirm")) {
          await handleTransferOutConfirm(String(msg.text), incomingChatId, String(msg.from?.id ?? ""));
        } else if (text === "/cancel") {
          await notify(transferConfirmations.cancel() ? "❎ Pending /transfer_out cancelled." : "Nothing pending.");
        } else if (text.startsWith("/withdraw_pct")) {
          const pct = Number(text.split(/\s+/)[1]);
          if (dlmmPoolInstance) await withdrawPartial(dlmmPoolInstance, pct);
        } else if (text === "/emergency_exit") {
          if (dlmmPoolInstance) await executeFullEmergencyExit(dlmmPoolInstance);
        } else if (text === "/pause") {
          isBotPaused = true;
          await notify("⏸️ <b>[PAUSED]</b> Deployments frozen. Standing by in current state.");
        } else if (text === "/resume") {
          if (transferConfirmations.cancel()) await notify("❎ Pending /transfer_out cancelled by /resume.");
          if (partialWithdrawPending && dlmmPoolInstance && activePositionPubkey) {
            // Funds were pulled for an external transfer: re-base entry equity so the equity stop measures
            // from what is left, not from the pre-withdrawal equity. Refuse to resume on a failed read.
            await dlmmPoolInstance.refetchStates();
            const ab = await dlmmPoolInstance.getActiveBin();
            const spotNow = Number(ab.price) * PRICE_DECIMAL_FACTOR;
            const pr = await probeEquityWithRetry(dlmmPoolInstance, spotNow, activePositionPubkey, 3);
            if (!pr.ok) {
              await notify(`⚠️ /resume refused: equity read failed (${escapeHtml(pr.reason || "unknown")}). Still PAUSED — try again.`);
              continue;
            }
            const before = entryEquityUsd;
            entryEquityUsd = pr.totalUsd;
            entryEquityPending = false;
            partialWithdrawPending = false;
            await notify(
              `ℹ️ Entry equity re-based after partial withdrawal: $${before.toFixed(2)} → $${entryEquityUsd.toFixed(2)}. ` +
                (transferredOutThisProcessUsd > 0
                  ? `Transfers made with /transfer_out are already in the capital baseline (on chain) — do NOT add them to NET_DEPOSITS_USD. ` +
                    (ENTRY_EQUITY_USD_ENV ? `Update ENTRY_EQUITY_USD to ${entryEquityUsd.toFixed(2)} (or remove it) at your next env edit.` : "")
                  : `Funds moved out by hand: set NET_DEPOSITS_USD for the amount and update/remove ENTRY_EQUITY_USD before the next restart.`)
            );
            logEntryPinHint();
          }
          isBotPaused = false;
          inCooldownUntil = 0;
          markStopsArmed(); // don't fire a "stops blind" alert for the paused period
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
            `• <b>Capital Baseline:</b> ${capitalBaselineLabel()}\n` +
            `• <b>Swept to Revenue (counted in PnL):</b> $${sweptForPnlUsd().toFixed(2)}\n` +
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
          let statusReadWarning = "";

          // /status is display-only for read results: a flaky/empty/partial read must never clear the
          // active position (that would disable stops and arm a second deploy) or corrupt the range.
          if (hasActivePosition) {
            const pos = userPositions.find((p: any) => activePositionPubkey && p.publicKey.equals(activePositionPubkey)) || userPositions[0];
            if (!activePositionPubkey) activePositionPubkey = pos.publicKey;
            if (isValidSpot(currentPrice) && pos?.positionData && pos.publicKey.equals(activePositionPubkey)) {
              const lo = calculateBinPriceUsd(currentPrice, activeBin.binId, pos.positionData.lowerBinId, poolBinStep);
              const hi = calculateBinPriceUsd(currentPrice, activeBin.binId, pos.positionData.upperBinId, poolBinStep);
              if (isValidSpot(lo) && isValidSpot(hi) && hi > lo) {
                lowestBinPrice = lo;
                highestBinPrice = hi;
              }
            }
          } else if (activePositionPubkey) {
            statusReadWarning = "⚠️ Position lookup returned none — keeping tracked position (possible bad read).\n";
          }

          const trackingPosition = hasActivePosition || !!activePositionPubkey;
          const rangeDisplay = trackingPosition
            ? `$${lowestBinPrice.toFixed(2)} ➔ $${highestBinPrice.toFixed(2)}`
            : "None (Liquidated to 100% USDC)";
          const stopDisplay = trackingPosition ? `${formatFloorStopLine()}\n• <b>Stop Lock:</b> ${stopLockLabel()}` : "N/A";

          const nowSec = Math.floor(Date.now() / 1000);
          let gateTelemetry = "";

          if (isBotPaused) {
            gateTelemetry = "⏸️ <b>PAUSED:</b> Deployments frozen by operator.";
          } else if (trackingPosition) {
            const nowS = Math.floor(Date.now() / 1000);
            const blindFor = Math.max(nowS - lastPriceStopEvalAt, entryEquityUsd > 0 || entryEquityPending ? nowS - lastEquityStopEvalAt : 0);
            gateTelemetry =
              statusReadWarning +
              (blindFor >= 60
                ? `⚠️ <b>Active, stops degraded:</b> last trustworthy stop read ${Math.round(blindFor)}s ago (${escapeHtml(lastReadFailureReason || "n/a")}).`
                : "🟢 <b>Active:</b> Monitoring open on-chain grid.") +
              (entryEquityPending ? "\n⏳ Entry equity pending first good read (equity stop not armed yet)." : "");
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

          let statusEquityUsd: number | null = null;
          try {
            statusEquityUsd = await getMarkToMarketEquityUsd(dlmmPoolInstance, currentPrice);
          } catch {}
          const statusPnl = statusEquityUsd != null ? totalPnlUsd(statusEquityUsd) : null;

          const statusMsg =
            `📊 <b>DLMM Keeper Status</b>\n\n` +
            `• <b>Regime:</b> <code>${config.regime}</code> (${escapeHtml(regimeSentinel.summary())})\n` +
            `• <b>Spot:</b> $${currentPrice.toFixed(2)}\n` +
            `• <b>Exact On-Chain Range:</b> ${rangeDisplay}\n` +
            `• <b>Floor Stop:</b> ${stopDisplay}\n` +
            `• <b>Equity (MTM):</b> ${statusEquityUsd != null ? `$${statusEquityUsd.toFixed(2)}` : "n/a"}\n` +
            `• <b>Capital Baseline:</b> ${capitalBaselineLabel()}\n` +
            `• <b>Net PnL:</b> ${statusPnl != null ? `${fmtSignedUsd(statusPnl)} (${fmtPct(statusPnl, capitalBaselineUsd)}, incl. $${sweptForPnlUsd().toFixed(2)} swept)` : "n/a"}\n` +
            `• <b>Next Fee Sweep:</b> ${nextSweepLabel()}\n` +
            `• <b>Position NFT:</b> <code>${activePositionPubkey ? activePositionPubkey.toBase58() : "None (Holding Cash)"}</code>\n\n` +
            `${gateTelemetry}`;
          await notify(statusMsg);
        } else if (text === "/harvest" || text === "harvest" || text === "sweep") {
          if (!dlmmPoolInstance || !activePositionPubkey) {
            await notify("⚠️ Cannot harvest: No active open DLMM position detected.");
            continue;
          }
          await notify("⏳ Checking and sweeping fees to LP Revenue...");
          const sweptAmount = await sweepRevenueToVault(dlmmPoolInstance);
          if (sweptAmount > 0) {
            await notify(`✅ Sweep complete: $${sweptAmount.toFixed(2)} sent to LP Revenue (USDC + any native fee SOL).`);
          } else {
            await notify("ℹ️ No surplus fees available to sweep.");
          }
        }
      }
    } catch (err: any) {
      if (err.response?.status === 409) {
        // Common during Railway rolling deploys when old+new both poll getUpdates.
        console.error("❌ [TELEGRAM 409 CONFLICT] Another process is polling this bot token (rolling deploy, or a second instance — set TELEGRAM_COMMANDS_ENABLED=false or its own TELEGRAM_BOT_TOKEN there). Backing off 30s...");
        await new Promise((resolve) => setTimeout(resolve, 30000));
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// ==================== ONE-TIME CATCH-UP: LEFTOVER FEE SOL → REVENUE ====================
/**
 * Env-driven one-shot (CATCHUP_SOL_SWEEP_LAMPORTS / CATCHUP_SOL_SWEEP_ID). Safe across restarts:
 *  - runs CATCHUP_SOL_SWEEP_DELAY_SEC (≥120s) after boot, so a tx sent by a previous process has landed or
 *    expired before the guard scan;
 *  - the transfer carries memo "dlmm-keeper:catchup-sol-sweep id=<ID> …" signed by the LP wallet; a fresh
 *    on-chain scan that finds that id means "already done" → nothing is sent (remove the env afterwards);
 *  - fails closed if the scan fails or is incomplete; never sends twice in one process (even on "unknown");
 *  - full amount must fit above GAS_RESERVE + FEE_SOL_SWEEP_MARGIN (no partial send); capped at
 *    CATCHUP_SOL_SWEEP_MAX_LAMPORTS (≤ 0.1 SOL hard ceiling).
 */
async function runCatchupSolSweep(attempt = 1): Promise<void> {
  if (!(CATCHUP_SOL_SWEEP_LAMPORTS > 0) || catchupSentThisProcess) return;
  const retryLater = (why: string) => {
    if (attempt >= 6) {
      void notify(`⚠️ Catch-up SOL sweep (id ${CATCHUP_SOL_SWEEP_ID}) gave up after ${attempt} attempts: ${why}`);
      return;
    }
    console.warn(`[CATCHUP] deferred (${why}); retry in 5 min`);
    setTimeout(() => void runCatchupSolSweep(attempt + 1), 5 * 60 * 1000);
  };
  if (isExiting || isDeploying || isLiquidating || solTransferInFlight || !dlmmPoolInstance) {
    retryLater("bot busy (exit/deploy/transfer in progress)");
    return;
  }
  let h: SweepHistory;
  try {
    h = await withTimeout(scanSweepHistoryOnChain(), 60_000, "catch-up guard scan");
  } catch (err: any) {
    h = { ok: false, complete: false, lastSweepUnix: null, lastSweepSig: null, totalSweptUsd: 0, sweepCount: 0, scannedSigs: 0,
      reason: redactSecrets(String(err?.message || err)) };
  }
  let native = 0;
  try {
    native = await connection.getBalance(wallet.publicKey, "confirmed");
  } catch (err: any) {
    retryLater(`balance read failed: ${err?.message || err}`);
    return;
  }
  const d = decideCatchup({
    configuredLamports: CATCHUP_SOL_SWEEP_LAMPORTS,
    capLamports: CATCHUP_SOL_SWEEP_MAX_LAMPORTS,
    id: CATCHUP_SOL_SWEEP_ID,
    scanOk: h.ok,
    scanComplete: h.complete,
    priorCatchupIds: h.catchupIds ?? new Set<string>(),
    sentThisProcess: catchupSentThisProcess,
    nativeLamports: native,
    gasReserveLamports: GAS_RESERVE_LAMPORTS,
    marginLamports: FEE_SOL_SWEEP_MARGIN_LAMPORTS,
    txFeeLamports: SOL_TRANSFER_FEE_LAMPORTS,
  });
  if (!d.send) {
    if (/already done/.test(d.reason)) {
      console.log(`[CATCHUP] ${d.reason} — nothing to do. You can remove CATCHUP_SOL_SWEEP_LAMPORTS.`);
      return;
    }
    if (/scan (failed|incomplete)/.test(d.reason)) {
      retryLater(d.reason + (h.reason ? `: ${h.reason}` : ""));
      return;
    }
    await notify(`⚠️ Catch-up SOL sweep (id ${CATCHUP_SOL_SWEEP_ID}) NOT sent: ${d.reason}`);
    return;
  }
  let spot = NaN;
  try {
    await dlmmPoolInstance.refetchStates();
    spot = Number((await dlmmPoolInstance.getActiveBin()).price) * PRICE_DECIMAL_FACTOR;
  } catch {}
  if (!isValidSpot(spot)) {
    retryLater("no valid spot");
    return;
  }
  catchupSentThisProcess = true; // set BEFORE sending: never a second send from this process
  const t = await sendSolToRevenue(
    d.lamports,
    spot,
    { kind: "catchup-sol-sweep", id: CATCHUP_SOL_SWEEP_ID },
    `One-time catch-up (id ${CATCHUP_SOL_SWEEP_ID}): leftover fee SOL from the Oct 9 2026 08:19 PT claim ` +
      `(tx 5jLmxgz6…; Jupiter swap 4B4K8qfQ… never landed). Fee already counted on that FEE_CLAIM row — this row is a sweep only.`
  );
  if (t.status === "landed") {
    await notify(
      `💰 <b>[CATCH-UP SOL SWEEP]</b> Sent <b>${(t.lamports / 1e9).toFixed(9)} SOL</b> ($${t.usd.toFixed(2)} @ $${spot.toFixed(2)}) ` +
        `to LP Revenue (id ${CATCHUP_SOL_SWEEP_ID}).\n• Destination: <code>${LP_REVENUE_VAULT.toBase58()}</code>\n• Tx: <code>${t.sig}</code>\n` +
        `Remove CATCHUP_SOL_SWEEP_LAMPORTS from Railway (it will be skipped anyway — the memo marks it done).`
    );
  } else if (t.status === "skipped" && !t.sig) {
    catchupSentThisProcess = false; // nothing was signed — allow a later retry
    retryLater(t.reason || "skipped");
  } else {
    await notify(
      `⚠️ Catch-up SOL sweep (id ${CATCHUP_SOL_SWEEP_ID}) status <b>${t.status}</b> (tx <code>${t.sig}</code>). ` +
        `Not retrying in this process; the next boot re-checks the chain before any resend.`
    );
  }
}

// ==================== MAIN LIFECYCLE CONTROLLER ====================
async function runKeeper() {
  await notify(
    "🚀 DLMM Automated Keeper initialized on Railway." +
      (POOL_ADDRESS !== DEFAULT_POOL_ADDRESS ? ` Pool: ${poolName()} <code>${POOL_ADDRESS}</code>` : "") +
      (TELEGRAM_BOT_TOKEN && !TELEGRAM_COMMANDS_ENABLED ? " (notifications only — Telegram commands disabled)" : "")
  );
  void emitLedger({ event: "BOOT", notes: "Keeper process started", is_estimate: true });
  dlmmPoolInstance = await DLMM.create(connection, SOL_USDC_POOL);
  {
    const lb: any = (dlmmPoolInstance as any).lbPair;
    const xMint = lb?.tokenXMint?.toBase58?.();
    const yMint = lb?.tokenYMint?.toBase58?.();
    // Spot math (PRICE_DECIMAL_FACTOR), swaps and balances assume X = SOL (9 dp), Y = USDC (6 dp).
    if (xMint !== WSOL_MINT.toBase58() || yMint !== USDC_MINT.toBase58()) {
      throw new Error(`POOL_ADDRESS ${POOL_ADDRESS} is not a SOL(X)/USDC(Y) pool (X=${xMint}, Y=${yMint}) — refusing to start.`);
    }
    const step = Number(lb?.binStep);
    if (!(step > 0)) throw new Error(`Could not read bin step for pool ${POOL_ADDRESS}`);
    const known = KNOWN_SOL_USDC_POOLS[POOL_ADDRESS]?.binStep;
    if (known && known !== step) console.warn(`[POOL] bin step on chain ${step} ≠ expected ${known} — using on-chain value.`);
    poolBinStep = step;
    const r = rangeForProfile(REGIME_PROFILES[DEFAULT_REGIME]);
    const g2 = gate2ThresholdBps(GATE2_MAX_VARIABLE_FEE_BPS_ENV, Number(lb?.parameters?.variableFeeControl ?? 0));
    console.log(
      `[POOL] ${poolName()} ${POOL_ADDRESS}${INSTANCE_LABEL ? ` | instance "${INSTANCE_LABEL}"` : ""} | ` +
        `default range ${r.bidBins}/${r.askBins} bins (−${r.bidPct.toFixed(2)}% / +${r.askPct.toFixed(2)}%; ${r.source}) | ` +
        `Gate 2 ≤ ${g2.bps} bps (${g2.source}) | Telegram commands ${TELEGRAM_COMMANDS_ENABLED ? "on" : "off"}`
    );
  }
  // Fee-sweep clock + prior swept total from chain (bounded by a timeout; never blocks boot on failure).
  await initSweepClock();
  await initTransferOutHistory();
  if (CATCHUP_SOL_SWEEP_LAMPORTS > 0) {
    console.log(
      `[CATCHUP] One-time SOL catch-up configured: ${CATCHUP_SOL_SWEEP_LAMPORTS} lamports (id ${CATCHUP_SOL_SWEEP_ID}); ` +
        `guard scan + send in ${CATCHUP_SOL_SWEEP_DELAY_SEC}s`
    );
    setTimeout(() => void runCatchupSolSweep(), CATCHUP_SOL_SWEEP_DELAY_SEC * 1000);
  }

  // Capital baseline (reporting only — never read by stops/TP/recenter/sizing), set ONCE here:
  // STARTING_CAPITAL_USD (+ NET_DEPOSITS_USD), else full MTM equity at boot (position + wallet).
  // Recomputed from scratch on every boot, so restarts can never accumulate/double it.
  let bootEquityUsd: number | null = null;
  // Spot at boot: retry a few times; refuse to start on a garbage price (Railway restarts the worker).
  let bootSpotUsd = NaN;
  for (let i = 0; i < 3 && !isValidSpot(bootSpotUsd); i++) {
    try {
      if (i > 0) await dlmmPoolInstance.refetchStates();
      const activeBin = await dlmmPoolInstance.getActiveBin();
      bootSpotUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;
    } catch (err: any) {
      console.warn(`[BOOT] spot read attempt ${i + 1} failed:`, err?.message || err);
    }
    if (!isValidSpot(bootSpotUsd) && i < 2) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!isValidSpot(bootSpotUsd)) throw new Error(`Unable to read a valid spot price at boot (${bootSpotUsd}).`);
  lastGoodSpotUsd = bootSpotUsd;
  {
    // Include open position inventory so boot equity isn't understated while LPing.
    // probeEquity never degrades to wallet-only on a failed position read.
    const p = await probeEquityWithRetry(dlmmPoolInstance, bootSpotUsd, null, 3);
    if (p.ok) bootEquityUsd = p.totalUsd;
    else console.warn("[BASELINE] Equity probe failed:", p.reason);
  }
  if (STARTING_CAPITAL_USD_ENV != null) {
    capitalBaselineUsd = baselineWithTransfersOut({
      source: "env",
      baselineUsd: Number((STARTING_CAPITAL_USD_ENV + NET_DEPOSITS_USD).toFixed(2)),
      priorTransferOutUsd,
    });
    capitalBaselineSource = "env";
  } else {
    capitalBaselineSource = "boot-equity";
    if (NET_DEPOSITS_USD !== 0 || PRIOR_SWEPT_USD !== 0) {
      console.warn("[BASELINE] NET_DEPOSITS_USD / PRIOR_SWEPT_USD ignored: STARTING_CAPITAL_USD unset (boot equity already reflects them).");
    }
    if (bootEquityUsd != null) {
      capitalBaselineUsd = bootEquityUsd;
    } else {
      // Don't crash-loop (that would leave an open position with no stops at all): fill on first good read.
      capitalBaselineUsd = 0;
      capitalBaselinePending = true;
      console.warn("[BASELINE] Boot equity unavailable — baseline pending first good equity read.");
    }
  }
  console.log(
    `[BASELINE] Capital baseline ${capitalBaselineLabel()}` +
      (bootEquityUsd != null ? ` | boot equity $${bootEquityUsd.toFixed(2)} | net P&L ${fmtSignedUsd(totalPnlUsd(bootEquityUsd))}` : "")
  );

  listenTelegramCommands().catch((e) => console.error("Command listener error:", e));

  let { userPositions } = await dlmmPoolInstance.getPositionsByUserAndLbPair(wallet.publicKey);
  if (userPositions.length === 0) {
    // Re-check once: a flaky empty read here would boot "in cash" and later open a second grid.
    await new Promise((r) => setTimeout(r, 3000));
    ({ userPositions } = await dlmmPoolInstance.getPositionsByUserAndLbPair(wallet.publicKey));
  }
  const config = await macroSentinel.evaluateRegime(SOL_USDC_POOL.toBase58());

  if (userPositions.length > 0) {
    // Attach to existing on-chain position — do NOT open a second grid on restart/redeploy.
    const pinnedPos = ENTRY_POSITION_PUBKEY_ENV
      ? userPositions.find((p: any) => p.publicKey.toBase58() === ENTRY_POSITION_PUBKEY_ENV)
      : undefined;
    const activePos = pinnedPos || userPositions[0];
    activePositionPubkey = activePos.publicKey;
    const attachedKey = activePositionPubkey.toBase58();

    const activeBin = await dlmmPoolInstance.getActiveBin();
    const attachBinId = activeBin.binId;
    const freshSpotUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;
    const spotPriceUsd = isValidSpot(freshSpotUsd) ? freshSpotUsd : bootSpotUsd;

    lowestBinPrice = calculateBinPriceUsd(spotPriceUsd, attachBinId, activePos.positionData.lowerBinId, poolBinStep);
    highestBinPrice = calculateBinPriceUsd(spotPriceUsd, attachBinId, activePos.positionData.upperBinId, poolBinStep);
    belowRangeTickCount = 0;
    markStopsArmed();

    // Entry pin: only at boot-attach, only for the exact pinned position (stale pins are ignored).
    const pinSpot = parseOptionalUsd("ENTRY_SPOT_USD");
    const pinEquity = parseOptionalUsd("ENTRY_EQUITY_USD");
    const pinRequested = !!(ENTRY_SPOT_USD_ENV || ENTRY_EQUITY_USD_ENV || ENTRY_STOP_PCT_ENV);
    let pinStatus = "none (entry = live values at attach)";
    let pinApplies = false;
    if (pinRequested) {
      if (!ENTRY_POSITION_PUBKEY_ENV) {
        pinStatus = "IGNORED — ENTRY_POSITION_PUBKEY unset (required so a pin can't go stale)";
      } else if (ENTRY_POSITION_PUBKEY_ENV !== attachedKey) {
        pinStatus = `IGNORED — stale: pinned ${ENTRY_POSITION_PUBKEY_ENV.slice(0, 8)}… ≠ attached ${attachedKey.slice(0, 8)}…`;
      } else {
        pinApplies = true;
        pinStatus = "applied (ENTRY_POSITION_PUBKEY matches)";
      }
      if (!pinApplies) console.warn(`[ENTRY] ENTRY_SPOT_USD/ENTRY_EQUITY_USD/ENTRY_STOP_PCT ${pinStatus}`);
    } else if (ENTRY_POSITION_PUBKEY_ENV && ENTRY_POSITION_PUBKEY_ENV !== attachedKey) {
      console.warn(`[ENTRY] ENTRY_POSITION_PUBKEY ${ENTRY_POSITION_PUBKEY_ENV} not found among open positions; attached ${attachedKey}.`);
    }

    // Price-stop % lock: pinned value, else RANGE 5% (never the live regime — a restart can't move the stop).
    const stopLockRes = resolveAttachStopLock(ENTRY_STOP_PCT_ENV, pinApplies);
    entryStopLock = stopLockRes.lock;
    if (stopLockRes.warning) console.warn(`[ENTRY] ${stopLockRes.warning}`);

    if (pinApplies && pinSpot != null && pinSpot > 0) {
      entrySpotUsd = pinSpot;
    } else {
      entrySpotUsd = spotPriceUsd;
      console.warn(
        `[ENTRY] Entry spot not pinned — using current spot $${spotPriceUsd.toFixed(2)} as entry (entry reset on restart).`
      );
    }
    if (pinApplies && pinEquity != null && pinEquity > 0) {
      // A /transfer_out after the pin was taken lowers this position's entry equity (on-chain memo). Without
      // this a stale pre-transfer pin would fire the equity stop at once.
      const eff = effectivePinnedEntryEquity(pinEquity, attachedKey, transferOutHistory.eqAfterByPosition);
      entryEquityUsd = eff.usd;
      if (eff.adjusted) {
        console.warn(
          `[ENTRY] ENTRY_EQUITY_USD $${pinEquity.toFixed(2)} predates a /transfer_out from this position — using $${eff.usd.toFixed(2)} ` +
            `(entry equity after the transfer, from the on-chain memo). Update ENTRY_EQUITY_USD to silence this.`
        );
      }
      entryEquityPending = false;
    } else {
      const p = await probeEquityWithRetry(dlmmPoolInstance, spotPriceUsd, activePositionPubkey, 3);
      if (p.ok) {
        entryEquityUsd = p.totalUsd;
        entryEquityPending = false;
        console.warn(
          `[ENTRY] Entry equity not pinned — using current MTM $${entryEquityUsd.toFixed(2)} as entry equity (entry reset on restart).`
        );
      } else {
        // Never use a wallet-only number as entry equity. Equity stop arms on the first good read.
        entryEquityUsd = 0;
        entryEquityPending = true;
        console.warn(`[ENTRY] Entry equity unavailable (${p.reason}) — equity stop arms on first good read.`);
      }
    }
    logEntryPinHint();

    await notify(
      `🔗 <b>[ATTACHED TO LIVE ON-CHAIN POSITION]</b>\n` +
      `• Position: <code>${activePositionPubkey.toBase58()}</code>\n` +
      `• Regime: <code>${config.regime}</code> (${escapeHtml(regimeSentinel.summary())}; bin shape for new deploys only)\n` +
      `• Spot: $${spotPriceUsd.toFixed(2)} (entry $${entrySpotUsd.toFixed(2)})\n` +
      `• Exact Range: $${lowestBinPrice.toFixed(2)} ➔ $${highestBinPrice.toFixed(2)}\n` +
      `• Floor Stop: ${formatFloorStopLine()}\n` +
      `• Stop lock: ${stopLockLabel()}\n` +
      `• Equity: ${bootEquityUsd != null ? `$${bootEquityUsd.toFixed(2)}` : "n/a"}\n` +
      `• Capital Baseline: ${capitalBaselineLabel()}` +
      (bootEquityUsd != null && !capitalBaselinePending ? `\n• Net PnL: ${fmtSignedUsd(totalPnlUsd(bootEquityUsd))}` : "") +
      `\n• Entry pin: ${pinStatus}` +
      `\n• Next fee sweep: ${nextSweepLabel()}` +
      (entryEquityPending ? `\n• ⏳ Entry equity pending first good read (equity stop not armed yet)` : "")
    );
    void emitLedger({
      event: "ATTACH",
      regime: config.regime,
      spot_usd: spotPriceUsd,
      total_equity_usd: bootEquityUsd ?? entryEquityUsd,
      entry_spot: entrySpotUsd,
      entry_equity: entryEquityUsd,
      ...pnlLedgerExtras(bootEquityUsd ?? entryEquityUsd),
      notes: `Attached to ${activePositionPubkey.toBase58()}. Entry pin: ${pinStatus}. Stop lock: ${stopLockLabel()}. Regime ${regimeSentinel.summary()}`,
      is_estimate: false,
    });
  } else {
    // STANDBY IN CASH: Do NOT deploy blindly on boot
    lowestBinPrice = 0;
    highestBinPrice = 0;
    activePositionPubkey = null;
    clearEntryState();
    lastExitPriceUsd = bootSpotUsd; // Anchor price to prevent premature Gate 3 bypass
    if (ENTRY_SPOT_USD_ENV || ENTRY_EQUITY_USD_ENV || ENTRY_POSITION_PUBKEY_ENV) {
      console.warn("[ENTRY] ENTRY_* pin ignored — no open position at boot (stale pin; safe to remove).");
    }
    await notify(
      `🟢 <b>[BOOTED IN 100% USDC]</b> Equity: ${bootEquityUsd != null ? `$${bootEquityUsd.toFixed(2)}` : "n/a"} | ` +
      `Capital Baseline: ${capitalBaselineLabel()}. Standing by for Gate 1-3 clearance.\n` +
      `• Next fee sweep: ${nextSweepLabel()}`
    );
  }

  // Stop-blindness watchdog (independent of the keeper tick so a hung tick is also caught).
  setInterval(() => {
    checkStopBlindness().catch((e) => console.error("[WATCHDOG]", e?.message || e));
  }, 30000);

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

      // READ GUARD (spot): zero/NaN or an unconfirmed one-tick jump never reaches the price stop,
      // take-profit, below-range recenter, top-up or re-entry. Skip the tick; re-check next tick.
      const spotCheck = vetSpot(currentPrice);
      if (!spotCheck.ok) {
        noteReadFailure("spot (all stops/TP/recenter)", spotCheck.reason, now);
        return;
      }

      // Regime is refreshed in the background (cached; may take seconds when an API is slow) so the stop
      // checks below are never delayed by external API calls. The tick only needs the cached label.
      void regimeSentinel.evaluate().catch((e: any) => console.warn("[REGIME] eval error:", e?.message || e));
      const currentConfig = regimeSentinel.current();

      // Scheduled sweep (before idle top-up so top-up doesn't absorb USDC about to be swept).
      // lastSweepTime only advances on an actual sweep (inside sweepRevenueToVault); if a due sweep
      // moves nothing, retry after SWEEP_RETRY_SEC instead of on every tick.
      if (now - lastSweepTime >= SWEEP_INTERVAL_SEC && now >= nextSweepRetryAt) {
        const swept = await sweepRevenueToVault(dlmmPoolInstance!);
        if (!(swept > 0)) {
          nextSweepRetryAt = now + SWEEP_RETRY_SEC;
          console.log(`[SWEEP] Due sweep moved nothing — retry at ${formatUnixPt(nextSweepRetryAt)}`);
        }
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
          // Unrealized vs entry; fees swept since entry are added back (a sweep is not a loss).
          const uPnL = entryEquityUsd > 0 ? Number((mtm + sweptSinceEntryUsd - entryEquityUsd).toFixed(2)) : 0;
          await emitLedger({
            event: "SNAPSHOT",
            regime: currentConfig.regime,
            spot_usd: currentPrice,
            position_value_usd: posUsd,
            wallet_value_usd: walletEq.totalUsd,
            total_equity_usd: mtm,
            unrealized_pnl_usd: uPnL,
            cumulative_fees_usd: cumulativeFeesUsd,
            ...pnlLedgerExtras(mtm),
            notes:
              `Periodic equity snapshot. Net PnL vs capital $${capitalBaselineUsd.toFixed(2)} (${capitalBaselineSource}): ${fmtSignedUsd(totalPnlUsd(mtm))}. ` +
              `Regime ${regimeSentinel.summary()}. Stop ${stopLockLabel()}`,
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
      // Spot was vetted above, so the price stop is evaluated on a trustworthy read this tick.
      lastPriceStopEvalAt = now;
      // READ GUARD (equity): the equity stop is evaluated ONLY on an ok, plausible full read
      // (wallet + the open position). Any failure / missing position / partial read / implausible
      // drop skips the equity stop for this tick — wallet-only equity can never fire it.
      let liveEquityUsd = 0;
      let equityStopHit = false;
      let equityReadOk = false;
      if (activePositionPubkey) {
        const eq = vetEquityProbe(await probeEquity(dlmmPoolInstance!, currentPrice, activePositionPubkey), currentPrice);
        if (eq.ok) {
          equityReadOk = true;
          liveEquityUsd = eq.totalUsd;
          lastEquityStopEvalAt = now;
          if (entryEquityPending) {
            entryEquityUsd = liveEquityUsd;
            entryEquityPending = false;
            console.log(`[ENTRY] Entry equity armed from first good read: $${entryEquityUsd.toFixed(2)}`);
            logEntryPinHint();
          }
          if (capitalBaselinePending) {
            capitalBaselineUsd = liveEquityUsd;
            capitalBaselinePending = false;
            console.log(`[BASELINE] Boot-equity baseline set from first good read: $${capitalBaselineUsd.toFixed(2)}`);
          }
        } else {
          noteReadFailure("equity stop", eq.reason, now);
        }
      }
      const priceStop = priceStopFromEntry(); // locked at entry; regime changes don't move it
      const equityStop = equityStopFromEntry();
      if (equityReadOk && equityStop > 0) equityStopHit = liveEquityUsd <= equityStop;
      const priceStopHit = entrySpotUsd > 0 && priceStop > 0 && isValidSpot(currentPrice) && currentPrice <= priceStop;

      if (priceStopHit || equityStopHit) {
        // Atomic in-flight lock: set BEFORE any await to stop double-trigger races.
        if (isLiquidating || isExiting || isDeploying || now < inCooldownUntil) return;
        isLiquidating = true;
        isExiting = true;

        const stopCooldownSec = lockedCooldownSec();
        inCooldownUntil = now + stopCooldownSec;
        const targetPos = activePositionPubkey;
        activePositionPubkey = null;
        lowestBinPrice = 0;
        highestBinPrice = 0;
        belowRangeTickCount = 0;

        const stopReason = priceStopHit
          ? `spot $${currentPrice.toFixed(2)} ≤ entry stop $${priceStop.toFixed(2)} (−${(lockedStopPct() * 100).toFixed(1)}% locked vs entry $${entrySpotUsd.toFixed(2)})`
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
            const cbClose = await closePositionAndReclaim(dlmmPoolInstance);
            if (!cbClose.ok) {
              // Position still open: keep tracking it (entry/stops unchanged) and retry the stop soon
              // instead of reporting a liquidation that did not happen.
              await reattachAfterFailedClose(dlmmPoolInstance, cbClose, targetPos);
              inCooldownUntil = Math.floor(Date.now() / 1000) + 120;
              await notify("🚨 <b>[CIRCUIT BREAKER INCOMPLETE]</b> Close failed — position still open; retrying the stop in ~2 min.");
              return;
            }
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

          // Exit equity = full wallet (USDC + SOL gas reserve), same basis as entry equity.
          let exitEquityUsd = postLiquidationUsdc;
          try {
            exitEquityUsd = Number((await getWalletLiquidEquityUsd(currentPrice)).totalUsd.toFixed(2));
          } catch {}
          const cycleEntryEquityUsd = entryEquityUsd;
          const cyclePnl = cycleRealizedPnlUsd(exitEquityUsd, cycleEntryEquityUsd, sweptSinceEntryUsd);
          const drawdownPct = cyclePnl != null ? fmtPct(cyclePnl, cycleEntryEquityUsd) : "n/a";
          const totalPnl = totalPnlUsd(exitEquityUsd);

          lastExitPriceUsd = currentPrice;
          clearEntryState();

          await notify(
            `🛡️ <b>[CIRCUIT BREAKER COMPLETE]</b>\n` +
            `• Liquidated Balance: <b>$${postLiquidationUsdc.toFixed(2)} USDC</b> (equity $${exitEquityUsd.toFixed(2)})\n` +
            `• Realized (cycle): <b>${cyclePnl != null ? fmtSignedUsd(cyclePnl) : "n/a"} (${drawdownPct} vs entry equity $${cycleEntryEquityUsd.toFixed(2)})</b>\n` +
            `• Net PnL vs capital: ${fmtSignedUsd(totalPnl)} (${fmtPct(totalPnl, capitalBaselineUsd)})\n` +
            `• Cooldown: Locked for ${stopCooldownSec / 60} minutes\n` +
            `• Swap Tx: <code>${swapSig || "N/A"}</code>`
          );

          await emitLedger({
            event: "CIRCUIT_BREAKER",
            spot_usd: currentPrice,
            realized_pnl_usd: cyclePnl ?? undefined,
            total_equity_usd: exitEquityUsd,
            entry_equity: cycleEntryEquityUsd || undefined,
            ...pnlLedgerExtras(exitEquityUsd),
            tx_sig: swapSig || "N/A",
            notes: `Stop: ${stopReason}. Ending USDC: $${postLiquidationUsdc.toFixed(2)}, equity $${exitEquityUsd.toFixed(2)} (${drawdownPct} vs entry). Net PnL vs capital: ${fmtSignedUsd(totalPnl)}`,
            is_estimate: false,
          });
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
          const recClose = await closePositionAndReclaim(dlmmPoolInstance!);
          if (!recClose.ok) {
            await reattachAfterFailedClose(dlmmPoolInstance!, recClose, activePositionPubkey);
            lastRecenterAt = now; // retry after RECENTER_COOLDOWN_SEC, never deploy on top of an open position
            return;
          }
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
        const tpClose = await closePositionAndReclaim(dlmmPoolInstance!);
        if (!tpClose.ok) {
          await reattachAfterFailedClose(dlmmPoolInstance!, tpClose, activePositionPubkey);
          lastRecenterAt = now; // retry after RECENTER_COOLDOWN_SEC
          return;
        }
        
        const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
        let postTpUsdc = 0;
        try {
          const acc = await getAccount(connection, botUsdcAta);
          postTpUsdc = Number(acc.amount) / 1e6;
        } catch {}

        // Exit equity = full wallet (USDC + SOL), same basis as entry equity.
        let exitEquityUsd = postTpUsdc;
        try {
          exitEquityUsd = Number((await getWalletLiquidEquityUsd(currentPrice)).totalUsd.toFixed(2));
        } catch {}
        const cycleEntryEquityUsd = entryEquityUsd;
        const cyclePnl = cycleRealizedPnlUsd(exitEquityUsd, cycleEntryEquityUsd, sweptSinceEntryUsd);
        const gainPct = cyclePnl != null ? fmtPct(cyclePnl, cycleEntryEquityUsd) : "n/a";
        const totalPnl = totalPnlUsd(exitEquityUsd);
        
        lastExitPriceUsd = currentPrice;

        await notify(
          `📈 <b>[REBALANCING GRID]</b>\n` +
          `• Capital Returned: $${postTpUsdc.toFixed(2)} USDC (equity $${exitEquityUsd.toFixed(2)})\n` +
          `• Cycle PnL: ${cyclePnl != null ? fmtSignedUsd(cyclePnl) : "n/a"} (${gainPct} vs entry equity $${cycleEntryEquityUsd.toFixed(2)})\n` +
          `• Net PnL vs capital: ${fmtSignedUsd(totalPnl)} (${fmtPct(totalPnl, capitalBaselineUsd)})\n` +
          `Recycling grid higher...`
        );
        
        if (cyclePnl != null) {
          await emitLedger({
            event: "TAKE_PROFIT",
            spot_usd: currentPrice,
            realized_pnl_usd: cyclePnl,
            total_equity_usd: exitEquityUsd,
            entry_equity: cycleEntryEquityUsd || undefined,
            ...pnlLedgerExtras(exitEquityUsd),
            notes: `Grid cleared upper bound at $${currentPrice.toFixed(2)}. Cycle PnL: ${fmtSignedUsd(cyclePnl)} (${gainPct}). Net PnL vs capital: ${fmtSignedUsd(totalPnl)}`,
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
      // A tick that throws before the stop block leaves stops unevaluated; the watchdog alerts if it persists.
      noteReadFailure("keeper tick", String(err?.message || err), Math.floor(Date.now() / 1000));
    } finally {
      keeperTickRunning = false;
    }
  }, 15000);
}

runKeeper().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
