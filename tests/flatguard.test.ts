import { test } from "node:test";
import assert from "node:assert/strict";
import {
  swapGasGate,
  planInventory,
  redeployDelaySec,
  flatSolExposureUsd,
  flatGuardHit,
  flatSolDumpLamports,
  resolveBootFlatGuard,
} from "../flatguard";
import { deployHoldbackLamports, deploySolLamports } from "../gasreserve";

const RESERVE = 120_000_000;
const FEE_FLOOR = 10_000_000;
const HOLDBACK = deployHoldbackLamports(RESERVE, 41_900_000, 5_000_000); // 0.1669 SOL (live log 6:06 PM PT Oct 11)

test("H0: USDC→SOL swap passes at 0.1220 SOL (the live deadlock) — only the fee floor applies", () => {
  const g = swapGasGate({ inIsSol: false, nativeLamports: 122_000_000, reserveLamports: RESERVE, bufferLamports: 5_000_000, feeFloorLamports: FEE_FLOOR });
  assert.equal(g.ok, true);
  const low = swapGasGate({ inIsSol: false, nativeLamports: 9_000_000, reserveLamports: RESERVE, bufferLamports: 5_000_000, feeFloorLamports: FEE_FLOOR });
  assert.equal(low.ok, false);
});

test("SOL-selling swap keeps the old reserve + buffer gate", () => {
  const base = { inIsSol: true, reserveLamports: RESERVE, bufferLamports: 5_000_000, feeFloorLamports: FEE_FLOOR };
  assert.equal(swapGasGate({ ...base, nativeLamports: 122_000_000 }).ok, false);
  assert.equal(swapGasGate({ ...base, nativeLamports: 125_000_000 }).ok, true);
  // amount-aware variant: must leave the reserve
  assert.equal(swapGasGate({ ...base, nativeLamports: 2_000_000_000, inLamports: 1_900_000_000 }).ok, false);
  assert.equal(swapGasGate({ ...base, nativeLamports: 2_000_000_000, inLamports: 1_800_000_000 }).ok, true);
});

test("H0: live TP state (0.1220 SOL, $456.39 USDC) buys ask + holdback shortfall, and the open then fits", () => {
  const spot = 111.79;
  const p = planInventory({
    nativeLamports: 122_000_000, usdcRaw: 456_390_000, holdbackLamports: HOLDBACK, spotUsd: spot,
    askRatio: 35 / 69, deployPct: 1, minSwapUsd: 10, slippageBps: 100,
  });
  assert.equal(p.ok, true);
  assert.equal(p.deficitLamports, HOLDBACK - 122_000_000);
  const deficitUsd = (p.deficitLamports / 1e9) * spot;
  assert.ok(p.buyUsdcRaw / 1e6 > p.targetAskUsd + deficitUsd - 0.01, "buys ask + deficit");
  assert.ok(p.buyUsdcRaw <= 456_390_000);
  // Simulate the swap at spot with 0.5% slippage: native after must cover holdback, ask leg ≈ target.
  const solOut = Math.floor(((p.buyUsdcRaw / 1e6) / spot) * 0.995 * 1e9);
  const after = 122_000_000 + solOut;
  assert.ok(after >= HOLDBACK);
  const askLamports = Math.floor((p.targetAskUsd / spot) * 1e9);
  const used = deploySolLamports(after, HOLDBACK, askLamports);
  assert.ok(used > askLamports * 0.99, "ask leg not short");
  assert.ok(after - used >= HOLDBACK, "holdback stays");
  // bid leg fits in remaining USDC
  assert.ok(456.39 - p.buyUsdcRaw / 1e6 >= p.targetBidUsd - 0.01);
});

test("H0: holdback shortfall below MIN_SWAP_USD is still bought (no ask need)", () => {
  // all-SOL ask target 0 (bid-only), native just short by 0.01 SOL ($1.1)
  const p = planInventory({
    nativeLamports: HOLDBACK - 10_000_000, usdcRaw: 400_000_000, holdbackLamports: HOLDBACK, spotUsd: 110,
    askRatio: 0, deployPct: 1, minSwapUsd: 10, slippageBps: 100,
  });
  assert.equal(p.ok, true);
  assert.ok(p.buyUsdcRaw > 1_100_000 && p.buyUsdcRaw < 1_200_000, String(p.buyUsdcRaw));
  assert.equal(p.sellSolLamports, 0);
});

test("SOL-heavy recenter: sells the surplus, no deficit", () => {
  const p = planInventory({
    nativeLamports: 4_200_000_000, usdcRaw: 1_000_000, holdbackLamports: HOLDBACK, spotUsd: 108,
    askRatio: 0.5, deployPct: 1, minSwapUsd: 10, slippageBps: 100,
  });
  assert.equal(p.ok, true);
  assert.equal(p.deficitLamports, 0);
  assert.ok(p.sellSolLamports > 0);
  assert.equal(p.buyUsdcRaw, 0);
  const freeUsd = ((4_200_000_000 - HOLDBACK) / 1e9) * 108;
  assert.ok(Math.abs(p.targetAskUsd + p.targetBidUsd - (freeUsd + 1)) < 1e-6);
});

