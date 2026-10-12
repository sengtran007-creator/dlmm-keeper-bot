/**
 * Pure tick math (no RPC): spot from the pool's active bin id and mark-to-market equity from one batched
 * account read. Mirrors probeEquity()'s fail-closed rules so the equity stop never runs on a partial read.
 */

/** Spot in USD per SOL from the active bin: (1 + binStep/1e4)^activeId × priceFactor (SOL 9dp / USDC 6dp → 1000). */
export function spotFromActiveId(activeId: number, binStepBps: number, priceFactor: number): number {
  if (!Number.isFinite(activeId) || !(binStepBps > 0)) return NaN;
  return Math.pow(1 + binStepBps / 10_000, activeId) * priceFactor;
}

export interface PositionAmounts {
  key: string;
  /** False when the position's data could not be decoded/processed (partial read). */
  ok: boolean;
  /** Raw amounts (lamports / USDC micro-units) as numbers; NaN when missing. */
  x: number;
  y: number;
  feeX: number;
  feeY: number;
  /** M2: lamports held by the position account (refundable rent). */
  rentLamports?: number;
}

export interface SnapshotEquityInput {
  spotUsd: number;
  nativeLamports: number;
  wsolRaw: number;
  usdcRaw: number;
  /** Every tracked position that was read (missing accounts are listed in `missing`). */
  positions: PositionAmounts[];
  /** Tracked position keys whose account came back null in the read. */
  missing: string[];
  /** The bot's active position (must be present and readable for ok). */
  expectedKey: string | null;
}

export interface SnapshotEquity {
  ok: boolean;
  reason?: string;
  totalUsd?: number;
  walletUsd?: number;
  positionsUsd?: number;
  activePositionUsd?: number;
  positionCount?: number;
}

function validSpot(s: number): boolean {
  return Number.isFinite(s) && s > 0;
}

export function walletUsdFromRaw(spotUsd: number, nativeLamports: number, wsolRaw: number, usdcRaw: number): number {
  return usdcRaw / 1e6 + ((nativeLamports + wsolRaw) / 1e9) * spotUsd;
}

export function positionUsd(p: PositionAmounts, spotUsd: number): number {
  // M2: the position account's rent is refunded to the wallet on close, so it is part of equity.
  const rent = Number.isFinite(p.rentLamports as number) ? (p.rentLamports as number) : 0;
  return ((p.x + p.feeX + rent) / 1e9) * spotUsd + (p.y + p.feeY) / 1e6;
}

/** Full MTM from one snapshot; ok:false on anything that probeEquity() would also reject. */
export function equityFromSnapshot(i: SnapshotEquityInput): SnapshotEquity {
  if (!validSpot(i.spotUsd)) return { ok: false, reason: `invalid spot ${i.spotUsd}` };
  for (const v of [i.nativeLamports, i.wsolRaw, i.usdcRaw]) {
    if (!Number.isFinite(v) || v < 0) return { ok: false, reason: "wallet read produced non-finite value" };
  }
  if (i.expectedKey && i.missing.includes(i.expectedKey)) {
    return { ok: false, reason: `open position ${i.expectedKey.slice(0, 8)} missing from read (account not returned)` };
  }
  const walletUsd = walletUsdFromRaw(i.spotUsd, i.nativeLamports, i.wsolRaw, i.usdcRaw);
  let positionsUsd = 0;
  let activePositionUsd = 0;
  let activeFound = false;
  for (const p of i.positions) {
    if (!p.ok) return { ok: false, reason: `position ${p.key.slice(0, 8)} has no positionData (partial read)` };
    if (![p.x, p.y].every(Number.isFinite)) return { ok: false, reason: `position ${p.key.slice(0, 8)} amounts missing/non-finite (partial read)` };
    const fx = Number.isFinite(p.feeX) ? p.feeX : 0;
    const fy = Number.isFinite(p.feeY) ? p.feeY : 0;
    const v = positionUsd({ ...p, feeX: fx, feeY: fy }, i.spotUsd);
    if (!Number.isFinite(v) || v < 0) return { ok: false, reason: `position ${p.key.slice(0, 8)} value ${v} invalid` };
    positionsUsd += v;
    if (i.expectedKey && p.key === i.expectedKey) {
      activeFound = true;
      activePositionUsd = v;
    }
  }
  if (i.expectedKey && !activeFound) {
    return { ok: false, reason: `open position ${i.expectedKey.slice(0, 8)} missing from read (${i.positions.length} returned)` };
  }
  const totalUsd = walletUsd + positionsUsd;
  if (!Number.isFinite(totalUsd)) return { ok: false, reason: "equity non-finite" };
  return {
    ok: true,
    totalUsd: Number(totalUsd.toFixed(2)),
    walletUsd,
    positionsUsd,
    activePositionUsd,
    positionCount: i.positions.length,
  };
}

/**
 * Upper bound of idle capital the top-up could deploy (USDC + native+WSOL above the gas reserve). Used only
 * to skip topUpExistingPosition()'s own fresh reads when this is already below TOPUP_MIN_USD; it is never
 * lower than what the top-up itself computes (WSOL is unwrapped to native there), so no top-up is skipped
 * that would have run.
 */
export function idleUsdUpperBound(spotUsd: number, nativeLamports: number, wsolRaw: number, usdcRaw: number, gasReserveLamports: number): number {
  if (!validSpot(spotUsd)) return Infinity; // unknown → let the top-up do its own read
  const idleSol = Math.max(0, nativeLamports + wsolRaw - gasReserveLamports);
  return usdcRaw / 1e6 + (idleSol / 1e9) * spotUsd;
}

/** Due when never run, forced, or the interval elapsed. */
export function isDue(nowSec: number, lastSec: number, intervalSec: number, force = false): boolean {
  return force || lastSec <= 0 || nowSec - lastSec >= intervalSec;
}

/** SOL units held inside the positions of a snapshot (liquidity + unclaimed SOL fees); NaN entries count 0. */
export function positionSolUnitsFromAmounts(amounts: PositionAmounts[]): number {
  let lamports = 0;
  for (const a of amounts) {
    if (!a.ok) continue;
    if (Number.isFinite(a.x)) lamports += a.x;
    if (Number.isFinite(a.feeX)) lamports += a.feeX;
  }
  return lamports / 1e9;
}
