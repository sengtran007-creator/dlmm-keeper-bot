import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateBinPriceUsd,
  binsToWidthPct,
  widthPctToBins,
  clampBins,
  resolveRangeBins,
  gate2ThresholdBps,
  volatilityMovePct,
  sanitizeInstanceLabel,
  withInstancePrefix,
  parseBoolEnv,
  parseOptionalInt,
  positionHasLiquidity,
  KNOWN_SOL_USDC_POOLS,
  DEFAULT_POOL_ADDRESS,
} from "../multipool";
import { REGIME_PROFILES } from "../regime";
import { sweepRawFromParsedTx, parseSweepTx } from "../feesweep";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

test("default pool is the original 10 bps pool; 4 bps pool known", () => {
  assert.equal(DEFAULT_POOL_ADDRESS, "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y");
  assert.equal(KNOWN_SOL_USDC_POOLS[DEFAULT_POOL_ADDRESS].binStep, 10);
  assert.equal(KNOWN_SOL_USDC_POOLS["5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"].binStep, 4);
});

test("calculateBinPriceUsd uses the given bin step (10 bps identical to the old helper)", () => {
  const old = (s: number, a: number, t: number) => s * Math.pow(1 + 10 / 10000, t - a);
  near(calculateBinPriceUsd(110, 100, 70, 10), old(110, 100, 70));
  near(calculateBinPriceUsd(110, 100, 130, 10), old(110, 100, 130));
  near(calculateBinPriceUsd(110, 0, 35, 4), 110 * Math.pow(1.0004, 35));
  near(calculateBinPriceUsd(110, 0, -34, 4), 110 * Math.pow(1.0004, -34));
  assert.equal(calculateBinPriceUsd(110, 0, 5, 0), 0);
  assert.equal(calculateBinPriceUsd(NaN, 0, 5, 4), 0);
});

test("width <-> bins conversions", () => {
  near(binsToWidthPct(30, 10), Math.pow(1.001, 30) - 1);
  assert.equal(widthPctToBins(binsToWidthPct(30, 10), 4), 75);
  assert.equal(widthPctToBins(0.014, 4), 35);
  assert.equal(widthPctToBins(0.03, 10), 30);
  assert.equal(widthPctToBins(0, 4), 0);
});

test("clampBins matches the original clampBinRange arithmetic", () => {
  assert.deepEqual(clampBins(30, 30), { bidBins: 30, askBins: 30, clamped: false });
  assert.deepEqual(clampBins(34, 35), { bidBins: 34, askBins: 35, clamped: false });
  assert.deepEqual(clampBins(75, 75), { bidBins: 34, askBins: 35, clamped: true });
  assert.deepEqual(clampBins(100, 0), { bidBins: 69, askBins: 0, clamped: true });
  assert.deepEqual(clampBins(-3, 2.7), { bidBins: 0, askBins: 2, clamped: false });
});

test("10 bps pool: every regime profile is used unchanged (live bot behavior unchanged)", () => {
  for (const [name, p] of Object.entries(REGIME_PROFILES)) {
    const r = resolveRangeBins(p.bidBins, p.askBins, 10);
    assert.equal(r.bidBins, p.bidBins, name);
    assert.equal(r.askBins, p.askBins, name);
    assert.equal(r.source, "regime profile");
    assert.equal(r.clamped, false);
  }
});

test("4 bps pool default: RANGE 30/30@10bps → 34/35 (max symmetric, ≈±1.4%)", () => {
  const p = REGIME_PROFILES.RANGE_CHOP;
  const r = resolveRangeBins(p.bidBins, p.askBins, 4);
  assert.equal(r.bidBins, 34);
  assert.equal(r.askBins, 35);
  assert.ok(r.clamped);
  assert.ok(r.bidBins + r.askBins + 1 <= 70);
  near(r.bidPct, 1.37, 0.01);
  near(r.askPct, 1.41, 0.01);
});

test("4 bps pool: env BID_BINS/ASK_BINS win, are clamped to 70 wide, one side mirrors", () => {
  const bull = REGIME_PROFILES.BULL_EXPANSION;
  const sym = resolveRangeBins(bull.bidBins, bull.askBins, 4, { bidBins: 34, askBins: 35 });
  assert.deepEqual([sym.bidBins, sym.askBins, sym.clamped], [34, 35, false]);
  const big = resolveRangeBins(30, 30, 4, { bidBins: 50, askBins: 50 });
  assert.deepEqual([big.bidBins, big.askBins, big.clamped], [34, 35, true]);
  const one = resolveRangeBins(30, 30, 4, { bidBins: 20 });
  assert.deepEqual([one.bidBins, one.askBins], [20, 20]);
  const zero = resolveRangeBins(30, 30, 4, { bidBins: 0, askBins: 10 });
  assert.deepEqual([zero.bidBins, zero.askBins], [0, 10]);
});

test("RANGE_WIDTH_PCT converts to bins on the pool's bin step", () => {
  const r = resolveRangeBins(30, 30, 4, { widthPct: 1.0 });
  assert.deepEqual([r.bidBins, r.askBins], [25, 25]);
  const w = resolveRangeBins(30, 30, 4, { widthPct: 3 });
  assert.deepEqual([w.bidBins, w.askBins, w.clamped], [34, 35, true]);
  const ten = resolveRangeBins(25, 35, 10, { widthPct: 2 });
  assert.deepEqual([ten.bidBins, ten.askBins], [20, 20]);
});

