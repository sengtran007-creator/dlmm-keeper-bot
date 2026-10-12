// Whale "market" for the rehearsal: moves the local pool's price by swapping through it (real DLMM program).
const { Connection, PublicKey, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require("@solana/web3.js");
const BN = require("bn.js");
const L = require("./lib");

const conn = new Connection(L.RPC, "confirmed");
const { DLMM, m } = L.dlmmModule();
let poolP = null;
async function pool() {
  if (!poolP) poolP = DLMM.create(conn, new PublicKey(L.POOL.address));
  const p = await poolP;
  await p.refetchStates();
  return p;
}
async function spot() {
  const p = await pool();
  const ab = await p.getActiveBin();
  return { binId: ab.binId, price: Number(ab.price) * 1000 };
}
async function airdrop(pk, sol) {
  const sig = await conn.requestAirdrop(pk, Math.round(sol * LAMPORTS_PER_SOL));
  await conn.confirmTransaction(sig, "confirmed");
}
/** One swap of `amountRaw` (SOL lamports if sellSol, else USDC raw) by the whale. */
async function swapOnce(whale, sellSol, amountRaw) {
  const p = await pool();
  const swapForY = sellSol; // X = SOL, Y = USDC (SDK: swapForY = selling X for Y)
  let binArrays; // fewer arrays if the 8-array lookahead hits an uncloned (null) bin array on the local validator
  for (const n of [8, 4, 2, 1]) { try { binArrays = await p.getBinArrayForSwap(swapForY, n); break; } catch (e) { if (n === 1) throw e; } }
  const q = p.swapQuote(new BN(amountRaw), swapForY, new BN(500), binArrays, true);
  const tx = await p.swap({
    inToken: sellSol ? L.WSOL_MINT : L.USDC_MINT,
    outToken: sellSol ? L.USDC_MINT : L.WSOL_MINT,
    inAmount: q.consumedInAmount, minOutAmount: new BN(0), lbPair: p.pubkey, user: whale.publicKey,
    binArraysPubkey: q.binArraysPubkey,
  });
  return sendAndConfirmTransaction(conn, tx, [whale], { commitment: "confirmed" });
}
/** Swap in steps until the active bin reaches targetBin (inclusive). */
async function moveToBin(whale, targetBin, { stepSol = 1500, stepUsdc = 165000 } = {}) {
  let shrink = 1; // a step that crosses too many bins exceeds the CU limit: halve it after each failure
  for (let i = 0; i < 400; i++) {
    const s = await spot();
    if (s.binId === targetBin) return s;
    const down = s.binId > targetBin;
    const gap = Math.abs(s.binId - targetBin);
    const scale = (Math.min(1, gap / 10) || 0.05) * shrink;
    try {
      await swapOnce(whale, down, down ? Math.max(1e7, Math.round(stepSol * scale * 1e9)) : Math.max(1e6, Math.round(stepUsdc * scale * 1e6)));
    } catch (e) {
      console.warn("[market] swap failed:", e.message?.slice(0, 200));
      shrink = Math.max(0.01, shrink / 2);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const s2 = await spot();
    if ((down && s2.binId < targetBin) || (!down && s2.binId > targetBin)) return s2; // overshoot by a bin or two is fine
  }
  return spot();
}
/** Wash-trade around the current bin to generate swap fees for LPs (net ≈ flat). */
async function washTrade(whale, rounds = 4, sol = 5) {
  for (let i = 0; i < rounds; i++) {
    const s = await spot();
    await swapOnce(whale, true, Math.round(sol * 1e9));
    await swapOnce(whale, false, Math.round(sol * s.price * 1e6));
  }
}
module.exports = { conn, pool, spot, airdrop, swapOnce, moveToBin, washTrade };

if (require.main === module) {
  (async () => {
    const whale = L.loadOrCreateKey("whale");
    await airdrop(whale.publicKey, 5000);
    console.log("spot", await spot());
    await swapOnce(whale, true, 10e9);
    console.log("after sell 10 SOL", await spot());
    console.log("moved", await moveToBin(whale, (await spot()).binId - 20));
    console.log("moved back", await moveToBin(whale, (await spot()).binId + 20));
  })().catch((e) => { console.error("ERR", e); process.exit(1); });
}
