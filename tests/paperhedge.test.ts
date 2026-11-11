import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { positionSolUnitsFromAmounts } from "../tickstate";
import { forbiddenPresent, loadConfig } from "../paper-hedge/config";
import {
  Book,
  HedgeConfig,
  Quote,
  StepInput,
  applyFill,
  contractDelta,
  freshBook,
  fundingCashUsd,
  hedgePnlUsd,
  leverageForNotional,
  lpSolFromParts,
  marginView,
  netDeltaUsd,
  positionFingerprint,
  rebalanceTrade,
  roundToContract,
  step,
  unrealizedUsd,
} from "../paper-hedge/engine";
import { bestLevel, buildFunding, buildQuote, buildRisk } from "../paper-hedge/kalshi";
import { parseReplayLine, replaySummary, runReplay } from "../paper-hedge/replay";
import { rowPayload } from "../paper-hedge/sheet";
import { decodeState, encodeState } from "../paper-hedge/state";

function cfg(over: Partial<HedgeConfig> = {}): HedgeConfig {
  return {
    bandPct: 0.1,
    hedgeRatio: 1,
    hedgeCheckMs: 3_600_000,
    contractSol: 0.1,
    takerFeeRate: 0.0004,
    fundingFallbackRate: 0,
    fundingSign: 1,
    fundingGraceMs: 120_000,
    marginFraction: 0.25,
    capitalUsd: 650,
    staleMs: 60_000,
    logEveryMs: 0,
    positionBucketSol: 0.05,
    maintLeverageFallback: 3.1,
    initialMarginMultiplier: 1.3,
    liquidationRatio: 1,
    queueRatio: 0.91,
    ...over,
  };
}

const NOW = 1_762_460_000_000;

function quote(over: Partial<Quote> = {}): Quote {
  return {
    bidContract: 10,
    askContract: 10.02,
    markContract: 10,
    contractSol: 0.1,
    tsMs: NOW,
    fetchedAtMs: NOW,
    bidSizeContracts: 500,
    askSizeContracts: 500,
    shortLeverageEstimates: null,
    ...over,
  };
}

function input(over: Partial<StepInput> = {}): StepInput {
  return {
    nowMs: NOW,
    chainOk: true,
    chainTsMs: NOW,
    solPrice: 100,
    lpSol: 3.54,
    lpEquity: 650,
    fingerprint: "pos:3.50",
    positionIds: ["Pos111"],
    quote: quote(),
    funding: { fetchedAtMs: NOW, nextFundingTimeMs: NOW + 8 * 3600_000, rates: [] },
    risk: null,
    ...over,
  };
}

test("LP SOL is position inventory plus fee SOL plus idle wallet SOL above the gas reserve", () => {
  const amounts = [
    { key: "a", ok: true, x: 2e9, y: 0, feeX: 1e7, feeY: 0 },
    { key: "b", ok: false, x: 5e9, y: 0, feeX: 0, feeY: 0 },
    { key: "c", ok: true, x: NaN, y: 0, feeX: 5e7, feeY: 0 },
  ];
  const positionSol = positionSolUnitsFromAmounts(amounts);
  assert.equal(positionSol, 2.06);
  assert.ok(Math.abs(lpSolFromParts(positionSol, 200_000_000, 10_000_000, 120_000_000) - 2.15) < 1e-9);
  assert.equal(lpSolFromParts(positionSol, 50_000_000, 0, 120_000_000), positionSol);
  assert.ok(Math.abs(netDeltaUsd(2.15, 2.1, 100) - 5) < 1e-9);
});

test("short size rounds to 0.1 SOL", () => {
  const stepSol = 0.1;
  assert.equal(roundToContract(0, stepSol), 0);
  assert.equal(roundToContract(0.04, stepSol), 0);
  assert.equal(roundToContract(0.05, stepSol), 0.1);
  assert.equal(roundToContract(1.24, stepSol), 1.2);
  assert.equal(roundToContract(1.25, stepSol), 1.3);
  assert.equal(roundToContract(3.54, stepSol), 3.5);
  assert.equal(roundToContract(Number.NaN, stepSol), 0);
  assert.equal(roundToContract(-2, stepSol), 0);
  assert.equal(contractDelta(3.5, 0, stepSol), 3.5);
  assert.equal(contractDelta(3.5, 3.6, stepSol), -0.1);
});

