/**
 * Read-only RPC credit simulation of the keeper tick (no private key, never sends a transaction).
 *   node dist-test/tools/rpc-sim.js <pool> <wallet> <position> [ticks=4] [rpc=https://api.mainnet-beta.solana.com]
 * "before" replays the pre-fix tick (refetchStates, getActiveBin, idle top-up probe, probeEquity with
 * getPositionsByUserAndLbPair); "after" uses TickReader (one batched read). Prints calls/credits per method
 * and checks both paths agree on spot and equity.
 */
import DLMM, { positionLbPairFilter, positionOwnerFilter, positionV2Filter } from "@meteora-ag/dlmm";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { RpcCallCounter, attachRpcCounter } from "../rpccredits";
import { TickReader } from "../tickreader";
import { equityFromSnapshot } from "../tickstate";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tokenRaw(c: Connection, ata: PublicKey): Promise<number> {
  try {
    return Number((await getAccount(c, ata)).amount);
  } catch (e: any) {
    if (/TokenAccountNotFound/.test(String(e?.name || e?.constructor?.name))) return 0;
    throw e;
  }
}

async function main() {
  const [poolS, walletS, posS, ticksS, rpcS] = process.argv.slice(2);
  const rpc = rpcS || "https://api.mainnet-beta.solana.com";
  const ticks = Math.max(1, Number(ticksS || 4));
  const pool = new PublicKey(poolS);
  const owner = new PublicKey(walletS);
  const pos = new PublicKey(posS);
  const usdcAta = getAssociatedTokenAddressSync(USDC, owner);
  const wsolAta = getAssociatedTokenAddressSync(WSOL, owner);

  // ---------- before ----------
  const cb = new Connection(rpc, "confirmed");
  const before = new RpcCallCounter();
  attachRpcCounter(cb, before);
  const dlmmB = await DLMM.create(cb, pool);
  const bootB = before.summary();
  before.reset();
  let lastB = { spot: NaN, equity: NaN };
  for (let i = 0; i < ticks; i++) {
    await dlmmB.refetchStates(); // tick
    const ab = await dlmmB.getActiveBin();
    const spot = Number(ab.price) * 1000;
    await dlmmB.refetchStates(); // topUpExistingPosition (runs every tick while idle < TOPUP_MIN_USD)
    await dlmmB.getActiveBin();
    await tokenRaw(cb, wsolAta);
    await tokenRaw(cb, usdcAta);
    await cb.getBalance(owner);
    const native = await cb.getBalance(owner); // probeEquity → probeWalletEquity
    const usdc = await tokenRaw(cb, usdcAta);
    const wsol = await tokenRaw(cb, wsolAta);
    const { userPositions } = await dlmmB.getPositionsByUserAndLbPair(owner);
    let posUsd = 0;
    for (const p of userPositions) {
      const pd: any = p.positionData;
      posUsd += ((Number(pd.totalXAmount) + Number(pd.feeX.toString())) / 1e9) * spot + (Number(pd.totalYAmount) + Number(pd.feeY.toString())) / 1e6;
    }
    lastB = { spot, equity: usdc / 1e6 + ((native + wsol) / 1e9) * spot + posUsd };
    await sleep(1200);
  }
  const beforePerTick = before.totalCredits() / ticks;
  const beforeSummary = before.summary();

  // ---------- after ----------
  const ca = new Connection(rpc, "confirmed");
  const after = new RpcCallCounter();
  attachRpcCounter(ca, after);
  const dlmmA = await DLMM.create(ca, pool);
  after.reset();
  const reader = new TickReader(ca, dlmmA, owner, usdcAta, wsolAta, 1000);
  // Position discovery (index.ts discoverPositionKeys): every POSITION_DISCOVERY_SEC, measured once here.
  const d0 = after.totalCredits();
  const found = await ca.getProgramAccounts((dlmmA as any).program.programId, {
    commitment: "confirmed",
    filters: [positionV2Filter(), positionOwnerFilter(owner), positionLbPairFilter(pool)],
    dataSlice: { offset: 0, length: 0 },
  });
  const discovery = { credits: after.totalCredits() - d0, keys: found.map((f) => f.pubkey.toBase58()) };
  if (!discovery.keys.includes(pos.toBase58())) throw new Error("discovery did not return the position");
  after.reset();
  let lastA = { spot: NaN, equity: NaN };
  const perTick: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const c0 = after.totalCredits();
    const snap = await reader.read([pos]);
    if (!snap.ok) throw new Error(`after read failed: ${snap.reason}`);
    const eq = equityFromSnapshot({
      spotUsd: snap.spotUsd, nativeLamports: snap.nativeLamports, wsolRaw: snap.wsolRaw, usdcRaw: snap.usdcRaw,
      positions: snap.amounts, missing: snap.missing, expectedKey: pos.toBase58(),
    });
    if (!eq.ok) throw new Error(`after equity failed: ${eq.reason}`);
    lastA = { spot: snap.spotUsd, equity: eq.totalUsd! };
    perTick.push(after.totalCredits() - c0);
    await sleep(1200);
  }
  const afterPerTick = after.totalCredits() / ticks;
  const out = {
    pool: poolS,
    ticks,
    bootCreate: bootB,
    before: { perTickCredits: beforePerTick, perDayAt15s: Math.round(beforePerTick * 5760), methods: beforeSummary, spot: lastB.spot, equity: Number(lastB.equity.toFixed(2)) },
    discovery,
    after: { perTickCredits: afterPerTick, perTick, perDayAt15s: Math.round(afterPerTick * 5760), methods: after.summary(), spot: lastA.spot, equity: lastA.equity },
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("SIM ERROR", e?.message || e);
  process.exit(1);
});
