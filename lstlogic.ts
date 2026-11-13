/**
 * Pure logic for the LST-pair mode (lstpair.ts): JupSOL-JitoSOL DLMM LP, unhedged, SOL-denominated.
 * No RPC, no env reads — everything here is unit-tested in tests/lstlogic.test.ts.
 */

/** SPL stake-pool account: total_lamports at 258, pool_token_supply at 266 (u64 LE). */
export const STAKE_POOL_TOTAL_LAMPORTS_OFFSET = 258;
export const STAKE_POOL_TOKEN_SUPPLY_OFFSET = 266;

export function stakePoolRate(data: Buffer): number {
  if (!data || data.length < STAKE_POOL_TOKEN_SUPPLY_OFFSET + 8) throw new Error("stake pool account too short");
  const total = Number(data.readBigUInt64LE(STAKE_POOL_TOTAL_LAMPORTS_OFFSET));
  const supply = Number(data.readBigUInt64LE(STAKE_POOL_TOKEN_SUPPLY_OFFSET));
  if (!(total > 0) || !(supply > 0)) throw new Error("stake pool has zero lamports/supply");
  const r = total / supply;
  if (!(r > 0.9 && r < 3)) throw new Error(`implausible stake pool rate ${r}`);
  return r;
}

/** Truthy env parse used for BOT_PAUSED and friends ("1", "true", "yes", "on", or any note text that is not falsy). */
export function parsePausedEnv(raw: string | undefined): boolean {
  if (raw == null) return false;
  const v = raw.trim();
  if (!v) return false;
  return !/^(0|false|no|off)$/i.test(v);
}

/** Fair pool price (Y per X, i.e. JitoSOL per JupSOL) from the two stake-pool SOL rates. */
export function fairPriceYPerX(solPerX: number, solPerY: number): number {
  return solPerX / solPerY;
}

export interface DepegCheck {
  deviationPct: number; // signed, pool vs fair, percent
  depegged: boolean;
}

/** Depeg / pool-dislocation guard: |pool/fair − 1| > maxPct (percent). */
export function checkDepeg(poolPriceYPerX: number, fairYPerX: number, maxPct: number): DepegCheck {
  if (!(poolPriceYPerX > 0) || !(fairYPerX > 0)) return { deviationPct: NaN, depegged: false };
  const deviationPct = (poolPriceYPerX / fairYPerX - 1) * 100;
  return { deviationPct, depegged: Math.abs(deviationPct) > maxPct };
}

/** Range for a tight position: active ± halfWidth bins. */
export function tightRange(activeBinId: number, halfWidth: number): { minBinId: number; maxBinId: number } {
  const h = Math.max(0, Math.floor(halfWidth));
  return { minBinId: activeBinId - h, maxBinId: activeBinId + h };
}

export interface RebalanceInput {
  activeBinId: number;
  minBinId: number;
  maxBinId: number;
  outOfRangeTicks: number; // consecutive ticks already seen out of range (before this tick)
  requiredTicks: number;
  nowSec: number;
  lastRebalanceSec: number;
  cooldownSec: number;
}
export interface RebalanceDecision {
  inRange: boolean;
  outOfRangeTicks: number;
  rebalance: boolean;
  reason: string;
}

/** Out of range for `requiredTicks` consecutive ticks AND cooldown elapsed → rebalance. */
export function decideRebalance(i: RebalanceInput): RebalanceDecision {
  const inRange = i.activeBinId >= i.minBinId && i.activeBinId <= i.maxBinId;
  if (inRange) return { inRange, outOfRangeTicks: 0, rebalance: false, reason: "in range" };
  const n = i.outOfRangeTicks + 1;
  if (n < i.requiredTicks) return { inRange, outOfRangeTicks: n, rebalance: false, reason: `out of range ${n}/${i.requiredTicks}` };
  const since = i.nowSec - i.lastRebalanceSec;
  if (i.lastRebalanceSec > 0 && since < i.cooldownSec)
    return { inRange, outOfRangeTicks: n, rebalance: false, reason: `cooldown ${i.cooldownSec - since}s left` };
  return { inRange, outOfRangeTicks: n, rebalance: true, reason: `out of range ${n} ticks` };
}

