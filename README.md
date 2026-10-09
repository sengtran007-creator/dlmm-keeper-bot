# dlmm-keeper-bot

Automated **Meteora DLMM** liquidity keeper for a public Solana **SOL/USDC** pool (default: the 10 bps pool; any SOL-USDC DLMM pool via `POOL_ADDRESS`). It deploys an asymmetric Spot grid, harvests fees to a revenue wallet, monitors a floor stop / take-profit, and can be steered over Telegram.

This software trades real capital. You can lose money. There is **no warranty**. Review the strategy, risk controls, and custody model before running it.

## Features

- Regime-aware bin width (bull / range / bear heuristics)
- Fee claim + sweep to `REVENUE_WALLET_PUBKEY`
- Circuit-breaker stop and upper-bound recycle
- Optional Telegram commands (`/status`, `/pause`, `/resume`, `/harvest`, `/emergency_exit`, `/withdraw_pct N`, …)
  - `/withdraw_pct N` pauses the bot and withdraws N% (1–90) of the open position's liquidity into the LP wallet (position stays open) so it can be transferred out. While paused no stops run. `/resume` re-bases entry equity to live equity (so the equity stop doesn't fire on the transfer out); before the next restart set `NET_DEPOSITS_USD` for the amount moved out and update/remove `ENTRY_EQUITY_USD`.
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

### Pool, range and instances