test("position fingerprint changes on open, close, and a 0.05 SOL bucket, not on fee dust", () => {
  const bucket = 0.05;
  const a = positionFingerprint([{ key: "p", ok: true, x: 3.52e9, feeX: 0 }], bucket);
  const dust = positionFingerprint([{ key: "p", ok: true, x: 3.52e9, feeX: 0.001e9 }], bucket);
  const topup = positionFingerprint([{ key: "p", ok: true, x: 3.70e9, feeX: 0 }], bucket);
  const closed = positionFingerprint([], bucket);
  assert.equal(a, dust);
  assert.notEqual(a, topup);
  assert.equal(closed, "");
  assert.notEqual(a, closed);
});

function hedgeArgs(over: Partial<Parameters<typeof rebalanceTrade>[0]> = {}) {
  return {
    shortSol: 10,
    solPrice: 100,
    contractSol: 0.1,
    bandPct: 0.1,
    hedgeRatio: 1,
    stale: false,
    nowMs: 1_000_000,
    lastCheckMs: 0,
    checkEveryMs: 3_600_000,
    positionSet: "A",
    prevPositionSet: "A" as string | null,
    lpSol: 10,
    ...over,
  };
}

function at(now: number, over: Partial<StepInput> = {}): StepInput {
  return input({
    nowMs: now,
    chainTsMs: now,
    lpSol: 10,
    positionIds: ["A"],
    quote: quote({ tsMs: now, fetchedAtMs: now }),
    funding: { fetchedAtMs: now, nextFundingTimeMs: now + 8 * 3600_000, rates: [] },
    ...over,
  });
}

test("band: inside 10% of target does not trade, outside trades to the rounded target", () => {
  const inside = rebalanceTrade(hedgeArgs({ lpSol: 10.9, shortSol: 10 }));
  assert.equal(inside.checked, true);
  assert.equal(inside.tradeSol, 0);
  assert.equal(inside.reason, "inside_band");
  assert.equal(inside.rawTarget, 10.9);

  // |9 − 10| is exactly 10% of the target, which does not exceed the band.
  const exact = rebalanceTrade(hedgeArgs({ lpSol: 10, shortSol: 9 }));
  assert.equal(exact.tradeSol, 0);
  assert.equal(exact.reason, "inside_band");

  const outside = rebalanceTrade(hedgeArgs({ lpSol: 10, shortSol: 8 }));
  assert.equal(outside.rawTarget, 10);
  assert.equal(outside.targetShort, 10);
  assert.equal(outside.tradeSol, 2);
  assert.equal(outside.reason, "band");

  const rounded = rebalanceTrade(hedgeArgs({ lpSol: 3.54, shortSol: 0, prevPositionSet: null }));
  assert.equal(rounded.targetShort, 3.5);
  assert.equal(rounded.tradeSol, 3.5);
  assert.equal(rounded.reason, "open");

  const halfInside = rebalanceTrade(hedgeArgs({ lpSol: 10, shortSol: 5, hedgeRatio: 0.5 }));
  assert.equal(halfInside.rawTarget, 5);
  assert.equal(halfInside.tradeSol, 0);
  assert.equal(halfInside.reason, "hold");

  const halfOutside = rebalanceTrade(hedgeArgs({ lpSol: 12, shortSol: 5, hedgeRatio: 0.5 }));
  assert.equal(halfOutside.rawTarget, 6);
  assert.equal(halfOutside.targetShort, 6);
  assert.equal(halfOutside.tradeSol, 1);
  assert.equal(halfOutside.reason, "band");

  const stale = rebalanceTrade(hedgeArgs({ lpSol: 0, shortSol: 10, stale: true, positionSet: "", prevPositionSet: "A" }));
  assert.equal(stale.tradeSol, 0);
  assert.equal(stale.reason, "stale");
  assert.equal(stale.checked, false);
});

test("hourly cadence holds an out-of-band drift, then trades to target on the next check", () => {
  const last = 1_000_000;
  const early = rebalanceTrade(
    hedgeArgs({ lpSol: 20, shortSol: 10, lastCheckMs: last, nowMs: last + 3_600_000 - 1 })
  );
  assert.equal(early.tradeSol, 0);
  assert.equal(early.checked, false);
  assert.equal(early.reason, "hold");

  const due = rebalanceTrade(hedgeArgs({ lpSol: 20, shortSol: 10, lastCheckMs: last, nowMs: last + 3_600_000 }));
  assert.equal(due.checked, true);
  assert.equal(due.targetShort, 20);
  assert.equal(due.tradeSol, 10);
  assert.equal(due.reason, "band");

  // Same position, 0.05 SOL inventory bucket: not a trade, even on the hour.
  const bucket = rebalanceTrade(
    hedgeArgs({ lpSol: 10.05, shortSol: 10, lastCheckMs: last, nowMs: last + 3_600_000 })
  );
  assert.equal(bucket.tradeSol, 0);
  assert.equal(bucket.reason, "inside_band");
});

