/**
 * Paper SOL delta hedge: pure sizing, fills, funding, and P&L.
 * No RPC, no HTTP, no keys. The process in index.ts feeds it public data.
 *
 * Short size is positive (SOL we are synthetically short). A positive trade
 * sells more perp (increases the short); a negative trade buys to cover.
 *
 * Funding sign default (+1): a positive published rate means the perp traded
 * rich to the index, so shorts receive and longs pay. Flip with
 * PAPER_HEDGE_FUNDING_SIGN=-1 if a live payment ever shows the other way.
 */

export interface Book {
  shortSol: number;
  avgEntrySolPx: number;
  realizedUsd: number;
  feesUsd: number;
  fundingUsd: number;
  /** Keyed by the exchange funding timestamp (or the fallback ISO time). */
  appliedFunding: Record<string, { rate: number; usd: number; source: "published" | "fallback" }>;
  /** Last fresh position-amount fingerprint. Inventory drift here does not trade by itself. */
  fingerprint: string | null;
  /**
   * Sorted open-position account ids from the last fresh read.
   * Null until that read. A change (close, stop-out, deploy, recenter) re-hedges immediately.
   */
  positionSet: string | null;
  /** Last time the hedge band was evaluated. 0 until the first fresh check. */
  lastHedgeCheckMs: number;
  baselineUsd: number;
  lastLogMs: number;
  lastMarkSolPx: number;
  /** next_funding_time we are waiting on, ms. */
  watchedFundingMs: number | null;
  openedAtMs: number | null;
}

export interface Quote {
  bidContract: number;
  askContract: number;
  markContract: number;
  contractSol: number;
  /** Exchange timestamp of the mark (ms). */
  tsMs: number;
  fetchedAtMs: number;
  bidSizeContracts: number;
  askSizeContracts: number;
  shortLeverageEstimates: Record<string, number> | null;
}

export interface FundingPrint {
  time: string;
  timeMs: number;
  rate: number;
  /** Kalshi contract price (dollars per contract), not SOL. */
  markContract: number;
}

export interface FundingSnap {
  fetchedAtMs: number;
  nextFundingTimeMs: number | null;
  rates: FundingPrint[];
}

export interface RiskParams {
  liquidationRatio: number;
  queueRatio: number;
  initialMultiplier: number;
  source: "published" | "fallback";
}

export interface StepInput {
  nowMs: number;
  chainOk: boolean;
  chainTsMs: number;
  solPrice: number;
  lpSol: number;
  lpEquity: number;
  fingerprint: string;
  positionIds: string[];
  idleSol?: number;
  positionSol?: number;
  binStep?: number;
  quote: Quote | null;
  funding: FundingSnap | null;
  risk: RiskParams | null;
}

export interface HedgeConfig {
  /** Hourly check: rebalance when |short − target| exceeds this fraction of the target. */
  bandPct: number;
  /** Target short = LP SOL × hedgeRatio. 1 keeps a full hedge. */
  hedgeRatio: number;
  /** Minimum gap between band checks. A position-set change does not wait. */
  hedgeCheckMs: number;
  contractSol: number;
  takerFeeRate: number;
  fundingFallbackRate: number;
  /** +1 short receives when the published rate is positive. */
  fundingSign: number;
  fundingGraceMs: number;
  marginFraction: number;
  capitalUsd: number;
  staleMs: number;
  logEveryMs: number;
  positionBucketSol: number;
  maintLeverageFallback: number;
  initialMarginMultiplier: number;
  liquidationRatio: number;
  queueRatio: number;
}

export interface LedgerRow {
  nowMs: number;
  solPrice: number;
  lpSol: number;
  shortSol: number;
  deltaUsd: number;
  tradeSol: number;
  feeUsd: number;
  fundingUsd: number;
  hedgePnlUsd: number;
  lpEquityUsd: number;
  combinedEquityUsd: number;
  unhedgedPnlUsd: number;
  hedgedPnlUsd: number;
  stale: boolean;
  notes: string;
  reason: string;
  warnings: string[];
}

