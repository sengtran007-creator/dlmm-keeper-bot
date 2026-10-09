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
  directionFromCandles,
  directionPoints,
  classifyScore,
  scoreInputs,
  smaFromDailyCandles,
  smaFromCoinGecko,
  trendParts,
  SCORE_BULL_MIN,
  SCORE_BEAR_IMMEDIATE_BELOW,
} from "../regime";

const T0 = 1_791_500_000; // ~Oct 8 2026
const SMA = 86.65;

/** CoinGecko-style: 200 daily points at `sma`, then the live point `price`. */
function cgSeries(price: number, sma = SMA) {
  const prices = Array.from({ length: 200 }, (_, i) => [i, sma]);
  prices.push([200, price]);
  return { prices };
}

/** HL-style daily candles: `closedDays` closed UTC days closing at `sma`, plus the in-progress day at `live`. */
function dailyCandles(nowSec: number, sma = SMA, closedDays = 230, live = 999) {
  const today = Math.floor(nowSec / 86400) * 86400;
  const rows = Array.from({ length: closedDays }, (_, i) => {
    const t = (today - (closedDays - i) * 86400) * 1000;
    return { t, T: t + 86400 * 1000 - 1, s: "SOL", i: "1d", o: "0", c: String(sma), h: "0", l: "0", v: "0", n: 1 };
  });
  rows.push({ t: today * 1000, T: today * 1000 + 86400 * 1000 - 1, s: "SOL", i: "1d", o: "0", c: String(live), h: "0", l: "0", v: "0", n: 1 });
  return rows;
}

/** 25 hourly settled rows ending at nowSec, each rate from fn(hourIndex). */
function hist(nowSec: number, fn: (i: number) => number) {
  return Array.from({ length: 25 }, (_, i) => ({ coin: "SOL", time: (nowSec - (24 - i) * 3600) * 1000, fundingRate: String(fn(i)), premium: "0" }));
}

const aprToHourly = (apr: number) => apr / 876000;

/** 72 hourly HL-style candles ending at nowSec; close(i) for i = 0..71 (71 = in-progress candle). */
function candles(nowSec: number, close: (i: number) => number) {
  const startHour = Math.floor(nowSec / 3600) * 3600 - 71 * 3600;
  return Array.from({ length: 72 }, (_, i) => {
    const t = (startHour + i * 3600) * 1000;
    return { t, T: t + 3600 * 1000 - 1, s: "SOL", i: "1h", o: "0", c: String(close(i)), h: "0", l: "0", v: "0", n: 1 };
  });
}
const flat = (p = 109) => (now: number) => candles(now, () => p);
/** Linear drift: total pct change over the 72 candles. */
const drift = (pctTotal: number, end = 109) => (now: number) => candles(now, (i) => end * (1 + (pctTotal / 100) * ((i - 71) / 71)));