- `POOL_ADDRESS` picks the pool (default `BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y`, 10 bps). The bin step is read from the pool at boot (`lbPair.binStep`) and used for every price/range calculation; the bot refuses to start on a pool that isn't SOL(X)/USDC(Y).
- Range for new positions: `BID_BINS`/`ASK_BINS` (this pool's bins) → `RANGE_WIDTH_PCT` (±%) → the regime profile. Regime profiles are in 10 bps bins and are converted to the same price width on other bin steps, then clamped to Meteora's 70-bin position limit (RANGE 30/30 on 10 bps ≈ ±3%; on the 4 bps pool that becomes 34/35 ≈ −1.37%/+1.41%).
- Gate 2 (re-entry after a stop): unless `GATE2_MAX_VARIABLE_FEE_BPS` is set, the limit is 15 bps on the 10 bps pool and is scaled by the pool's `variableFeeControl` elsewhere, so it means the same volatility on any bin step (45 bps on the 4 bps pool).
- Running two instances (e.g. one per pool): give each its **own wallet** (`BOT_PRIVATE_KEY`), its own `STARTING_CAPITAL_USD` / `NET_DEPOSITS_USD`, and never copy `ENTRY_*` / `PRIOR_SWEPT_USD` / `LAST_SWEEP_UNIX` between them. `INSTANCE_LABEL` prefixes Telegram messages and fills the ledger `instance` field. Two processes must not poll the same Telegram token: either give the second one its own `TELEGRAM_BOT_TOKEN`, or set `TELEGRAM_COMMANDS_ENABLED=false` there (notifications only). Both may sweep to the same `REVENUE_WALLET_PUBKEY`: each instance's sweep clock and swept total only count transfers signed by its own LP wallet from its own USDC account.
- Closing a position (recenter, take-profit, stops, emergency exit) withdraws 100% of its liquidity, claims fees and closes it in one SDK call (`removeLiquidity … shouldClaimAndClose`), then re-reads the chain. If a position is still open the bot keeps tracking it and does not deploy a new one on top of it.

### P&L baseline

The bot reports P&L against **capital contributed**, not against internal moves:

```
Net PnL = live equity (position + wallet) + swept to revenue − (STARTING_CAPITAL_USD + NET_DEPOSITS_USD)
```

| Variable | Meaning |
| --- | --- |
| `STARTING_CAPITAL_USD` | Authoritative starting capital in USD. If unset, the baseline falls back to mark-to-market equity at boot (P&L is then "since boot"). `BASELINE_USD` is a deprecated alias. |
| `NET_DEPOSITS_USD` | Optional. External deposits − withdrawals after the start (may be negative). Fee sweeps are **not** withdrawals. |
| `PRIOR_SWEPT_USD` | Fallback only. The bot derives cumulative swept on-chain at boot (all LP-wallet → revenue USDC transfers + native SOL transfers at their memo USD value) and adds in-process sweeps; this env is used only if the scan fails or is incomplete. Only used with `STARTING_CAPITAL_USD`. |

- Top-ups, deploys, recenters, swaps, wrap/unwrap, closes, take-profit, circuit breaker and emergency exit never change the baseline; it is set once per boot, so restarts cannot double it.
- Fee sweeps to the revenue wallet are added back, so they never show as a loss.
- The baseline is **reporting only**. Stops use the entry state: price stop = `entry spot × (1 − locked stop %)`, equity stop = `entry equity × (1 − MAX_DRAWDOWN_PCT)`.

### Fee-sweep schedule

Fees are claimed and swept to `REVENUE_WALLET_PUBKEY` every `SWEEP_INTERVAL_SEC` (24h). The clock survives restarts: at boot the bot scans the revenue wallet's USDC ATA and uses the block time of the latest transfer whose source is the LP wallet's USDC ATA, signed by the LP wallet (address-poisoning dust from lookalike wallets and transfers from anyone else are ignored). If the scan fails it falls back to `LAST_SWEEP_UNIX`, else boot time, and retries the scan in the background every 15 min (up to 8 times). The clock advances only when a sweep actually moves USDC (scheduled, `/harvest`, or a stop/TP/recenter/emergency pre-close sweep); a due sweep that moves nothing is retried after `SWEEP_RETRY_SEC` (1h). The next sweep time (PT) is shown at boot/attach and in `/status`.

### Fee SOL handling and ledger rows

- **FEE_CLAIM** rows record both halves once: `fees_claimed_usd = USDC + SOL × pool spot at claim`; notes carry
  `fees_sol=… fees_usdc=… spot=… sol_usd=…`. (The old `feeX(SOL)=` note token is no longer written — the
  Executive PnL "Fees earned" formula adds that token × spot for old rows, so writing it again would double-count.)
- **FEE_SWEEP** rows carry `swept_to_revenue_usd` only (no `fees_claimed_usd`) — fees are counted once, on FEE_CLAIM.
- Claimed fee SOL is swapped to USDC via Jupiter (`FEE_SOL_SWAP_ATTEMPTS`, default 2). A retry happens only after the
  previous signature is proven not to have landed (blockhash expired / failed); an "unknown" outcome stops (no retry,
  no transfer). If the swap fails or is skipped (gas gate, < `FEE_SOL_SWAP_MIN_LAMPORTS`), the claimed SOL is sent
  **natively** to `REVENUE_WALLET_PUBKEY` (from config only — never from tx history), never taking the LP wallet below
  `GAS_RESERVE_LAMPORTS + FEE_SOL_SWEEP_MARGIN_LAMPORTS` (+ tx fee). That transfer carries a memo
  `dlmm-keeper:fee-sol-sweep lamports=… usd=… spot=…` and logs a FEE_SWEEP row at that USD value.
- The boot-time on-chain swept total scans both the revenue USDC ATA and the revenue wallet: USDC transfers count at
  face value, native SOL transfers LP → revenue (signed by the LP wallet) at the USD value stored in the bot's memo
  (spot at send time); SOL transfers without a bot memo use the Hyperliquid 1m close at block time, else the scan is
  marked incomplete (env fallback). Revenue → LP transfers are **not** subtracted — book them as a DEPOSIT
  (`NET_DEPOSITS_USD` / Capital Flows).
- One-time catch-up: `CATCHUP_SOL_SWEEP_LAMPORTS` (+ `CATCHUP_SOL_SWEEP_ID`, default `2026-10-09`) sends that much SOL
  to the revenue wallet once, `CATCHUP_SOL_SWEEP_DELAY_SEC` (≥120 s) after boot, only if no LP-signed memo
  `dlmm-keeper:catchup-sol-sweep id=<ID>` is already on chain (fails closed if the scan fails/is incomplete), the full
  amount fits above the gas floor, and it is ≤ `CATCHUP_SOL_SWEEP_MAX_LAMPORTS` (default 0.05 SOL, hard max 0.1).
  Remove the variable after the Telegram confirmation.

### Market regime (bin shape for new deploys)

The regime only shapes **new** deploys (bid/ask bins) and the stop % a new position starts with. Logic is in `regime.ts` (unit-tested: `npm test`).

- **Score** = 50 + trend (±35) + funding (±25) + direction (±20).
  - Trend (±35) = long `15 × clamp((price / SMA200 − 1) / 10%)` + medium `10 × clamp((price / SMA50 − 1) / 8%)` + cross `10 × clamp((SMA50 / SMA200 − 1) / 15%)` (golden/death cross); each clamped to ±1. Weights: price vs SMA200 is the only component with a (small) forward edge in 500 days of HL data, so it carries the most; price vs SMA50 is the only one that moves on a weeks timescale (38 sign flips in 500 days vs 3–5 for the others), and its 8% full scale ≈ the median |deviation|; the cross mostly repeats SMA200 and gets 10. SMA50 = mean of the last 50 closed daily closes from the same fetch/cache/fallback (≥ 50 days); if unknown, the medium and cross components score 0 and the read is partial. The 200-day mean uses the last 200 *closed* UTC daily closes from Hyperliquid `candleSnapshot` (`1d`); the in-progress day is excluded, and at least 150 days are required. The price is the latest Hyperliquid 1h close. The SMA is cached for 6h (an HL failure retries after 15 min). If HL daily fails, CoinGecko `market_chart` (same definition, live point excluded) is used as a secondary source, cached 1h with a 30-min retry backoff. A stale SMA up to 24h old is reused. Otherwise the trend is **unknown → 0 points**, and the read is partial: it can't switch the regime or trip the immediate-BEAR shortcut. The SMA source is shown in the `[REGIME]` line.
  - Regime evaluation never blocks the keeper tick: it runs in the background, and the tick uses the current (last committed) regime.
  - Funding: Hyperliquid SOL, 24h average of **settled hourly** rates (`fundingHistory`), annualized `hourly × 24 × 365 × 100`. Fallback: HL predicted rate (venue `HlPerp`) normalized by its `fundingIntervalHours`. |APR| < 3% → 0 (deadband); 3→8% → 0→+25; 8–40% → +25 (HL's neutral baseline is 10.95%); > 40% → 0 (overheated); −3→−10% → 0→−25; unknown → 0.
  - Direction (short-term): Hyperliquid 1h candles (`candleSnapshot`, 72h). Composite = 0.25 × (price vs 1h EMA20, full at ±1.5%) + 0.25 × (4h change, full at ±1.5%) + 0.5 × (24h change, full at ±4%), each clamped to ±1 (full scales ≈ 95th percentile of the last 14 days; the 24h change is weighted most so a 4h bounce inside a down day doesn't read as rising). |composite| < 0.25 → 0 (flat), then linear to ±20. Unknown → 0.
  - `BULL_EXPANSION`: score ≥ 90 **and** direction ≥ 0 **and** funding > 0 (trend alone tops out at 85; never BULL while price is falling short-term). `BEAR_DEFENSIVE`: score < 35 **and** trend + funding < 0 (direction alone can't make BEAR). Else `RANGE_CHOP`. Thresholds were rescaled when trend went from ±25 to ±35 so the extra trend weight doesn't simply inflate BULL/BEAR time (90-day replay: BULL time unchanged vs ±25, BEAR time lower).
  - Schmitt band: an existing BULL is kept while score ≥ 80 and direction ≥ −8; an existing BEAR while score < 45 (trend + funding < 0).
- **Hysteresis**: a new regime needs 2 consecutive complete reads ≥ 30 min apart (the bot re-checks after 30 min while a switch is pending) — or, except for BULL, a score ≥ 10 points inside the new band — **and** ≥ 2h in the current regime. BEAR is immediate only when the long-side score (50 + trend + funding, direction excluded) is < 20. A read with unknown funding or direction can't trigger a switch.
- **Boot**: nothing is persisted; the bot starts in `RANGE_CHOP` and leaves it only after 2 consecutive confirming reads (~30 min).
- **Failures**: keeps the current regime while the last good read is < 6h old, else `RANGE_CHOP`; never defaults to BULL. Failed reads back off 5 min (no per-tick API calls); good reads are cached 1h.
- A `[REGIME]` log line (score, price, SMA200, SMA50, cross and each trend component's points, funding raw/interval/APR/source, direction inputs, result, hysteresis) is written whenever the result changes, and at least hourly. `/regime` shows the same; SNAPSHOT ledger notes include the regime, score, SMA200/SMA50 and each component's points.

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
4. Use a single replica per service — two processes polling one Telegram token fight over `getUpdates` (HTTP 409). A second service on another pool needs its own wallet and either its own Telegram token or `TELEGRAM_COMMANDS_ENABLED=false`.

## Security

- Never put private keys, Telegram tokens, or webhook URLs in git.
- Prefer rotating any secret that ever appeared in git history before making a repo public.
- Restrict Telegram to your `TELEGRAM_CHAT_ID`.

## License / disclaimer

Provided as-is for educational and operational use. Automated market making involves impermanent loss, smart-contract risk, RPC/API failures, and liquidation-style stops that can realize losses. You are solely responsible for funds and compliance.
