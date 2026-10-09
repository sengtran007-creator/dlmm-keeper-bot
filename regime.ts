/**
 * Macro regime classifier + per-position stop lock (pure logic; network access is injected).
 *
 * Score = 50 + trend term (±25) + funding term (±25).
 *   trend:   25 × clamp((price / SMA200 − 1) / 10%, −1, 1)        (full ±25 at ≥10% above/below the 200-day mean)
 *   funding: Hyperliquid SOL funding, 24h average of SETTLED hourly rates, annualized
 *            (hourly rate × 24 × 365 × 100). Fallback: HL predicted rate normalized by its interval.
 *            |APR| < 3%            → 0   (deadband: sign noise around zero never moves the score)
 *            3% … 8%               → 0 … +25 linear (HL's neutral baseline is 10.95% APR; ≥8% = no persistent short pressure)
 *            8% … 40%              → +25
 *            > 40%                 → 0   (overheated longs: not a clean bull signal)
 *            −3% … −10%            → 0 … −25 linear (shorts paying)
 *            ≤ −10%                → −25
 *            unknown               → 0   (partial read; can't trigger a regime switch)
 * Regime: score ≥ 85 BULL_EXPANSION (trend AND funding must agree) · score < 40 BEAR_DEFENSIVE · else RANGE_CHOP.
 *
 * Hysteresis: a different regime must be observed on 2 consecutive complete evaluations (≥10 min apart)
 * OR (not for BULL) sit ≥10 points inside its band, AND the current regime must have been in force ≥2h.
 * Exception: score < 30 → BEAR immediately (safety). Boot starts in RANGE_CHOP (nothing persisted) and
 * leaves it only after 2 consecutive confirming reads (no margin shortcut, no dwell at boot).
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
  BEAR_DEFENSIVE: { bidBins: 45, askBins: 15, floorStopPct: 0.06, cooldownSec: 14400, capitalDeployPct: 0.6 },
};

export const DEFAULT_REGIME: MarketRegime = "RANGE_CHOP";

export const SCORE_BULL_MIN = 85;
export const SCORE_BEAR_BELOW = 40;
export const SCORE_BEAR_IMMEDIATE_BELOW = 30;
export const SWITCH_MARGIN_POINTS = 10;
export const TREND_FULL_PCT = 0.1;
export const FUNDING_DEADBAND_APR = 3;
export const FUNDING_FULL_BULL_APR = 8;
export const FUNDING_OVERHEATED_APR = 40;
export const FUNDING_FULL_BEAR_APR = -10;
export const FUNDING_WINDOW_HOURS = 24;
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

export interface MarketInputs {
  solPrice: number;
  sma200: number;
  smaPoints: number;
  funding: FundingReading;
}

export function annualizeFunding(rate: number, intervalHours: number): number {
  return rate * (24 / intervalHours) * 365 * 100;
}

/** CoinGecko market_chart (daily, 200d) → current price + mean of all points. null if unusable. */
export function smaFromCoinGecko(data: any): { solPrice: number; sma200: number; smaPoints: number } | null {
  const raw = data?.prices;
  if (!Array.isArray(raw) || raw.length < 150) return null;
  const prices = raw.map((p: any) => Number(Array.isArray(p) ? p[1] : NaN));
  if (prices.some((p: number) => !Number.isFinite(p) || p <= 0)) return null;
  const solPrice = prices[prices.length - 1];
  const sma200 = prices.reduce((a: number, b: number) => a + b, 0) / prices.length;
  return { solPrice, sma200, smaPoints: prices.length };
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

// ---------------- scoring ----------------

export function trendPoints(solPrice: number, sma200: number): number {
  if (!(solPrice > 0) || !(sma200 > 0)) return 0;
  const rel = solPrice / sma200 - 1;
  return 25 * Math.max(-1, Math.min(1, rel / TREND_FULL_PCT));
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

export function scoreInputs(inp: MarketInputs): { score: number; trendPts: number; fundingPts: number } {
  const trendPts = trendPoints(inp.solPrice, inp.sma200);
  const fundingPts = fundingPoints(inp.funding);
  return { score: 50 + trendPts + fundingPts, trendPts, fundingPts };
}

export function classifyScore(score: number): MarketRegime {
  if (score >= SCORE_BULL_MIN) return "BULL_EXPANSION";
  if (score < SCORE_BEAR_BELOW) return "BEAR_DEFENSIVE";
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
    fundingAnnual: number;
    fundingRawRate: number;
    fundingIntervalHours: number;
    fundingSource: string;
    fundingKnown: boolean;
    trendPts: number;
    fundingPts: number;
    turnoverRatio: number;
  };
}

export interface RegimeFetchers {
  fetchCoinGecko(): Promise<any>;
  fetchFundingHistory(startTimeMs: number): Promise<any>;
  fetchPredictedFundings(): Promise<any>;
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
  fundingPts: number;
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

  constructor(private fetchers: RegimeFetchers, opts: SentinelOptions = {}) {
    this.o = {
      evalSec: opts.evalSec ?? 3600,
      confirmSec: opts.confirmSec ?? 900,
      retrySec: opts.retrySec ?? 300,
      dwellSec: opts.dwellSec ?? 7200,
      lastGoodMaxAgeSec: opts.lastGoodMaxAgeSec ?? 21600,
      minConfirmGapSec: opts.minConfirmGapSec ?? 600,
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
        fundingAnnual: g ? g.inputs.funding.apr : NaN,
        fundingRawRate: g ? g.inputs.funding.rawRate : NaN,
        fundingIntervalHours: g ? g.inputs.funding.intervalHours : 1,
        fundingSource: g ? g.inputs.funding.source : "n/a",
        fundingKnown: g ? g.inputs.funding.known : false,
        trendPts: g ? g.trendPts : 0,
        fundingPts: g ? g.fundingPts : 0,
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
    return `${c.regime} (score ${sc}${extra})`;
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

  private async fetchInputs(nowSec: number): Promise<MarketInputs> {
    const nowMs = nowSec * 1000;
    const [cg, hist] = await Promise.allSettled([
      this.fetchers.fetchCoinGecko(),
      this.fetchers.fetchFundingHistory(nowMs - (FUNDING_WINDOW_HOURS + 1) * 3600 * 1000),
    ]);
    if (cg.status !== "fulfilled") throw new Error(`CoinGecko: ${errMsg(cg.reason)}`);
    const trend = smaFromCoinGecko(cg.value);
    if (!trend) throw new Error("CoinGecko: unusable price series");
    let funding: FundingReading | null = hist.status === "fulfilled" ? fundingFromHistory(hist.value, nowMs) : null;
    if (!funding) {
      try {
        funding = fundingFromPredicted(await this.fetchers.fetchPredictedFundings());
      } catch {
        funding = null;
      }
    }
    return { ...trend, funding: funding ?? UNKNOWN_FUNDING };
  }

  private async runEvaluation(now: number): Promise<RegimeConfig> {
    this.lastAttemptAt = now;
    const before = this.effective;
    let changedNote = "";
    try {
      const inputs = await this.fetchInputs(now);
      const { score, trendPts, fundingPts } = scoreInputs(inputs);
      const raw = classifyScore(score);
      const complete = inputs.funding.known;
      this.lastGood = { at: now, inputs, score, trendPts, fundingPts, rawRegime: raw, complete };
      this.lastEvalOk = true;
      this.lastFailure = "";
      changedNote = this.applyObservation(raw, score, complete, now);
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
  private applyObservation(raw: MarketRegime, score: number, complete: boolean, now: number): string {
    if (raw === this.effective) {
      this.pending = null;
      if (this.provisional && complete) this.provisional = false;
      this.holdReason = "";
      return "";
    }
    if (raw === "BEAR_DEFENSIVE" && score < SCORE_BEAR_IMMEDIATE_BELOW) {
      this.switchTo(raw, now);
      this.holdReason = "";
      return `immediate switch to BEAR (score ${score.toFixed(1)} < ${SCORE_BEAR_IMMEDIATE_BELOW})`;
    }
    if (!complete) {
      this.holdReason = `raw ${raw} not acted on — funding unknown (partial read can't switch)`;
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
    // Margin shortcut never applies to BULL: its band tops out 15 pts above the threshold, so a "full" bull
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
    ? ` | trend ${fmtPts(d.trendPts)}: $${d.solPrice.toFixed(2)} vs SMA200 $${d.sma200.toFixed(2)} (${((d.solPrice / d.sma200 - 1) * 100).toFixed(1)}%)` +
      ` | funding ${fmtPts(d.fundingPts)}: ` +
      (d.fundingKnown
        ? `${d.fundingRawRate.toExponential(3)}/${d.fundingIntervalHours}h → ${d.fundingAnnual.toFixed(2)}% APR [${d.fundingSource}]`
        : "unknown → neutral")
    : "";
  const hold = c.holdReason ? ` | ${c.holdReason}` : "";
  const chg = changedNote ? ` | ${changedNote}` : "";
  return `${head} | ${res}${inputs}${hold}${chg} | source ${c.source} | next eval ${fmtTime(c.nextEvalAt)}`;
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