test("a position-set change re-hedges immediately, including a flat LP", () => {
  const last = 1_000_000;
  const soon = last + 30_000;
  const wiggle = rebalanceTrade(
    hedgeArgs({ lpSol: 0, shortSol: 10, lastCheckMs: last, nowMs: soon, positionSet: "A", prevPositionSet: "A" })
  );
  assert.equal(wiggle.tradeSol, 0);
  assert.equal(wiggle.checked, false);

  const stopped = rebalanceTrade(
    hedgeArgs({ lpSol: 0, shortSol: 10, lastCheckMs: last, nowMs: soon, positionSet: "", prevPositionSet: "A" })
  );
  assert.equal(stopped.checked, true);
  assert.equal(stopped.targetShort, 0);
  assert.equal(stopped.tradeSol, -10);
  assert.equal(stopped.reason, "position_change");

  // Recenter/redeploy inside the 10% band still snaps to the new target.
  const recenter = rebalanceTrade(
    hedgeArgs({ lpSol: 10.4, shortSol: 10, lastCheckMs: last, nowMs: soon, positionSet: "B", prevPositionSet: "A" })
  );
  assert.equal(recenter.tradeSol, 0.4);
  assert.equal(recenter.targetShort, 10.4);
  assert.equal(recenter.reason, "position_change");

  const redeploy = rebalanceTrade(
    hedgeArgs({ lpSol: 4, shortSol: 0, lastCheckMs: last, nowMs: soon, positionSet: "C", prevPositionSet: "" })
  );
  assert.equal(redeploy.tradeSol, 4);
  assert.equal(redeploy.reason, "open");
});

test("step logs an in-band hourly skip and covers a flat LP without waiting out the hour", () => {
  const c = cfg({ logEveryMs: 300_000 });
  const open = step(freshBook(650), at(NOW, { lpSol: 10, positionIds: ["A"] }), c);
  assert.equal(open.book.shortSol, 10);
  assert.equal(open.row?.reason, "open");
  assert.equal(open.book.lastHedgeCheckMs, NOW);
  assert.equal(open.book.positionSet, "A");
  assert.equal(open.skipLog, null);

  const drift = step(open.book, at(NOW + 30 * 60_000, { lpSol: 20, positionIds: ["A"], fingerprint: "A:20.00" }), c);
  assert.equal(drift.book.shortSol, 10);
  assert.equal(drift.row?.tradeSol, 0);
  assert.equal(drift.reason, "hold");
  assert.equal(drift.skipLog, null);
  assert.equal(drift.book.lastHedgeCheckMs, NOW);
  assert.equal(drift.book.positionSet, "A");

  const hour = step(drift.book, at(NOW + 3_600_000, { lpSol: 10.4, positionIds: ["A"] }), c);
  assert.equal(hour.book.shortSol, 10);
  assert.equal(hour.row?.tradeSol, 0);
  assert.equal(hour.reason, "inside_band");
  assert.match(hour.skipLog || "", /hedge check skipped: drift inside band/);
  assert.match(hour.skipLog || "", /short=10\.0000 target=10\.4000/);
  assert.equal(hour.book.lastHedgeCheckMs, NOW + 3_600_000);

  const closed = step(hour.book, at(NOW + 3_600_000 + 30_000, { lpSol: 0, positionIds: [], fingerprint: "" }), c);
  assert.equal(closed.book.shortSol, 0);
  assert.equal(closed.row?.tradeSol, -10);
  assert.equal(closed.row?.reason, "position_change");
  assert.equal(closed.skipLog, null);
  assert.equal(closed.book.positionSet, "");

  const poisoned = step(
    closed.book,
    at(NOW + 3_600_000 + 40_000, { chainOk: false, lpSol: 15, positionIds: ["Z"] }),
    c
  );
  assert.equal(poisoned.book.shortSol, 0);
  assert.equal(poisoned.book.positionSet, "");
  assert.equal(poisoned.book.lastHedgeCheckMs, closed.book.lastHedgeCheckMs);

  const again = step(poisoned.book, at(NOW + 3_600_000 + 50_000, { lpSol: 4, positionIds: ["Z"] }), c);
  assert.equal(again.book.shortSol, 4);
  assert.equal(again.row?.reason, "open");
  assert.equal(again.book.positionSet, "Z");
});

