/**
 * Pool / instance helpers (pure, unit-tested) so one codebase can run on any SOL-USDC DLMM pool:
 * bin-step-aware prices and range sizing, a bin-step-agnostic Gate 2 threshold, instance labels,
 * and the sweep-history filter.
 *
 * The regime profiles in regime.ts are expressed in bins of the original 10 bps pool
 * (REFERENCE_BIN_STEP_BPS). On any other bin step they are converted to the same price width and
 * then clamped to the 70-bin position limit — so on the 10 bps pool nothing changes.
 */

/** Bin step (bps) the regime profiles' bid/ask bin counts were designed for. */
export const REFERENCE_BIN_STEP_BPS = 10;
/** Meteora max inclusive position width (DEFAULT_BIN_PER_POSITION). */
export const MAX_POSITION_WIDTH_BINS = 70;

/** Public Meteora SOL-USDC pools with known bin steps (used only for labels before the pool is loaded). */
export const KNOWN_SOL_USDC_POOLS: Record<string, { binStep: number; label: string }> = {
  BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y: { binStep: 10, label: "SOL-USDC 10bps" },
  "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6": { binStep: 4, label: "SOL-USDC 4bps" },
};
export const DEFAULT_POOL_ADDRESS = "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y";

/** USD price of `targetBinId` given the active bin's price and the pool bin step (bps). */
export function calculateBinPriceUsd(activeSpotUsd: number, activeBinId: number, targetBinId: number, binStepBps: number): number {
  if (!(binStepBps > 0) || !Number.isFinite(activeSpotUsd)) return 0;
  const binDiff = Number(targetBinId) - Number(activeBinId);
  const p = activeSpotUsd * Math.pow(1 + binStepBps / 10000, binDiff);
  return Number.isFinite(p) ? p : 0;
}

/** Price width (fraction, e.g. 0.014) covered by `bins` bins of `binStepBps`. */
export function binsToWidthPct(bins: number, binStepBps: number): number {
  if (!(bins > 0) || !(binStepBps > 0)) return 0;
  return Math.pow(1 + binStepBps / 10000, bins) - 1;
}

/** Number of bins (rounded) covering a price width `widthFrac` (e.g. 0.014 = 1.4%). */
export function widthPctToBins(widthFrac: number, binStepBps: number): number {
  if (!(widthFrac > 0) || !(binStepBps > 0)) return 0;
  return Math.round(Math.log(1 + widthFrac) / Math.log(1 + binStepBps / 10000));
}

/**
 * Clamp bid/ask bins so the inclusive width (bid + ask + 1) ≤ maxWidth, keeping the bid:ask ratio.
 * Same arithmetic as the original clampBinRange (30/30 on 10 bps is untouched; 75/75 → 34/35).
 */
export function clampBins(bidBins: number, askBins: number, maxWidth = MAX_POSITION_WIDTH_BINS): { bidBins: number; askBins: number; clamped: boolean } {
  let bid = Math.max(0, Math.floor(Number(bidBins) || 0));
  let ask = Math.max(0, Math.floor(Number(askBins) || 0));
  let clamped = false;
  if (bid + ask + 1 > maxWidth) {
    const budget = maxWidth - 1;
    const totalSide = Math.max(1, bid + ask);
    bid = Math.max(0, Math.floor((budget * bid) / totalSide));
    ask = Math.max(0, budget - bid);
    clamped = true;
  }
  return { bidBins: bid, askBins: ask, clamped };
}

export interface RangeOverrides {
  /** BID_BINS env (bins below active, in THIS pool's bins). */
  bidBins?: number | null;
  /** ASK_BINS env (bins above active, in THIS pool's bins). */
  askBins?: number | null;
  /** RANGE_WIDTH_PCT env: symmetric half-width in percent (e.g. 1.4 = ±1.4%). */
  widthPct?: number | null;
}

export interface ResolvedRange {
  bidBins: number;
  askBins: number;
  /** Where the bins came from, for logs / Telegram. */
  source: string;
  clamped: boolean;
  bidPct: number;
  askPct: number;
}

function isPosInt(v: any): boolean {
  return v != null && Number.isFinite(Number(v)) && Number(v) >= 0;
}

/**
 * Bid/ask bins for a NEW position on a pool with `binStepBps`:
 *  1. BID_BINS / ASK_BINS (pool bins; one side set → mirrored), else
 *  2. RANGE_WIDTH_PCT (symmetric ±%), else
 *  3. the regime profile, converted from 10 bps bins to the same price width on this bin step.
 * Always clamped to the 70-bin position width.
 */