export interface MarginView {
  postedCollateralUsd: number;
  marginEquityUsd: number;
  notionalUsd: number;
  effectiveLeverage: number | null;
  maintenanceUsd: number;
  initialUsd: number;
  /** maintenance / margin equity. Higher is worse. Null when there is no position. */
  marginRatio: number | null;
  leverage: number;
  leverageSource: "published" | "fallback";
  warnings: string[];
}

export interface StepResult {
  book: Book;
  row: LedgerRow | null;
  warnings: string[];
  stale: boolean;
  staleReasons: string[];
  reason: string;
  /** Set when a band check ran and the short was left unchanged because drift was inside the band. */
  skipLog: string | null;
}

export function freshBook(baselineUsd: number): Book {
  return {
    shortSol: 0,
    avgEntrySolPx: 0,
    realizedUsd: 0,
    feesUsd: 0,
    fundingUsd: 0,
    appliedFunding: {},
    fingerprint: null,
    positionSet: null,
    lastHedgeCheckMs: 0,
    baselineUsd: Number.isFinite(baselineUsd) ? baselineUsd : 0,
    lastLogMs: 0,
    lastMarkSolPx: 0,
    watchedFundingMs: null,
    openedAtMs: null,
  };
}

export function roundToContract(sol: number, contractSol: number): number {
  if (!Number.isFinite(sol) || !(contractSol > 0)) return 0;
  const n = Math.round(sol / contractSol);
  return Math.round(Math.max(0, n) * contractSol * 1e8) / 1e8;
}

/** Signed SOL change, in whole contracts, from current short to target. */
export function contractDelta(targetSol: number, currentSol: number, contractSol: number): number {
  if (!(contractSol > 0) || !Number.isFinite(targetSol) || !Number.isFinite(currentSol)) return 0;
  const n = Math.round((targetSol - currentSol) / contractSol);
  return Math.round(n * contractSol * 1e8) / 1e8;
}

/** Position X + unclaimed fee X, plus wallet SOL above the gas reserve. Rent is not inventory. */
export function lpSolFromParts(positionSol: number, nativeLamports: number, wsolRaw: number, gasReserveLamports: number): number {
  const pos = Number.isFinite(positionSol) ? Math.max(0, positionSol) : 0;
  const native = Number.isFinite(nativeLamports) ? nativeLamports : 0;
  const wsol = Number.isFinite(wsolRaw) ? wsolRaw : 0;
  const gas = Number.isFinite(gasReserveLamports) ? gasReserveLamports : 0;
  const idleLamports = Math.max(0, native + wsol - gas);
  return pos + idleLamports / 1e9;
}

export function positionFingerprint(
  rows: { key: string; ok: boolean; x: number; feeX: number }[],
  bucketSol: number
): string {
  const bucket = bucketSol > 0 ? bucketSol : 0.05;
  const parts: string[] = [];
  for (const a of rows) {
    if (!a?.ok || !a.key) continue;
    const lamports = (Number.isFinite(a.x) ? a.x : 0) + (Number.isFinite(a.feeX) ? a.feeX : 0);
    const b = Math.round(lamports / 1e9 / bucket) * bucket;
    parts.push(`${a.key}:${b.toFixed(4)}`);
  }
  parts.sort();
  return parts.join("|");
}

export function netDeltaUsd(lpSol: number, shortSol: number, solPrice: number): number {
  if (![lpSol, shortSol, solPrice].every((n) => Number.isFinite(n))) return NaN;
  return (lpSol - shortSol) * solPrice;
}

export function solFromContract(contractPx: number, contractSol: number): number {
  if (!(contractPx > 0) || !(contractSol > 0)) return NaN;
  return contractPx / contractSol;
}

/** Canonical id of the open position accounts. Empty means no open position. */
export function positionSetKey(ids: readonly string[] | null | undefined): string {
  if (!ids || !ids.length) return "";
  const uniq = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const s = id.trim();
    if (s) uniq.add(s);
  }
  return [...uniq].sort().join(",");
}

