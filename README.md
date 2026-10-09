# dlmm-keeper-bot

Automated **Meteora DLMM** liquidity keeper for the public Solana **SOL/USDC** (~10 bps) pool. It deploys an asymmetric Spot grid, harvests fees to a revenue wallet, monitors a floor stop / take-profit, and can be steered over Telegram.

This software trades real capital. You can lose money. There is **no warranty**. Review the strategy, risk controls, and custody model before running it.

## Features

- Regime-aware bin width (bull / range / bear heuristics)
- Fee claim + sweep to `REVENUE_WALLET_PUBKEY`
- Circuit-breaker stop and upper-bound recycle
- Optional Telegram commands (`/status`, `/pause`, `/resume`, `/harvest`, `/emergency_exit`, …)
- Optional Google Sheet webhook logging

## Requirements

- Node.js 20+
- A funded Solana wallet (USDC + SOL for gas)
- RPC URL, and the env vars in `.env.example`

## Setup

```bash
cp .env.example .env
# edit .env with real secrets — never commit .env
npm install
npm run build
npm start
```

## Environment

See `.env.example` for every variable the bot reads. **Required at minimum:** `BOT_PRIVATE_KEY`, `REVENUE_WALLET_PUBKEY`, plus a usable RPC (`SOLANA_RPC_URL` or `RPC_URL`).

### P&L baseline

The bot reports P&L against **capital contributed**, not against internal moves:

```
Net PnL = live equity (position + wallet) + swept to revenue − (STARTING_CAPITAL_USD + NET_DEPOSITS_USD)
```

| Variable | Meaning |
| --- | --- |
| `STARTING_CAPITAL_USD` | Authoritative starting capital in USD. If unset, the baseline falls back to mark-to-market equity at boot (P&L is then "since boot"). `BASELINE_USD` is a deprecated alias. |
| `NET_DEPOSITS_USD` | Optional. External deposits − withdrawals after the start (may be negative). Fee sweeps are **not** withdrawals. |
| `PRIOR_SWEPT_USD` | Fallback only. The bot derives cumulative swept on-chain at boot (all LP-wallet → revenue-ATA USDC transfers) and adds in-process sweeps; this env is used only if the scan fails or is incomplete. Only used with `STARTING_CAPITAL_USD`. |

- Top-ups, deploys, recenters, swaps, wrap/unwrap, closes, take-profit, circuit breaker and emergency exit never change the baseline; it is set once per boot, so restarts cannot double it.
- Fee sweeps to the revenue wallet are added back, so they never show as a loss.
- The baseline is **reporting only**. Stops use the entry state: price stop = `entry spot × (1 − locked stop %)`, equity stop = `entry equity × (1 − MAX_DRAWDOWN_PCT)`.

### Fee-sweep schedule

Fees are claimed and swept to `REVENUE_WALLET_PUBKEY` every `SWEEP_INTERVAL_SEC` (24h). The clock survives restarts: at boot the bot scans the revenue wallet's USDC ATA and uses the block time of the latest transfer whose source is the LP wallet's USDC ATA, signed by the LP wallet (address-poisoning dust from lookalike wallets and transfers from anyone else are ignored). If the scan fails it falls back to `LAST_SWEEP_UNIX`, else boot time, and retries the scan in the background every 15 min (up to 8 times). The clock advances only when a sweep actually moves USDC (scheduled, `/harvest`, or a stop/TP/recenter/emergency pre-close sweep); a due sweep that moves nothing is retried after `SWEEP_RETRY_SEC` (1h). The next sweep time (PT) is shown at boot/attach and in `/status`.

### Market regime (bin shape for new deploys)

The regime only shapes **new** deploys (bid/ask bins) and the stop % a new position starts with. Logic is in `regime.ts` (unit-tested: `npm test`).

