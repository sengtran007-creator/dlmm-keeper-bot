// H0/H3 (swap gas gate + inventory sizing) and C1 (flat-with-SOL guard + redeploy retry) — pure helpers, no RPC.
//
// H0: the USDC→SOL rebalance swap was gated on native ≥ reserve + 0.005 SOL, but that swap is what ADDS SOL, so a
// wallet just below the gate (e.g. 0.122 after a take-profit) could never redeploy. Swaps that add SOL now only need
// fee headroom, and the deploy/top-up sizing buys the holdback shortfall out of USDC.
// C1: when the bot is flat while still holding SOL (redeploy after a recenter failed, restart between close and
// redeploy, or a failed stop liquidation) the price/equity stops kept evaluating nothing. The guard keeps a stop on
// that SOL and the redeploy is retried with a bounded backoff instead of a flat 600 s cooldown + Gate 3.

export interface SwapGateInput {
  /** True when the swap spends SOL (SOL→USDC); false when it buys SOL with USDC. */
  inIsSol: boolean;
  nativeLamports: number;
  /** SOL being sold (lamports) — only used when inIsSol. */
  inLamports?: number;
  reserveLamports: number;
  /** Extra headroom kept on SOL-spending swaps (old gate: 0.005 SOL). */
  bufferLamports: number;
  /** Minimum native SOL any tx needs (fees + temporary WSOL ATA rent). */
  feeFloorLamports: number;
}

/** Gas gate for a Jupiter swap. Buying SOL needs only the fee floor; selling SOL must leave reserve + buffer. */
export function swapGasGate(i: SwapGateInput): { ok: boolean; reason: string } {
  const native = Math.floor(i.nativeLamports);
  if (native < i.feeFloorLamports) {
    return { ok: false, reason: `native ${(native / 1e9).toFixed(4)} SOL below fee floor ${(i.feeFloorLamports / 1e9).toFixed(4)}` };
  }
  if (!i.inIsSol) return { ok: true, reason: "SOL-buying swap: fee floor only" };
  const after = native - Math.max(0, Math.floor(i.inLamports ?? 0));
  const need = i.reserveLamports + i.bufferLamports;
  if (i.inLamports != null ? after < i.reserveLamports : native < need) {
    return {
      ok: false,
      reason:
        i.inLamports != null
          ? `selling ${(i.inLamports / 1e9).toFixed(4)} SOL would leave ${(after / 1e9).toFixed(4)} < reserve ${(i.reserveLamports / 1e9).toFixed(4)}`
          : `native ${(native / 1e9).toFixed(4)} SOL below reserve+buffer ${(need / 1e9).toFixed(4)}`,
    };
  }
  return { ok: true, reason: "SOL-selling swap leaves the reserve" };
}

export interface InventoryInput {
  nativeLamports: number;
  usdcRaw: number;
  /** Native SOL that must remain outside the position after the open/top-up. */
  holdbackLamports: number;
  spotUsd: number;
  /** Fraction of deployable capital that goes to the ask (SOL) side. */
  askRatio: number;
  /** Fraction of working capital to deploy (DEPLOY_PCT; 1 = all). */
  deployPct: number;
  minSwapUsd: number;
  /** Slippage allowance applied to the holdback shortfall purchase, bps. */
  slippageBps: number;
}

export interface InventoryPlan {
  ok: boolean;
  reason?: string;
  /** Working capital after the holdback is funded (USD). */
  workingUsd: number;
  targetAskUsd: number;
  targetBidUsd: number;
  /** Native SOL short of the holdback before any swap (lamports). */
  deficitLamports: number;
  /** SOL→USDC sale (lamports), 0 if none. */
  sellSolLamports: number;
  /** USDC→SOL purchase (USDC raw), 0 if none. Includes the holdback shortfall. */
  buyUsdcRaw: number;
}

/**
 * Inventory rebalance for a deploy or top-up. The holdback (reserve + open cost + fee buffer) is funded first —
 * from USDC when native SOL is short — and only the rest is split ask/bid.
 */
