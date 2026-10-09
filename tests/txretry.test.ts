import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TxSendError,
  backoffDelayMs,
  isRetryableTxError,
  recenterRetryAnchor,
  retryTxWithChainCheck,
  shouldRetryTx,
  shortTxError,
} from "../txretry";

// ---------------------------------------------------------------- classification

test("retryable: the Oct 9 incident error (preflight Blockhash not found)", () => {
  const e = new Error("Simulation failed. \nMessage: Transaction simulation failed: Blockhash not found. \nLogs: \n[]. ");
  assert.equal(isRetryableTxError(e), true);
});

test("retryable: expiry, 429, timeouts, network blips", () => {
  for (const m of [
    "Signature 5x… has expired: block height exceeded.",
    "TransactionExpiredBlockheightExceededError",
    "Server responded with 429 Too Many Requests. Retrying after 500ms delay...",
    "failed to get recent blockhash: 429 Too Many Requests",
    "Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed.",
    "request to https://x failed, reason: socket hang up",
    "FetchError: request failed, reason: connect ECONNRESET",
    "fetch failed",
    "ETIMEDOUT",
    "503 Service Unavailable",
    "Node is behind by 120 slots",
  ]) {
    assert.equal(isRetryableTxError(new Error(m)), true, m);
  }
});

test("non-retryable: program errors, even when wrapped in a simulation failure", () => {
  for (const m of [
    "Simulation failed. Message: Transaction simulation failed: Error processing Instruction 2: custom program error: 0x178e.",
    'failed: {"InstructionError":[1,{"Custom":6030}]}',
    "AnchorError occurred. Error Code: NonEmptyPosition. Error Number: 6030.",
    "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit. insufficient funds",
    "No liquidity to remove",
    "AccountOwnedByWrongProgram",
  ]) {
    assert.equal(isRetryableTxError(new Error(m)), false, m);
  }
});

test("non-retryable: unrecognised errors and landed-with-error TxSendError", () => {
  assert.equal(isRetryableTxError(new Error("something odd happened")), false);
  assert.equal(isRetryableTxError(new TxSendError("close tx abc… failed: landed with a program error", "failed")), false);
  assert.equal(isRetryableTxError(null), false);
});

test("TxSendError: not_landed / unknown are retryable unless the text is a program error", () => {
  assert.equal(isRetryableTxError(new TxSendError("close tx a… not_landed", "not_landed")), true);
  assert.equal(isRetryableTxError(new TxSendError("close tx a… unknown", "unknown")), true);
  assert.equal(isRetryableTxError(new TxSendError("close tx a… not_landed: custom program error: 0x1", "not_landed")), false);
});

test("shouldRetryTx: without a chain re-read only provably-not-landed failures are retried", () => {
  const unknown = new TxSendError("claim tx a… unknown", "unknown");
  const notLanded = new TxSendError("claim tx a… not_landed: Blockhash not found", "not_landed");
  assert.equal(shouldRetryTx(unknown, { chainChecked: false }), false);
  assert.equal(shouldRetryTx(unknown, { chainChecked: true }), true);
  assert.equal(shouldRetryTx(notLanded, { chainChecked: false }), true);
  // raw web3 timeout (sent, outcome unknown) is not resent without a chain check
  const timeout = new Error("Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed.");
  assert.equal(shouldRetryTx(timeout, { chainChecked: false }), false);
  assert.equal(shouldRetryTx(timeout, { chainChecked: true }), true);
  // a 429 while building (nothing sent) is fine
  assert.equal(shouldRetryTx(new Error("429 Too Many Requests"), { chainChecked: false }), true);
});

// ---------------------------------------------------------------- backoff

test("backoff: 2s, 4s, 8s, 16s, capped at 16s (no jitter at rand=0.5)", () => {
  const mid = () => 0.5;
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(n, {}, mid)), [2000, 4000, 8000, 16000, 16000, 16000]);
});

test("backoff: jitter stays within ±20% and honours custom base/cap", () => {
  assert.equal(backoffDelayMs(1, {}, () => 0), 1600);
  assert.equal(backoffDelayMs(1, {}, () => 0.999999), 2400);
  assert.equal(backoffDelayMs(3, { baseMs: 1000, maxMs: 3000, jitter: 0 }, Math.random), 3000);
  for (let i = 0; i < 200; i++) {
    const d = backoffDelayMs(2);
    assert.ok(d >= 3200 && d <= 4800, String(d));
  }
});

// ---------------------------------------------------------------- retry loop

function harness() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms), rand: () => 0.5 };
}