- **Score** = 50 + trend (±25) + funding (±25) + direction (±20).
  - Trend: `25 × clamp((price / 200-day mean − 1) / 10%, −1, 1)` (CoinGecko daily, 200 days).
  - Funding: Hyperliquid SOL, 24h average of **settled hourly** rates (`fundingHistory`), annualized `hourly × 24 × 365 × 100`. Fallback: HL predicted rate (venue `HlPerp`) normalized by its `fundingIntervalHours`. |APR| < 3% → 0 (deadband); 3→8% → 0→+25; 8–40% → +25 (HL's neutral baseline is 10.95%); > 40% → 0 (overheated); −3→−10% → 0→−25; unknown → 0.
  - Direction (short-term): Hyperliquid 1h candles (`candleSnapshot`, 72h). Composite = 0.25 × (price vs 1h EMA20, full at ±1.5%) + 0.25 × (4h change, full at ±1.5%) + 0.5 × (24h change, full at ±4%), each clamped to ±1 (full scales ≈ 95th percentile of the last 14 days; the 24h change is weighted most so a 4h bounce inside a down day doesn't read as rising). |composite| < 0.25 → 0 (flat), then linear to ±20. Unknown → 0.
  - `BULL_EXPANSION`: score ≥ 85 **and** direction ≥ 0 (never BULL while price is falling short-term). `BEAR_DEFENSIVE`: score < 40 **and** trend + funding < 0 (direction alone can't make BEAR). Else `RANGE_CHOP`.
  - Schmitt band: an existing BULL is kept while score ≥ 75 and direction ≥ −8; an existing BEAR while score < 48 (trend + funding < 0).
- **Hysteresis**: a new regime needs 2 consecutive complete reads ≥ 30 min apart (the bot re-checks after 30 min while a switch is pending) — or, except for BULL, a score ≥ 10 points inside the new band — **and** ≥ 2h in the current regime. BEAR is immediate only when the long-side score (50 + trend + funding, direction excluded) is < 30. A read with unknown funding or direction can't trigger a switch.
- **Boot**: nothing is persisted; the bot starts in `RANGE_CHOP` and leaves it only after 2 consecutive confirming reads (~30 min).
- **Failures**: keeps the current regime while the last good read is < 6h old, else `RANGE_CHOP`; never defaults to BULL. Failed reads back off 5 min (no per-tick API calls); good reads are cached 1h.
- A `[REGIME]` log line (score, price, SMA, funding raw/interval/APR/source, direction inputs, result, hysteresis) is written whenever the result changes, and at least hourly. `/regime` shows the same; SNAPSHOT ledger notes include the regime and score.

### Price stop is locked per position

When a position is deployed, its price-stop % and post-stop cooldown are taken from the regime **at that moment** and locked for the life of the position (kept across below-range recenters, like the entry spot). Later regime changes never move the stop. On a boot-attach the lock is `ENTRY_STOP_PCT` if pinned (see below), otherwise **RANGE_CHOP's 5%** — deliberately not the live regime, so a restart can't move the stop. Idle top-ups use the locked regime's bid/ask split (the shape the position was opened with), so a regime flip doesn't trigger rebalancing swaps. `/status`, deploy and attach messages show the locked % and its source. The equity stop (`MAX_DRAWDOWN_PCT`) is unchanged.

### Entry pin across restarts

On restart the bot re-anchors entry (and therefore both stops) to the live spot/equity unless pinned. To keep the original entry, set `ENTRY_POSITION_PUBKEY`, `ENTRY_SPOT_USD`, `ENTRY_EQUITY_USD` and `ENTRY_STOP_PCT` (fraction, e.g. `0.05`; must be 0.005–0.25). The pin is applied only when attaching at boot and only if the attached position equals `ENTRY_POSITION_PUBKEY`; otherwise it is ignored with a warning (so it can never be re-applied to a later position after a take-profit / recenter / new deploy). After every deploy/attach the bot logs the exact values to copy (`[ENTRY] To keep this entry across restarts set: ...`).

### Read guard (stop safety)

- Equity for the equity stop comes from a probe that fails closed: RPC error/timeout, the open position missing from the result, missing/non-finite amounts (partial read) or an invalid spot → that tick's equity stop is **skipped**, never evaluated on wallet-only equity.
- Spot that is zero/NaN, or jumps more than `SPOT_JUMP_MAX_PCT` in one tick, skips the whole tick (price stop, take-profit, below-range recenter, top-up, re-entry) until it is confirmed by `SUSPECT_CONFIRM_TICKS` consecutive reads.
- An open position read as $0 is always rejected; a one-tick position-value drop over `POS_DROP_MAX_PCT` while spot moved less than `POS_DROP_SPOT_MOVE_PCT` is rejected until confirmed by `SUSPECT_CONFIRM_TICKS` consecutive reads.
- Failed reads are logged every tick and written to the ledger as `ERROR` at most once per `READ_ERROR_LEDGER_SEC`. A watchdog sends a Telegram **STOPS BLIND** alert if a stop has had no trustworthy read for `STOP_BLIND_ALERT_SEC` (default 5 min), and **STOPS RESTORED** when reads recover.
- `/status` never clears the tracked position or rewrites the range from a bad/empty read.
- Error text sent to Telegram / the sheet is scrubbed of URLs and keys (RPC errors can embed the RPC URL).
- Ledger `realized_pnl_usd` (TAKE_PROFIT / CIRCUIT_BREAKER / EMERGENCY_EXIT) is per position cycle: exit equity + fees swept since entry − entry equity. `unrealized_pnl_usd` (SNAPSHOT) adds back fees swept since entry. Rows also carry `capital_baseline_usd`, `cumulative_swept_usd` and `total_pnl_usd` (ignored by the v2.1 Apps Script, which only writes its fixed columns).

## Deploy on Railway

1. Create a service from this repo (worker / no public HTTP needed).
2. Set the same env vars as in `.env.example` in the Railway Variables UI.
3. Start command should match the `Procfile`: `npm run build && npm start` (or rely on the Procfile worker process).
4. Use a single replica — multiple instances will fight over Telegram `getUpdates` (HTTP 409).

## Security

- Never put private keys, Telegram tokens, or webhook URLs in git.
- Prefer rotating any secret that ever appeared in git history before making a repo public.
- Restrict Telegram to your `TELEGRAM_CHAT_ID`.

## License / disclaimer

Provided as-is for educational and operational use. Automated market making involves impermanent loss, smart-contract risk, RPC/API failures, and liquidation-style stops that can realize losses. You are solely responsible for funds and compliance.
