import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RegimeSentinel,
  RegimeFetchers,
  annualizeFunding,
  fundingFromPredicted,
  fundingFromHistory,
  fundingPoints,
  lockFromRegime,
  resolveAttachStopLock,
  priceStopFromLock,
  entryPinLine,
  UNKNOWN_FUNDING,
} from "../regime";

const T0 = 1_791_500_000; // ~Oct 8 2026
const SMA = 86.65;

/** 201 daily points averaging exactly `sma`, last point = `price`. */
function cgSeries(price: number, sma = SMA) {
  const n = 201;
  const rest = (sma * n - price) / (n - 1);
  const prices = Array.from({ length: n - 1 }, (_, i) => [i, rest]);
  prices.push([n, price]);
  return { prices };
}

/** 25 hourly settled rows ending at nowSec, each rate from fn(hourIndex). */
function hist(nowSec: number, fn: (i: number) => number) {
  return Array.from({ length: 25 }, (_, i) => ({ coin: "SOL", time: (nowSec - (24 - i) * 3600) * 1000, fundingRate: String(fn(i)), premium: "0" }));
}

const aprToHourly = (apr: number) => apr / 876000;

function harness(opts: { price?: number | (() => number); hourly?: (now: number) => any; failCg?: () => boolean; failHist?: boolean; predicted?: any }) {
  let now = T0;
  const calls = { cg: 0, hist: 0, pred: 0 };
  const logs: string[] = [];
  const fetchers: RegimeFetchers = {
    fetchCoinGecko: async () => {
      calls.cg++;
      if (opts.failCg && opts.failCg()) throw Object.assign(new Error("Request failed with status code 429"), { response: { status: 429 } });
      const p = typeof opts.price === "function" ? opts.price() : opts.price ?? 109;
      return cgSeries(p);
    },
    fetchFundingHistory: async () => {
      calls.hist++;
      if (opts.failHist) throw new Error("timeout");
      return opts.hourly ? opts.hourly(now) : hist(now, () => aprToHourly(10.95));
    },
    fetchPredictedFundings: async () => {
      calls.pred++;
      if (opts.predicted === undefined) throw new Error("timeout");
      return opts.predicted;
    },
  };
  const s = new RegimeSentinel(fetchers, { nowSec: () => now, log: (l) => logs.push(l), fmtTime: (x) => String(x) });
  return {
    s,
    calls,
    logs,
    advance: (sec: number) => {
      now += sec;
    },
    now: () => now,
  };
}

test("funding units: HL hourly and Binance 8h baselines both annualize to 10.95%", () => {
  assert.equal(annualizeFunding(0.0000125, 1).toFixed(2), "10.95");
  assert.equal(annualizeFunding(0.0001, 8).toFixed(2), "10.95");
  const pred = [["SOL", [["BinPerp", { fundingRate: "-0.00011128", fundingIntervalHours: 8 }], ["HlPerp", { fundingRate: "0.0000125", fundingIntervalHours: 1 }]]]];
  const f = fundingFromPredicted(pred)!;
  assert.equal(f.apr.toFixed(2), "10.95"); // HlPerp chosen, not the first venue (BinPerp)
  assert.equal(fundingFromPredicted([["BTC", []]]), null); // SOL missing → unknown, no default of 10
  assert.equal(fundingPoints(UNKNOWN_FUNDING), 0);
  assert.equal(fundingPoints({ ...UNKNOWN_FUNDING, known: true, apr: 2.9 }), 0); // deadband
  assert.equal(fundingPoints({ ...UNKNOWN_FUNDING, known: true, apr: -2.9 }), 0);
  assert.equal(fundingPoints({ ...UNKNOWN_FUNDING, known: true, apr: 10.95 }), 25);
  assert.equal(fundingPoints({ ...UNKNOWN_FUNDING, known: true, apr: -12 }), -25);
  assert.equal(fundingFromHistory(hist(T0, () => 0.00001).slice(0, 5), T0 * 1000), null); // too few samples
});

