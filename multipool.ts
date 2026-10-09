/** Pool / position helpers (pure, unit-tested). */

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
