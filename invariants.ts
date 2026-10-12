// Part 3 runtime invariant alerts (Telegram + log). Pure checks here; index.ts feeds them live values and
// rate-limits the notifications with AlertGate.

/** Rate limiter: an alert key fires at most once per repeatSec (cleared when the condition goes away). */
export class AlertGate {
  private last = new Map<string, number>();
  shouldFire(key: string, nowSec: number, repeatSec: number): boolean {
    const t = this.last.get(key);
    if (t != null && nowSec - t < repeatSec) return false;
    this.last.set(key, nowSec);
    return true;
  }
  clear(key: string): void {
    this.last.delete(key);
  }
}

/** Native SOL after an open must be ≥ the gas reserve. */
export function gasBelowReserveAfterOpen(nativeLamports: number, reserveLamports: number): boolean {
  return Number.isFinite(nativeLamports) && nativeLamports < reserveLamports;
}

/**
 * Unexplained equity jump between two consecutive good reads with NO money operation in between: the change
 * should be ≈ SOL units held × spot change (fees accrue slowly). Flags |residual| > max(minUsd, pct × equity).
 */
export function unexplainedEquityJump(p: {
  prevEquityUsd: number;
  prevSpotUsd: number;
  equityUsd: number;
  spotUsd: number;
  solUnits: number;
  minUsd?: number;
  pct?: number;
}): { jump: boolean; residualUsd: number; tolUsd: number } {
  const expected = p.solUnits * (p.spotUsd - p.prevSpotUsd);
  const residual = p.equityUsd - p.prevEquityUsd - expected;
  const tol = Math.max(p.minUsd ?? 5, (p.pct ?? 0.01) * Math.max(p.prevEquityUsd, p.equityUsd));
  const ok = [p.prevEquityUsd, p.prevSpotUsd, p.equityUsd, p.spotUsd, p.solUnits].every(Number.isFinite);
  return { jump: ok && Math.abs(residual) > tol, residualUsd: Number(residual.toFixed(2)), tolUsd: Number(tol.toFixed(2)) };
}

/** Hourly RPC credits far above the steady-state budget (default: > 3× budget and > floor). */
export function creditSpike(creditsLastHour: number, budgetPerHour: number, factor = 3, floor = 1500): boolean {
  return Number.isFinite(creditsLastHour) && creditsLastHour > Math.max(floor, budgetPerHour * factor);
}

/** Idle capital (USD above the gas reserve) left undeployed for too long while flat, or not topped up while positioned. */
export function idleFundsAlert(p: { idleUsd: number; idleSinceSec: number | null; nowSec: number; minUsd: number; maxIdleSec: number }): boolean {
  return p.idleSinceSec != null && p.idleUsd >= p.minUsd && p.nowSec - p.idleSinceSec >= p.maxIdleSec;
}

/** Positions of this wallet in this pool that the bot does not manage. */
export function orphanPositions(discovered: string[], active: string | null): string[] {
  return discovered.filter((k) => k !== active);
}

/** Daily ledger drift: in-memory swept total vs the on-chain rescan. */
export function ledgerDrift(inMemoryUsd: number, onChainUsd: number, tolUsd = 0.5): { drift: boolean; diffUsd: number } {
  const d = Number((onChainUsd - inMemoryUsd).toFixed(2));
  return { drift: Math.abs(d) > tolUsd, diffUsd: d };
}

/** M5: deterministic boot delay per instance so two bots redeployed together don't burst the shared RPC at once. */
export function bootJitterSec(label: string, maxSec: number): number {
  if (!(maxSec > 0)) return 0;
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % (Math.floor(maxSec) + 1);
}