export function planInventory(i: InventoryInput): InventoryPlan {
  const spot = i.spotUsd;
  const empty: InventoryPlan = { ok: false, workingUsd: 0, targetAskUsd: 0, targetBidUsd: 0, deficitLamports: 0, sellSolLamports: 0, buyUsdcRaw: 0 };
  if (!(spot > 0) || !Number.isFinite(spot)) return { ...empty, reason: `invalid spot ${spot}` };
  const usdcUsd = Math.max(0, i.usdcRaw) / 1e6;
  const deficitLamports = Math.max(0, Math.ceil(i.holdbackLamports - i.nativeLamports));
  const solFreeLamports = Math.max(0, Math.floor(i.nativeLamports - i.holdbackLamports));
  const solFreeUsd = (solFreeLamports / 1e9) * spot;
  const deficitUsd = (deficitLamports / 1e9) * spot * (1 + Math.max(0, i.slippageBps) / 10_000);
  const workingUsd = usdcUsd + solFreeUsd - deficitUsd;
  if (!(workingUsd > 0)) {
    return { ...empty, deficitLamports, reason: `not enough capital to fund the SOL holdback (short ${(deficitLamports / 1e9).toFixed(4)} SOL, $${usdcUsd.toFixed(2)} USDC)` };
  }
  const pct = Math.min(1, Math.max(0, i.deployPct));
  const target = workingUsd * pct;
  const ask = Math.min(1, Math.max(0, i.askRatio));
  const targetAskUsd = target * ask;
  const targetBidUsd = target * (1 - ask);
  const surplusUsd = solFreeUsd - targetAskUsd; // > 0: too much SOL
  let sellSolLamports = 0;
  let buyUsdcRaw = 0;
  if (deficitLamports === 0 && surplusUsd > i.minSwapUsd) {
    sellSolLamports = Math.floor((surplusUsd / spot) * 1e9);
  } else {
    // Buy the ask shortfall plus the holdback shortfall. The holdback part is bought even when it is below
    // MIN_SWAP_USD: without it the open is refused or the ask leg comes up short.
    const askShortUsd = Math.max(0, -surplusUsd);
    const needUsd = (askShortUsd > i.minSwapUsd ? askShortUsd : 0) + deficitUsd;
    if (needUsd > 0) buyUsdcRaw = Math.floor(Math.min(usdcUsd, needUsd + (deficitLamports > 0 ? 0.01 : 0)) * 1e6);
  }
  return { ok: true, workingUsd, targetAskUsd, targetBidUsd, deficitLamports, sellSolLamports, buyUsdcRaw };
}

/** Bounded exponential backoff for a pending redeploy: base, 2×base, … capped at maxSec. */
export function redeployDelaySec(attempt: number, baseSec = 60, maxSec = 600): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(maxSec, baseSec * 2 ** (n - 1));
}

export interface FlatGuardState {
  /** Price stop on the SOL held while flat (USD). Infinity = liquidate now (e.g. a stop's swap failed). */
  stopPrice: number;
  /** Equity stop on wallet equity (USD), 0 = none. */
  equityStop: number;
  source: string;
}

/** SOL (incl. WSOL) above the reserve, valued at spot. */
export function flatSolExposureUsd(nativeLamports: number, wsolRaw: number, reserveLamports: number, spotUsd: number): number {
  return (Math.max(0, nativeLamports + wsolRaw - reserveLamports) / 1e9) * Math.max(0, spotUsd);
}

/** Has the flat guard's stop been hit? */
export function flatGuardHit(g: FlatGuardState, spotUsd: number, walletEquityUsd: number | null): { hit: boolean; reason: string } {
  if (!Number.isFinite(g.stopPrice)) return { hit: true, reason: `liquidation pending (${g.source})` };
  if (g.stopPrice > 0 && spotUsd <= g.stopPrice) return { hit: true, reason: `spot $${spotUsd.toFixed(2)} ≤ flat stop $${g.stopPrice.toFixed(2)} (${g.source})` };
  if (g.equityStop > 0 && walletEquityUsd != null && walletEquityUsd <= g.equityStop) {
    return { hit: true, reason: `wallet equity $${walletEquityUsd.toFixed(2)} ≤ $${g.equityStop.toFixed(2)} (${g.source})` };
  }
  return { hit: false, reason: "" };
}

