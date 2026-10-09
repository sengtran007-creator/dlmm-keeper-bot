/**
 * Macro regime classifier + per-position stop lock (pure logic; network access is injected).
 *
 * Score = 50 + trend term (±35) + funding term (±25) + direction term (±20).
 *   trend (±35) = three components from Hyperliquid SOL daily closes:
 *            long   15 × clamp((price / SMA200 − 1) / 10%)    — primary; the only one with a forward edge in 500d of data
 *            medium 10 × clamp((price / SMA50 − 1) / 8%)      — weeks-scale trend; 8% ≈ median |price/SMA50 − 1|
 *            cross  10 × clamp((SMA50 / SMA200 − 1) / 15%)    — golden (+) / death (−) cross
 *            SMA200 / SMA50 = mean of the last 200 / 50 CLOSED daily candles (UTC days; in-progress day
 *            excluded; ≥150 / ≥50 closed days required), cached 6h. Fallback: CoinGecko daily (same definition),
 *            then a cached SMA up to 24h old, else that component is unknown → 0 (partial read; can't switch).
 *            Price = latest HL 1h candle close (same feed as the direction term).
 *   funding: Hyperliquid SOL funding, 24h average of SETTLED hourly rates, annualized
 *            (hourly rate × 24 × 365 × 100). Fallback: HL predicted rate normalized by its interval.
 *            |APR| < 3%            → 0   (deadband: sign noise around zero never moves the score)
 *            3% … 8%               → 0 … +25 linear (HL's neutral baseline is 10.95% APR; ≥8% = no persistent short pressure)
 *            8% … 40%              → +25
 *            > 40%                 → 0   (overheated longs: not a clean bull signal)
 *            −3% … −10%            → 0 … −25 linear (shorts paying)
 *            ≤ −10%                → −25
 *            unknown               → 0   (partial read; can't trigger a regime switch)
 *   direction (±20): short-term price direction from Hyperliquid 1h candles. Composite c =
 *            0.25 × clamp((price/EMA20(1h) − 1) / 1.5%) + 0.25 × clamp(4h change / 1.5%) + 0.5 × clamp(24h change / 4%)
 *            (each clamped to ±1; full scale ≈ 95th percentile of the last 14 days; 24h weighted most so a
 *            4h bounce inside a down day doesn't read as rising). |c| < 0.25 → 0 (flat); beyond that
 *            linear to ±20. Unknown → 0 (partial read; can't trigger a switch).
 * Regime (score = 50 + trend + funding + direction):
 *   BULL_EXPANSION  score ≥ 90 AND direction ≥ 0 AND funding > 0 (trend alone, max 85, can never make BULL)
 *   BEAR_DEFENSIVE  score < 35 AND trend + funding < 0 (short-term direction alone can't make BEAR)
 *   RANGE_CHOP      otherwise
 *
 * Hysteresis: a different regime must be observed on 2 consecutive complete evaluations (≥30 min apart)
 * OR (not for BULL) sit ≥10 points inside its band, AND the current regime must have been in force ≥2h.
 * Exception: BEAR immediately when the LONG-SIDE score 50 + trend + funding < 20 (direction excluded,
 * so short-term noise can't trip the safety shortcut). Boot starts in RANGE_CHOP (nothing persisted) and
 * leaves it only after 2 consecutive confirming reads ~30 min apart (no margin shortcut, no dwell at boot).
 * Schmitt band: an existing BULL is kept while score ≥ 80 and direction ≥ −8; an existing BEAR while
 * score < 45 (and trend + funding < 0) — so values hovering at an entry threshold don't flip the raw read.
 * Failures: keep the current regime while the last good read is < 6h old, else fall back to RANGE_CHOP;
 * never default to BULL. Failed evaluations back off (5 min) instead of retrying every tick.
 */

export type MarketRegime = "BULL_EXPANSION" | "RANGE_CHOP" | "BEAR_DEFENSIVE";

export interface RegimeProfile {
  bidBins: number;
  askBins: number;
  floorStopPct: number;
  cooldownSec: number;
  capitalDeployPct: number;
}

export const REGIME_PROFILES: Record<MarketRegime, RegimeProfile> = {
  BULL_EXPANSION: { bidBins: 25, askBins: 35, floorStopPct: 0.04, cooldownSec: 1800, capitalDeployPct: 0.85 },
  RANGE_CHOP: { bidBins: 30, askBins: 30, floorStopPct: 0.05, cooldownSec: 3600, capitalDeployPct: 0.85 },
  // BEAR is symmetric (was 45/15): 90-day backtest showed 45/15 kept buying SOL into the stop; 30/30 won in every window.
  BEAR_DEFENSIVE: { bidBins: 30, askBins: 30, floorStopPct: 0.06, cooldownSec: 14400, capitalDeployPct: 0.6 },
};

export const DEFAULT_REGIME: MarketRegime = "RANGE_CHOP";