/** LP SOL × hedge ratio, before contract rounding. */
export function rawTargetSol(lpSol: number, hedgeRatio: number): number {
  const lp = Number.isFinite(lpSol) ? Math.max(0, lpSol) : 0;
  const ratio = Number.isFinite(hedgeRatio) ? Math.max(0, hedgeRatio) : 1;
  return lp * ratio;
}

/** True when |short − target| exceeds `bandPct` of |target|. Equality does not exceed. */
export function driftExceedsBand(shortSol: number, rawTarget: number, bandPct: number): boolean {
  const short = Number.isFinite(shortSol) ? shortSol : 0;
  const target = Number.isFinite(rawTarget) ? rawTarget : 0;
  const limit = (bandPct > 0 ? bandPct : 0) * Math.abs(target);
  return Math.abs(short - target) > limit;
}

export function bandSkipMessage(args: {
  shortSol: number;
  rawTarget: number;
  bandPct: number;
  hedgeRatio: number;
}): string {
  const short = Number.isFinite(args.shortSol) ? args.shortSol : 0;
  const target = Number.isFinite(args.rawTarget) ? args.rawTarget : 0;
  const diff = Math.abs(short - target);
  const limit = (args.bandPct > 0 ? args.bandPct : 0) * Math.abs(target);
  return (
    `[PAPER] hedge check skipped: drift inside band short=${short.toFixed(4)} ` +
    `target=${target.toFixed(4)} absDiff=${diff.toFixed(4)} limit=${limit.toFixed(4)} ` +
    `band=${args.bandPct} ratio=${args.hedgeRatio}`
  );
}

export interface RebalanceDecision {
  tradeSol: number;
  /** Contract-rounded target. */
  targetShort: number;
  /** LP SOL × hedge ratio, before contract rounding. */
  rawTarget: number;
  deltaUsd: number;
  reason: "stale" | "open" | "position_change" | "band" | "inside_band" | "hold";
  /** True when the band was evaluated or a position-set change was applied. */
  checked: boolean;
}

/**
 * Target short is LP SOL × hedge ratio, rounded to the contract.
 *
 * The band is checked at most once per `checkEveryMs` (default one hour).
 * A check trades only when |short − target| exceeds `bandPct` of the target.
 * Replacing the set of open position accounts (stop-out, close, take-profit,
 * deploy, recenter) does not wait for that hour and trades to the new target
 * even inside the band, so a flat LP is not left short. SOL drift inside the
 * same position accounts does not.
 */
export function rebalanceTrade(args: {
  lpSol: number;
  shortSol: number;
  solPrice: number;
  contractSol: number;
  bandPct: number;
  hedgeRatio: number;
  stale: boolean;
  nowMs: number;
  lastCheckMs: number;
  checkEveryMs: number;
  positionSet: string;
  prevPositionSet: string | null;
}): RebalanceDecision {
  const rawTarget = rawTargetSol(args.lpSol, args.hedgeRatio);
  const targetShort = roundToContract(rawTarget, args.contractSol);
  const deltaUsd = netDeltaUsd(args.lpSol, args.shortSol, args.solPrice);
  const hold = (reason: RebalanceDecision["reason"], checked: boolean): RebalanceDecision => ({
    tradeSol: 0,
    targetShort,
    rawTarget,
    deltaUsd,
    reason,
    checked,
  });
  if (args.stale || !(args.solPrice > 0)) return hold("stale", false);

  const positionChanged = args.prevPositionSet !== null && args.positionSet !== args.prevPositionSet;
  const hourlyDue = !(args.lastCheckMs > 0) || args.nowMs - args.lastCheckMs >= args.checkEveryMs;
  if (!positionChanged && !hourlyDue) return hold("hold", false);

  const tradeSol = contractDelta(targetShort, args.shortSol, args.contractSol);
  if (positionChanged) {
    if (tradeSol === 0) return hold("hold", true);
    const reason = args.shortSol <= 1e-12 && tradeSol > 0 ? "open" : "position_change";
    return { tradeSol, targetShort, rawTarget, deltaUsd, reason, checked: true };
  }
  if (tradeSol === 0 || !driftExceedsBand(args.shortSol, rawTarget, args.bandPct)) {
    return hold(tradeSol === 0 ? "hold" : "inside_band", true);
  }
  const reason = args.shortSol <= 1e-12 && tradeSol > 0 ? "open" : "band";
  return { tradeSol, targetShort, rawTarget, deltaUsd, reason, checked: true };
}

