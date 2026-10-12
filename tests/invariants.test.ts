import { test } from "node:test";
import assert from "node:assert/strict";
import { AlertGate, gasBelowReserveAfterOpen, unexplainedEquityJump, creditSpike, idleFundsAlert, orphanPositions, ledgerDrift, bootJitterSec } from "../invariants";

test("AlertGate rate-limits per key and clears", () => {
  const g = new AlertGate();
  assert.equal(g.shouldFire("k", 100, 1800), true);
  assert.equal(g.shouldFire("k", 200, 1800), false);
  assert.equal(g.shouldFire("j", 200, 1800), true);
  assert.equal(g.shouldFire("k", 1901, 1800), true);
  g.clear("k");
  assert.equal(g.shouldFire("k", 1902, 1800), true);
});

test("gas below reserve after open", () => {
  assert.equal(gasBelowReserveAfterOpen(119_995_000, 120_000_000), true);
  assert.equal(gasBelowReserveAfterOpen(124_990_000, 120_000_000), false);
});

test("unexplained equity jump: price moves explained, transfers not", () => {
  const ok = unexplainedEquityJump({ prevEquityUsd: 500, prevSpotUsd: 100, equityUsd: 510, spotUsd: 102, solUnits: 5 });
  assert.equal(ok.jump, false);
  const drop = unexplainedEquityJump({ prevEquityUsd: 500, prevSpotUsd: 100, equityUsd: 450, spotUsd: 100, solUnits: 5 });
  assert.equal(drop.jump, true);
  assert.equal(drop.residualUsd, -50);
  const small = unexplainedEquityJump({ prevEquityUsd: 500, prevSpotUsd: 100, equityUsd: 497, spotUsd: 100, solUnits: 5 });
  assert.equal(small.jump, false);
  assert.equal(unexplainedEquityJump({ prevEquityUsd: NaN, prevSpotUsd: 100, equityUsd: 1, spotUsd: 1, solUnits: 1 }).jump, false);
});

test("credit spike: steady 280/h fine, boot-free 2k/h flagged", () => {
  assert.equal(creditSpike(280, 500), false);
  assert.equal(creditSpike(1400, 500), false);
  assert.equal(creditSpike(2000, 500), true);
});

test("idle funds after the window only", () => {
  assert.equal(idleFundsAlert({ idleUsd: 30, idleSinceSec: 0, nowSec: 1799, minUsd: 25, maxIdleSec: 1800 }), false);
  assert.equal(idleFundsAlert({ idleUsd: 30, idleSinceSec: 0, nowSec: 1800, minUsd: 25, maxIdleSec: 1800 }), true);
  assert.equal(idleFundsAlert({ idleUsd: 10, idleSinceSec: 0, nowSec: 9999, minUsd: 25, maxIdleSec: 1800 }), false);
  assert.equal(idleFundsAlert({ idleUsd: 30, idleSinceSec: null, nowSec: 9999, minUsd: 25, maxIdleSec: 1800 }), false);
});

test("orphans and ledger drift", () => {
  assert.deepEqual(orphanPositions(["a", "b"], "a"), ["b"]);
  assert.deepEqual(orphanPositions(["a"], "a"), []);
  assert.deepEqual(ledgerDrift(100, 100.3), { drift: false, diffUsd: 0.3 });
  assert.deepEqual(ledgerDrift(100, 102.29), { drift: true, diffUsd: 2.29 });
});

test("M5 boot jitter: deterministic, bounded, differs between the two bots", () => {
  const a = bootJitterSec("4bps", 20);
  const b = bootJitterSec("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", 20);
  assert.equal(a, bootJitterSec("4bps", 20));
  for (const v of [a, b]) assert.ok(v >= 0 && v <= 20);
  assert.notEqual(a, b);
  assert.equal(bootJitterSec("x", 0), 0);
});