/**
 * Swap needed to bring X/Y holdings to a target X share (by SOL value). Returns the side to sell and the raw
 * amount of that token; null when the imbalance is below minSwapSol (not worth a swap's fee + slippage).
 */
export function rebalanceSwap(
  xRaw: number,
  yRaw: number,
  solPerX: number,
  solPerY: number,
  decimals: number,
  targetXShare: number,
  minSwapSol: number
): { sell: "X" | "Y"; amountRaw: number; solValue: number } | null {
  const scale = 10 ** decimals;
  const xSol = (xRaw / scale) * solPerX;
  const ySol = (yRaw / scale) * solPerY;
  const total = xSol + ySol;
  if (!(total > 0)) return null;
  const wantX = total * Math.min(1, Math.max(0, targetXShare));
  const diff = xSol - wantX; // >0: too much X
  if (Math.abs(diff) < minSwapSol) return null;
  if (diff > 0) return { sell: "X", amountRaw: Math.floor((diff / solPerX) * scale), solValue: diff };
  return { sell: "Y", amountRaw: Math.floor((-diff / solPerY) * scale), solValue: -diff };
}

/** USDC to put into the test at entry: never more than the configured cap, never more than the balance. */
export function usdcToDeploy(usdcBalanceRaw: number, maxUsdcRaw: number): number {
  if (!(maxUsdcRaw > 0)) return 0;
  return Math.max(0, Math.min(usdcBalanceRaw, maxUsdcRaw));
}

export interface EquityInput {
  usdc: number; // UI USDC in wallet
  xTokens: number; // UI X in wallet + position (incl. unclaimed fees)
  yTokens: number;
  solPerX: number;
  solPerY: number;
  nativeSol: number; // native SOL in wallet (incl. position rent already spent → see rentSol)
  rentSol: number; // SOL locked as position rent (refundable on close)
  gasBaselineSol: number; // native SOL excluded from the test baseline (measured at entry)
  solUsd: number;
}
export interface Equity {
  sol: number; // equity in SOL terms, gas baseline excluded
  usd: number;
}

/** Test equity excluding the gas baseline: tx fees therefore show up as a cost, refundable rent as neutral. */
export function testEquity(e: EquityInput): Equity {
  const lstSol = e.xTokens * e.solPerX + e.yTokens * e.solPerY;
  const gasDelta = e.nativeSol + e.rentSol - e.gasBaselineSol;
  const sol = lstSol + gasDelta + (e.solUsd > 0 ? e.usdc / e.solUsd : 0);
  return { sol, usd: sol * e.solUsd };
}

export function pnl(equity: Equity, baseline: Equity): { usd: number; sol: number; usdPct: number; solPct: number } {
  return {
    usd: equity.usd - baseline.usd,
    sol: equity.sol - baseline.sol,
    usdPct: baseline.usd > 0 ? ((equity.usd - baseline.usd) / baseline.usd) * 100 : 0,
    solPct: baseline.sol > 0 ? ((equity.sol - baseline.sol) / baseline.sol) * 100 : 0,
  };
}

/** Only ever manage one position: returns the one to adopt, and whether extra ones exist (alert, never open more). */
export function pickPosition<T extends { publicKey: { toBase58(): string } }>(
  positions: T[],
  pinned?: string
): { adopt: T | null; extras: T[] } {
  if (!positions.length) return { adopt: null, extras: [] };
  const pinnedOne = pinned ? positions.find((p) => p.publicKey.toBase58() === pinned) : undefined;
  const adopt = pinnedOne ?? positions[0];
  return { adopt, extras: positions.filter((p) => p !== adopt) };
}

export type DepegExitTarget = "SOL" | "USDC" | "HOLD";
export function parseDepegExit(raw: string | undefined): DepegExitTarget {
  const v = (raw || "").trim().toUpperCase();
  return v === "USDC" ? "USDC" : v === "HOLD" ? "HOLD" : "SOL";
}