test("a stale chain or Kalshi read does not change the short", () => {
  const book = { ...freshBook(650), shortSol: 3.5, avgEntrySolPx: 100, fingerprint: "pos:3.50", lastMarkSolPx: 100 };
  const staleChain = step(book, input({ chainOk: false, chainTsMs: NOW - 120_000, lpSol: 10, fingerprint: "other" }), cfg());
  assert.equal(staleChain.book.shortSol, 3.5);
  assert.equal(staleChain.row?.reason, "stale");
  assert.equal(staleChain.row?.tradeSol, 0);
  assert.ok(staleChain.staleReasons.includes("chain"));

  const oldBook = step(book, input({ quote: quote({ tsMs: NOW - 90_000, fetchedAtMs: NOW - 90_000 }) }), cfg());
  assert.equal(oldBook.book.shortSol, 3.5);
  assert.ok(oldBook.staleReasons.includes("kalshi_mark_stale"));
});

test("taker fills: sell the bid to short, buy the ask to cover, fees and P&L", () => {
  let book = freshBook(650);
  const open = step(book, input({ lpSol: 3.54, fingerprint: "a" }), cfg());
  book = open.book;
  assert.equal(book.shortSol, 3.5);
  assert.equal(book.avgEntrySolPx, 100);
  assert.ok(Math.abs(book.feesUsd - 3.5 * 100 * 0.0004) < 1e-9);
  assert.equal(open.row?.reason, "open");
  assert.equal(open.row?.tradeSol, 3.5);

  const marked = step(
    book,
    input({
      lpSol: 3.54,
      fingerprint: "a",
      solPrice: 110,
      quote: quote({ bidContract: 11, askContract: 11.02, markContract: 11 }),
    }),
    cfg()
  );
  assert.equal(marked.book.shortSol, 3.5);
  assert.ok(Math.abs(unrealizedUsd(3.5, 100, 110) + 35) < 1e-9);
  assert.ok(Math.abs(marked.row!.hedgePnlUsd - (0 + -35 + 0 - book.feesUsd)) < 1e-9);

  const cover = step(
    book,
    input({
      lpSol: 0,
      lpEquity: 300,
      fingerprint: "",
      positionIds: [],
      quote: quote({ bidContract: 11.1, askContract: 11.2, markContract: 11.2 }),
    }),
    cfg()
  );
  assert.equal(cover.book.shortSol, 0);
  assert.equal(cover.row?.reason, "position_change");
  const coverFee = 3.5 * 112 * 0.0004;
  const realized = 3.5 * (100 - 112);
  assert.ok(Math.abs(cover.book.realizedUsd - realized) < 1e-9);
  assert.ok(Math.abs(cover.book.feesUsd - (book.feesUsd + coverFee)) < 1e-9);
  assert.ok(Math.abs(hedgePnlUsd(cover.book, 112) - (realized - cover.book.feesUsd)) < 1e-9);
});

test("adding to the short blends the entry; reducing realizes only the covered size", () => {
  let book: Book = { ...freshBook(650), shortSol: 1, avgEntrySolPx: 100, fingerprint: "a" };
  book = applyFill(book, 1, 110, 0);
  assert.equal(book.shortSol, 2);
  assert.equal(book.avgEntrySolPx, 105);
  book = applyFill(book, -0.5, 90, 0);
  assert.equal(book.shortSol, 1.5);
  assert.equal(book.avgEntrySolPx, 105);
  assert.ok(Math.abs(book.realizedUsd - 0.5 * (105 - 90)) < 1e-9);
});