export function fundingCashUsd(shortSol: number, markSolPx: number, rate: number, fundingSign = 1): number {
  if (!(shortSol > 0) || !(markSolPx > 0) || !Number.isFinite(rate)) return 0;
  const sign = fundingSign < 0 ? -1 : 1;
  return shortSol * markSolPx * rate * sign;
}

export function unrealizedUsd(shortSol: number, avgEntrySolPx: number, markSolPx: number): number {
  if (!(shortSol > 0) || !(avgEntrySolPx > 0) || !(markSolPx > 0)) return 0;
  return shortSol * (avgEntrySolPx - markSolPx);
}

export function hedgePnlUsd(book: Pick<Book, "shortSol" | "avgEntrySolPx" | "realizedUsd" | "feesUsd" | "fundingUsd">, markSolPx: number): number {
  return book.realizedUsd + unrealizedUsd(book.shortSol, book.avgEntrySolPx, markSolPx) + book.fundingUsd - book.feesUsd;
}

export function applyFill(book: Book, tradeSol: number, fillSolPx: number, feeRate: number): Book {
  if (!Number.isFinite(tradeSol) || tradeSol === 0 || !(fillSolPx > 0)) return book;
  const fee = Math.abs(tradeSol) * fillSolPx * Math.max(0, feeRate);
  if (tradeSol > 0) {
    const newShort = Math.round((book.shortSol + tradeSol) * 1e8) / 1e8;
    const avg = (book.avgEntrySolPx * book.shortSol + fillSolPx * tradeSol) / newShort;
    return { ...book, shortSol: newShort, avgEntrySolPx: avg, feesUsd: book.feesUsd + fee };
  }
  const cover = Math.min(book.shortSol, -tradeSol);
  const realized = cover * (book.avgEntrySolPx - fillSolPx);
  const newShort = Math.round((book.shortSol - cover) * 1e8) / 1e8;
  return {
    ...book,
    shortSol: newShort > 1e-8 ? newShort : 0,
    avgEntrySolPx: newShort > 1e-8 ? book.avgEntrySolPx : 0,
    realizedUsd: book.realizedUsd + realized,
    feesUsd: book.feesUsd + fee,
  };
}

/** Smallest published leverage bucket that covers `notional`, else the largest bucket. */
export function leverageForNotional(
  estimates: Record<string, number> | null | undefined,
  notional: number,
  fallback: number
): { leverage: number; source: "published" | "fallback" } {
  const fb = fallback > 0 ? fallback : 3.1;
  if (!estimates || typeof estimates !== "object") return { leverage: fb, source: "fallback" };
  const buckets: { cap: number; lev: number }[] = [];
  for (const [k, v] of Object.entries(estimates)) {
    const cap = Number(k);
    const lev = Number(v);
    if (cap > 0 && lev > 0) buckets.push({ cap, lev });
  }
  if (!buckets.length) return { leverage: fb, source: "fallback" };
  buckets.sort((a, b) => a.cap - b.cap);
  let chosen = buckets[buckets.length - 1];
  for (const b of buckets) {
    if (notional <= b.cap) {
      chosen = b;
      break;
    }
  }
  return { leverage: chosen.lev, source: "published" };
}

