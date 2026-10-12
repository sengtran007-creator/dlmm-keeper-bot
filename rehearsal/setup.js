// Generates throwaway keys + funded token accounts and prints the solana-test-validator argument list.
// Usage: node rehearsal/setup.js > rehearsal/.state/validator.args
const fs = require("fs");
const path = require("path");
const BN = require("bn.js");
const { PublicKey } = require("@solana/web3.js");
const L = require("./lib");

const BOT_USDC_RAW = Number(process.env.REHEARSAL_BOT_USDC ?? 250) * 1e6;
const WHALE_USDC_RAW = 50_000_000 * 1e6;

const bot = L.loadOrCreateKey("bot");
const revenue = L.loadOrCreateKey("revenue");
const whale = L.loadOrCreateKey("whale");
const accounts = [
  [bot.publicKey, BOT_USDC_RAW],
  [whale.publicKey, WHALE_USDC_RAW],
  [revenue.publicKey, 0],
];
const args = [];
for (const [owner, amt] of accounts) {
  const ata = L.spl.getAssociatedTokenAddressSync(L.USDC_MINT, owner);
  const f = path.join(L.STATE_DIR, `usdc-${owner.toBase58()}.json`);
  fs.writeFileSync(f, JSON.stringify(L.tokenAccountJson(ata, L.USDC_MINT, owner, amt)));
  args.push("--account", ata.toBase58(), f);
}
// Bin arrays around the active bin (±12 arrays ≈ ±336 bins ≈ ±13% on a 4 bps pool).
const { m } = L.dlmmModule();
const active = Number(process.env.REHEARSAL_ACTIVE_ID ?? -5494);
const idx = m.binIdToBinArrayIndex(new BN(active)).toNumber();
const prog = new PublicKey(L.DLMM_PROGRAM);
const pool = new PublicKey(L.POOL.address);
const maybe = [];
for (let i = idx - 12; i <= idx + 12; i++) maybe.push(m.deriveBinArray(pool, new BN(i), prog)[0].toBase58());
args.push("--clone-upgradeable-program", L.DLMM_PROGRAM);
for (const k of [L.POOL.address, L.POOL.reserveX, L.POOL.reserveY, L.POOL.oracle, L.POOL.bitmapExt, L.USDC_MINT.toBase58()]) args.push("--clone", k);
for (const k of maybe) args.push("--maybe-clone", k);
fs.writeFileSync(path.join(L.STATE_DIR, "pubkeys.json"), JSON.stringify({ bot: bot.publicKey.toBase58(), revenue: revenue.publicKey.toBase58(), whale: whale.publicKey.toBase58() }, null, 2));
process.stdout.write(args.join("\n") + "\n");