test("published funding is accrued once for a short, with the print's mark", () => {
  const book: Book = { ...freshBook(650), shortSol: 2, avgEntrySolPx: 100, fingerprint: "a", lastMarkSolPx: 50 };
  const rates = [{ time: "2026-11-06T13:00:00Z", timeMs: Date.parse("2026-11-06T13:00:00Z"), rate: 0.001, markContract: 10 }];
  const first = step(
    book,
    input({
      nowMs: Date.parse("2026-11-06T13:30:00Z"),
      chainTsMs: Date.parse("2026-11-06T13:30:00Z"),
      quote: quote({ tsMs: Date.parse("2026-11-06T13:30:00Z"), fetchedAtMs: Date.parse("2026-11-06T13:30:00Z"), markContract: 8 }),
      funding: { fetchedAtMs: Date.parse("2026-11-06T13:30:00Z"), nextFundingTimeMs: Date.parse("2026-11-06T21:00:00Z"), rates },
    }),
    cfg()
  );
  assert.ok(Math.abs(fundingCashUsd(2, 100, 0.001) - 0.2) < 1e-12);
  assert.ok(Math.abs(first.book.fundingUsd - 0.2) < 1e-12);
  assert.equal(first.book.appliedFunding[rates[0].time].source, "published");
  assert.equal(first.row?.fundingUsd, 0.2);

  const second = step(first.book, input({
    nowMs: Date.parse("2026-11-06T13:31:00Z"),
    chainTsMs: Date.parse("2026-11-06T13:31:00Z"),
    quote: quote({ tsMs: Date.parse("2026-11-06T13:31:00Z"), fetchedAtMs: Date.parse("2026-11-06T13:31:00Z") }),
    funding: { fetchedAtMs: Date.parse("2026-11-06T13:31:00Z"), nextFundingTimeMs: Date.parse("2026-11-06T21:00:00Z"), rates },
  }), cfg());
  assert.equal(second.book.fundingUsd, first.book.fundingUsd);
  assert.equal(second.row?.fundingUsd, 0);

  const flipped = step(book, input({
    nowMs: Date.parse("2026-11-06T13:30:00Z"),
    chainTsMs: Date.parse("2026-11-06T13:30:00Z"),
    quote: quote({ tsMs: Date.parse("2026-11-06T13:30:00Z"), fetchedAtMs: Date.parse("2026-11-06T13:30:00Z") }),
    funding: { fetchedAtMs: Date.parse("2026-11-06T13:30:00Z"), nextFundingTimeMs: null, rates },
  }), cfg({ fundingSign: -1 }));
  assert.ok(Math.abs(flipped.book.fundingUsd + 0.2) < 1e-12);
});

test("a missing funding print after the grace window uses the fallback rate and is flagged", () => {
  const due = Date.parse("2026-11-06T13:00:00Z");
  const now = due + 180_000;
  const book: Book = {
    ...freshBook(650),
    shortSol: 2,
    avgEntrySolPx: 100,
    fingerprint: "a",
    lastMarkSolPx: 100,
    watchedFundingMs: due,
  };
  const out = step(
    book,
    input({
      nowMs: now,
      chainTsMs: now,
      quote: quote({ tsMs: now, fetchedAtMs: now, markContract: 10 }),
      funding: { fetchedAtMs: now, nextFundingTimeMs: null, rates: [] },
    }),
    cfg({ fundingFallbackRate: 0.0005 })
  );
  assert.ok(Math.abs(out.book.fundingUsd - 2 * 100 * 0.0005) < 1e-12);
  assert.ok(out.warnings.includes("funding_fallback"));
  assert.match(out.row!.notes, /fundingSource=fallback/);
  const again = step(out.book, input({
    nowMs: now + 30_000,
    chainTsMs: now + 30_000,
    quote: quote({ tsMs: now + 30_000, fetchedAtMs: now + 30_000 }),
    funding: { fetchedAtMs: now + 30_000, nextFundingTimeMs: null, rates: [] },
  }), cfg({ fundingFallbackRate: 0.0005 }));
  assert.equal(again.book.fundingUsd, out.book.fundingUsd);
});

