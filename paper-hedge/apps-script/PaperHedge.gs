/**
 * Paper Hedge tab for the keeper's Google Sheet.
 *
 * Do not replace the existing doPost. Paste this file into the same Apps
 * Script project, then add these lines at the TOP of the existing doPost(e),
 * before any ledger append:
 *
 *   if (routePaperHedge_(e)) {
 *     return ContentService.createTextOutput(JSON.stringify({ ok: true, sheet: "Paper Hedge" }))
 *       .setMimeType(ContentService.MimeType.JSON);
 *   }
 *
 * Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy.
 * The web app URL does not change. Leave GOOGLE_SHEET_WEBHOOK_URL as it is.
 *
 * Until this is deployed, paper-hedge rows would be appended to the keeper
 * tab (the old script ignores unknown fields and writes event_type). Keep
 * GOOGLE_SHEET_WEBHOOK_URL unset on the paper service until the new version
 * is live, or accept those rows on the main tab.
 */
var PAPER_HEDGE_TAB = "Paper Hedge";
var PAPER_HEDGE_HEADERS = [
  "timestamp",
  "SOL price",
  "LP SOL",
  "short size",
  "delta $",
  "trade size",
  "fee",
  "funding",
  "hedge P&L",
  "LP equity",
  "combined equity",
  "unhedged vs hedged cumulative P&L",
  "stale",
  "notes",
];

function routePaperHedge_(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return false;
    var body = JSON.parse(e.postData.contents);
    var event = String(body.event || body.event_type || "");
    if (body.sheet !== "Paper Hedge" && event !== "PAPER_HEDGE") return false;
    appendPaperHedgeRow_(body);
    return true;
  } catch (err) {
    return false;
  }
}

function appendPaperHedgeRow_(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(PAPER_HEDGE_TAB);
  if (!sh) sh = ss.insertSheet(PAPER_HEDGE_TAB);
  if (sh.getLastRow() === 0) sh.appendRow(PAPER_HEDGE_HEADERS);
  var vs = body.unhedged_vs_hedged;
  if (!vs && (body.unhedged_pnl_usd != null || body.hedged_pnl_usd != null)) {
    vs = "unhedged=" + body.unhedged_pnl_usd + " hedged=" + body.hedged_pnl_usd;
  }
  sh.appendRow([
    body.timestamp_pt || body.timestamp || body.timestamp_iso || "",
    num_(body.sol_price),
    num_(body.lp_sol),
    num_(body.short_size),
    num_(body.delta_usd),
    num_(body.trade_size),
    num_(body.fee != null ? body.fee : body.fee_usd),
    num_(body.funding != null ? body.funding : body.funding_usd),
    num_(body.hedge_pnl != null ? body.hedge_pnl : body.hedge_pnl_usd),
    num_(body.lp_equity != null ? body.lp_equity : body.lp_equity_usd),
    num_(body.combined_equity != null ? body.combined_equity : body.combined_equity_usd),
    vs || "",
    body.stale ? "TRUE" : "FALSE",
    body.notes || "",
  ]);
}

function num_(v) {
  if (v === "" || v == null) return "";
  var n = Number(v);
  return isFinite(n) ? n : "";
}