test("API failure at boot → RANGE_CHOP / 5%, never BULL; failures back off (no per-tick hammering)", async () => {
  const h = harness({ failCg: () => true });
  const c = await h.s.evaluate();
  assert.equal(c.regime, "RANGE_CHOP");
  assert.equal(c.floorStopPct, 0.05);
  assert.equal(c.source, "default");
  for (let i = 0; i < 19; i++) {
    h.advance(15); // 19 keeper ticks within 5 min
    await h.s.evaluate();
  }
  assert.equal(h.calls.cg, 1, "no retry inside the 5-min backoff");
  h.advance(30);
  await h.s.evaluate();
  assert.equal(h.calls.cg, 2, "retries after backoff");
  assert.match(h.logs[0], /EVAL FAILED \(CoinGecko: HTTP 429/);
  // attach with no pin → RANGE 5% lock (not the live regime)
  const { lock } = resolveAttachStopLock("", false);
  assert.equal(lock.stopPct, 0.05);
  assert.equal(priceStopFromLock(110.26, lock).toFixed(2), "104.75");
});

test("funding SOL entry missing + history down → funding unknown/neutral, partial read can't switch", async () => {
  const h = harness({ price: 120, failHist: true, predicted: [["BTC", []]] }); // trend +25 → score 75 alone
  const c1 = await h.s.evaluate();
  assert.equal(c1.details.fundingKnown, false);
  assert.equal(c1.score, 75);
  assert.equal(c1.regime, "RANGE_CHOP");
  h.advance(3600);
  const c2 = await h.s.evaluate();
  assert.equal(c2.regime, "RANGE_CHOP");
});

test("flip-flopping funding (sign alternating hourly) → deadband, no regime switch over 24h", async () => {
  const h = harness({ price: 109, hourly: (now) => hist(now, (i) => aprToHourly((i + Math.floor(now / 3600)) % 2 ? 11 : -11)) });
  const seen = new Set<string>();
  for (let i = 0; i < 24; i++) {
    const c = await h.s.evaluate();
    seen.add(c.regime);
    assert.ok(Math.abs(c.details.fundingAnnual) < 3, `24h avg in deadband (${c.details.fundingAnnual})`);
    h.advance(3600);
  }
  assert.deepEqual([...seen], ["RANGE_CHOP"]);
});

test("raw regime alternating each evaluation with small margin → hysteresis holds (no switch)", async () => {
  let k = 0;
  // 9% APR → +25 (score 100, BULL); 4% → +5 (score 80, RANGE). Alternate per evaluation.
  const h = harness({ price: 109, hourly: (now) => hist(now, () => aprToHourly(k % 2 === 0 ? 9 : 4)) });
  const regimes: string[] = [];
  for (let i = 0; i < 12; i++) {
    const c = await h.s.evaluate();
    regimes.push(c.regime);
    k++;
    h.advance(3600);
  }
  assert.ok(regimes.every((r) => r === "RANGE_CHOP"), regimes.join(","));
});

test("a single strong BULL read (score 100, margin 15) after dwell still needs a 2nd read", async () => {
  let apr = 0;
  const h = harness({ price: 109, hourly: (now) => hist(now, () => aprToHourly(apr)) });
  assert.equal((await h.s.evaluate()).regime, "RANGE_CHOP"); // score 75 → RANGE confirmed
  h.advance(3 * 3600);
  apr = 9;
  let c = await h.s.evaluate();
  assert.equal(c.score, 100);
  assert.equal(c.regime, "RANGE_CHOP");
  assert.match(c.holdReason, /BULL needs 2 consecutive reads \(1\/2\)/);
  h.advance(900);
  c = await h.s.evaluate();
  assert.equal(c.regime, "BULL_EXPANSION");
});

test("two consecutive confirming reads switch after boot; dwell 2h then holds a single contrary read", async () => {
  let apr = 9;
  const h = harness({ price: 109, hourly: (now) => hist(now, () => aprToHourly(apr)) });
  let c = await h.s.evaluate();
  assert.equal(c.regime, "RANGE_CHOP"); // boot: 1/2
  assert.match(c.holdReason, /boot: needs 2 consecutive reads \(1\/2\)/);
  assert.ok(c.nextEvalAt - h.now() === 900, "re-check in 15 min while a switch is pending");
  h.advance(900);
  c = await h.s.evaluate();
  assert.equal(c.regime, "BULL_EXPANSION");
  assert.equal(c.floorStopPct, 0.04);
  // contrary read 1h later: score 80 → RANGE margin 5, dwell 1h → held
  apr = 4;
  h.advance(3600);
  c = await h.s.evaluate();
  assert.equal(c.regime, "BULL_EXPANSION");
  assert.equal(c.source, "held");
  // contrary read with margin 10 (score 75) but still inside 2h dwell → held
  apr = 0;
  h.advance(900);
  c = await h.s.evaluate();
  assert.equal(c.regime, "BULL_EXPANSION");
  assert.match(c.holdReason, /dwell/);
  // after dwell, 2nd consecutive RANGE read → switch
  h.advance(3600);
  c = await h.s.evaluate();
  assert.equal(c.regime, "RANGE_CHOP");
});

test("score < 30 → immediate BEAR (safety), no confirmation or dwell", async () => {
  // price 20% below SMA → trend −25; funding −15% APR → −25 → score 0
  const h = harness({ price: SMA * 0.8, hourly: (now) => hist(now, () => aprToHourly(-15)) });
  const c = await h.s.evaluate();
  assert.equal(c.regime, "BEAR_DEFENSIVE");
  assert.equal(c.score, 0);
});

test("eval failure keeps last good regime < 6h, then falls back to RANGE (never BULL)", async () => {
  let fail = false;
  const h = harness({ price: 109, failCg: () => fail, hourly: (now) => hist(now, () => aprToHourly(9)) });
  await h.s.evaluate();
  h.advance(900);
  assert.equal((await h.s.evaluate()).regime, "BULL_EXPANSION");
  fail = true;
  h.advance(3600);
  let c = await h.s.evaluate();
  assert.equal(c.regime, "BULL_EXPANSION");
  assert.equal(c.source, "last-good");
  h.advance(6 * 3600);
  c = await h.s.evaluate();
  assert.equal(c.regime, "RANGE_CHOP");
});

test("locked stop doesn't move when the regime changes", async () => {
  const lock = lockFromRegime("RANGE_CHOP", "deploy");
  const before = priceStopFromLock(110.26, lock);
  const h = harness({ price: 109, hourly: (now) => hist(now, () => aprToHourly(9)) });
  await h.s.evaluate();
  h.advance(900);
  const c = await h.s.evaluate();
  assert.equal(c.regime, "BULL_EXPANSION");
  assert.equal(c.floorStopPct, 0.04); // live regime would say 4%…
  assert.equal(priceStopFromLock(110.26, lock), before); // …but the position's stop is unchanged
  assert.equal(before.toFixed(2), "104.75");
});

test("restart with pin → same stop; stale/invalid pin → RANGE 5% with a warning", () => {
  const lock = lockFromRegime("BULL_EXPANSION", "deploy");
  const line = entryPinLine("8FDtGJ6mP8QXiwRDaiGwE5xqF6aQjJXY36ZMzgWNvqrS", 110.26, 915.5, lock);
  assert.match(line, /ENTRY_STOP_PCT=0\.04$/);
  const pinned = line.match(/ENTRY_STOP_PCT=([0-9.]+)/)![1];
  const r = resolveAttachStopLock(pinned, true);
  assert.equal(r.lock.stopPct, 0.04);
  assert.equal(r.lock.regime, "BULL_EXPANSION");
  assert.equal(r.lock.cooldownSec, 1800);
  assert.equal(priceStopFromLock(110.26, r.lock), priceStopFromLock(110.26, lock));
  const stale = resolveAttachStopLock(pinned, false);
  assert.equal(stale.lock.stopPct, 0.05);
  assert.match(stale.warning, /does not match/);
  const bad = resolveAttachStopLock("5", true);
  assert.equal(bad.lock.stopPct, 0.05);
  assert.match(bad.warning, /out of range/);
  // the live position at merge: ENTRY_STOP_PCT=0.05 → $104.75
  assert.equal(priceStopFromLock(110.26, resolveAttachStopLock("0.05", true).lock).toFixed(2), "104.75");
});