export function resolveRangeBins(
  profileBid: number,
  profileAsk: number,
  binStepBps: number,
  o: RangeOverrides = {},
  maxWidth = MAX_POSITION_WIDTH_BINS
): ResolvedRange {
  let bid: number;
  let ask: number;
  let source: string;
  const hasBid = isPosInt(o.bidBins);
  const hasAsk = isPosInt(o.askBins);
  if (hasBid || hasAsk) {
    bid = Math.floor(Number(hasBid ? o.bidBins : o.askBins));
    ask = Math.floor(Number(hasAsk ? o.askBins : o.bidBins));
    source = "env BID_BINS/ASK_BINS";
  } else if (o.widthPct != null && Number.isFinite(o.widthPct) && o.widthPct > 0) {
    const n = widthPctToBins(o.widthPct / 100, binStepBps);
    bid = n;
    ask = n;
    source = `env RANGE_WIDTH_PCT ±${o.widthPct}%`;
  } else if (binStepBps === REFERENCE_BIN_STEP_BPS || !(binStepBps > 0)) {
    bid = profileBid;
    ask = profileAsk;
    source = "regime profile";
  } else {
    // Same price width as the 10 bps profile: n10 bins of 10 bps ≈ n10 × 10 / step bins.
    bid = widthPctToBins(binsToWidthPct(profileBid, REFERENCE_BIN_STEP_BPS), binStepBps);
    ask = widthPctToBins(binsToWidthPct(profileAsk, REFERENCE_BIN_STEP_BPS), binStepBps);
    source = `regime profile ${profileBid}/${profileAsk}@${REFERENCE_BIN_STEP_BPS}bps → ${bid}/${ask}@${binStepBps}bps`;
  }
  const c = clampBins(bid, ask, maxWidth);
  if (c.clamped) source += ` (clamped to ${maxWidth} bins)`;
  return {
    bidBins: c.bidBins,
    askBins: c.askBins,
    source,
    clamped: c.clamped,
    bidPct: binsToWidthPct(c.bidBins, binStepBps) * 100,
    askPct: binsToWidthPct(c.askBins, binStepBps) * 100,
  };
}

// ---- Gate 2 (re-entry volatility) ----
/**
 * The original gate was "variable fee ≤ 15 bps" on the 10 bps pool, whose variableFeeControl is 40000.
 * Meteora: variableFee = vfc × (volAcc × binStep)² / 1e11 (1e9 = 100%), and volAcc × binStep tracks the
 * accumulated price move independently of bin step. So the SAME volatility tolerance on another pool is
 *   threshold = 15 bps × (pool vfc / 40000).
 * On the 10 bps pool this is exactly 15 (unchanged); on the 4 bps pool (vfc 120000) it is 45 bps.
 */
export const GATE2_REF_FEE_BPS = 15;
export const GATE2_REF_VARIABLE_FEE_CONTROL = 40000;

export function gate2ThresholdBps(envAbsoluteBps: number | null, variableFeeControl: number): { bps: number; source: string } {
  if (envAbsoluteBps != null && Number.isFinite(envAbsoluteBps) && envAbsoluteBps > 0) {
    return { bps: envAbsoluteBps, source: "env GATE2_MAX_VARIABLE_FEE_BPS" };
  }
  const vfc = Number(variableFeeControl);
  if (!(vfc > 0)) return { bps: GATE2_REF_FEE_BPS, source: "default (pool vfc unknown)" };
  const bps = Number(((GATE2_REF_FEE_BPS * vfc) / GATE2_REF_VARIABLE_FEE_CONTROL).toFixed(4));
  return { bps, source: vfc === GATE2_REF_VARIABLE_FEE_CONTROL ? "default" : `default scaled to pool vfc ${vfc}` };
}

/** Accumulated price move (percent) implied by the volatility accumulator: volAcc/1e4 bins × binStep bps. */
export function volatilityMovePct(volAcc: number, binStepBps: number): number {
  if (!(volAcc >= 0) || !(binStepBps > 0)) return 0;
  return ((volAcc / 10000) * binStepBps) / 100;
}

// ---- Instance identity ----
/** INSTANCE_LABEL / BOT_NAME → safe short label ("" when unset). Allowed: letters, digits, space, _ . -  */
export function sanitizeInstanceLabel(raw: string | undefined | null): string {
  const s = String(raw ?? "")
    .replace(/[^A-Za-z0-9 _.\-]/g, "")
    .trim()
    .slice(0, 32);
  return s;
}

/** Telegram text with an instance prefix (unchanged when no label). */
export function withInstancePrefix(msg: string, label: string): string {
  if (!label) return msg;
  return `[${label}] ${msg}`;
}

/** "false"/"0"/"no"/"off" → false; unset → default. */
export function parseBoolEnv(raw: string | undefined | null, dflt: boolean): boolean {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return dflt;
  if (["0", "false", "no", "off", "disabled"].includes(s)) return false;
  if (["1", "true", "yes", "on", "enabled"].includes(s)) return true;
  return dflt;
}

/** Optional non-negative integer env (null when unset/invalid). */
export function parseOptionalInt(raw: string | undefined | null): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) return null;
  return n;
}

// ---- Sweep history ----
// sweepRawFromParsedTx (own-signer-filtered USDC sweep parsing) lives in feesweep.ts.

/** Does an SDK position carry liquidity (needs removeLiquidity before it can be closed)? */
export function positionHasLiquidity(positionData: any): boolean {
  if (!positionData) return false;
  const nz = (v: any) => {
    const s = String(v?.toString?.() ?? v ?? "0").trim();
    return s !== "" && s !== "0" && Number(s) !== 0;
  };
  if (nz(positionData.totalXAmount) || nz(positionData.totalYAmount)) return true;
  const bins: any[] = Array.isArray(positionData.positionBinData) ? positionData.positionBinData : [];
  return bins.some((b) => nz(b?.positionLiquidity));
}
