import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BIN_ARRAY_RENT_LAMPORTS,
  deployHoldbackLamports,
  deploySolLamports,
  expectedNativeAfterOpen,
  openCostLamports,
  positionAccountBytes,
} from "../gasreserve";

const RESERVE = 120_000_000;
const POS_RENT = 41_899_840; // on-chain rent of the 8120-byte position account (CPqj9VLW…, Oct 11 2026)
const FEE_BUF = 5_000_000;

test("positionAccountBytes: 8120 bytes for ≤70-bin positions (matches CPqj9VLW… / Awyg6ed3… on-chain)", () => {
  assert.equal(positionAccountBytes(69), 8120); // 4bps: 34 bid + 35 ask (+ active)
  assert.equal(positionAccountBytes(61), 8120); // 10bps: 30/30
  assert.equal(positionAccountBytes(70), 8120);
  assert.equal(positionAccountBytes(71), 8120 + 112); // each extra bin adds 112 bytes
});

test("openCostLamports: position rent + bin arrays + bitmap", () => {
  assert.equal(openCostLamports({ positionRentLamports: POS_RENT, binArraysToCreate: 0 }), POS_RENT);
  assert.equal(
    openCostLamports({ positionRentLamports: POS_RENT, binArraysToCreate: 2 }),
    POS_RENT + 2 * BIN_ARRAY_RENT_LAMPORTS
  );
  assert.equal(BIN_ARRAY_RENT_LAMPORTS, 71_437_440);
  assert.equal(
    openCostLamports({ positionRentLamports: POS_RENT, binArraysToCreate: 1, binArrayRentLamports: 10, bitmapExtensionLamports: 7 }),
    POS_RENT + 17
  );
  assert.equal(openCostLamports({ positionRentLamports: -5, binArraysToCreate: -1 }), 0);
});

test("old sizing reproduces the 0.0781 landing; new sizing keeps ≥ reserve", () => {
  // Oct 11 2:16 PM PT recenter: native 2.21304074 SOL before the open, ask leg bigger than what was available.
  const native = 2_213_040_740;
  const target = 5_000_000_000;
  const txFee = 10_000;
  // Old: deposit = native − reserve; then rent + fee paid from the reserve.
  const oldDeposit = deploySolLamports(native, RESERVE, target);
  assert.equal(oldDeposit, 2_093_040_740);
  const oldAfter = expectedNativeAfterOpen(native, oldDeposit, POS_RENT) - txFee;
  assert.equal(oldAfter, 78_090_160); // ≈ 0.0781 SOL (on-chain: 0.07809018)
  assert.ok(oldAfter < RESERVE);
  // New: hold back reserve + open cost + fee buffer.
  const hold = deployHoldbackLamports(RESERVE, openCostLamports({ positionRentLamports: POS_RENT, binArraysToCreate: 0 }), FEE_BUF);
  assert.equal(hold, RESERVE + POS_RENT + FEE_BUF);
  const newDeposit = deploySolLamports(native, hold, target);
  const newAfter = expectedNativeAfterOpen(native, newDeposit, POS_RENT) - txFee;
  assert.ok(newAfter >= RESERVE, `after ${newAfter}`);
  assert.equal(newAfter, RESERVE + FEE_BUF - txFee);
});

test("new sizing keeps reserve even when bin arrays must be created", () => {
  const native = 3_000_000_000;
  const cost = openCostLamports({ positionRentLamports: POS_RENT, binArraysToCreate: 2 });
  const hold = deployHoldbackLamports(RESERVE, cost, FEE_BUF);
  const dep = deploySolLamports(native, hold, 10_000_000_000);
  assert.ok(expectedNativeAfterOpen(native, dep, cost) - 50_000 >= RESERVE);
});

test("deploySolLamports: target ask smaller than available is honoured; never negative", () => {
  assert.equal(deploySolLamports(1_000_000_000, 200_000_000, 300_000_000), 300_000_000);
  assert.equal(deploySolLamports(100_000_000, 200_000_000, 300_000_000), 0);
  assert.equal(deploySolLamports(1_000_000_000, 200_000_000, -1), 0);
});

test("deployHoldbackLamports ignores negative parts", () => {
  assert.equal(deployHoldbackLamports(RESERVE, -1, -1), RESERVE);
  assert.equal(deployHoldbackLamports(RESERVE, POS_RENT, 0), RESERVE + POS_RENT);
});
