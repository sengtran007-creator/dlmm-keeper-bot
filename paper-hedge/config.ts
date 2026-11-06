/**
 * Env parsing for the paper hedger. Reads an allowlist only.
 * Presence of a wallet or Kalshi credential is reported so the process can
 * refuse to start; the secret value is never logged, stored, or sent.
 */
import { DEFAULT_POOL_ADDRESS } from "../multipool";
import { HedgeConfig } from "./engine";

export const FORBIDDEN_ENV = [
  "BOT_PRIVATE_KEY",
  "PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "WALLET_PRIVATE_KEY",
  "KALSHI_API_KEY",
  "KALSHI_API_SECRET",
  "KALSHI_ACCESS_KEY",
  "KALSHI_PRIVATE_KEY",
  "KALSHI_ACCESS_SIGNATURE",
];

export const DEFAULT_WALLET = "2YtsAfr19EhNaGrB6W8YqtuJeaaRoY7xq83GFxdnYq6t";

export interface PaperConfig extends HedgeConfig {
  enabled: boolean;
  pollMs: number;
  wallet: string;
  pool: string;
  ticker: string;
  kalshiBase: string;
  rpcUrl: string;
  sheetUrl: string;
  statePath: string;
  instance: string;
  gasReserveLamports: number;
  httpTimeoutMs: number;
  /** Recorded in the boot log. Fills assume the taker rate. */
  makerFeeRate: number;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number, min?: number, max?: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (min != null && n < min) return fallback;
  if (max != null && n > max) return fallback;
  return n;
}

export function forbiddenPresent(env: NodeJS.ProcessEnv): string[] {
  const hit: string[] = [];
  for (const key of FORBIDDEN_ENV) {
    const v = env[key];
    if (typeof v === "string" && v.trim().length > 0) hit.push(key);
  }
  return hit;
}

export function loadConfig(env: NodeJS.ProcessEnv): PaperConfig {
  const enabledRaw = (env.PAPER_HEDGE_ENABLED || "").trim().toLowerCase();
  const enabled = enabledRaw === "1" || enabledRaw === "true" || enabledRaw === "yes";
  const sign = num(env, "PAPER_HEDGE_FUNDING_SIGN", 1);
  return {
    enabled,
    pollMs: Math.round(num(env, "PAPER_HEDGE_POLL_SEC", 30, 5, 3600) * 1000),
    staleMs: Math.round(num(env, "PAPER_HEDGE_STALE_SEC", 60, 5, 3600) * 1000),
    logEveryMs: Math.round(num(env, "PAPER_HEDGE_LOG_SEC", 300, 0, 86400) * 1000),
    bandPct: num(env, "PAPER_HEDGE_BAND_PCT", 0.05, 0, 1),
    contractSol: num(env, "PAPER_HEDGE_CONTRACT_SOL", 0.1, 0.0001, 100),
    takerFeeRate: num(env, "PAPER_HEDGE_TAKER_FEE_RATE", 0.0004, 0, 0.05),
    makerFeeRate: num(env, "PAPER_HEDGE_MAKER_FEE_RATE", 0.0002, 0, 0.05),
    fundingFallbackRate: num(env, "PAPER_HEDGE_FUNDING_FALLBACK_RATE", 0, -0.2, 0.2),
    fundingSign: sign < 0 ? -1 : 1,
    fundingGraceMs: Math.round(num(env, "PAPER_HEDGE_FUNDING_GRACE_SEC", 120, 0, 3600) * 1000),
    marginFraction: num(env, "PAPER_HEDGE_MARGIN_FRACTION", 0.25, 0, 1),
    capitalUsd: num(env, "PAPER_HEDGE_CAPITAL_USD", 650, 0, 1e9),
    positionBucketSol: num(env, "PAPER_HEDGE_POSITION_BUCKET_SOL", 0.05, 0.001, 10),
    maintLeverageFallback: num(env, "PAPER_HEDGE_MAINT_LEVERAGE", 3.1, 1, 100),
    initialMarginMultiplier: num(env, "PAPER_HEDGE_INITIAL_MARGIN_MULTIPLIER", 1.3, 1, 10),
    liquidationRatio: num(env, "PAPER_HEDGE_LIQUIDATION_RATIO", 1, 0.01, 100),
    queueRatio: num(env, "PAPER_HEDGE_QUEUE_RATIO", 0.91, 0.01, 100),
    wallet: (env.PAPER_HEDGE_WALLET || env.HEDGE_WALLET_PUBKEY || DEFAULT_WALLET).trim(),
    pool: (env.PAPER_HEDGE_POOL || env.POOL_ADDRESS || DEFAULT_POOL_ADDRESS).trim(),
    ticker: (env.PAPER_HEDGE_TICKER || "KXSOLPERP").trim(),
    kalshiBase: (env.PAPER_HEDGE_KALSHI_BASE || "https://external-api.kalshi.com/trade-api/v2").trim().replace(/\/+$/, ""),
    rpcUrl: (env.SOLANA_RPC_URL || env.RPC_URL || "").trim(),
    sheetUrl: (env.GOOGLE_SHEET_WEBHOOK_URL || "").trim(),
    statePath: (env.PAPER_HEDGE_STATE_PATH || "paper-hedge-state.json").trim(),
    instance: (env.PAPER_HEDGE_INSTANCE || env.INSTANCE_LABEL || "paper-hedge").trim() || "paper-hedge",
    gasReserveLamports: Math.round(num(env, "GAS_RESERVE_LAMPORTS", 120_000_000, 0, 1e12)),
    httpTimeoutMs: Math.round(num(env, "PAPER_HEDGE_HTTP_TIMEOUT_MS", 8000, 1000, 30000)),
  };
}