export function marginView(
  book: Book,
  markSolPx: number,
  cfg: Pick<HedgeConfig, "marginFraction" | "capitalUsd" | "maintLeverageFallback" | "initialMarginMultiplier" | "liquidationRatio" | "queueRatio">,
  estimates: Record<string, number> | null,
  risk: RiskParams | null
): MarginView {
  const posted = Math.max(0, cfg.marginFraction) * Math.max(0, cfg.capitalUsd);
  const pnl = hedgePnlUsd(book, markSolPx);
  const marginEquity = posted + pnl;
  const notional = book.shortSol > 0 && markSolPx > 0 ? book.shortSol * markSolPx : 0;
  const picked = leverageForNotional(estimates, notional, cfg.maintLeverageFallback);
  const mult = risk && risk.initialMultiplier > 0 ? risk.initialMultiplier : cfg.initialMarginMultiplier;
  const liqRatio = risk && risk.liquidationRatio > 0 ? risk.liquidationRatio : cfg.liquidationRatio;
  const queueRatio = risk && risk.queueRatio > 0 ? risk.queueRatio : cfg.queueRatio;
  const maintenance = picked.leverage > 0 ? notional / picked.leverage : 0;
  const initial = maintenance * (mult > 0 ? mult : 1);
  const effective = notional > 0 ? (marginEquity > 0 ? notional / marginEquity : Number.POSITIVE_INFINITY) : 0;
  const ratio = notional > 0 ? (marginEquity > 0 ? maintenance / marginEquity : Number.POSITIVE_INFINITY) : null;
  const warnings: string[] = [];
  if (notional > 0 && ratio != null && ratio >= liqRatio) warnings.push("liquidation");
  else if (notional > 0 && ratio != null && ratio >= queueRatio) warnings.push("liquidation_queue");
  if (notional > 0 && marginEquity < initial) warnings.push("below_initial_margin");
  return {
    postedCollateralUsd: posted,
    marginEquityUsd: marginEquity,
    notionalUsd: notional,
    effectiveLeverage: notional > 0 ? effective : 0,
    maintenanceUsd: maintenance,
    initialUsd: initial,
    marginRatio: ratio,
    leverage: picked.leverage,
    leverageSource: picked.source,
    warnings,
  };
}

function fundingAlready(book: Book, timeMs: number): boolean {
  for (const k of Object.keys(book.appliedFunding)) {
    const t = Date.parse(k);
    if (Number.isFinite(t) && Math.abs(t - timeMs) < 5000) return true;
  }
  return false;
}

function cloneBook(book: Book): Book {
  return { ...book, appliedFunding: { ...book.appliedFunding } };
}

export function shouldEmit(nowMs: number, lastLogMs: number, logEveryMs: number, tradeSol: number, fundingUsd: number, force: boolean): boolean {
  if (force || tradeSol !== 0 || fundingUsd !== 0) return true;
  if (!(lastLogMs > 0)) return true;
  return logEveryMs <= 0 || nowMs - lastLogMs >= logEveryMs;
}

function finiteOr(n: number, blank: number): number {
  return Number.isFinite(n) ? n : blank;
}