export const SCORE_BULL_MIN = 90;
export const SCORE_BEAR_BELOW = 35;
export const SCORE_BEAR_IMMEDIATE_BELOW = 20;
export const SWITCH_MARGIN_POINTS = 10;
// Schmitt-trigger exits: once in BULL/BEAR, stay while the (looser) exit condition still holds.
export const SCORE_BULL_STAY_MIN = 80;
export const DIRECTION_BULL_STAY_MIN = -8;
export const SCORE_BEAR_STAY_BELOW = 45;
// Trend components (max points, full-scale deviation).
export const TREND_LONG_MAX = 15;
export const TREND_FULL_PCT = 0.1;
export const TREND_MED_MAX = 10;
export const TREND_MED_FULL_PCT = 0.08;
export const TREND_CROSS_MAX = 10;
export const TREND_CROSS_FULL_PCT = 0.15;
export const TREND_MAX_POINTS = TREND_LONG_MAX + TREND_MED_MAX + TREND_CROSS_MAX;
export const FUNDING_DEADBAND_APR = 3;
export const FUNDING_FULL_BULL_APR = 8;
export const FUNDING_OVERHEATED_APR = 40;
export const FUNDING_FULL_BEAR_APR = -10;
export const FUNDING_WINDOW_HOURS = 24;
export const SMA_DAYS = 200;
export const SMA_MIN_DAYS = 150;
export const SMA50_DAYS = 50;
export const SMA_CACHE_SEC = 6 * 3600;
export const SMA_FALLBACK_CACHE_SEC = 3600;
export const SMA_STALE_MAX_SEC = 24 * 3600;
export const SMA_HL_RETRY_SEC = 900;
export const SMA_CG_RETRY_SEC = 1800;
export const DIRECTION_MAX_POINTS = 20;
export const DIRECTION_FULL_EMA_GAP = 0.015;
export const DIRECTION_FULL_MOM4H = 0.015;
export const DIRECTION_FULL_MOM24H = 0.04;
export const DIRECTION_DEADBAND = 0.25;
export const DIRECTION_WEIGHT_EMA = 0.25;
export const DIRECTION_WEIGHT_4H = 0.25;
export const DIRECTION_WEIGHT_24H = 0.5;
export const DIRECTION_EMA_PERIOD = 20;
export const DIRECTION_CANDLE_HOURS = 72;
export const FUNDING_MIN_SAMPLES = 12;

// ---------------- inputs ----------------

export interface FundingReading {
  known: boolean;
  /** Annualized %, correctly normalized for the venue's interval. NaN when unknown. */
  apr: number;
  /** Raw per-interval rate (average over the window for history). NaN when unknown. */
  rawRate: number;
  intervalHours: number;
  source: string;
  samples: number;
}

export const UNKNOWN_FUNDING: FundingReading = {
  known: false,
  apr: NaN,
  rawRate: NaN,
  intervalHours: 1,
  source: "unknown",
  samples: 0,
};

export interface DirectionReading {
  known: boolean;
  /** Price used for direction (latest 1h candle close, incl. the in-progress candle). */
  price: number;
  ema20: number;
  emaGapPct: number;
  mom4hPct: number;
  mom24hPct: number;
  /** Composite in [−1, 1] before the deadband. */
  composite: number;
  source: string;
}

export const UNKNOWN_DIRECTION: DirectionReading = {
  known: false,
  price: NaN,
  ema20: NaN,
  emaGapPct: NaN,
  mom4hPct: NaN,
  mom24hPct: NaN,
  composite: NaN,
  source: "unknown",
};

export interface MarketInputs {
  solPrice: number;
  sma200: number;
  smaPoints: number;
  /** 50-day SMA of closed daily closes (NaN/absent = unknown → medium and cross components 0). */
  sma50?: number;
  sma50Points?: number;
  /** False when SMA200 or the price is unavailable → trend term 0 and the read is partial. */
  trendKnown?: boolean;
  smaSource?: string;
  funding: FundingReading;
  direction: DirectionReading;
}

export function annualizeFunding(rate: number, intervalHours: number): number {
  return rate * (24 / intervalHours) * 365 * 100;
}

/**
 * CoinGecko market_chart (daily) → live price (last point) + mean of the last 200 daily points before it
 * (same "closed days only" definition as the Hyperliquid SMA). null if unusable.
 */
export function smaFromCoinGecko(
  data: any
): { solPrice: number; sma200: number; smaPoints: number; sma50: number; sma50Points: number } | null {
  const raw = data?.prices;
  if (!Array.isArray(raw) || raw.length < SMA_MIN_DAYS + 1) return null;
  const prices = raw.map((p: any) => Number(Array.isArray(p) ? p[1] : NaN));
  if (prices.some((p: number) => !Number.isFinite(p) || p <= 0)) return null;
  const solPrice = prices[prices.length - 1];
  const closed = prices.slice(0, -1).slice(-SMA_DAYS);
  const sma200 = closed.reduce((a: number, b: number) => a + b, 0) / closed.length;
  const c50 = closed.slice(-SMA50_DAYS);
  const sma50 = c50.reduce((a: number, b: number) => a + b, 0) / c50.length;
  return { solPrice, sma200, smaPoints: closed.length, sma50, sma50Points: c50.length };
}

/**
 * Hyperliquid candleSnapshot (1d) → mean of the last 200 CLOSED daily closes (candle end T < now; the
 * in-progress UTC day is excluded), plus the 50-day mean of the same closes. Requires ≥150 closed days
 * (so SMA50's ≥50 is implied) and a close within the last 48h.
 */
export function smaFromDailyCandles(
  rows: any,
  nowMs: number
): { sma200: number; smaPoints: number; sma50: number; sma50Points: number; lastClose: number } | null {
  if (!Array.isArray(rows)) return null;
  const closed = rows
    .map((r: any) => ({ t: Number(r?.t), T: Number(r?.T), close: Number(r?.c) }))
    .filter((r: any) => Number.isFinite(r.t) && Number.isFinite(r.T) && r.close > 0 && r.T < nowMs)
    .sort((a: any, b: any) => a.t - b.t);
  if (closed.length < SMA_MIN_DAYS) return null;
  if (nowMs - closed[closed.length - 1].T > 48 * 3600 * 1000) return null;
  const win = closed.slice(-SMA_DAYS);
  const sma200 = win.reduce((a: number, r: any) => a + r.close, 0) / win.length;
  const w50 = closed.slice(-SMA50_DAYS);
  const sma50 = w50.reduce((a: number, r: any) => a + r.close, 0) / w50.length;
  return { sma200, smaPoints: win.length, sma50, sma50Points: w50.length, lastClose: closed[closed.length - 1].close };
}

