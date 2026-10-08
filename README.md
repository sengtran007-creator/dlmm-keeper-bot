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