test("Gate 2 threshold: 15 bps on the 10 bps pool, same volatility tolerance elsewhere, env wins", () => {
  assert.deepEqual(gate2ThresholdBps(null, 40000), { bps: 15, source: "default" });
  assert.equal(gate2ThresholdBps(null, 120000).bps, 45);
  assert.equal(gate2ThresholdBps(null, 0).bps, 15);
  assert.equal(gate2ThresholdBps(20, 120000).bps, 20);
  assert.equal(gate2ThresholdBps(0, 40000).bps, 15); // 0 is not a valid override
  // Same accumulated move → same pass/fail at the default threshold on both pools:
  // fee_bps = vfc * (volAcc*binStep)^2 / 1e16
  const fee = (vfc: number, volAcc: number, step: number) => (vfc * Math.pow(volAcc * step, 2)) / 1e16;
  const move10 = 150_000 * 10; // volAcc 150k on 10 bps
  const volAcc4 = move10 / 4;
  near(fee(40000, 150_000, 10) / 15, fee(120000, volAcc4, 4) / 45, 1e-9);
  near(volatilityMovePct(150_000, 10), volatilityMovePct(volAcc4, 4));
});

test("instance label + Telegram prefix + bool/int env parsing", () => {
  assert.equal(sanitizeInstanceLabel(undefined), "");
  assert.equal(sanitizeInstanceLabel("  4bps <b>x</b> "), "4bps bxb");
  assert.equal(sanitizeInstanceLabel("a".repeat(50)).length, 32);
  assert.equal(withInstancePrefix("hi", ""), "hi");
  assert.equal(withInstancePrefix("hi", "4bps"), "[4bps] hi");
  assert.equal(parseBoolEnv(undefined, true), true);
  assert.equal(parseBoolEnv("false", true), false);
  assert.equal(parseBoolEnv(" OFF ", true), false);
  assert.equal(parseBoolEnv("0", true), false);
  assert.equal(parseBoolEnv("true", false), true);
  assert.equal(parseBoolEnv("garbage", true), true);
  assert.equal(parseOptionalInt(""), null);
  assert.equal(parseOptionalInt("34"), 34);
  assert.equal(parseOptionalInt("3.5"), null);
  assert.equal(parseOptionalInt("-1"), null);
});

test("sweep scan counts only THIS LP wallet's sweeps when two instances share a revenue wallet", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const REV_ATA = "RevAta1111111111111111111111111111111111111";
  const A = { wallet: "WalletA111111111111111111111111111111111111", ata: "AtaA11111111111111111111111111111111111111" };
  const B = { wallet: "WalletB111111111111111111111111111111111111", ata: "AtaB11111111111111111111111111111111111111" };
  const sweepTx = (from: { wallet: string; ata: string }, amount: number, err: any = null) => ({
    meta: { err, innerInstructions: [] },
    transaction: {
      message: {
        instructions: [
          {
            program: "spl-token",
            parsed: {
              type: "transferChecked",
              info: { source: from.ata, destination: REV_ATA, authority: from.wallet, mint: USDC, tokenAmount: { amount: String(amount) } },
            },
          },
        ],
      },
    },
  });
  const txs = [sweepTx(A, 1_500_000), sweepTx(B, 2_000_000), sweepTx(A, 500_000), sweepTx(A, 9_000_000, { InstructionError: [] })];
  const total = (who: typeof A) => txs.reduce((s, t) => s + sweepRawFromParsedTx(t, who.wallet, who.ata, REV_ATA, USDC), 0);
  assert.equal(total(A), 2_000_000);
  assert.equal(total(B), 2_000_000);
  // Wrong signer for A's ATA (poisoning / other authority) → 0
  const spoof = sweepTx({ wallet: B.wallet, ata: A.ata }, 7_000_000);
  assert.equal(sweepRawFromParsedTx(spoof, A.wallet, A.ata, REV_ATA, USDC), 0);
  // Other mint → 0
  const other = sweepTx(A, 1);
  (other.transaction.message.instructions[0].parsed.info as any).mint = "So11111111111111111111111111111111111111112";
  assert.equal(sweepRawFromParsedTx(other, A.wallet, A.ata, REV_ATA, USDC), 0);
});

test("positionHasLiquidity: funded positions must be withdrawn before close", () => {
  assert.equal(positionHasLiquidity(null), false);
  assert.equal(positionHasLiquidity({ totalXAmount: "0", totalYAmount: "0", positionBinData: [] }), false);
  assert.equal(positionHasLiquidity({ totalXAmount: "428757709", totalYAmount: "0" }), true);
  assert.equal(positionHasLiquidity({ totalXAmount: { toString: () => "0" }, totalYAmount: { toString: () => "12" } }), true);
  assert.equal(
    positionHasLiquidity({ totalXAmount: "0", totalYAmount: "0", positionBinData: [{ positionLiquidity: "0" }, { positionLiquidity: "5" }] }),
    true
  );
});