test("retry: succeeds on attempt 3 after two blockhash-not-found failures, with backoff between", async () => {
  const h = harness();
  let calls = 0;
  const out = await retryTxWithChainCheck({
    maxAttempts: 4,
    sleep: h.sleep,
    rand: h.rand,
    isDone: async () => false,
    attempt: async () => {
      calls++;
      if (calls < 3) throw new TxSendError("close tx a… not_landed: Blockhash not found", "not_landed");
      return "SIG";
    },
  });
  assert.equal(out.status, "ok");
  assert.equal(out.attempts, 3);
  assert.equal(out.result, "SIG");
  assert.deepEqual(h.slept, [2000, 4000]);
});

test("retry: already-closed short-circuit — a previous attempt landed, nothing is resent", async () => {
  const h = harness();
  let sends = 0;
  let closed = false;
  const out = await retryTxWithChainCheck({
    maxAttempts: 4,
    sleep: h.sleep,
    rand: h.rand,
    isDone: async () => closed,
    attempt: async () => {
      sends++;
      closed = true; // it actually landed…
      throw new TxSendError("close tx a… unknown: confirm timed out", "unknown"); // …but we could not see it
    },
  });
  assert.equal(out.status, "already_done");
  assert.equal(sends, 1);
  assert.equal(out.attempts, 1);
});

test("retry: already closed before the first attempt → no send at all", async () => {
  const h = harness();
  let sends = 0;
  const out = await retryTxWithChainCheck({
    maxAttempts: 4,
    sleep: h.sleep,
    isDone: async () => true,
    attempt: async () => void sends++,
  });
  assert.equal(out.status, "already_done");
  assert.equal(sends, 0);
  assert.deepEqual(h.slept, []);
});

test("retry: program error stops immediately", async () => {
  const h = harness();
  let sends = 0;
  const out = await retryTxWithChainCheck({
    maxAttempts: 4,
    sleep: h.sleep,
    isDone: async () => false,
    attempt: async () => {
      sends++;
      throw new Error("Transaction simulation failed: custom program error: 0x178e");
    },
  });
  assert.equal(out.status, "failed");
  assert.equal(out.stopReason, "non_retryable");
  assert.equal(sends, 1);
  assert.deepEqual(h.slept, []);
});

test("retry: exhausted after maxAttempts with the last error kept", async () => {
  const h = harness();
  let n = 0;
  const out = await retryTxWithChainCheck({
    maxAttempts: 4,
    sleep: h.sleep,
    rand: h.rand,
    isDone: async () => false,
    attempt: async () => {
      n++;
      throw new Error(`429 Too Many Requests #${n}`);
    },
  });
  assert.equal(out.status, "failed");
  assert.equal(out.stopReason, "exhausted");
  assert.equal(out.attempts, 4);
  assert.match(String(out.lastError?.message), /#4/);
  assert.deepEqual(h.slept, [2000, 4000, 8000]);
});

test("retry: a failed chain re-read skips that round's send (never sends blind)", async () => {
  const h = harness();
  let reads = 0;
  let sends = 0;
  const out = await retryTxWithChainCheck({
    maxAttempts: 3,
    sleep: h.sleep,
    rand: h.rand,
    isDone: async () => {
      reads++;
      if (reads === 2) throw new Error("429 Too Many Requests");
      return false;
    },
    attempt: async () => {
      sends++;
      throw new TxSendError("close tx a… unknown", "unknown");
    },
  });
  assert.equal(out.status, "failed");
  assert.equal(reads, 3);
  assert.equal(sends, 2); // round 2 was skipped because the re-read failed
});

test("retry: without isDone, an unknown outcome is not resent", async () => {
  const h = harness();
  let sends = 0;
  const out = await retryTxWithChainCheck({
    maxAttempts: 3,
    sleep: h.sleep,
    attempt: async () => {
      sends++;
      throw new TxSendError("claim tx a… unknown", "unknown");
    },
  });
  assert.equal(out.status, "failed");
  assert.equal(sends, 1);
});

// ---------------------------------------------------------------- recenter retry anchor / misc

test("recenter retry anchor: failed close → recenter allowed again after RECENTER_FAIL_RETRY_SEC, capped by the cooldown", () => {
  const now = 1_791_600_000;
  const cooldown = 1800;
  const anchor = recenterRetryAnchor(now, cooldown, 180);
  assert.equal(anchor + cooldown, now + 180);
  assert.equal(recenterRetryAnchor(now, 60, 180) + 60, now + 60); // never longer than the cooldown
  assert.equal(recenterRetryAnchor(now, 0, 180), now);
});

test("shortTxError: one line, capped", () => {
  const s = shortTxError(new Error("a\n  b\n" + "x".repeat(500)), 50);
  assert.equal(s.length, 50);
  assert.ok(!s.includes("\n"));
});
