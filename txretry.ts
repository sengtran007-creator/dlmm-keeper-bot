/**
 * Pure retry logic for transaction sends (no RPC, no env): retryable-error classification, backoff
 * schedule, and a retry loop that re-reads the chain before every attempt so an attempt that actually
 * landed is never sent twice. index.ts wires these to the real connection.
 */

export type TxLandedStatus = "landed" | "failed" | "not_landed" | "unknown";

/** Error thrown by the send helper; carries what is known about whether the tx reached the chain. */
export class TxSendError extends Error {
  landedStatus: TxLandedStatus;
  sig: string;
  constructor(message: string, landedStatus: TxLandedStatus, sig = "") {
    super(message);
    this.name = "TxSendError";
    this.landedStatus = landedStatus;
    this.sig = sig;
  }
}

// Program / instruction errors: the tx ran (or simulated) and the program said no. Retrying the same
// thing will fail the same way (or, worse, do something twice), so these are never retried.
const NON_RETRYABLE_RE =
  /custom program error|InstructionError|"Custom"\s*:|Custom\(\d+\)|Error Code:|AnchorError|Program failed to complete|insufficient (funds|lamports)|NonEmptyPosition|No liquidity to remove|AccountOwnedByWrongProgram|already been closed|invalid account data|account not found|signature verification failed|missing signature/i;

// Transient: expired/unknown blockhash, rate limits, timeouts, network blips, overloaded/lagging RPC.
const RETRYABLE_RE =
  /blockhash not found|block ?height exceeded|has expired|TransactionExpired|expired|429|too many requests|rate.?limit|timed? ?out|timeout|was not confirmed in|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|network ?error|failed to fetch|\b50[234]\b|bad gateway|service unavailable|gateway time|node is (behind|unhealthy)|minimum context slot|unconfirmed|not landed/i;

function errText(err: any): string {
  if (err == null) return "";
  const parts = [err?.message, err?.name, err?.code, typeof err === "string" ? err : ""];
  if (Array.isArray(err?.logs)) parts.push(err.logs.join(" "));
  if (Array.isArray(err?.transactionLogs)) parts.push(err.transactionLogs.join(" "));
  return parts.filter((p) => p != null && p !== "").map(String).join(" ") || String(err);
}

/**
 * True for transient failures worth retrying with a fresh blockhash; false for program errors and
 * anything unrecognised. A TxSendError that is known to have landed with an error ("failed") is a
 * program error.
 */
export function isRetryableTxError(err: any): boolean {
  if (err instanceof TxSendError || err?.name === "TxSendError") {
    if (err.landedStatus === "failed" || err.landedStatus === "landed") return false;
  }
  const m = errText(err);
  if (NON_RETRYABLE_RE.test(m)) return false;
  if (err instanceof TxSendError || err?.name === "TxSendError") {
    if (err.landedStatus === "not_landed" || err.landedStatus === "unknown") return true;
  }
  return RETRYABLE_RE.test(m);
}

/**
 * May this failure be retried? Without a chain re-read before the next attempt, only failures PROVEN
 * not to have reached the chain (preflight rejection / blockhash expired unseen / failed before any
 * send) qualify: an "unknown" outcome could still land, so resending would double it.
 */
export function shouldRetryTx(err: any, opts: { chainChecked: boolean }): boolean {
  if (!isRetryableTxError(err)) return false;
  if (opts.chainChecked) return true;
  const st: TxLandedStatus | undefined = err?.landedStatus;
  if (st === undefined) return !/not confirmed in|unknown if it succeeded|has expired|block ?height exceeded/i.test(errText(err));
  return st === "not_landed";
}

export interface BackoffOpts {
  baseMs?: number;
  maxMs?: number;
  /** ± fraction of the delay (0.2 = ±20%). */
  jitter?: number;
}