function harness(opts: {
  price?: number | (() => number);
  hourly?: (now: number) => any;
  failAll?: () => boolean;
  failDaily?: () => boolean;
  failCg?: () => boolean;
  failHist?: boolean;
  predicted?: any;
  candles?: ((now: number) => any) | null;
  daily?: (now: number) => any;
}) {
  let now = T0;
  const calls = { cg: 0, hist: 0, pred: 0, daily: 0, candles: 0 };
  const logs: string[] = [];
  const price = () => (typeof opts.price === "function" ? opts.price() : opts.price ?? 109);
  const all = () => !!(opts.failAll && opts.failAll());
  const http429 = () => Object.assign(new Error("Request failed with status code 429"), { response: { status: 429 } });
  const fetchers: RegimeFetchers = {
    fetchCoinGecko: async () => {
      calls.cg++;
      if (all() || (opts.failCg && opts.failCg())) throw http429();
      return cgSeries(price());
    },
    fetchDailyCandles: async () => {
      calls.daily++;
      if (all() || (opts.failDaily && opts.failDaily())) throw new Error("timeout");
      return opts.daily ? opts.daily(now) : dailyCandles(now);
    },
    fetchFundingHistory: async () => {
      calls.hist++;
      if (all() || opts.failHist) throw new Error("timeout");
      return opts.hourly ? opts.hourly(now) : hist(now, () => aprToHourly(10.95));
    },
    fetchPredictedFundings: async () => {
      calls.pred++;
      if (all() || opts.predicted === undefined) throw new Error("timeout");
      return opts.predicted;
    },
    fetchCandles: async () => {
      calls.candles++;
      if (all() || opts.candles === null) throw new Error("timeout");
      return (opts.candles ?? flat(price()))(now);
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
  const h = harness({ failAll: () => true });
  const c = await h.s.evaluate();
  assert.equal(c.regime, "RANGE_CHOP");
  assert.equal(c.floorStopPct, 0.05);
  assert.equal(c.source, "default");
  for (let i = 0; i < 19; i++) {
    h.advance(15); // 19 keeper ticks within 5 min
    await h.s.evaluate();
  }
  assert.equal(h.calls.hist, 1, "no retry inside the 5-min backoff");
  assert.equal(h.calls.cg, 1);
  h.advance(30);
  await h.s.evaluate();
  assert.equal(h.calls.hist, 2, "retries after backoff");
  assert.equal(h.calls.cg, 1, "CoinGecko has its own 30-min backoff");
  assert.match(h.logs[0], /EVAL FAILED \(all inputs unavailable \(HL 1d: timeout; CoinGecko: HTTP 429/);
  // attach with no pin → RANGE 5% lock (not the live regime)
  const { lock } = resolveAttachStopLock("", false);
  assert.equal(lock.stopPct, 0.05);
  assert.equal(priceStopFromLock(110.26, lock).toFixed(2), "104.75");
});

test("funding SOL entry missing + history down → funding unknown/neutral, partial read can't switch", async () => {
  const h = harness({ price: 120, failHist: true, predicted: [["BTC", []]] }); // trend +25 → score 75 alone
  const c1 = await h.s.evaluate();
  assert.equal(c1.details.fundingKnown, false);
  assert.ok(Math.abs(c1.score! - (75)) < 1e-9, `c1.score=${c1.score}`);
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

test("a single strong BULL read (score 100, margin 10) after dwell still needs a 2nd read", async () => {
  let apr = 0;
  const h = harness({ price: 109, hourly: (now) => hist(now, () => aprToHourly(apr)) });
  assert.equal((await h.s.evaluate()).regime, "RANGE_CHOP"); // score 75 → RANGE confirmed
  h.advance(3 * 3600);
  apr = 9;
  let c = await h.s.evaluate();
  assert.ok(Math.abs(c.score! - (100)) < 1e-9, `c.score=${c.score}`);
  assert.equal(c.regime, "RANGE_CHOP");
  assert.match(c.holdReason, /BULL needs 2 consecutive reads \(1\/2\)/);
  h.advance(1800);
  c = await h.s.evaluate();
  assert.equal(c.regime, "BULL_EXPANSION");
});

test("two consecutive confirming reads switch after boot; dwell 2h then holds a single contrary read", async () => {
  let apr = 9;
  const h = harness({ price: 109, hourly: (now) => hist(now, () => aprToHourly(apr)) });
  let c = await h.s.evaluate();
  assert.equal(c.regime, "RANGE_CHOP"); // boot: 1/2
  assert.match(c.holdReason, /boot: needs 2 consecutive reads \(1\/2\)/);
  assert.ok(c.nextEvalAt - h.now() === 1800, "re-check in 30 min while a switch is pending");
  h.advance(1800);
  c = await h.s.evaluate();
  assert.equal(c.regime, "BULL_EXPANSION");
  assert.equal(c.floorStopPct, 0.04);
  // Schmitt band: score 80 (funding 4% APR) keeps an existing BULL (stay ≥ 75) — no flip at the entry edge
  apr = 4;
  h.advance(3600);
  c = await h.s.evaluate();
  assert.equal(c.regime, "BULL_EXPANSION");
  assert.equal(c.rawRegime, "BULL_EXPANSION");
  // clearly contrary read (funding −5% APR → score ≈ 69, RANGE margin 16) inside the 2h dwell → held
  apr = -5;
  h.advance(900); // 1h15m after the switch to BULL; forced read (like /regime)
  c = await h.s.evaluate(true);
  assert.equal(c.regime, "BULL_EXPANSION");
  assert.equal(c.source, "held");
  assert.match(c.holdReason, /dwell/);
  // after the dwell → switch
  h.advance(3600);
  c = await h.s.evaluate();
  assert.equal(c.regime, "RANGE_CHOP");
});

test("long-side score < 20 → immediate BEAR (safety), no confirmation or dwell", async () => {
  // price 20% below SMA200 (= SMA50 in the harness) → long −15 + medium −10 + cross 0 = −25; funding −15% APR → −25 → score 0
  const h = harness({ price: SMA * 0.8, hourly: (now) => hist(now, () => aprToHourly(-15)) });
  const c = await h.s.evaluate();
  assert.equal(c.regime, "BEAR_DEFENSIVE");
  assert.ok(Math.abs(c.score! - (0)) < 1e-9, `c.score=${c.score}`);
});

test("eval failure keeps last good regime < 6h, then falls back to RANGE (never BULL)", async () => {
  let fail = false;
  const h = harness({ price: 109, failAll: () => fail, hourly: (now) => hist(now, () => aprToHourly(9)) });
  await h.s.evaluate();
  h.advance(1800);
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
  h.advance(1800);
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

test("direction: flat → 0; falling → negative; rising → positive; too little data → unknown", () => {
  const now = T0;
  const f = directionFromCandles(flat()(now), now * 1000)!;
  assert.equal(directionPoints(f), 0);
  const down = directionFromCandles(drift(-6)(now), now * 1000)!; // −6% over 3 days, ~−2% in the last 24h
  assert.ok(directionPoints(down) < 0, `down ${directionPoints(down)}`);
  const up = directionFromCandles(drift(+6)(now), now * 1000)!;
  assert.ok(directionPoints(up) > 0, `up ${directionPoints(up)}`);
  assert.equal(directionFromCandles(flat()(now).slice(-10), now * 1000), null);
  assert.equal(directionFromCandles("bad", now * 1000), null);
});

test("falling price while 26% above the 200-day average → not BULL", async () => {
  // today's shape: 24h −6%, below the 1h EMA20, 4h −1.3%; funding healthy (9% APR)
  const h = harness({
    price: 109,
    hourly: (now) => hist(now, () => aprToHourly(9)),
    candles: (now) => candles(now, (i) => (i >= 47 ? 116 - (7 * (i - 47)) / 24 : 116)),
  });
  for (let i = 0; i < 6; i++) {
    const c = await h.s.evaluate();
    assert.notEqual(c.regime, "BULL_EXPANSION");
    assert.notEqual(c.rawRegime, "BULL_EXPANSION");
    assert.ok(c.details.dirPts < 0);
    h.advance(1800);
  }
});

test("rising price + positive funding → BULL after 2 confirming reads", async () => {
  const h = harness({ price: 109, hourly: (now) => hist(now, () => aprToHourly(9)), candles: drift(+6) });
  let c = await h.s.evaluate();
  assert.equal(c.rawRegime, "BULL_EXPANSION");
  assert.equal(c.regime, "RANGE_CHOP");
  h.advance(1800);
  c = await h.s.evaluate();
  assert.equal(c.regime, "BULL_EXPANSION");
  assert.ok(c.details.dirPts > 0);
});

test("flat market with neutral funding → RANGE", async () => {
  // price ≈ 200-day average (trend ~0), funding in deadband, flat candles → score ≈ 50
  const h = harness({ price: SMA, hourly: (now) => hist(now, () => aprToHourly(1)), candles: flat(SMA) });
  for (let i = 0; i < 4; i++) {
    const c = await h.s.evaluate();
    assert.equal(c.regime, "RANGE_CHOP");
    assert.equal(c.rawRegime, "RANGE_CHOP");
    assert.equal(c.details.dirPts, 0);
    h.advance(3600);
  }
});

test("direction data missing → neutral (and trend price unknown) — partial read, no BULL", async () => {
  const h = harness({ price: 109, hourly: (now) => hist(now, () => aprToHourly(9)), candles: null });
  let c = await h.s.evaluate();
  assert.equal(c.details.directionKnown, false);
  assert.equal(c.details.dirPts, 0);
  assert.equal(c.details.trendKnown, false); // price comes from the same 1h feed
  for (let i = 0; i < 4; i++) {
    h.advance(3600);
    c = await h.s.evaluate();
    assert.equal(c.regime, "RANGE_CHOP");
  }
  const p = scoreInputs({ solPrice: 109, sma200: SMA, smaPoints: 200, funding: { ...UNKNOWN_FUNDING, known: true, apr: 9 }, direction: { known: false } as any });
  assert.equal(p.dirPts, 0); // unknown direction scores 0
});

test("short-term crash alone can't trigger BEAR; long side must agree", () => {
  const base = { solPrice: 109, sma200: 109, smaPoints: 201, funding: { ...UNKNOWN_FUNDING, known: true, apr: 0 } };
  const crash = { ...directionFromCandles(drift(-30)(T0), T0 * 1000)! }; // ~−10% in 24h
  const p = scoreInputs({ ...base, direction: crash });
  assert.equal(p.dirPts, -20);
  assert.ok(Math.abs(p.score! - (30)) < 1e-9, `p.score=${p.score}`);
  assert.equal(classifyScore(p), "RANGE_CHOP"); // trend + funding = 0 → not BEAR
  const bearish = scoreInputs({ ...base, solPrice: 102, direction: crash }); // 6.4% below the 200-day → long −9.6 (no SMA50)
  assert.equal(classifyScore(bearish), "BEAR_DEFENSIVE"); // long side agrees → BEAR (via normal confirmation)
  assert.ok(bearish.longScore > SCORE_BEAR_IMMEDIATE_BELOW, "long-side score above 20 → not the immediate shortcut");
});

test("HL daily SMA: closed days only, ≥150 required, last 200 used", () => {
  const nowMs = T0 * 1000;
  const r = smaFromDailyCandles(dailyCandles(T0, 86.54, 230, 5000), nowMs)!;
  assert.equal(r.sma200.toFixed(4), "86.5400"); // in-progress day (close 5000) excluded
  assert.equal(r.smaPoints, 200);
  assert.equal(smaFromDailyCandles(dailyCandles(T0, 86.54, 149), nowMs), null);
  assert.equal(smaFromDailyCandles(dailyCandles(T0, 86.54, 150), nowMs)!.smaPoints, 150);
  assert.equal(smaFromDailyCandles("bad", nowMs), null);
  // CoinGecko fallback uses the same definition (live point excluded)
  assert.equal(smaFromCoinGecko(cgSeries(5000, 86.54))!.sma200.toFixed(4), "86.5400");
});

test("SMA cached 6h: one HL daily fetch across hourly evals, CoinGecko never called", async () => {
  const h = harness({ price: 109 });
  for (let i = 0; i < 6; i++) {
    const c = await h.s.evaluate();
    assert.equal(c.details.trendKnown, true);
    assert.match(c.details.smaSource, /^HL 1d closes \(200\)/);
    h.advance(3600);
  }
  assert.equal(h.calls.daily, 1);
  assert.equal(h.calls.cg, 0);
  await h.s.evaluate();
  assert.equal(h.calls.daily, 2, "refetched after 6h");
});

test("HL daily down → CoinGecko fallback; both down → trend unknown/neutral, partial, no hammering", async () => {
  const h1 = harness({ price: 109, failDaily: () => true });
  const c1 = await h1.s.evaluate();
  assert.match(c1.details.smaSource, /CoinGecko fallback/);
  assert.ok(Math.abs(c1.details.trendPts! - (25)) < 1e-9, `c1.details.trendPts=${c1.details.trendPts}`);

  // both SMA sources down; funding +25 and a strong rally (+20) → raw would be BULL without trend…
  const h2 = harness({ price: 109, failDaily: () => true, failCg: () => true, hourly: (now) => hist(now, () => aprToHourly(9)), candles: drift(+30) });
  let c2 = await h2.s.evaluate();
  assert.equal(c2.details.trendKnown, false);
  assert.ok(Math.abs(c2.details.trendPts! - (0)) < 1e-9, `c2.details.trendPts=${c2.details.trendPts}`);
  assert.match(c2.details.smaSource, /unknown \(HL 1d: timeout; CoinGecko: HTTP 429/);
  for (let i = 0; i < 480; i++) {
    // 2h of 15s keeper ticks
    h2.advance(15);
    c2 = await h2.s.evaluate();
  }
  assert.equal(c2.regime, "RANGE_CHOP", "partial read (trend unknown) can't switch");
  assert.ok(h2.calls.daily <= 9, `HL daily backoff 15 min (${h2.calls.daily})`);
  assert.ok(h2.calls.cg <= 5, `CoinGecko backoff 30 min (${h2.calls.cg})`);
});

test("immediate BEAR shortcut needs the trend known (funding alone can't trip it)", async () => {
  const h = harness({ price: 109, failDaily: () => true, failCg: () => true, hourly: (now) => hist(now, () => aprToHourly(-15)) });
  const c = await h.s.evaluate();
  assert.equal(c.details.trendKnown, false);
  assert.equal(c.rawRegime, "BEAR_DEFENSIVE"); // score 25 with trend unknown…
  assert.equal(c.regime, "RANGE_CHOP"); // …but no immediate switch on a partial read
});

/** Daily candles: 150 closed days at `old`, then 80 closed days at `recent` (SMA50 = recent), in-progress day = 999. */
function twoLevelDaily(old: number, recent: number) {
  return (now: number) =>
    dailyCandles(now, old, 230, 999).map((r, i, a) => (i >= a.length - 1 - 80 && i < a.length - 1 ? { ...r, c: String(recent) } : r));
}

test("SMA50 from the same closed HL daily closes (last 50; in-progress day excluded)", () => {
  const nowMs = T0 * 1000;
  const r = smaFromDailyCandles(twoLevelDaily(80, 100)(T0), nowMs)!;
  assert.equal(r.sma50.toFixed(4), "100.0000");
  assert.equal(r.sma50Points, 50);
  assert.equal(r.sma200.toFixed(4), ((120 * 80 + 80 * 100) / 200).toFixed(4));
  const cg = smaFromCoinGecko({ prices: [...Array.from({ length: 150 }, (_, i) => [i, 80]), ...Array.from({ length: 50 }, (_, i) => [150 + i, 100]), [200, 5000]] })!;
  assert.equal(cg.sma50.toFixed(4), "100.0000");
});

test("trend components: SMA50 above/below, golden/death cross, missing SMA50 → 0 for those parts", () => {
  // today's live numbers: SOL $109.07, SMA200 $86.54, SMA50 $107.79
  const now = trendParts(109.07, 86.54, 107.79);
  assert.equal(now.long, 15); // +26% vs SMA200 → full
  assert.ok(now.medium > 1.4 && now.medium < 1.6, `medium ${now.medium}`); // +1.2% vs SMA50 → +1.5
  assert.equal(now.cross, 10); // SMA50 24.6% above SMA200 → golden cross, full
  // price BELOW its 50-day while still above the 200-day: the medium component goes negative
  const below = trendParts(100, 86.54, 107.79);
  assert.ok(below.medium < -8.9 && below.medium > -9.1, `medium ${below.medium}`); // −7.2% vs SMA50 → −9.0
  assert.equal(below.long, 15);
  assert.ok(below.total < now.total - 8);
  // death cross
  const death = trendParts(80, 90, 76.5); // SMA50 15% below SMA200
  assert.equal(death.cross, -10);
  assert.ok(death.long < 0 && death.medium > 0);
  // SMA50 missing → medium and cross are 0, long unaffected
  const miss = trendParts(109, 86.54, NaN);
  assert.equal(miss.medium, 0);
  assert.equal(miss.cross, 0);
  assert.equal(miss.long, 15);
  // max ±35
  assert.equal(trendParts(200, 100, 150).total, 35);
  assert.equal(trendParts(50, 100, 70).total, -35);
});

test("BULL needs funding > 0: full trend (+35) and a strong rally (+20) with neutral funding stay RANGE", () => {
  const dirUp = directionFromCandles(drift(+30)(T0), T0 * 1000)!;
  const base = { solPrice: 200, sma200: 100, sma50: 150, smaPoints: 200, sma50Points: 50, direction: dirUp };
  const neutral = scoreInputs({ ...base, funding: { ...UNKNOWN_FUNDING, known: true, apr: 1 } });
  assert.equal(neutral.trendPts, 35);
  assert.ok(neutral.score >= SCORE_BULL_MIN, `score ${neutral.score}`);
  assert.equal(classifyScore(neutral), "RANGE_CHOP");
  const paid = scoreInputs({ ...base, funding: { ...UNKNOWN_FUNDING, known: true, apr: 9 } });
  assert.equal(classifyScore(paid), "BULL_EXPANSION");
  // trend alone (direction 0, funding 0) maxes at 85 < 90
  const flatDir = directionFromCandles(flat(200)(T0), T0 * 1000)!;
  const alone = scoreInputs({ ...base, direction: flatDir, funding: { ...UNKNOWN_FUNDING, known: true, apr: 0 } });
  assert.equal(alone.score, 85);
  assert.equal(classifyScore(alone), "RANGE_CHOP");
});

test("sentinel: price below SMA50 lowers trend; [REGIME] line and summary show SMA200, SMA50 and each component", async () => {
  // SMA200 = (120×80 + 80×120)/200 = 96, SMA50 = 120; price 109 → +13.5% vs 200 (long +15), −9.2% vs 50 (medium −10), cross +25% (+10)
  const h = harness({ price: 109, daily: twoLevelDaily(80, 120), hourly: (now) => hist(now, () => aprToHourly(9)) });
  const c = await h.s.evaluate(true);
  assert.equal(c.details.sma50.toFixed(2), "120.00");
  assert.equal(c.details.sma200.toFixed(2), "96.00");
  assert.equal(c.details.trendLongPts, 15);
  assert.equal(c.details.trendMedPts, -10);
  assert.equal(c.details.crossPts, 10);
  assert.ok(Math.abs(c.details.trendPts - 15) < 1e-9);
  const line = h.logs[h.logs.length - 1];
  assert.match(line, /vs SMA200 \$96\.00 \(\+13\.5%\) \+15\.0, vs SMA50 \$120\.00 \(-9\.2%\) -10\.0, cross SMA50\/200 \+25\.0% \+10\.0 \[HL 1d closes \(200\)\]/);
  assert.match(h.s.summary(), /trend \+15\.0 \[SMA200 \$96\.00 \+15\.0, SMA50 \$120\.00 -10\.0, cross \+10\.0\], funding \+25\.0, dir \+0\.0/);
});

test("SMA50 unknown → its components score 0 and the read is partial (can't switch)", async () => {
  // Inputs with SMA200 but no SMA50 (scoring level) …
  const p = scoreInputs({ solPrice: 109, sma200: 86.54, smaPoints: 200, funding: { ...UNKNOWN_FUNDING, known: true, apr: 9 }, direction: directionFromCandles(flat(109)(T0), T0 * 1000)! });
  assert.equal(p.trendMedPts, 0);
  assert.equal(p.crossPts, 0);
  assert.equal(p.trendLongPts, 15);
  // … and in the sentinel: a fallback source without SMA50 is treated as a partial read
  const h = harness({ price: 109, failDaily: () => true, hourly: (now) => hist(now, () => aprToHourly(9)), candles: drift(+30) });
  (h as any).s["fetchers"].fetchCoinGecko = async () => ({ prices: [[0, NaN]] }); // unusable → SMA unknown entirely
  let c = await h.s.evaluate();
  assert.equal(c.details.trendKnown, false);
  assert.ok(Number.isNaN(c.details.sma50));
  for (let i = 0; i < 4; i++) {
    h.advance(1800);
    c = await h.s.evaluate();
  }
  assert.equal(c.regime, "RANGE_CHOP");
  assert.match(c.holdReason, /trend\/SMA/);
});