export function step(book: Book, input: StepInput, cfg: HedgeConfig): StepResult {
  let next = cloneBook(book);
  const staleReasons: string[] = [];
  const age = (ts: number) => input.nowMs - ts;
  if (!input.chainOk) staleReasons.push("chain");
  else if (!(input.chainTsMs > 0) || age(input.chainTsMs) > cfg.staleMs) staleReasons.push("chain_stale");
  if (!(input.solPrice > 0) || !Number.isFinite(input.lpSol)) staleReasons.push("spot");
  const quote = input.quote;
  if (!quote) staleReasons.push("kalshi");
  else {
    if (!(quote.fetchedAtMs > 0) || age(quote.fetchedAtMs) > cfg.staleMs) staleReasons.push("kalshi_stale");
    if (!(quote.tsMs > 0) || age(quote.tsMs) > cfg.staleMs) staleReasons.push("kalshi_mark_stale");
    if (!(quote.bidContract > 0) || !(quote.askContract > 0) || !(quote.markContract > 0)) staleReasons.push("kalshi_book");
  }
  if (!input.funding) staleReasons.push("funding");
  else if (!(input.funding.fetchedAtMs > 0) || age(input.funding.fetchedAtMs) > cfg.staleMs) staleReasons.push("funding_stale");
  const stale = staleReasons.length > 0;

  const contractSol = quote && quote.contractSol > 0 ? quote.contractSol : cfg.contractSol;
  if (quote && quote.markContract > 0 && contractSol > 0) {
    const markSol = quote.markContract / contractSol;
    if (markSol > 0) next.lastMarkSolPx = markSol;
  }

  let fundingThis = 0;
  let fundingFallback = false;
  const fundingFresh = !!input.funding && input.funding.fetchedAtMs > 0 && age(input.funding.fetchedAtMs) <= cfg.staleMs;
  if (fundingFresh && input.funding) {
    for (const r of input.funding.rates) {
      if (!(r.timeMs > 0) || r.timeMs > input.nowMs) continue;
      if (next.appliedFunding[r.time] || fundingAlready(next, r.timeMs)) continue;
      const markSol = r.markContract > 0 && contractSol > 0 ? r.markContract / contractSol : next.lastMarkSolPx;
      const usd = fundingCashUsd(next.shortSol, markSol, r.rate, cfg.fundingSign);
      next.appliedFunding[r.time] = { rate: r.rate, usd, source: "published" };
      next.fundingUsd += usd;
      fundingThis += usd;
    }
    if (input.funding.nextFundingTimeMs && input.funding.nextFundingTimeMs > input.nowMs) {
      next.watchedFundingMs = input.funding.nextFundingTimeMs;
    }
    if (next.watchedFundingMs && input.nowMs >= next.watchedFundingMs + Math.max(0, cfg.fundingGraceMs)) {
      const due = next.watchedFundingMs;
      const hit = input.funding.rates.some((r) => Math.abs(r.timeMs - due) < 5000) || fundingAlready(next, due);
      if (!hit) {
        const usd = fundingCashUsd(next.shortSol, next.lastMarkSolPx, cfg.fundingFallbackRate, cfg.fundingSign);
        const key = new Date(due).toISOString();
        next.appliedFunding[key] = { rate: cfg.fundingFallbackRate, usd, source: "fallback" };
        next.fundingUsd += usd;
        fundingThis += usd;
        fundingFallback = true;
        next.watchedFundingMs = null;
      }
    }
  }

  const positionSet = positionSetKey(input.positionIds);
  const decision = rebalanceTrade({
    lpSol: input.lpSol,
    shortSol: next.shortSol,
    solPrice: input.solPrice,
    contractSol,
    bandPct: cfg.bandPct,
    hedgeRatio: cfg.hedgeRatio,
    stale,
    nowMs: input.nowMs,
    lastCheckMs: next.lastHedgeCheckMs,
    checkEveryMs: cfg.hedgeCheckMs,
    positionSet,
    prevPositionSet: next.positionSet,
  });

  let tradeSol = 0;
  let fee = 0;
  let thin = false;
  if (!stale && decision.tradeSol !== 0 && quote && contractSol > 0) {
    const fillContract = decision.tradeSol > 0 ? quote.bidContract : quote.askContract;
    const fillSol = fillContract / contractSol;
    const touch = decision.tradeSol > 0 ? quote.bidSizeContracts : quote.askSizeContracts;
    const tradeContracts = Math.abs(decision.tradeSol) / contractSol;
    if (Number.isFinite(touch) && touch + 1e-9 < tradeContracts) thin = true;
    const beforeFees = next.feesUsd;
    const beforeShort = next.shortSol;
    next = applyFill(next, decision.tradeSol, fillSol, cfg.takerFeeRate);
    tradeSol = Math.round((next.shortSol - beforeShort) * 1e8) / 1e8;
    fee = next.feesUsd - beforeFees;
    if (!next.openedAtMs && next.shortSol > 0) next.openedAtMs = input.nowMs;
  }
  if (decision.checked) next.lastHedgeCheckMs = input.nowMs;
  if (!stale && input.chainOk) {
    next.fingerprint = input.fingerprint;
    next.positionSet = positionSet;
  }

  const markForPnl = next.lastMarkSolPx;
  const hedge = hedgePnlUsd(next, markForPnl);
  const lpEquity = input.chainOk && Number.isFinite(input.lpEquity) ? input.lpEquity : NaN;
  const combined = Number.isFinite(lpEquity) ? lpEquity + hedge : NaN;
  const unhedged = Number.isFinite(lpEquity) ? lpEquity - next.baselineUsd : NaN;
  const hedged = Number.isFinite(combined) ? combined - next.baselineUsd : NaN;
  const margin = marginView(next, markForPnl, cfg, quote?.shortLeverageEstimates ?? null, input.risk);
  const warnings = margin.warnings.slice();
  if (fundingFallback) warnings.push("funding_fallback");
  if (thin) warnings.push("thin_book");

  const shownReason = stale ? "stale" : tradeSol !== 0 ? decision.reason : decision.reason === "inside_band" ? "inside_band" : "hold";
  const skipLog =
    shownReason === "inside_band"
      ? bandSkipMessage({
          shortSol: next.shortSol,
          rawTarget: decision.rawTarget,
          bandPct: cfg.bandPct,
          hedgeRatio: cfg.hedgeRatio,
        })
      : null;

  const noteParts = [
    `reason=${shownReason}`,
    stale ? `stale=${staleReasons.join(",")}` : "",
    `target=${decision.targetShort}`,
    `markSol=${Number.isFinite(markForPnl) ? markForPnl.toFixed(4) : "na"}`,
    `fill=${tradeSol === 0 ? "-" : tradeSol > 0 ? "sell_bid" : "buy_ask"}`,
    `lev=${margin.effectiveLeverage == null || !Number.isFinite(margin.effectiveLeverage) ? "inf" : margin.effectiveLeverage.toFixed(3)}`,
    `marginEq=${margin.marginEquityUsd.toFixed(2)}`,
    `posted=${margin.postedCollateralUsd.toFixed(2)}`,
    `maint=${margin.maintenanceUsd.toFixed(2)}`,
    `initial=${margin.initialUsd.toFixed(2)}`,
    `ratio=${margin.marginRatio == null || !Number.isFinite(margin.marginRatio) ? "na" : margin.marginRatio.toFixed(3)}`,
    `levSrc=${margin.leverageSource}`,
    `feesCum=${next.feesUsd.toFixed(4)}`,
    `fundingCum=${next.fundingUsd.toFixed(4)}`,
    input.positionIds?.length ? `positions=${input.positionIds.join(",")}` : "positions=none",
    input.positionSol != null && Number.isFinite(input.positionSol) ? `posSol=${input.positionSol.toFixed(4)}` : "",
    input.idleSol != null && Number.isFinite(input.idleSol) ? `idleSol=${input.idleSol.toFixed(4)}` : "",
    input.binStep ? `binStep=${input.binStep}` : "",
    fundingFallback ? "fundingSource=fallback" : "",
    warnings.length ? `WARN=${warnings.join(",")}` : "",
  ].filter(Boolean);
  const notes = noteParts.join(" ").slice(0, 900);

  const lpSolShown = input.chainOk && Number.isFinite(input.lpSol) ? input.lpSol : NaN;
  const solShown = input.chainOk && input.solPrice > 0 ? input.solPrice : NaN;
  const deltaShown = Number.isFinite(lpSolShown) && solShown > 0 ? netDeltaUsd(lpSolShown, next.shortSol, solShown) : NaN;

  const emit = shouldEmit(input.nowMs, next.lastLogMs, cfg.logEveryMs, tradeSol, fundingThis, fundingFallback);
  if (emit) next.lastLogMs = input.nowMs;

  const row: LedgerRow | null = emit
    ? {
        nowMs: input.nowMs,
        solPrice: finiteOr(solShown, NaN),
        lpSol: finiteOr(lpSolShown, NaN),
        shortSol: next.shortSol,
        deltaUsd: deltaShown,
        tradeSol,
        feeUsd: fee,
        fundingUsd: fundingThis,
        hedgePnlUsd: hedge,
        lpEquityUsd: lpEquity,
        combinedEquityUsd: combined,
        unhedgedPnlUsd: unhedged,
        hedgedPnlUsd: hedged,
        stale,
        notes,
        reason: shownReason,
        warnings,
      }
    : null;

  return { book: next, row, warnings, stale, staleReasons, reason: shownReason, skipLog };
}
