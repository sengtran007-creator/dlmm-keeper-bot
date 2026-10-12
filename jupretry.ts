// Jupiter swap retry policy (pure; no network). Live 4bps, Oct 11 2026: after the gas gate was cleared, redeploy
// rebalances failed at 7:00 PM PT with 0x1771 (Jupiter SlippageToleranceExceeded, in preflight) and at 7:10 PM PT
// with HTTP 503 — each failure cost a full deploy cycle. A swap is now retried in-process: re-quote with a
// stepped-up slippage cap on 0x1771, back off on 5xx / 429 / network / expired tx, never retry when a signed tx
// could have landed ("unknown").

export type SwapFailureKind = "slippage" | "ratelimit" | "transient" | "fatal" | "unsafe";

export interface SwapFailure {
  message: string;
  httpStatus?: number;
  /** A tx was signed (and maybe sent). */
  attemptedSig?: string;
  landedStatus?: "landed" | "failed" | "not_landed" | "unknown";
}

// 0x1771 = Jupiter SlippageToleranceExceeded (6001); DLMM's own min-out check is ExceededAmountSlippageTolerance (6003).
const SLIPPAGE_RE = /0x1771|SlippageToleranceExceeded|slippage tolerance exceeded|ExceededAmountSlippageTolerance|Exceeded amount slippage tolerance/i;
const TRANSIENT_RE =
  /\b(429|500|502|503|504)\b|too many requests|service unavailable|bad gateway|gateway time-?out|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network error|fetch failed|blockhash not found|block height exceeded|expired|not_landed/i;
const FATAL_RE = /below gas reserve|fee floor|insufficient (funds|lamports)|Bad Jupiter quote|could not prove it landed/i;

export function classifySwapFailure(f: SwapFailure): SwapFailureKind {
  // A signed tx whose fate is unknown may still land: retrying could double-swap.
  if (f.attemptedSig && f.landedStatus === "unknown") return "unsafe";
  if (f.landedStatus === "landed") return "fatal";
  const msg = f.message || "";
  if (SLIPPAGE_RE.test(msg)) return "slippage";
  if (FATAL_RE.test(msg) && !/\b(429|5\d\d)\b/.test(msg)) return "fatal";
  if (f.httpStatus === 429 || /\b429\b|too many requests|rate limit exceeded/i.test(msg)) return "ratelimit";
  if (f.httpStatus != null && f.httpStatus >= 500) return "transient";
  if (f.httpStatus != null && f.httpStatus >= 400) return "fatal";
  if (TRANSIENT_RE.test(msg)) return "transient";
  return "fatal";
}

/** Next slippage cap after a 0x1771: double, at least +25 bps, capped. */
export function nextSlippageBps(currentBps: number, maxBps: number): number {
  const next = Math.max(currentBps * 2, currentBps + 25);
  return Math.min(Math.max(currentBps, maxBps), Math.round(next));
}

/** Backoff before retry n (1-based): 2 s, 4 s, 8 s … capped, ± jitter. */
export function swapRetryDelayMs(attempt: number, baseMs = 2000, maxMs = 15000, rand: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const d = Math.min(maxMs, baseMs * 2 ** (n - 1));
  return Math.round(d * (0.8 + 0.4 * rand()));
}

// ---- Rate limits (live 4bps, Oct 12 2026 5:33 AM PT on: every lite-api.jup.ag call answered 429 "Rate limit
// exceeded, please try again later." for 30+ min). api.jup.ag uses a 60 s sliding window: keyless 0.5 RPS
// (30/min), Free key 1 RPS; 429 responses carry x-ratelimit-reset (unix seconds) when a window is active.

/** Default Jupiter base: api.jup.ag (lite-api.jup.ag is being throttled down and retired). */
export const DEFAULT_JUPITER_API_BASE = "https://api.jup.ag/swap/v1";

/** Rewrites the retired lite-api host to api.jup.ag (same paths). Other hosts (e.g. a local stub) are kept. */
export function normalizeJupiterBase(raw: string | undefined): string {
  const b = (raw || "").trim().replace(/\/$/, "");
  if (!b) return DEFAULT_JUPITER_API_BASE;
  return b.replace(/^https?:\/\/lite-api\.jup\.ag/i, "https://api.jup.ag");
}

/**
 * Wait before retrying a 429: x-ratelimit-reset (absolute unix s) or Retry-After (seconds or HTTP date) when
 * present, clamped to [minMs, maxMs]; else the fixed ladder 5 s, 15 s, 30 s.
 */
export function rateLimitWaitMs(
  attempt: number,
  headers: Record<string, string | undefined> | undefined,
  nowMs: number,
  ladderMs: number[] = [5000, 15000, 30000],
  minMs = 1000,
  maxMs = 60000
): number {
  const h: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = v == null ? undefined : String(v);
  const clamp = (x: number) => Math.min(maxMs, Math.max(minMs, Math.round(x)));
  const reset = Number(h["x-ratelimit-reset"]);
  if (Number.isFinite(reset) && reset > 0) return clamp(reset * 1000 - nowMs + 250);
  const ra = h["retry-after"];
  if (ra != null && ra !== "") {
    const sec = Number(ra);
    if (Number.isFinite(sec)) return clamp(sec * 1000);
    const t = Date.parse(ra);
    if (Number.isFinite(t)) return clamp(t - nowMs);
  }
  const n = Math.max(1, Math.floor(attempt));
  return ladderMs[Math.min(ladderMs.length - 1, n - 1)];
}

/** Minimum spacing between Jupiter requests: keyless 0.5 RPS → 2.1 s; with a key (≥ 1 RPS) → 1.05 s. */
export function jupiterMinIntervalMs(hasKey: boolean, override?: number): number {
  if (override != null && Number.isFinite(override) && override >= 0) return override;
  return hasKey ? 1050 : 2100;
}

/** Use the direct Meteora-pool fallback? Only when Jupiter failed without a possibly-in-flight tx. */
export function shouldFallbackToPool(kind: SwapFailureKind, enabled: boolean): boolean {
  return enabled && (kind === "ratelimit" || kind === "transient" || kind === "slippage");
}