/** Hyperliquid fundingHistory rows (hourly, settled) → 24h average. null if too few valid samples. */
export function fundingFromHistory(rows: any, nowMs: number, windowHours = FUNDING_WINDOW_HOURS): FundingReading | null {
  if (!Array.isArray(rows)) return null;
  const since = nowMs - windowHours * 3600 * 1000;
  const rates = rows
    .filter((r: any) => Number(r?.time) >= since && Number(r?.time) <= nowMs + 60_000)
    .map((r: any) => Number(r?.fundingRate))
    .filter((x: number) => Number.isFinite(x));
  if (rates.length < FUNDING_MIN_SAMPLES) return null;
  const avg = rates.reduce((a: number, b: number) => a + b, 0) / rates.length;
  return {
    known: true,
    apr: annualizeFunding(avg, 1),
    rawRate: avg,
    intervalHours: 1,
    source: `HL settled ${windowHours}h avg (${rates.length} samples)`,
    samples: rates.length,
  };
}

/** Hyperliquid predictedFundings → the HlPerp SOL venue only, normalized by its fundingIntervalHours. */
export function fundingFromPredicted(data: any): FundingReading | null {
  if (!Array.isArray(data)) return null;
  const sol = data.find((item: any) => Array.isArray(item) && item[0] === "SOL");
  const venues = Array.isArray(sol?.[1]) ? sol[1] : [];
  const hl = venues.find((v: any) => Array.isArray(v) && v[0] === "HlPerp");
  const rate = Number(hl?.[1]?.fundingRate);
  const interval = Number(hl?.[1]?.fundingIntervalHours ?? 1);
  if (!Number.isFinite(rate) || !(interval > 0)) return null;
  return {
    known: true,
    apr: annualizeFunding(rate, interval),
    rawRate: rate,
    intervalHours: interval,
    source: "HL predicted (HlPerp, instantaneous — fallback)",
    samples: 1,
  };
}

function clamp1(x: number): number {
  return Math.max(-1, Math.min(1, x));
}

/**
 * Hyperliquid candleSnapshot (1h) → direction inputs. EMA20 over completed candles; current price = latest
 * candle close (the in-progress candle if present); 4h/24h change vs the last close at/before now−4h/−24h.
 */
export function directionFromCandles(rows: any, nowMs: number): DirectionReading | null {
  if (!Array.isArray(rows)) return null;
  const c = rows
    .map((r: any) => ({ t: Number(r?.t), T: Number(r?.T), close: Number(r?.c) }))
    .filter((r: any) => Number.isFinite(r.t) && Number.isFinite(r.T) && r.close > 0 && r.t <= nowMs)
    .sort((a: any, b: any) => a.t - b.t);
  if (c.length < 30) return null;
  const last = c[c.length - 1];
  if (nowMs - last.t > 2 * 3600 * 1000) return null; // stale feed
  const price = last.close;
  const completed = c.filter((r: any) => r.T < nowMs);
  if (completed.length < DIRECTION_EMA_PERIOD + 5) return null;
  const closes = completed.map((r: any) => r.close);
  const seed = closes.slice(0, DIRECTION_EMA_PERIOD).reduce((a: number, b: number) => a + b, 0) / DIRECTION_EMA_PERIOD;
  const k = 2 / (DIRECTION_EMA_PERIOD + 1);
  let ema20 = seed;
  for (let i = DIRECTION_EMA_PERIOD; i < closes.length; i++) ema20 = closes[i] * k + ema20 * (1 - k);
  const closeAtOrBefore = (ms: number): number => {
    let v = NaN;
    for (const r of completed) if (r.T <= ms) v = r.close;
    return v;
  };
  const p4 = closeAtOrBefore(nowMs - 4 * 3600 * 1000);
  const p24 = closeAtOrBefore(nowMs - 24 * 3600 * 1000);
  if (!(p4 > 0) || !(p24 > 0) || !(ema20 > 0)) return null;
  const emaGap = price / ema20 - 1;
  const mom4 = price / p4 - 1;
  const mom24 = price / p24 - 1;
  // 24h change weighted 50%: a 4h bounce inside a down day must not read as "rising".
  const composite =
    DIRECTION_WEIGHT_EMA * clamp1(emaGap / DIRECTION_FULL_EMA_GAP) +
    DIRECTION_WEIGHT_4H * clamp1(mom4 / DIRECTION_FULL_MOM4H) +
    DIRECTION_WEIGHT_24H * clamp1(mom24 / DIRECTION_FULL_MOM24H);
  return {
    known: true,
    price,
    ema20,
    emaGapPct: emaGap * 100,
    mom4hPct: mom4 * 100,
    mom24hPct: mom24 * 100,
    composite,
    source: `HL 1h candles (${completed.length})`,
  };
}

// ---------------- scoring ----------------


export interface TrendParts {
  /** price vs SMA200 (±15) */
  long: number;
  /** price vs SMA50 (±10) */
  medium: number;
  /** SMA50 vs SMA200 — golden/death cross (±10) */
  cross: number;
  total: number;
}

/** Trend components; any component whose inputs are missing/invalid scores 0. */
export function trendParts(solPrice: number, sma200: number, sma50?: number): TrendParts {
  const p = solPrice > 0;
  const long = p && sma200 > 0 ? TREND_LONG_MAX * clamp1((solPrice / sma200 - 1) / TREND_FULL_PCT) : 0;
  const medium = p && sma50! > 0 ? TREND_MED_MAX * clamp1((solPrice / sma50! - 1) / TREND_MED_FULL_PCT) : 0;
  const cross = sma50! > 0 && sma200 > 0 ? TREND_CROSS_MAX * clamp1((sma50! / sma200 - 1) / TREND_CROSS_FULL_PCT) : 0;
  return { long, medium, cross, total: long + medium + cross };
}

export function trendPoints(solPrice: number, sma200: number, sma50?: number): number {
  return trendParts(solPrice, sma200, sma50).total;
}

export function fundingPoints(f: FundingReading): number {
  if (!f.known || !Number.isFinite(f.apr)) return 0;
  const apr = f.apr;
  if (Math.abs(apr) < FUNDING_DEADBAND_APR) return 0;
  if (apr > FUNDING_OVERHEATED_APR) return 0;
  if (apr > 0) {
    return 25 * Math.min(1, (apr - FUNDING_DEADBAND_APR) / (FUNDING_FULL_BULL_APR - FUNDING_DEADBAND_APR));
  }
  return -25 * Math.min(1, (-apr - FUNDING_DEADBAND_APR) / (-FUNDING_FULL_BEAR_APR - FUNDING_DEADBAND_APR));
}