test("planInventory refuses when capital cannot fund the holdback, and on invalid spot", () => {
  assert.equal(planInventory({ nativeLamports: 50_000_000, usdcRaw: 1_000_000, holdbackLamports: HOLDBACK, spotUsd: 110, askRatio: 0.5, deployPct: 1, minSwapUsd: 10, slippageBps: 100 }).ok, false);
  assert.equal(planInventory({ nativeLamports: 1e9, usdcRaw: 1e8, holdbackLamports: HOLDBACK, spotUsd: NaN, askRatio: 0.5, deployPct: 1, minSwapUsd: 10, slippageBps: 100 }).ok, false);
});

test("H3 top-up: native below reserve+buffer buys the shortfall with the ask top-up", () => {
  const hold = RESERVE + 5_000_000;
  const p = planInventory({ nativeLamports: 80_000_000, usdcRaw: 30_000_000, holdbackLamports: hold, spotUsd: 110, askRatio: 0.5, deployPct: 1, minSwapUsd: 10, slippageBps: 100 });
  assert.equal(p.ok, true);
  assert.equal(p.deficitLamports, 45_000_000);
  assert.ok(p.buyUsdcRaw / 1e6 > (0.045 * 110) + p.targetAskUsd - 0.01);
});

test("redeploy backoff: 60, 120, 240, 480, 600 cap", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((a) => redeployDelaySec(a)), [60, 120, 240, 480, 600, 600]);
  assert.equal(redeployDelaySec(0), 60);
});

test("flat exposure / dump amounts", () => {
  assert.equal(flatSolExposureUsd(120_000_000, 0, RESERVE, 110), 0);
  assert.ok(Math.abs(flatSolExposureUsd(2_120_000_000, 0, RESERVE, 110) - 220) < 1e-9);
  assert.ok(Math.abs(flatSolExposureUsd(1_120_000_000, 1_000_000_000, RESERVE, 100) - 200) < 1e-9);
  assert.equal(flatSolDumpLamports(2_120_000_000, 0, RESERVE, 5_000_000), 1_995_000_000);
  assert.equal(flatSolDumpLamports(100_000_000, 0, RESERVE, 5_000_000), 0);
});

test("flat guard: price stop, equity stop, liquidation pending", () => {
  const g = { stopPrice: 106.24, equityStop: 439.91, source: "t" };
  assert.equal(flatGuardHit(g, 106.3, 450).hit, false);
  assert.equal(flatGuardHit(g, 106.24, 450).hit, true);
  assert.equal(flatGuardHit(g, 107, 439.9).hit, true);
  assert.equal(flatGuardHit(g, 107, null).hit, false);
  assert.equal(flatGuardHit({ stopPrice: Number.POSITIVE_INFINITY, equityStop: 0, source: "cb" }, 200, null).hit, true);
});

test("boot flat: pins within 10% of spot are used", () => {
  const r = resolveBootFlatGuard({ spotUsd: 109, walletEquityUsd: 460, pinSpotUsd: 111.83, pinEquityUsd: 463.06, pinStopPct: 0.05, defaultStopPct: 0.05, maxDrawdownPct: 0.05 });
  assert.ok(Math.abs(r.guard.stopPrice - 106.2385) < 1e-6);
  assert.ok(Math.abs(r.guard.equityStop - 439.907) < 1e-6);
  assert.equal(r.entrySpotUsd, 111.83);
  assert.match(r.guard.source, /pins/);
});

test("boot flat: stale pin (>10% away) or none → spot-based default; equity = wallet", () => {
  const r = resolveBootFlatGuard({ spotUsd: 130, walletEquityUsd: 500, pinSpotUsd: 111.83, pinEquityUsd: 463.06, pinStopPct: 0.04, defaultStopPct: 0.05, maxDrawdownPct: 0.05 });
  assert.equal(r.entrySpotUsd, 130);
  assert.ok(Math.abs(r.guard.stopPrice - 130 * 0.96) < 1e-9, "pin stop pct still honoured");
  assert.ok(Math.abs(r.guard.equityStop - 475) < 1e-9);
  assert.match(r.how, /stale/);
  const n = resolveBootFlatGuard({ spotUsd: 100, walletEquityUsd: null, pinSpotUsd: null, pinEquityUsd: null, pinStopPct: null, defaultStopPct: 0.05, maxDrawdownPct: 0.05 });
  assert.equal(n.guard.stopPrice, 95);
  assert.equal(n.guard.equityStop, 0);
});
