import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stakePoolRate, parsePausedEnv, fairPriceYPerX, checkDepeg, tightRange, decideRebalance,
  rebalanceSwap, usdcToDeploy, testEquity, pnl, pickPosition, parseDepegExit,
} from "../lstlogic";

function poolBuf(total: bigint, supply: bigint): Buffer {
  const b = Buffer.alloc(300);
  b.writeBigUInt64LE(total, 258);
  b.writeBigUInt64LE(supply, 266);
  return b;
}

test("stakePoolRate reads SPL stake pool total_lamports / pool_token_supply", () => {
  assert.ok(Math.abs(stakePoolRate(poolBuf(1311305608n, 1000000000n)) - 1.311305608) < 1e-12);
  assert.throws(() => stakePoolRate(Buffer.alloc(10)));
  assert.throws(() => stakePoolRate(poolBuf(0n, 1n)));
  assert.throws(() => stakePoolRate(poolBuf(10n, 1n))); // implausible
});

test("parsePausedEnv: unset/false → running; true/notes → paused", () => {
  for (const v of [undefined, "", "  ", "0", "false", "NO", "off"]) assert.equal(parsePausedEnv(v), false, String(v));
  for (const v of ["1", "true", "yes", "on", "paused by owner Nov 12"]) assert.equal(parsePausedEnv(v), true, v);
});

test("fair price and depeg guard (Nov 12 2026 mainnet: pool 0.929883 vs fair 0.929852)", () => {
  const fair = fairPriceYPerX(1.2193267044, 1.3113056084);
  assert.ok(Math.abs(fair - 0.92985) < 1e-4);
  const ok = checkDepeg(0.929883132, fair, 0.5);
  assert.equal(ok.depegged, false);
  assert.ok(Math.abs(ok.deviationPct) < 0.01);
  assert.equal(checkDepeg(fair * 0.994, fair, 0.5).depegged, true);
  assert.equal(checkDepeg(fair * 1.006, fair, 0.5).depegged, true);
  assert.equal(checkDepeg(0, fair, 0.5).depegged, false); // bad read never triggers an exit
});

test("tightRange ±1 bin", () => {
  assert.deepEqual(tightRange(-727, 1), { minBinId: -728, maxBinId: -726 });
  assert.deepEqual(tightRange(5, 0), { minBinId: 5, maxBinId: 5 });
});

test("decideRebalance: needs N consecutive out-of-range ticks and cooldown", () => {
  const base = { minBinId: -728, maxBinId: -726, requiredTicks: 3, nowSec: 10_000, lastRebalanceSec: 0, cooldownSec: 1800 };
  assert.equal(decideRebalance({ ...base, activeBinId: -727, outOfRangeTicks: 2 }).outOfRangeTicks, 0);
  assert.equal(decideRebalance({ ...base, activeBinId: -725, outOfRangeTicks: 0 }).rebalance, false);
  assert.equal(decideRebalance({ ...base, activeBinId: -725, outOfRangeTicks: 2 }).rebalance, true);
  const cd = decideRebalance({ ...base, activeBinId: -729, outOfRangeTicks: 5, lastRebalanceSec: 9_000 });
  assert.equal(cd.rebalance, false);
  assert.match(cd.reason, /cooldown/);
  assert.equal(decideRebalance({ ...base, activeBinId: -729, outOfRangeTicks: 5, lastRebalanceSec: 8_000 }).rebalance, true);
});

test("rebalanceSwap sizes the excess side by SOL value; skips dust", () => {
  // 4 JupSOL (1.2193) + 0 JitoSOL → sell ~2 JupSOL worth
  const r = rebalanceSwap(4e9, 0, 1.2193, 1.3113, 9, 0.5, 0.01)!;
  assert.equal(r.sell, "X");
  assert.ok(Math.abs(r.amountRaw - 2e9) < 2);
  const r2 = rebalanceSwap(0, 4e9, 1.2193, 1.3113, 9, 0.5, 0.01)!;
  assert.equal(r2.sell, "Y");
  assert.equal(rebalanceSwap(1e9, 0.93e9, 1.2193, 1.3113, 9, 0.5, 0.01), null);
  assert.equal(rebalanceSwap(0, 0, 1.2, 1.3, 9, 0.5, 0.01), null);
});

test("usdcToDeploy never exceeds cap or balance; zero cap = no USDC touched", () => {
  assert.equal(usdcToDeploy(680_526_395, 680_530_000), 680_526_395);
  assert.equal(usdcToDeploy(800_000_000, 680_530_000), 680_530_000);
  assert.equal(usdcToDeploy(800_000_000, 0), 0);
});

test("testEquity excludes gas baseline; rent neutral; fees show as cost", () => {
  const base = testEquity({ usdc: 680.53, xTokens: 0, yTokens: 0, solPerX: 1.2193, solPerY: 1.3113, nativeSol: 0.124895, rentSol: 0, gasBaselineSol: 0.124895, solUsd: 80 });
  assert.ok(Math.abs(base.usd - 680.53) < 1e-9);
  // after entry: rent 0.0419 moved from native into the position account, 0.0001 fees paid
  const after = testEquity({ usdc: 0, xTokens: 340.265 / 80 / 1.2193, yTokens: 340.265 / 80 / 1.3113, solPerX: 1.2193, solPerY: 1.3113, nativeSol: 0.124895 - 0.0419 - 0.0001, rentSol: 0.0419, gasBaselineSol: 0.124895, solUsd: 80 });
  assert.ok(Math.abs(after.usd - (680.53 - 0.008)) < 1e-6);
  const p = pnl(after, base);
  assert.ok(p.usd < 0 && p.usd > -0.01);
});

test("pickPosition: adopt pinned or first; report extras", () => {
  const mk = (k: string) => ({ publicKey: { toBase58: () => k } });
  const a = mk("A"), b = mk("B");
  assert.deepEqual(pickPosition([]), { adopt: null, extras: [] });
  assert.equal(pickPosition([a, b]).adopt, a);
  assert.equal(pickPosition([a, b], "B").adopt, b);
  assert.deepEqual(pickPosition([a, b], "B").extras, [a]);
});

test("parseDepegExit defaults to SOL", () => {
  assert.equal(parseDepegExit(undefined), "SOL");
  assert.equal(parseDepegExit("usdc"), "USDC");
  assert.equal(parseDepegExit("hold"), "HOLD");
});