test("paper margin: leverage, queue, liquidation, and initial-margin warnings", () => {
  const c = cfg();
  const flat = marginView(freshBook(650), 100, c, null, null);
  assert.equal(flat.postedCollateralUsd, 162.5);
  assert.equal(flat.warnings.length, 0);

  const modest: Book = { ...freshBook(650), shortSol: 1, avgEntrySolPx: 100 };
  const ok = marginView(modest, 100, c, { "1000": 4, "10000": 2 }, null);
  assert.equal(ok.leverageSource, "published");
  assert.equal(ok.leverage, 4);
  assert.equal(ok.notionalUsd, 100);
  assert.ok(Math.abs((ok.effectiveLeverage ?? 0) - 100 / 162.5) < 1e-9);
  assert.equal(ok.warnings.length, 0);

  const large: Book = { ...freshBook(650), shortSol: 6, avgEntrySolPx: 100 };
  const hot = marginView(large, 100, c, null, null);
  assert.equal(hot.leverageSource, "fallback");
  assert.ok(hot.warnings.includes("liquidation"));
  assert.ok(hot.warnings.includes("below_initial_margin"));

  const spiked: Book = { ...freshBook(650), shortSol: 2, avgEntrySolPx: 100 };
  const liq = marginView(spiked, 200, c, { "1000": 3.1 }, null);
  assert.ok(liq.marginEquityUsd < 0 || (liq.marginRatio != null && liq.marginRatio >= 1));
  assert.ok(liq.warnings.includes("liquidation"));

  assert.equal(leverageForNotional({ "1000": 4, "10000": 2 }, 5000, 3.1).leverage, 2);
  assert.equal(leverageForNotional({ "1000": 4, "10000": 2 }, 50_000, 3.1).leverage, 2);
  assert.equal(leverageForNotional(null, 100, 3.1).source, "fallback");
});

test("sheet row carries the Paper Hedge discriminator and blanks a missing price", () => {
  const book = freshBook(650);
  const out = step(book, input({ chainOk: false, solPrice: NaN, lpSol: NaN, lpEquity: NaN }), cfg());
  const payload = rowPayload(out.row!, "paper-hedge", "SOL-USDC 10bps");
  assert.equal(payload.event, "PAPER_HEDGE");
  assert.equal(payload.sheet, "Paper Hedge");
  assert.equal(payload.sol_price, "");
  assert.equal(payload.stale, true);
  assert.match(String(payload.unhedged_vs_hedged), /unhedged=/);
});

test("Kalshi book parser takes the best bid and ask even when they are not first", () => {
  const market = {
    market: {
      bid: "9.0345",
      ask: "9.0370",
      contract_size: "0.100000",
      settlement_mark_price: { price: "9.0337", ts_ms: 1_793_995_703_701 },
      reference_price: { price: "9.0330", ts_ms: 1_793_995_707_000 },
      short_leverage_estimates: { "1000": 3.0984, "10000": 3.0909 },
    },
  };
  const book = {
    orderbook: {
      asks: [["9.0375", "51.00"], ["9.0371", "449.00"], ["9.0370", "17.00"]],
      bids: [["9.0335", "51.00"], ["9.0340", "51.00"], ["9.0345", "375.00"]],
    },
  };
  const q = buildQuote(market, book, 1_793_995_708_000);
  assert.ok(q);
  assert.equal(q!.bidContract, 9.0345);
  assert.equal(q!.bidSizeContracts, 375);
  assert.equal(q!.askContract, 9.037);
  assert.equal(q!.askSizeContracts, 17);
  assert.equal(q!.markContract, 9.0337);
  assert.equal(q!.contractSol, 0.1);
  assert.equal(q!.tsMs, 1_793_995_703_701);
  assert.equal(bestLevel(book.orderbook.bids, "bid")!.price, 9.0345);

  const funding = buildFunding(
    { next_funding_time: "2026-11-06T21:00:00Z", funding_rate: 0 },
    { funding_rates: [{ funding_time: "2026-11-06T13:00:00Z", funding_rate: -0.00027, mark_price: "9.0093", market_ticker: "KXSOLPERP" }] },
    100
  );
  assert.equal(funding.rates.length, 1);
  assert.equal(funding.rates[0].rate, -0.00027);
  assert.equal(funding.nextFundingTimeMs, Date.parse("2026-11-06T21:00:00Z"));

  const risk = buildRisk(
    { liquidation_margin_ratio_threshold: 1, queue_entry_margin_ratio_threshold: 0.91, initial_margin_multiplier: { KXSOLPERP: 1.3 } },
    "KXSOLPERP",
    { liquidationRatio: 9, queueRatio: 9, initialMultiplier: 9 }
  );
  assert.equal(risk.source, "published");
  assert.equal(risk.initialMultiplier, 1.3);
  assert.equal(risk.queueRatio, 0.91);
});

