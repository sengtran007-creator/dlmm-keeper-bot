// Jupiter swap retry policy (pure; no network). Live 4bps, Oct 11 2026: after the gas gate was cleared, redeploy
// rebalances failed at 7:00 PM PT with 0x1771 (Jupiter SlippageToleranceExceeded, in preflight) and at 7:10 PM PT
// with HTTP 503 — each failure cost a full deploy cycle. A swap is now retried in-process: re-quote with a
// stepped-up slippage cap on 0x1771, back off on 5xx / 429 / network / expired tx, never retry when a signed tx
// could have landed ("unknown").

export type SwapFailureKind = "slippage" | "transient" | "fatal" | "unsafe";

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
  if (f.httpStatus != null && (f.httpStatus === 429 || f.httpStatus >= 500)) return "transient";
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
