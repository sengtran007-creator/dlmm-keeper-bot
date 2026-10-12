// Shared constants/helpers for the full-cycle rehearsal (local validator; throwaway keys only).
const fs = require("fs");
const path = require("path");
const { Keypair, PublicKey } = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const bs58 = require("bs58");

const STATE_DIR = path.join(__dirname, ".state"); // gitignored: throwaway keys, ledger capture, logs
const RPC = process.env.REHEARSAL_RPC || "http://127.0.0.1:8899";
const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
// 4bps SOL/USDC pool (the 4bps bot's pool). Accounts cloned from mainnet at validator start.
const POOL = {
  address: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
  reserveX: "EYj9xKw6ZszwpyNibHY7JD5o3QgTVrSdcBp1fMJhrR9o",
  reserveY: "CoaxzEh8p5YyGLcj36Eo3cUThVJxeKCs7qvLAGDYwBcz",
  oracle: "59YuGWPunbchD2mbi9U7qvjWQKQReGeepn4ZSr9zz9Li",
  bitmapExt: "DArpuuqJxNLRGQ8xq5ebZbobyjxSWWsPq8MqSZ2fUZLE",
};

function dlmmModule() {
  const m = require("@meteora-ag/dlmm");
  return { m, DLMM: m.DLMM || m.default || m };
}

function loadOrCreateKey(name) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const f = path.join(STATE_DIR, `${name}.json`);
  if (fs.existsSync(f)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
  const kp = Keypair.generate(); // throwaway, generated locally; never a bot key
  fs.writeFileSync(f, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

/** Validator --account JSON for an SPL token account (owner, mint, raw amount). */
function tokenAccountJson(address, mint, owner, amountRaw) {
  const data = Buffer.alloc(spl.AccountLayout.span);
  spl.AccountLayout.encode(
    {
      mint, owner, amount: BigInt(amountRaw), delegateOption: 0, delegate: PublicKey.default, state: 1,
      isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    },
    data
  );
  return {
    pubkey: address.toBase58(),
    account: { lamports: 2039280, data: [data.toString("base64"), "base64"], owner: spl.TOKEN_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0, space: data.length },
  };
}

module.exports = { STATE_DIR, RPC, DLMM_PROGRAM, USDC_MINT, WSOL_MINT, POOL, dlmmModule, loadOrCreateKey, tokenAccountJson, bs58, spl };
