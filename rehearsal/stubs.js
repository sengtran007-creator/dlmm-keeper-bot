// Local stand-ins for the bot's external writes: Jupiter swap API (routes through the cloned DLMM pool on the
// local validator) and the Google Sheet ledger webhook (rows appended to .state/ledger.jsonl).
// Fault injection: POST /control {"jupiterFail": n, "mode": "expire"|"http500"} makes the next n swaps fail.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { PublicKey, VersionedTransaction, TransactionMessage } = require("@solana/web3.js");
const BN = require("bn.js");
const L = require("./lib");
const market = require("./market");

const PORT = Number(process.env.STUB_PORT || 8787);
const LEDGER = path.join(L.STATE_DIR, "ledger.jsonl");
const control = { jupiterFail: 0, mode: "expire", swaps: 0, failed: 0 };

async function quote(inputMint, amount) {
  const p = await market.pool();
  const sellSol = inputMint === L.WSOL_MINT.toBase58();
  const binArrays = await p.getBinArrayForSwap(sellSol, 8);
  const q = p.swapQuote(new BN(amount), sellSol, new BN(100), binArrays, true);
  return {
    inputMint, outputMint: sellSol ? L.USDC_MINT.toBase58() : L.WSOL_MINT.toBase58(),
    inAmount: q.consumedInAmount.toString(), outAmount: q.outAmount.toString(), otherAmountThreshold: "0",
    slippageBps: 100, priceImpactPct: "0", routePlan: [{ swapInfo: { label: "Meteora DLMM (local rehearsal)" } }],
  };
}

async function swapTx(quoteResponse, user) {
  const p = await market.pool();
  const sellSol = quoteResponse.inputMint === L.WSOL_MINT.toBase58();
  const binArrays = await p.getBinArrayForSwap(sellSol, 8);
  const q = p.swapQuote(new BN(quoteResponse.inAmount), sellSol, new BN(100), binArrays, true);
  const tx = await p.swap({
    inToken: sellSol ? L.WSOL_MINT : L.USDC_MINT, outToken: sellSol ? L.USDC_MINT : L.WSOL_MINT,
    inAmount: q.consumedInAmount, minOutAmount: new BN(0), lbPair: p.pubkey, user: new PublicKey(user), binArraysPubkey: q.binArraysPubkey,
  });
  let { blockhash, lastValidBlockHeight } = await market.conn.getLatestBlockhash("confirmed");
  if (control.jupiterFail > 0 && control.mode === "expire") {
    // A blockhash that is already past its validity window → the bot's confirm resolves "expired"/not landed.
    const h = await market.conn.getBlockHeight("confirmed");
    lastValidBlockHeight = h - 1;
    blockhash = "11111111111111111111111111111111";
  }
  const msg = new TransactionMessage({ payerKey: new PublicKey(user), recentBlockhash: blockhash, instructions: tx.instructions }).compileToV0Message();
  return { swapTransaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64"), lastValidBlockHeight };
}

function body(req) {
  return new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b ? JSON.parse(b) : {})); });
}
function send(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }

function start() {
  fs.mkdirSync(L.STATE_DIR, { recursive: true });
  const srv = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (req.method === "POST" && u.pathname === "/ledger") {
        const row = await body(req);
        fs.appendFileSync(LEDGER, JSON.stringify(row) + "\n");
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && u.pathname === "/control") { Object.assign(control, await body(req)); return send(res, 200, control); }
      if (req.method === "GET" && u.pathname === "/control") return send(res, 200, control);
      if (req.method === "GET" && u.pathname === "/jup/quote") {
        return send(res, 200, await quote(u.searchParams.get("inputMint"), u.searchParams.get("amount")));
      }
      if (req.method === "POST" && u.pathname === "/jup/swap") {
        const b = await body(req);
        control.swaps++;
        if (control.jupiterFail > 0 && control.mode === "http500") { control.jupiterFail--; control.failed++; return send(res, 500, { error: "injected" }); }
        const out = await swapTx(b.quoteResponse, b.userPublicKey);
        if (control.jupiterFail > 0) { control.jupiterFail--; control.failed++; }
        return send(res, 200, out);
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      console.error("[stub]", e.message);
      send(res, 500, { error: String(e.message).slice(0, 200) });
    }
  });
  return new Promise((r) => srv.listen(PORT, "127.0.0.1", () => r(srv)));
}
module.exports = { start, control, LEDGER, PORT };
if (require.main === module) start().then(() => console.log(`stubs on :${PORT}`));
