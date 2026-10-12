#!/usr/bin/env bash
# Starts a local solana-test-validator with the Meteora DLMM program + the 4bps SOL/USDC pool cloned from mainnet
# (read-only clone over public RPC) and throwaway funded accounts. Ledger in rehearsal/.state/ledger.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
mkdir -p rehearsal/.state && node rehearsal/setup.js > rehearsal/.state/validator.args
mapfile -t ARGS < rehearsal/.state/validator.args
exec solana-test-validator --reset --quiet --ledger rehearsal/.state/ledger \
  --url "${CLONE_URL:-https://api.mainnet-beta.solana.com}" --rpc-port 8899 --limit-ledger-size 50000000 \
  "${ARGS[@]}"
