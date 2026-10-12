import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySwapFailure, nextSlippageBps, swapRetryDelayMs } from "../jupretry";

const LIVE_1771 =
  "swap tx 2FYySRtU… not_landed (send error: Simulation failed. Message: Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1771. Logs: [ \"Program JUP6… failed: custom program error: 0x1771\" ])";

test("live 4bps 7:00 PM PT 0x1771 (preflight, not landed) → slippage re-quote", () => {
  assert.equal(classifySwapFailure({ message: LIVE_1771, attemptedSig: "2FYy", landedStatus: "not_landed" }), "slippage");
  assert.equal(classifySwapFailure({ message: "… Error Code: ExceededAmountSlippageTolerance …", attemptedSig: "x", landedStatus: "not_landed" }), "slippage");
});

test("live 4bps 7:10 PM PT 503 and other transient errors → backoff", () => {
  assert.equal(classifySwapFailure({ message: "Request failed with status code 503", httpStatus: 503, landedStatus: "not_landed" }), "transient");
  assert.equal(classifySwapFailure({ message: "Request failed with status code 429", httpStatus: 429 }), "transient");
  assert.equal(classifySwapFailure({ message: "timeout of 10000ms exceeded" }), "transient");
  assert.equal(classifySwapFailure({ message: "swap tx abc not_landed", attemptedSig: "abc", landedStatus: "not_landed" }), "transient");
  assert.equal(classifySwapFailure({ message: "getaddrinfo ENOTFOUND lite-api.jup.ag" }), "transient");
});

test("never retry a signed swap whose fate is unknown; gas gate and 4xx are final", () => {
  assert.equal(classifySwapFailure({ message: LIVE_1771, attemptedSig: "abc", landedStatus: "unknown" }), "unsafe");
  assert.equal(classifySwapFailure({ message: "SOL below gas reserve — refusing Jupiter swap", landedStatus: "not_landed" }), "fatal");
  assert.equal(classifySwapFailure({ message: "Request failed with status code 400", httpStatus: 400 }), "fatal");
  assert.equal(classifySwapFailure({ message: "Bad Jupiter quote: {\"error\":\"no route\"}" }), "fatal");
  assert.equal(classifySwapFailure({ message: "swap tx abc failed", attemptedSig: "abc", landedStatus: "failed" }), "fatal");
});

test("slippage steps 50 → 100 → 150 and stops at the cap", () => {
  assert.equal(nextSlippageBps(50, 150), 100);
  assert.equal(nextSlippageBps(100, 150), 150);
  assert.equal(nextSlippageBps(150, 150), 150);
  assert.equal(nextSlippageBps(10, 150), 35);
});

test("swap retry backoff 2 s, 4 s, 8 s, ≤ 15 s, ±20% jitter", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((a) => swapRetryDelayMs(a, 2000, 15000, () => 0.5)), [2000, 4000, 8000, 15000, 15000]);
  assert.equal(swapRetryDelayMs(1, 2000, 15000, () => 0), 1600);
  assert.equal(swapRetryDelayMs(1, 2000, 15000, () => 1), 2400);
});