export function directionPoints(d: DirectionReading): number {
  if (!d.known || !Number.isFinite(d.composite)) return 0;
  const a = Math.abs(d.composite);
  if (a < DIRECTION_DEADBAND) return 0;
  return Math.sign(d.composite) * DIRECTION_MAX_POINTS * Math.min(1, (a - DIRECTION_DEADBAND) / (1 - DIRECTION_DEADBAND));
}

export interface ScoreParts {
  score: number;
  trendPts: number;
  trendLongPts: number;
  trendMedPts: number;
  crossPts: number;
  fundingPts: number;
  dirPts: number;
  /** 50 + trend + funding (direction excluded) — the long-side view used by the BEAR rules. */
  longScore: number;
}

export function scoreInputs(inp: MarketInputs): ScoreParts {
  const t = inp.trendKnown === false ? { long: 0, medium: 0, cross: 0, total: 0 } : trendParts(inp.solPrice, inp.sma200, inp.sma50);
  const fundingPts = fundingPoints(inp.funding);
  const dirPts = directionPoints(inp.direction ?? UNKNOWN_DIRECTION);
  const longScore = 50 + t.total + fundingPts;
  return {
    score: longScore + dirPts,
    trendPts: t.total,
    trendLongPts: t.long,
    trendMedPts: t.medium,
    crossPts: t.cross,
    fundingPts,
    dirPts,
    longScore,
  };
}

/**
 * Raw regime for one read. `current` enables the Schmitt-trigger band: entering BULL needs score ≥ 90,
 * direction ≥ 0 and funding > 0, but an existing BULL is kept while score ≥ 80 and direction ≥ −8; entering
 * BEAR needs score < 35 with trend + funding < 0, an existing BEAR is kept while score < 45 and trend + funding < 0.
 */
export function classifyScore(parts: ScoreParts, current?: MarketRegime): MarketRegime {
  const longBearish = parts.trendPts + parts.fundingPts < 0;
  if (current === "BULL_EXPANSION" && parts.score >= SCORE_BULL_STAY_MIN && parts.dirPts >= DIRECTION_BULL_STAY_MIN) return "BULL_EXPANSION";
  if (current === "BEAR_DEFENSIVE" && parts.score < SCORE_BEAR_STAY_BELOW && longBearish) return "BEAR_DEFENSIVE";
  if (parts.score >= SCORE_BULL_MIN && parts.dirPts >= 0 && parts.fundingPts > 0) return "BULL_EXPANSION";
  if (parts.score < SCORE_BEAR_BELOW && longBearish) return "BEAR_DEFENSIVE";
  return "RANGE_CHOP";
}

/** How far (points) the score sits inside the given regime's band. */
export function regimeMargin(regime: MarketRegime, score: number): number {
  if (regime === "BULL_EXPANSION") return score - SCORE_BULL_MIN;
  if (regime === "BEAR_DEFENSIVE") return SCORE_BEAR_BELOW - score;
  return Math.min(score - SCORE_BEAR_BELOW, SCORE_BULL_MIN - score);
}

// ---------------- sentinel (hysteresis + failure handling) ----------------

export interface RegimeConfig extends RegimeProfile {
  regime: MarketRegime;
  /** Raw score of the last good evaluation (null before the first good read). */
  score: number | null;
  /** Regime the last good evaluation pointed to before hysteresis. */
  rawRegime: MarketRegime | null;
  /** "live" = last eval agrees; "held" = hysteresis kept the current regime; "last-good" = latest eval failed;
   *  "default" = no good read yet / last good too old. */
  source: "live" | "held" | "last-good" | "default";
  holdReason: string;
  provisional: boolean;
  effectiveSince: number;
  lastGoodAt: number;
  lastFailure: string;
  nextEvalAt: number;
  details: {
    solPrice: number;
    sma200: number;
    smaSource: string;
    smaPoints: number;
    sma50: number;
    sma50Points: number;
    trendKnown: boolean;
    fundingAnnual: number;
    fundingRawRate: number;
    fundingIntervalHours: number;
    fundingSource: string;
    fundingKnown: boolean;
    trendPts: number;
    trendLongPts: number;
    trendMedPts: number;
    crossPts: number;
    fundingPts: number;
    dirPts: number;
    longScore: number;
    directionKnown: boolean;
    directionSource: string;
    emaGapPct: number;
    mom4hPct: number;
    mom24hPct: number;
    turnoverRatio: number;
  };
}

export interface SmaReading {
  sma200: number;
  smaPoints: number;
  sma50: number;
  sma50Points: number;
  source: string;
}

export interface RegimeFetchers {
  /** Secondary SMA source (fallback only). */
  fetchCoinGecko(): Promise<any>;
  /** Hyperliquid candleSnapshot rows (1d) between startMs and endMs — primary SMA source. */
  fetchDailyCandles(startMs: number, endMs: number): Promise<any>;
  fetchFundingHistory(startTimeMs: number): Promise<any>;
  fetchPredictedFundings(): Promise<any>;
  /** Hyperliquid candleSnapshot rows (1h) between startMs and endMs. */
  fetchCandles(startMs: number, endMs: number): Promise<any>;
}

export interface SentinelOptions {
  evalSec?: number;
  confirmSec?: number;
  retrySec?: number;
  dwellSec?: number;
  lastGoodMaxAgeSec?: number;
  minConfirmGapSec?: number;
  logIntervalSec?: number;
  forcedMinGapSec?: number;
  nowSec?: () => number;
  log?: (line: string) => void;
  fmtTime?: (unixSec: number) => string;
}

