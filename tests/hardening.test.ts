import { test } from "node:test";
import assert from "node:assert/strict";
import { usdcSweepCapRaw, sweepTotalsLine } from "../feesweep";
import { positionUsd, positionSolUnitsFromAmounts, equityFromSnapshot } from "../tickstate";

test("H1: USDC sweep capped at claimed + swap proceeds (withdrawal USDC in the window stays)", () => {
  // claim 1.07 USDC + swap 1.22 USDC, but a /withdraw_pct landed 150 USDC in the same window
  assert.equal(usdcSweepCapRaw({ walletDeltaRaw: 152_292_054n, claimedUsdcMetaRaw: 1_072_375n, swapProceedsRaw: 1_220_679n }), 2_293_054n);
  // normal sweep: delta == claim + proceeds
  assert.equal(usdcSweepCapRaw({ walletDeltaRaw: 2_293_054n, claimedUsdcMetaRaw: 1_072_375n, swapProceedsRaw: 1_220_679n }), 2_293_054n);
  // delta smaller than the cap (swap fee) → delta
  assert.equal(usdcSweepCapRaw({ walletDeltaRaw: 2_000_000n, claimedUsdcMetaRaw: 1_072_375n, swapProceedsRaw: 1_220_679n }), 2_000_000n);
  // no meta → wallet delta (lock keeps other money actions out)
  assert.equal(usdcSweepCapRaw({ walletDeltaRaw: 5n, claimedUsdcMetaRaw: null, swapProceedsRaw: 0n }), 5n);
  assert.equal(usdcSweepCapRaw({ walletDeltaRaw: -5n, claimedUsdcMetaRaw: 3n, swapProceedsRaw: 0n }), 0n);
});

test("sweep alert label: this run vs cumulative", () => {
  const l = sweepTotalsLine(2.29, 41.7);
  assert.match(l, /Swept this run: <b>\$2\.29<\/b>/);
  assert.match(l, /cumulative to revenue: <b>\$41\.70<\/b>/);
});

test("M2: refundable position rent counts in equity", () => {
  const p = { key: "k", ok: true, x: 1e9, y: 50e6, feeX: 0, feeY: 0 };
  const noRent = positionUsd(p, 100);
  const withRent = positionUsd({ ...p, rentLamports: 57_406_080 }, 100);
  assert.equal(Number((withRent - noRent).toFixed(4)), 5.7406);
  const eq = equityFromSnapshot({
    spotUsd: 100, nativeLamports: 0, wsolRaw: 0, usdcRaw: 0, expectedKey: "k", missing: [],
    positions: [{ ...p, rentLamports: 57_406_080 }],
  } as any);
  assert.ok(eq.ok);
  assert.equal(eq.totalUsd, Number(withRent.toFixed(2)));
});

test("position SOL units (equity-jump invariant input)", () => {
  assert.equal(positionSolUnitsFromAmounts([
    { key: "a", ok: true, x: 2e9, y: 0, feeX: 1e7, feeY: 0 },
    { key: "b", ok: false, x: 5e9, y: 0, feeX: 0, feeY: 0 },
    { key: "c", ok: true, x: NaN, y: 0, feeX: 0, feeY: 0 },
  ]), 2.01);
});
