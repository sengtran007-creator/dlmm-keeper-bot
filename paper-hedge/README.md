# Paper delta hedger

A **separate process** from the Meteora keeper. It watches the 10 bps bot wallet, computes the SOL that should be short, and simulates that short on Kalshi's SOL perpetual (`KXSOLPERP`). It never signs, never sends an order, and never reads a private key. If `BOT_PRIVATE_KEY` or any Kalshi API key is set in the environment, the process exits.

The live keeper stays `npm run build && npm start` (`dist/index.js`). Do not point the **DALMM Bot** Railway service at this start command.

## What it hedges

Every `PAPER_HEDGE_POLL_SEC` (30s) it reads, with a public RPC:

- SOL inside every open DLMM position of `PAPER_HEDGE_WALLET` (token X + unclaimed fee SOL)
- idle wallet SOL (native + WSOL) above `GAS_RESERVE_LAMPORTS`

Position-account rent is not hedged (same operational SOL as the gas reserve). The target short is that SOL times `PAPER_HEDGE_RATIO` (default `1`, a full hedge; `0.5` hedges half), rounded to the contract size (0.1 SOL on KXSOLPERP). Positions are discovered each poll; nothing is hardcoded.

The hedge band is evaluated at most once per `PAPER_HEDGE_CHECK_SEC` (default 3600, one hour). It rebalances only when the absolute gap between the current short and the target exceeds `PAPER_HEDGE_BAND_PCT` of the target (default `0.10`). A smaller drift, including the ~0.05 SOL inventory bucket inside the same position accounts, does not trade. When an hourly check falls inside the band, the process logs `hedge check skipped: drift inside band` and leaves the short in place. Sheet rows keep the same columns and the same cadence (`PAPER_HEDGE_LOG_SEC`, plus every trade and every funding accrual).

A change in the set of open position accounts does not wait for the hour and trades to the new target even inside the band. That covers a stop-out, circuit breaker, close, take-profit, or a fresh deploy/recenter (the keeper closes one position account and opens another), so a flat LP is not left short for up to an hour. SOL that merely moves inside the same accounts, including a top-up smaller than the band, waits for the hourly check. The first fresh read still opens the short. `PAPER_HEDGE_POSITION_BUCKET_SOL` only buckets the stored fingerprint; it is not a trade trigger.

Fills use the public Kalshi book as a taker: sell at the best bid to increase the short, buy at the best ask to cover. The touch is assumed to fill the whole trade (a `thin_book` warning is logged when displayed size is smaller). Mark-to-market uses the published settlement mark. Funding accrues from the public historical 8h prints (05:00 / 13:00 / 21:00 UTC, which is midnight / 08:00 / 16:00 US Eastern). A positive rate is treated as shorts receiving (perp rich to the index). If a scheduled print is missing after `PAPER_HEDGE_FUNDING_GRACE_SEC` on a successful fetch, the fallback rate is accrued once and the row is flagged `funding_fallback`. It is not revised if the real print shows up later.

Paper margin posts `PAPER_HEDGE_MARGIN_FRACTION` (25%) of `PAPER_HEDGE_CAPITAL_USD` as collateral. That cash is **not** removed from LP equity; it is only the denominator for leverage. Maintenance uses Kalshi's published short-leverage estimate (`notional / leverage`) when the market payload includes it, otherwise `PAPER_HEDGE_MAINT_LEVERAGE` (3.1). Liquidation is warned when `maintenance / margin equity` reaches the published liquidation ratio (default 1). The queue warning uses the published queue ratio (default 0.91). `below_initial_margin` means the posted collateral would not meet initial margin (maintenance × the published multiplier, default 1.3).

Any chain, book, or funding fetch older than `PAPER_HEDGE_STALE_SEC` (60s) marks the sample stale. Stale samples do not trade. Rows still go out at most every `PAPER_HEDGE_LOG_SEC` (5 min), plus every trade and every funding accrual.

## Railway

Create a **new** service in the same project. Leave **DALMM Bot** on `main` / `npm run build && npm start`.

- Repo: this repo, branch `main` (after this change is merged)
- Start command: `npm run build:paper-hedge && npm run start:paper-hedge`
- One replica. No public port.
- Volume mounted at `/data` so a restart does not open a second paper short. Without it the disk is wiped and the next boot flattens the book to zero and sells the short again (fees, and a new P&L segment on the sheet).