interface GoodRead {
  at: number;
  inputs: MarketInputs;
  score: number;
  trendPts: number;
  trendLongPts: number;
  trendMedPts: number;
  crossPts: number;
  fundingPts: number;
  dirPts: number;
  longScore: number;
  rawRegime: MarketRegime;
  complete: boolean;
}

export class RegimeSentinel {
  private o: Required<SentinelOptions>;
  private effective: MarketRegime = DEFAULT_REGIME;
  private effectiveSince: number;
  private provisional = true;
  private pending: { regime: MarketRegime; count: number; lastAt: number } | null = null;
  private lastGood: GoodRead | null = null;
  private lastAttemptAt = 0;
  private nextEvalAt = 0;
  private lastFailure = "";
  private holdReason = "boot: starting in RANGE_CHOP until 2 confirming reads";
  private lastEvalOk = false;
  private inflight: Promise<RegimeConfig> | null = null;
  private lastLogAt = 0;
  private lastLogKey = "";
  private smaCache: (SmaReading & { at: number; validSec: number }) | null = null;
  private smaNextHlAt = 0;
  private smaNextCgAt = 0;
  /** Last SMA-source error (for logs); cleared on success. */
  private smaError = "";

  constructor(private fetchers: RegimeFetchers, opts: SentinelOptions = {}) {
    this.o = {
      evalSec: opts.evalSec ?? 3600,
      confirmSec: opts.confirmSec ?? 1800,
      retrySec: opts.retrySec ?? 300,
      dwellSec: opts.dwellSec ?? 7200,
      lastGoodMaxAgeSec: opts.lastGoodMaxAgeSec ?? 21600,
      minConfirmGapSec: opts.minConfirmGapSec ?? 1800,
      logIntervalSec: opts.logIntervalSec ?? 3600,
      forcedMinGapSec: opts.forcedMinGapSec ?? 30,
      nowSec: opts.nowSec ?? (() => Math.floor(Date.now() / 1000)),
      log: opts.log ?? ((l: string) => console.log(l)),
      fmtTime: opts.fmtTime ?? ((s: number) => new Date(s * 1000).toISOString()),
    };
    this.effectiveSince = this.o.nowSec();
  }

  /** Cached view; never touches the network. */
  current(): RegimeConfig {
    const g = this.lastGood;
    const p = REGIME_PROFILES[this.effective];
    let source: RegimeConfig["source"];
    if (!g) source = "default";
    else if (!this.lastEvalOk) source = "last-good";
    else if (g.rawRegime === this.effective) source = "live";
    else source = "held";
    return {
      ...p,
      regime: this.effective,
      score: g ? g.score : null,
      rawRegime: g ? g.rawRegime : null,
      source,
      holdReason: this.holdReason,
      provisional: this.provisional,
      effectiveSince: this.effectiveSince,
      lastGoodAt: g ? g.at : 0,
      lastFailure: this.lastFailure,
      nextEvalAt: this.nextEvalAt,
      details: {
        solPrice: g ? g.inputs.solPrice : NaN,
        sma200: g ? g.inputs.sma200 : NaN,
        smaSource: g ? g.inputs.smaSource ?? "n/a" : "n/a",
        smaPoints: g ? g.inputs.smaPoints : 0,
        sma50: g && g.inputs.sma50 != null ? g.inputs.sma50 : NaN,
        sma50Points: g ? g.inputs.sma50Points ?? 0 : 0,
        trendKnown: g ? g.inputs.trendKnown !== false : false,
        fundingAnnual: g ? g.inputs.funding.apr : NaN,
        fundingRawRate: g ? g.inputs.funding.rawRate : NaN,
        fundingIntervalHours: g ? g.inputs.funding.intervalHours : 1,
        fundingSource: g ? g.inputs.funding.source : "n/a",
        fundingKnown: g ? g.inputs.funding.known : false,
        trendPts: g ? g.trendPts : 0,
        trendLongPts: g ? g.trendLongPts : 0,
        trendMedPts: g ? g.trendMedPts : 0,
        crossPts: g ? g.crossPts : 0,
        fundingPts: g ? g.fundingPts : 0,
        dirPts: g ? g.dirPts : 0,
        longScore: g ? g.longScore : NaN,
        directionKnown: g ? g.inputs.direction.known : false,
        directionSource: g ? g.inputs.direction.source : "n/a",
        emaGapPct: g ? g.inputs.direction.emaGapPct : NaN,
        mom4hPct: g ? g.inputs.direction.mom4hPct : NaN,
        mom24hPct: g ? g.inputs.direction.mom24hPct : NaN,
        turnoverRatio: 0.15,
      },
    };
  }

  /** Short summary for ledger notes. */
  summary(): string {
    const c = this.current();
    const sc = c.score != null ? c.score.toFixed(1) : "n/a";
    const extra =
      c.source === "held" ? `, raw ${c.rawRegime} held` : c.source === "last-good" ? ", last good read" : c.source === "default" ? ", default" : "";
    const d = c.details;
    const parts =
      c.score == null
        ? ""
        : (d.trendKnown
            ? `: trend ${fmtPts(d.trendPts)} [SMA200 $${d.sma200.toFixed(2)} ${fmtPts(d.trendLongPts)}, ` +
              (Number.isFinite(d.sma50) ? `SMA50 $${d.sma50.toFixed(2)} ${fmtPts(d.trendMedPts)}, cross ${fmtPts(d.crossPts)}]` : `SMA50 unknown]`)
            : ": trend unknown") +
          `, funding ${d.fundingKnown ? fmtPts(d.fundingPts) : "unknown"}` +
          `, dir ${d.directionKnown ? fmtPts(d.dirPts) : "unknown"}`;
    return `${c.regime} (score ${sc}${parts}${extra})`;
  }