/** SOL to sell when the flat guard fires: everything above reserve + margin (WSOL is unwrapped by Jupiter). */
export function flatSolDumpLamports(nativeLamports: number, wsolRaw: number, reserveLamports: number, marginLamports: number): number {
  return Math.max(0, Math.floor(nativeLamports + wsolRaw - reserveLamports - marginLamports));
}

export interface BootFlatInput {
  spotUsd: number;
  walletEquityUsd: number | null;
  pinSpotUsd: number | null;
  pinEquityUsd: number | null;
  /** ENTRY_STOP_PCT (fraction) if set and valid. */
  pinStopPct: number | null;
  defaultStopPct: number;
  maxDrawdownPct: number;
  /** A pin further than this from the current spot is treated as stale (fraction, default 0.10). */
  maxPinDistance?: number;
}

/**
 * Stop for SOL held while flat at boot (the process restarted between a close and the redeploy).
 * ENTRY_SPOT_USD (+ ENTRY_STOP_PCT / ENTRY_EQUITY_USD) are used when the pin spot is within 10% of the current
 * spot (the pin then belongs to the position that was just closed); otherwise a spot-based default stop.
 */
export function resolveBootFlatGuard(i: BootFlatInput): { guard: FlatGuardState; entrySpotUsd: number; entryEquityUsd: number; stopPct: number; how: string } {
  const maxDist = i.maxPinDistance ?? 0.1;
  const stopPct = i.pinStopPct != null && i.pinStopPct > 0 && i.pinStopPct < 0.5 ? i.pinStopPct : i.defaultStopPct;
  const pinOk = i.pinSpotUsd != null && i.pinSpotUsd > 0 && Math.abs(i.pinSpotUsd / i.spotUsd - 1) <= maxDist;
  if (pinOk) {
    const entryEquityUsd = i.pinEquityUsd != null && i.pinEquityUsd > 0 ? i.pinEquityUsd : i.walletEquityUsd ?? 0;
    return {
      guard: { stopPrice: i.pinSpotUsd! * (1 - stopPct), equityStop: entryEquityUsd > 0 ? entryEquityUsd * (1 - i.maxDrawdownPct) : 0, source: "boot: ENTRY_* pins" },
      entrySpotUsd: i.pinSpotUsd!,
      entryEquityUsd,
      stopPct,
      how: `ENTRY_SPOT_USD $${i.pinSpotUsd!.toFixed(2)} (within ${(maxDist * 100).toFixed(0)}% of spot) × (1 − ${(stopPct * 100).toFixed(1)}%)` +
        (i.pinEquityUsd ? `, equity pin $${i.pinEquityUsd.toFixed(2)}` : ", equity = wallet at boot"),
    };
  }
  const entryEquityUsd = i.walletEquityUsd ?? 0;
  return {
    guard: { stopPrice: i.spotUsd * (1 - stopPct), equityStop: entryEquityUsd > 0 ? entryEquityUsd * (1 - i.maxDrawdownPct) : 0, source: "boot: spot-based default" },
    entrySpotUsd: i.spotUsd,
    entryEquityUsd,
    stopPct,
    how:
      (i.pinSpotUsd ? `ENTRY_SPOT_USD $${i.pinSpotUsd.toFixed(2)} ignored (>${(maxDist * 100).toFixed(0)}% from spot — stale); ` : "no ENTRY_SPOT_USD; ") +
      `boot spot $${i.spotUsd.toFixed(2)} × (1 − ${(stopPct * 100).toFixed(1)}%)`,
  };
}