/** Delay before retry n (n = 1 for the first retry): base·2^(n−1), capped, ± jitter. rand ∈ [0,1). */
export function backoffDelayMs(retry: number, opts: BackoffOpts = {}, rand: () => number = Math.random): number {
  const base = Math.max(0, opts.baseMs ?? 2000);
  const max = Math.max(base, opts.maxMs ?? 16_000);
  const jitter = Math.min(0.9, Math.max(0, opts.jitter ?? 0.2));
  const n = Math.max(1, Math.floor(retry));
  const raw = Math.min(max, base * Math.pow(2, n - 1));
  const r = Math.min(Math.max(rand(), 0), 1);
  return Math.max(0, Math.round(raw * (1 + jitter * (2 * r - 1))));
}

export interface RetryDeps<T> {
  maxAttempts: number;
  backoff?: BackoffOpts;
  /** Build + send one attempt (rebuild the tx, fresh blockhash). Throws on failure. */
  attempt: (n: number) => Promise<T>;
  /**
   * Re-read the chain before an attempt: true = the goal is already reached (e.g. the position account
   * is gone because a previous attempt landed) → stop, success, nothing sent. Omit when there is no
   * chain check; then only provably-not-landed failures are retried.
   */
  isDone?: (n: number) => Promise<boolean>;
  /** Also run isDone before the first attempt (default true when isDone is given). */
  checkBeforeFirst?: boolean;
  sleep: (ms: number) => Promise<void>;
  rand?: () => number;
  onRetry?: (info: { nextAttempt: number; delayMs: number; error: any }) => void;
}

export interface RetryOutcome<T> {
  status: "ok" | "already_done" | "failed";
  /** Attempts whose send was started (chain-check-only rounds not counted). */
  attempts: number;
  result?: T;
  lastError?: any;
  /** Why it stopped on failure. */
  stopReason?: "non_retryable" | "exhausted";
}

export async function retryTxWithChainCheck<T>(d: RetryDeps<T>): Promise<RetryOutcome<T>> {
  const max = Math.max(1, Math.floor(d.maxAttempts));
  const chainChecked = typeof d.isDone === "function";
  const checkFirst = chainChecked && d.checkBeforeFirst !== false;
  let attempts = 0;
  let lastError: any;
  for (let n = 1; n <= max; n++) {
    if (n > 1) {
      const delayMs = backoffDelayMs(n - 1, d.backoff, d.rand);
      d.onRetry?.({ nextAttempt: n, delayMs, error: lastError });
      await d.sleep(delayMs);
    }
    if (chainChecked && (n > 1 || checkFirst)) {
      let done: boolean;
      try {
        done = await d.isDone!(n);
      } catch (readErr: any) {
        // Cannot prove the previous attempt did not land → do not send this round (reads are idempotent;
        // the next round re-reads after the backoff).
        lastError = new Error(`chain re-read failed before attempt ${n}: ${readErr?.message || readErr}`);
        continue;
      }
      if (done) return { status: "already_done", attempts, lastError };
    }
    attempts++;
    try {
      const result = await d.attempt(n);
      return { status: "ok", attempts, result };
    } catch (err: any) {
      lastError = err;
      if (!shouldRetryTx(err, { chainChecked })) return { status: "failed", attempts, lastError, stopReason: "non_retryable" };
    }
  }
  return { status: "failed", attempts, lastError, stopReason: "exhausted" };
}

/** Next unix second a failed recenter/TP may run again: soon, but never later than the normal cooldown. */
export function recenterRetryAnchor(nowSec: number, cooldownSec: number, retryAfterSec: number): number {
  const retry = Math.max(0, Math.min(retryAfterSec, cooldownSec));
  // Callers gate on `now >= lastRecenterAt + cooldownSec`; back-date the anchor so that fires at now + retry.
  return nowSec - cooldownSec + retry;
}

/** One-line, length-capped error text for logs / Telegram (caller redacts secrets). */
export function shortTxError(err: any, max = 220): string {
  const m = (err?.message || String(err ?? "")).replace(/\s+/g, " ").trim();
  return m.length > max ? m.slice(0, max - 1) + "…" : m;
}
