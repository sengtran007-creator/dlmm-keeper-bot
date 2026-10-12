// Local stand-ins for the bot's external writes: Jupiter swap API (routes through the cloned DLMM pool on the
// local validator) and the Google Sheet ledger webhook (rows appended to .state/ledger.jsonl).
// Fault injection: POST /control {"jupiterFail": n, "mode": ...} for the next n swaps:
//   "expire"   swap tx with a dead blockhash (never lands)      "http500" /swap returns 500
//   "http429"  every /jup call returns 429 + x-ratelimit-reset (resetSec, default 3 s) — live 4bps Oct 12 5:33 AM PT
//   "http503"  /quote returns 503 (live 4bps Oct 11 7:10 PM PT)
//   "slippage" quotes 1.2% too optimistic and the swap enforces min-out = quote × (1 − slippageBps): fails in
//              preflight with the DLMM ExceededAmountSlippageTolerance error unless slippageBps ≳ 120 (live: 0x1771).
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
// Telegram stand-in (TELEGRAM_API_BASE=http://127.0.0.1:PORT/tg): the harness queues commands with POST /tg-cmd
// {"text": "/pause"}; getUpdates hands them to the bot; sendMessage texts are kept in tg.sent.
const tg = { updates: [], nextId: 1, sent: [] };
const TG_CHAT = "4242";

// Only bin arrays near the cloned price exist on the local validator; after a deep crash the SDK's 8-array lookahead
// can hit an uncloned (null) array. Fall back to fewer arrays (plenty for the bot's swap sizes).
async function binArraysFor(p, sellSol) {
  for (const n of [8, 4, 2, 1]) { try { return await p.getBinArrayForSwap(sellSol, n); } catch (e) { if (n === 1) throw e; } }
}

async function quote(inputMint, amount, slippageBps = 100) {
  const p = await market.pool();
  const sellSol = inputMint === L.WSOL_MINT.toBase58();
  const binArrays = await binArraysFor(p, sellSol);
  const q = p.swapQuote(new BN(amount), sellSol, new BN(100), binArrays, true);
  const optimistic = control.jupiterFail > 0 && control.mode === "slippage";
  const out = optimistic ? q.outAmount.muln(1012).divn(1000) : q.outAmount;
  return {
    inputMint, outputMint: sellSol ? L.USDC_MINT.toBase58() : L.WSOL_MINT.toBase58(),
    inAmount: q.consumedInAmount.toString(), outAmount: out.toString(), otherAmountThreshold: "0",
    slippageBps: Number(slippageBps) || 100, priceImpactPct: "0", routePlan: [{ swapInfo: { label: "Meteora DLMM (local rehearsal)" } }],
  };
}

async function swapTx(quoteResponse, user) {
  const p = await market.pool();
  const sellSol = quoteResponse.inputMint === L.WSOL_MINT.toBase58();
  const binArrays = await binArraysFor(p, sellSol);
  const q = p.swapQuote(new BN(quoteResponse.inAmount), sellSol, new BN(100), binArrays, true);
  const tx = await p.swap({
    inToken: sellSol ? L.WSOL_MINT : L.USDC_MINT, outToken: sellSol ? L.USDC_MINT : L.WSOL_MINT,
    inAmount: q.consumedInAmount,
    minOutAmount: control.mode === "slippage" && control.jupiterFail > 0
      ? new BN(quoteResponse.outAmount).muln(10_000 - Number(quoteResponse.slippageBps || 0)).divn(10_000)
      : new BN(0),
    lbPair: p.pubkey, user: new PublicKey(user), binArraysPubkey: q.binArraysPubkey,
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
      if (req.method === "POST" && u.pathname === "/tg-cmd") {
        const b = await body(req);
        tg.updates.push({ update_id: tg.nextId++, message: { chat: { id: Number(TG_CHAT) }, from: { id: Number(TG_CHAT) }, text: String(b.text) } });
        return send(res, 200, { ok: true });
      }
      if (u.pathname.startsWith("/tg/") && u.pathname.endsWith("/getUpdates")) {
        const offset = Number(u.searchParams.get("offset") || 0);
        tg.updates = tg.updates.filter((x) => x.update_id >= offset); // confirmed updates are gone (as on Telegram)
        for (let i = 0; i < 20 && !tg.updates.some((x) => x.update_id >= offset); i++) await new Promise((r) => setTimeout(r, 100));
        return send(res, 200, { ok: true, result: tg.updates.filter((x) => x.update_id >= offset) });
      }
      if (u.pathname.startsWith("/tg/") && u.pathname.endsWith("/sendMessage")) {
        const b = await body(req);
        tg.sent.push(String(b.text || ""));
        return send(res, 200, { ok: true, result: { message_id: tg.sent.length } });
      }
      if (u.pathname.startsWith("/jup/") && control.jupiterFail > 0 && control.mode === "http429") {
        // Live 4bps Oct 12 5:33 AM PT: lite-api answered every call with this body. api.jup.ag adds x-ratelimit-* headers.
        control.jupiterFail--; control.failed++;
        res.writeHead(429, { "Content-Type": "application/json", "x-ratelimit-remaining": "-1", "x-ratelimit-current": "31",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + Number(control.resetSec ?? 3)) });
        return res.end(JSON.stringify({ error: "Rate limit exceeded, please try again later." }));
      }
      if (req.method === "GET" && u.pathname === "/jup/quote") {
        if (control.jupiterFail > 0 && control.mode === "http503") { control.jupiterFail--; control.failed++; return send(res, 503, { error: "Service Unavailable (injected)" }); }
        return send(res, 200, await quote(u.searchParams.get("inputMint"), u.searchParams.get("amount"), u.searchParams.get("slippageBps")));
      }
      if (req.method === "POST" && u.pathname === "/jup/swap") {
        const b = await body(req);
        control.swaps++;
        if (control.jupiterFail > 0 && control.mode === "http500") { control.jupiterFail--; control.failed++; return send(res, 500, { error: "injected" }); }
        const out = await swapTx(b.quoteResponse, b.userPublicKey);
        if (control.jupiterFail > 0 && control.mode !== "slippage") { control.jupiterFail--; control.failed++; }
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
module.exports = { start, control, LEDGER, PORT, tg, TG_CHAT };
if (require.main === module) start().then(() => console.log(`stubs on :${PORT}`));