  async evaluate(force = false): Promise<RegimeConfig> {
    const now = this.o.nowSec();
    if (this.inflight) return this.inflight;
    if (!force && now < this.nextEvalAt) return this.current();
    if (force && now - this.lastAttemptAt < this.o.forcedMinGapSec) return this.current();
    this.inflight = this.runEvaluation(now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * 200-day SMA with its own cache (6h for Hyperliquid, 1h for the CoinGecko fallback) and per-source
   * backoff (HL 15 min, CoinGecko 30 min) so a failing source is never hit on every tick or every eval.
   */
  private async getSma(nowSec: number): Promise<SmaReading | null> {
    const c = this.smaCache;
    const view = (x: SmaReading, source = x.source): SmaReading => ({
      sma200: x.sma200,
      smaPoints: x.smaPoints,
      sma50: x.sma50,
      sma50Points: x.sma50Points,
      source,
    });
    if (c && nowSec - c.at < c.validSec) return view(c);
    const nowMs = nowSec * 1000;
    const errs: string[] = [];
    if (nowSec >= this.smaNextHlAt) {
      try {
        const rows = await this.fetchers.fetchDailyCandles(nowMs - (SMA_DAYS + 30) * 86400 * 1000, nowMs);
        const r = smaFromDailyCandles(rows, nowMs);
        if (!r) throw new Error("fewer than 150 closed daily candles / stale");
        this.smaCache = {
          sma200: r.sma200,
          smaPoints: r.smaPoints,
          sma50: r.sma50,
          sma50Points: r.sma50Points,
          source: `HL 1d closes (${r.smaPoints})`,
          at: nowSec,
          validSec: SMA_CACHE_SEC,
        };
        this.smaNextHlAt = nowSec + SMA_CACHE_SEC;
        this.smaError = "";
        return view(this.smaCache);
      } catch (e: any) {
        this.smaNextHlAt = nowSec + SMA_HL_RETRY_SEC;
        errs.push(`HL 1d: ${errMsg(e)}`);
      }
    }
    if (nowSec >= this.smaNextCgAt) {
      try {
        const r = smaFromCoinGecko(await this.fetchers.fetchCoinGecko());
        if (!r) throw new Error("unusable price series");
        this.smaCache = {
          sma200: r.sma200,
          smaPoints: r.smaPoints,
          sma50: r.sma50,
          sma50Points: r.sma50Points,
          source: `CoinGecko fallback (${r.smaPoints})`,
          at: nowSec,
          validSec: SMA_FALLBACK_CACHE_SEC,
        };
        this.smaNextCgAt = nowSec + SMA_FALLBACK_CACHE_SEC;
        this.smaError = errs.join("; ");
        return view(this.smaCache);
      } catch (e: any) {
        this.smaNextCgAt = nowSec + SMA_CG_RETRY_SEC;
        errs.push(`CoinGecko: ${errMsg(e)}`);
      }
    }
    if (errs.length) this.smaError = errs.join("; ");
    if (c && nowSec - c.at < SMA_STALE_MAX_SEC) {
      return view(c, `${c.source}, cached ${((nowSec - c.at) / 3600).toFixed(1)}h`);
    }
    return null;
  }

  private async fetchInputs(nowSec: number): Promise<MarketInputs> {
    const nowMs = nowSec * 1000;
    const [smaRes, hist, candles] = await Promise.allSettled([
      this.getSma(nowSec),
      this.fetchers.fetchFundingHistory(nowMs - (FUNDING_WINDOW_HOURS + 1) * 3600 * 1000),
      this.fetchers.fetchCandles(nowMs - DIRECTION_CANDLE_HOURS * 3600 * 1000, nowMs),
    ]);
    const sma = smaRes.status === "fulfilled" ? smaRes.value : null;
    let funding: FundingReading | null = hist.status === "fulfilled" ? fundingFromHistory(hist.value, nowMs) : null;
    if (!funding) {
      try {
        funding = fundingFromPredicted(await this.fetchers.fetchPredictedFundings());
      } catch {
        funding = null;
      }
    }
    const direction = candles.status === "fulfilled" ? directionFromCandles(candles.value, nowMs) : null;
    const price = direction ? direction.price : NaN;
    const trendKnown = !!sma && price > 0;
    if (!trendKnown && !funding && !direction) {
      throw new Error(`all inputs unavailable${this.smaError ? ` (${this.smaError})` : ""}`);
    }
    return {
      solPrice: price,
      sma200: sma ? sma.sma200 : NaN,
      smaPoints: sma ? sma.smaPoints : 0,
      sma50: sma && sma.sma50 > 0 ? sma.sma50 : NaN,
      sma50Points: sma && sma.sma50 > 0 ? sma.sma50Points : 0,
      trendKnown,
      smaSource: sma ? sma.source : `unknown${this.smaError ? ` (${this.smaError})` : ""}`,
      funding: funding ?? UNKNOWN_FUNDING,
      direction: direction ?? UNKNOWN_DIRECTION,
    };
  }

  private async runEvaluation(now: number): Promise<RegimeConfig> {
    this.lastAttemptAt = now;
    const before = this.effective;
    let changedNote = "";
    try {
      const inputs = await this.fetchInputs(now);
      const parts = scoreInputs(inputs);
      const { score, trendPts, trendLongPts, trendMedPts, crossPts, fundingPts, dirPts, longScore } = parts;
      const raw = classifyScore(parts, this.effective);
      const trendKnown = inputs.trendKnown !== false;
      const sma50Known = Number.isFinite(inputs.sma50) && inputs.sma50! > 0;
      const complete = trendKnown && sma50Known && inputs.funding.known && inputs.direction.known;
      this.lastGood = {
        at: now,
        inputs,
        score,
        trendPts,
        trendLongPts,
        trendMedPts,
        crossPts,
        fundingPts,
        dirPts,
        longScore,
        rawRegime: raw,
        complete,
      };
      this.lastEvalOk = true;
      this.lastFailure = "";
      changedNote = this.applyObservation(raw, score, longScore, complete, now, trendKnown && inputs.funding.known);
      this.nextEvalAt = now + (this.pending ? this.o.confirmSec : this.o.evalSec);
    } catch (e: any) {
      this.lastEvalOk = false;
      this.lastFailure = errMsg(e);
      const age = this.lastGood ? now - this.lastGood.at : Infinity;
      if (age > this.o.lastGoodMaxAgeSec && this.effective !== DEFAULT_REGIME) {
        this.switchTo(DEFAULT_REGIME, now);
        changedNote = `fallback to ${DEFAULT_REGIME}: no good read for >${Math.round(this.o.lastGoodMaxAgeSec / 3600)}h`;
      }
      this.holdReason = this.lastGood
        ? age <= this.o.lastGoodMaxAgeSec
          ? `eval failed — keeping ${this.effective} (last good read ${Math.round(age / 60)} min ago)`
          : `eval failed — no good read for >${Math.round(this.o.lastGoodMaxAgeSec / 3600)}h, using ${DEFAULT_REGIME}`
        : `eval failed — no good read yet, using ${DEFAULT_REGIME}`;
      this.nextEvalAt = now + this.o.retrySec;
    }
    this.maybeLog(now, before, changedNote);
    return this.current();
  }

  /** Returns a note when the effective regime changed. */
  private applyObservation(
    raw: MarketRegime,
    score: number,
    longScore: number,
    complete: boolean,
    now: number,
    longSideKnown: boolean
  ): string {
    if (raw === this.effective) {
      this.pending = null;
      if (this.provisional && complete) this.provisional = false;
      this.holdReason = "";
      return "";
    }
    // Safety shortcut uses the LONG-SIDE score (trend + funding) so short-term direction alone can't trip it.
    // Requires both long-side inputs: an unknown trend (0 pts) must not let funding alone trip it.
    if (raw === "BEAR_DEFENSIVE" && longSideKnown && longScore < SCORE_BEAR_IMMEDIATE_BELOW) {
      this.switchTo(raw, now);
      this.holdReason = "";
      return `immediate switch to BEAR (long-side score ${longScore.toFixed(1)} < ${SCORE_BEAR_IMMEDIATE_BELOW})`;
    }
    if (!complete) {
      const g = this.lastGood;
      const missing = [
        g && g.inputs.trendKnown === false ? "trend/SMA" : "",
        g && g.inputs.trendKnown !== false && !(Number(g.inputs.sma50) > 0) ? "SMA50" : "",
        g && !g.inputs.funding.known ? "funding" : "",
        g && !g.inputs.direction.known ? "direction" : "",
      ]
        .filter(Boolean)
        .join("+");
      this.holdReason = `raw ${raw} not acted on — ${missing || "input"} unknown (partial read can't switch)`;
      return "";
    }
    if (this.pending && this.pending.regime === raw) {
      if (now - this.pending.lastAt >= this.o.minConfirmGapSec) {
        this.pending.count += 1;
        this.pending.lastAt = now;
      }
    } else {
      this.pending = { regime: raw, count: 1, lastAt: now };
    }
    const margin = regimeMargin(raw, score);
    // Margin shortcut never applies to BULL: its band tops out 20 pts above the threshold, so a "full" bull
    // read always clears 10 — BULL (tightest stop for new deploys) always needs 2 consecutive reads.
    const marginOk = !this.provisional && raw !== "BULL_EXPANSION" && margin >= SWITCH_MARGIN_POINTS;
    const confirmed = this.pending.count >= 2 || marginOk;
    const dwell = now - this.effectiveSince;
    const dwellOk = this.provisional || dwell >= this.o.dwellSec;
    if (confirmed && dwellOk) {
      const why = this.pending.count >= 2 ? `${this.pending.count} consecutive reads` : `margin ${margin.toFixed(1)} pts`;
      this.switchTo(raw, now);
      this.holdReason = "";
      return `switched to ${raw} (${why})`;
    }
    const parts: string[] = [];
    if (!confirmed) {
      parts.push(
        this.provisional
          ? `boot: needs 2 consecutive reads (${this.pending.count}/2)`
          : raw === "BULL_EXPANSION"
            ? `BULL needs 2 consecutive reads (${this.pending.count}/2)`
            : `needs 2nd confirming read (${this.pending.count}/2) or margin ≥${SWITCH_MARGIN_POINTS} (is ${margin.toFixed(1)})`
      );
    }
    if (!dwellOk) parts.push(`dwell ${(dwell / 3600).toFixed(1)}h/${(this.o.dwellSec / 3600).toFixed(1)}h in ${this.effective}`);
    this.holdReason = `holding ${this.effective} vs raw ${raw}: ${parts.join("; ")}`;
    return "";
  }

  private switchTo(r: MarketRegime, now: number) {
    this.effective = r;
    this.effectiveSince = now;
    this.pending = null;
    this.provisional = false;
  }

  private maybeLog(now: number, before: MarketRegime, changedNote: string) {
    const c = this.current();
    const key = `${c.regime}|${c.rawRegime}|${c.source}|${this.lastEvalOk}|${this.pending?.regime ?? ""}:${this.pending?.count ?? 0}`;
    const due = now - this.lastLogAt >= this.o.logIntervalSec;
    if (!changedNote && key === this.lastLogKey && !due && c.regime === before) return;
    this.lastLogAt = now;
    this.lastLogKey = key;
    this.o.log(formatRegimeLine(c, this.lastEvalOk, changedNote, this.o.fmtTime));
  }
}

export function formatRegimeLine(c: RegimeConfig, evalOk: boolean, changedNote: string, fmtTime: (s: number) => string): string {
  const d = c.details;
  const head = `[REGIME] ${c.regime}${c.provisional ? " (provisional)" : ""}`;
  const res = evalOk
    ? `raw ${c.rawRegime} score ${c.score != null ? c.score.toFixed(1) : "n/a"}`
    : `EVAL FAILED (${c.lastFailure})`;
  const inputs = c.score != null
    ? ` | trend ${fmtPts(d.trendPts)}: ` +
      (d.trendKnown
        ? `$${d.solPrice.toFixed(2)} vs SMA200 $${d.sma200.toFixed(2)} (${fmtPct((d.solPrice / d.sma200 - 1) * 100, 1)}) ${fmtPts(d.trendLongPts)}, ` +
          (Number.isFinite(d.sma50)
            ? `vs SMA50 $${d.sma50.toFixed(2)} (${fmtPct((d.solPrice / d.sma50 - 1) * 100, 1)}) ${fmtPts(d.trendMedPts)}, ` +
              `cross SMA50/200 ${fmtPct((d.sma50 / d.sma200 - 1) * 100, 1)} ${fmtPts(d.crossPts)}`
            : `SMA50 unknown → 0`) +
          ` [${d.smaSource}]`
        : `unknown → neutral [SMA ${d.smaSource}]`) +
      ` | funding ${fmtPts(d.fundingPts)}: ` +
      (d.fundingKnown
        ? `${d.fundingRawRate.toExponential(3)}/${d.fundingIntervalHours}h → ${d.fundingAnnual.toFixed(2)}% APR [${d.fundingSource}]`
        : "unknown → neutral") +
      ` | direction ${fmtPts(d.dirPts)}: ` +
      (d.directionKnown
        ? `vs EMA20(1h) ${fmtPct(d.emaGapPct)}, 4h ${fmtPct(d.mom4hPct)}, 24h ${fmtPct(d.mom24hPct)} [${d.directionSource}]`
        : "unknown → neutral")
    : "";
  const hold = c.holdReason ? ` | ${c.holdReason}` : "";
  const chg = changedNote ? ` | ${changedNote}` : "";
  return `${head} | ${res}${inputs}${hold}${chg} | source ${c.source} | next eval ${fmtTime(c.nextEvalAt)}`;
}

function fmtPct(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function fmtPts(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
}

function errMsg(e: any): string {
  const status = e?.response?.status;
  const m = String(e?.message || e || "error");
  return (status ? `HTTP ${status} ` : "") + m.slice(0, 160);
}

// ---------------- per-position stop lock ----------------

export interface EntryStopLock {
  stopPct: number;
  cooldownSec: number;
  regime: MarketRegime;
  source: string;
}

/** Lock taken from the regime in force when a position is opened. */
export function lockFromRegime(regime: MarketRegime, context: string): EntryStopLock {
  const p = REGIME_PROFILES[regime];
  return { stopPct: p.floorStopPct, cooldownSec: p.cooldownSec, regime, source: `${regime} at ${context}` };
}

/** Maps a stop % back to the regime profile that uses it (exact match), else RANGE_CHOP. */
export function regimeForStopPct(pct: number): MarketRegime {
  for (const r of Object.keys(REGIME_PROFILES) as MarketRegime[]) {
    if (Math.abs(REGIME_PROFILES[r].floorStopPct - pct) < 1e-9) return r;
  }
  return DEFAULT_REGIME;
}

/** ENTRY_STOP_PCT must be a fraction (0.05 = 5%) within [0.005, 0.25]. */
export function parseStopPctPin(raw: string): { ok: boolean; value: number; error: string } {
  const s = (raw || "").trim();
  if (!s) return { ok: false, value: NaN, error: "unset" };
  const v = Number(s);
  if (!Number.isFinite(v)) return { ok: false, value: NaN, error: `not a number (${s})` };
  if (v < 0.005 || v > 0.25) return { ok: false, value: v, error: `out of range ${s} (expected a fraction 0.005–0.25, e.g. 0.05)` };
  return { ok: true, value: v, error: "" };
}

/**
 * Stop lock at boot-attach. A valid ENTRY_STOP_PCT applies only when the ENTRY_POSITION_PUBKEY pin
 * matches (pinApplies). Otherwise RANGE_CHOP's 5% — NOT the live regime — so a restart can't move the stop.
 */
export function resolveAttachStopLock(pinRaw: string, pinApplies: boolean): { lock: EntryStopLock; warning: string } {
  const def = REGIME_PROFILES[DEFAULT_REGIME];
  const parsed = parseStopPctPin(pinRaw);
  if (pinApplies && parsed.ok) {
    const r = regimeForStopPct(parsed.value);
    return {
      lock: { stopPct: parsed.value, cooldownSec: REGIME_PROFILES[r].cooldownSec, regime: r, source: "pin ENTRY_STOP_PCT" },
      warning: "",
    };
  }
  let warning = "";
  if (pinRaw && pinRaw.trim()) {
    warning = !parsed.ok ? `ENTRY_STOP_PCT ignored — ${parsed.error}` : "ENTRY_STOP_PCT ignored — ENTRY_POSITION_PUBKEY pin does not match";
  }
  return {
    lock: {
      stopPct: def.floorStopPct,
      cooldownSec: def.cooldownSec,
      regime: DEFAULT_REGIME,
      source: `default ${DEFAULT_REGIME} ${(def.floorStopPct * 100).toFixed(1)}% (not pinned)`,
    },
    warning,
  };
}

export function priceStopFromLock(entrySpotUsd: number, lock: EntryStopLock | null): number {
  if (!(entrySpotUsd > 0)) return 0;
  const pct = lock && lock.stopPct > 0 ? lock.stopPct : REGIME_PROFILES[DEFAULT_REGIME].floorStopPct;
  return entrySpotUsd * (1 - pct);
}

/** Copy-paste env line that pins the current entry (incl. stop %) across restarts. */
export function entryPinLine(pubkey: string, entrySpot: number, entryEquity: number, lock: EntryStopLock | null): string {
  const pct = lock && lock.stopPct > 0 ? lock.stopPct : REGIME_PROFILES[DEFAULT_REGIME].floorStopPct;
  return (
    `ENTRY_POSITION_PUBKEY=${pubkey} ENTRY_SPOT_USD=${entrySpot.toFixed(2)} ` +
    `ENTRY_EQUITY_USD=${entryEquity > 0 ? entryEquity.toFixed(2) : "(pending)"} ENTRY_STOP_PCT=${Number(pct.toFixed(4))}`
  );
}