test("config defaults are safe and a private key blocks startup detection", () => {
  const c = loadConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.wallet, "2YtsAfr19EhNaGrB6W8YqtuJeaaRoY7xq83GFxdnYq6t");
  assert.equal(c.pool, "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y");
  assert.equal(c.bandPct, 0.1);
  assert.equal(c.hedgeRatio, 1);
  assert.equal(c.hedgeCheckMs, 3_600_000);
  assert.equal(c.takerFeeRate, 0.0004);
  assert.equal(c.marginFraction, 0.25);
  assert.equal(c.capitalUsd, 650);
  assert.equal(c.gasReserveLamports, 120_000_000);
  assert.equal(c.pollMs, 30_000);
  assert.equal(c.staleMs, 60_000);
  const on = loadConfig({
    PAPER_HEDGE_ENABLED: "true",
    PAPER_HEDGE_BAND_PCT: "0.2",
    PAPER_HEDGE_FUNDING_SIGN: "-1",
    PAPER_HEDGE_RATIO: "0.5",
    PAPER_HEDGE_CHECK_SEC: "900",
  });
  assert.equal(on.enabled, true);
  assert.equal(on.bandPct, 0.2);
  assert.equal(on.fundingSign, -1);
  assert.equal(on.hedgeRatio, 0.5);
  assert.equal(on.hedgeCheckMs, 900_000);
  assert.deepEqual(forbiddenPresent({}), []);
  assert.deepEqual(forbiddenPresent({ BOT_PRIVATE_KEY: "abc", KALSHI_API_KEY: "k" }), ["BOT_PRIVATE_KEY", "KALSHI_API_KEY"]);
  assert.deepEqual(forbiddenPresent({ BOT_PRIVATE_KEY: "   " }), []);
});

test("state round-trip keeps the short and ignores a corrupt file", () => {
  const book: Book = {
    ...freshBook(650),
    shortSol: 3.4,
    avgEntrySolPx: 99.5,
    feesUsd: 0.14,
    fundingUsd: 0.2,
    fingerprint: "pos",
    positionSet: "Pos111",
    lastHedgeCheckMs: 1_700_000_000_000,
    appliedFunding: { "2026-11-06T13:00:00Z": { rate: 0.001, usd: 0.2, source: "published" } },
  };
  const decoded = decodeState(encodeState(book), freshBook(1));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.book.shortSol, 3.4);
  assert.equal(decoded.book.avgEntrySolPx, 99.5);
  assert.equal(decoded.book.positionSet, "Pos111");
  assert.equal(decoded.book.lastHedgeCheckMs, 1_700_000_000_000);
  assert.equal(decoded.book.appliedFunding["2026-11-06T13:00:00Z"].usd, 0.2);
  const legacy = decodeState(JSON.stringify({ version: 1, book: { shortSol: 1, baselineUsd: 650 } }), freshBook(650));
  assert.equal(legacy.ok, true);
  assert.equal(legacy.book.shortSol, 1);
  assert.equal(legacy.book.positionSet, null);
  assert.equal(legacy.book.lastHedgeCheckMs, 0);
  const bad = decodeState("{not json", freshBook(650));
  assert.equal(bad.ok, false);
  assert.equal(bad.book.shortSol, 0);
});

test("replay of a 5 SOL drop from 100 to 80 hedges the LP loss down to the taker fee", () => {
  const file = path.join(process.cwd(), "paper-hedge", "fixtures", "sol-drop.jsonl");
  const ticks = fs.readFileSync(file, "utf8").split("\n").map(parseReplayLine).filter((t): t is NonNullable<typeof t> => !!t);
  assert.equal(ticks.length, 3);
  const result = runReplay(ticks, cfg({ logEveryMs: 300_000 }));
  const summary = replaySummary(result);
  assert.equal(summary.trades, 1);
  assert.equal(summary.finalShortSol, 5);
  assert.ok(Math.abs(Number(summary.feesUsd) - 0.2) < 1e-9);
  assert.ok(Math.abs(Number(summary.hedgePnlUsd) - 99.8) < 1e-6);
  assert.ok(Math.abs(Number(summary.unhedgedPnlUsd) - -100) < 1e-6);
  assert.ok(Math.abs(Number(summary.hedgedPnlUsd) - -0.2) < 1e-6);
  assert.ok((summary.warnings as string[]).includes("below_initial_margin"));
});

test("paper hedger sources do not import the keeper or sign transactions", () => {
  const dir = path.join(process.cwd(), "paper-hedge");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.includes("index.ts"));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(src, /from ["']\.\.\/index["']/);
    assert.doesNotMatch(src, /Keypair\.fromSecretKey|signTransaction|sendTransaction|partialSign/);
  }
});
