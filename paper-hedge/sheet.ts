/**
 * Posts paper-hedge rows to the same Google Apps Script webhook the keeper uses.
 * The keeper's v2.1 script ignores unknown columns and would file these rows on
 * the main ledger tab. paper-hedge/apps-script/PaperHedge.gs routes event
 * PAPER_HEDGE to a "Paper Hedge" tab. Until that is deployed, leave the webhook
 * unset on this service.
 */
import { LedgerRow } from "./engine";
import { redact } from "./redact";

export function formatTimestampPt(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} PT`;
}

function roundOrBlank(n: number, dp: number): number | "" {
  if (!Number.isFinite(n)) return "";
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function signed(n: number): string {
  if (!Number.isFinite(n)) return "na";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

export function rowPayload(row: LedgerRow, instance: string, pool: string): Record<string, unknown> {
  const vs = `unhedged=${signed(row.unhedgedPnlUsd)} hedged=${signed(row.hedgedPnlUsd)}`;
  const now = new Date(row.nowMs);
  return {
    schema_version: 2,
    sheet: "Paper Hedge",
    event: "PAPER_HEDGE",
    event_type: "PAPER_HEDGE",
    paper_only: true,
    timestamp_iso: now.toISOString(),
    timestamp_pt: formatTimestampPt(now),
    timestamp: formatTimestampPt(now),
    pool_name: pool,
    instance,
    sol_price: roundOrBlank(row.solPrice, 6),
    lp_sol: roundOrBlank(row.lpSol, 6),
    short_size: roundOrBlank(row.shortSol, 4),
    delta_usd: roundOrBlank(row.deltaUsd, 4),
    trade_size: roundOrBlank(row.tradeSol, 4),
    fee: roundOrBlank(row.feeUsd, 6),
    fee_usd: roundOrBlank(row.feeUsd, 6),
    funding: roundOrBlank(row.fundingUsd, 6),
    funding_usd: roundOrBlank(row.fundingUsd, 6),
    hedge_pnl: roundOrBlank(row.hedgePnlUsd, 4),
    hedge_pnl_usd: roundOrBlank(row.hedgePnlUsd, 4),
    lp_equity: roundOrBlank(row.lpEquityUsd, 4),
    lp_equity_usd: roundOrBlank(row.lpEquityUsd, 4),
    combined_equity: roundOrBlank(row.combinedEquityUsd, 4),
    combined_equity_usd: roundOrBlank(row.combinedEquityUsd, 4),
    unhedged_pnl_usd: roundOrBlank(row.unhedgedPnlUsd, 4),
    hedged_pnl_usd: roundOrBlank(row.hedgedPnlUsd, 4),
    unhedged_vs_hedged: vs,
    stale: row.stale,
    notes: redact(row.notes),
  };
}

export function formatConsole(row: LedgerRow): string {
  const n = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "na");
  const warn = row.warnings.length ? ` WARN=${row.warnings.join(",")}` : "";
  return (
    `[PAPER] ${row.stale ? "STALE " : ""}${row.reason} sol=${n(row.solPrice, 4)} lpSol=${n(row.lpSol, 4)} ` +
    `short=${n(row.shortSol, 1)} delta=${n(row.deltaUsd)} trade=${n(row.tradeSol, 1)} fee=${n(row.feeUsd, 4)} ` +
    `fund=${n(row.fundingUsd, 4)} hedgePnl=${n(row.hedgePnlUsd)} lpEq=${n(row.lpEquityUsd)} ` +
    `comb=${n(row.combinedEquityUsd)} unhedged=${n(row.unhedgedPnlUsd)} hedged=${n(row.hedgedPnlUsd)}${warn}`
  );
}

export async function postLedger(url: string, payload: Record<string, unknown>): Promise<void> {
  if (!url) return;
  const once = () =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    }).then((res) => {
      if (!res.ok) throw new Error(`sheet HTTP ${res.status}`);
    });
  try {
    await once();
  } catch (err1: any) {
    try {
      await new Promise((r) => setTimeout(r, 750));
      await once();
    } catch (err2: any) {
      console.error("[PAPER] sheet post failed:", redact(err2?.message || err1?.message));
    }
  }
}