### Env

Set:

| Variable | Required | Default |
| --- | --- | --- |
| `PAPER_HEDGE_ENABLED` | yes, `true` | off (process idles) |
| `SOLANA_RPC_URL` | yes | none |
| `GOOGLE_SHEET_WEBHOOK_URL` | after the Apps Script below is deployed | stdout only |
| `PAPER_HEDGE_STATE_PATH` | recommended | `paper-hedge-state.json` |
| `PAPER_HEDGE_WALLET` | no | `2YtsAfr19EhNaGrB6W8YqtuJeaaRoY7xq83GFxdnYq6t` |
| `PAPER_HEDGE_POOL` | no | 10 bps pool `BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y` |
| `PAPER_HEDGE_CAPITAL_USD` | no | `650` (P&L baseline) |
| `GAS_RESERVE_LAMPORTS` | no | `120000000` (0.12 SOL, same as the keeper) |

Do **not** set `BOT_PRIVATE_KEY`, `PRIVATE_KEY`, or any `KALSHI_*` key. The process exits if those are non-empty.

Optional tunables (defaults in parentheses): `PAPER_HEDGE_POLL_SEC` (30), `PAPER_HEDGE_STALE_SEC` (60), `PAPER_HEDGE_LOG_SEC` (300), `PAPER_HEDGE_CHECK_SEC` (3600), `PAPER_HEDGE_BAND_PCT` (0.10, fraction of the target short), `PAPER_HEDGE_RATIO` (1), `PAPER_HEDGE_CONTRACT_SOL` (0.1, used only if the market payload omits `contract_size`), `PAPER_HEDGE_TAKER_FEE_RATE` (0.0004), `PAPER_HEDGE_MAKER_FEE_RATE` (0.0002, logged, not charged), `PAPER_HEDGE_FUNDING_FALLBACK_RATE` (0 per 8h), `PAPER_HEDGE_FUNDING_SIGN` (+1), `PAPER_HEDGE_FUNDING_GRACE_SEC` (120), `PAPER_HEDGE_MARGIN_FRACTION` (0.25), `PAPER_HEDGE_MAINT_LEVERAGE` (3.1), `PAPER_HEDGE_INITIAL_MARGIN_MULTIPLIER` (1.3), `PAPER_HEDGE_LIQUIDATION_RATIO` (1), `PAPER_HEDGE_QUEUE_RATIO` (0.91), `PAPER_HEDGE_POSITION_BUCKET_SOL` (0.05, fingerprint only), `PAPER_HEDGE_TICKER` (`KXSOLPERP`), `PAPER_HEDGE_KALSHI_BASE`, `PAPER_HEDGE_INSTANCE` (`paper-hedge`).

`PAPER_HEDGE_STATE_PATH=/data/paper-hedge-state.json` when the volume is mounted.

## Google Sheet

The webhook is the keeper's existing `GOOGLE_SHEET_WEBHOOK_URL`. Rows are JSON with `event: "PAPER_HEDGE"` and `sheet: "Paper Hedge"`.

1. Open the Apps Script bound to the keeper sheet.
2. Add the file `paper-hedge/apps-script/PaperHedge.gs` (File > New > Script, paste the contents).
3. At the **top** of the existing `doPost(e)`, before it appends a ledger row, add:

```javascript
if (routePaperHedge_(e)) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, sheet: "Paper Hedge" }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

4. Deploy > Manage deployments > Edit > Version: **New version** > Deploy. The URL stays the same.
5. Then set `GOOGLE_SHEET_WEBHOOK_URL` on the paper service.

The new tab is created on the first row. Columns: timestamp (PT), SOL price (DLMM spot), LP SOL, short size, delta $, trade size (positive = sold / increased the short), fee (this fill), funding (this accrual), hedge P&L (cumulative, mark to Kalshi), LP equity, combined equity (LP + hedge P&L), unhedged vs hedged cumulative P&L versus `PAPER_HEDGE_CAPITAL_USD`, stale, notes.

## Replay

```bash
npm run replay:paper-hedge -- paper-hedge/fixtures/sol-drop.jsonl
```

`sol-drop.jsonl` holds 5 SOL from $100 to $80. Unhedged P&L is about −$100; the paper short gives that back minus the taker fee. No network.

## Tests

`npm test` includes `tests/paperhedge.test.ts` (delta, rounding, triggers, funding, P&L, margin warnings, replay).
