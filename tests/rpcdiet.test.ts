import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { getPriceOfBinByBinId } from "@meteora-ag/dlmm";
import { RpcCallCounter, attachRpcCounter, creditsPerDay, rpcCredits } from "../rpccredits";
import { equityFromSnapshot, idleUsdUpperBound, isDue, spotFromActiveId, walletUsdFromRaw } from "../tickstate";
import { TickReader } from "../tickreader";

// ---------------------------------------------------------------- credit weights / counter

test("rpcCredits: Helius weights (gPA / history calls 10, standard 1)", () => {
  assert.equal(rpcCredits("getProgramAccounts"), 10);
  assert.equal(rpcCredits("getSignaturesForAddress"), 10);
  assert.equal(rpcCredits("getTransaction"), 10);
  assert.equal(rpcCredits("getBlockTime"), 10);
  assert.equal(rpcCredits("getMultipleAccounts"), 1);
  assert.equal(rpcCredits("getAccountInfo"), 1);
  assert.equal(rpcCredits("getBalance"), 1);
  assert.equal(rpcCredits("getSignatureStatuses", [["s"]]), 1);
  assert.equal(rpcCredits("getSignatureStatuses", [["s"], { searchTransactionHistory: true }]), 10);
});

test("attachRpcCounter counts single and batch requests, never changes results", async () => {
  const fake: any = {
    _rpcRequest: async (m: string) => ({ result: m }),
    _rpcBatchRequest: async (reqs: any[]) => reqs.map((r) => ({ result: r.methodName })),
  };
  const c = new RpcCallCounter();
  assert.equal(attachRpcCounter(fake, c), true);
  assert.deepEqual(await fake._rpcRequest("getMultipleAccounts", []), { result: "getMultipleAccounts" });
  await fake._rpcRequest("getProgramAccounts", []);
  await fake._rpcBatchRequest([{ methodName: "getTransaction", args: [] }, { methodName: "getTransaction", args: [] }]);
  assert.equal(c.totalCalls(), 4);
  assert.equal(c.totalCredits(), 1 + 10 + 20);
  assert.match(c.summary(), /^getTransaction 2×=20, getProgramAccounts 1×=10, getMultipleAccounts 1×=1$/);
  c.reset();
  assert.equal(c.totalCredits(), 0);
});

test("credit budget: old tick vs new tick per day (15 s ticks)", () => {
  // Measured on mainnet (tools/rpc-sim): old tick = 26 credits (gPA 10 + 16 single reads), new = 1 batched read.
  const oldPerDay = creditsPerDay(26, 15);
  const newPerDay = creditsPerDay(1, 15) + creditsPerDay(10, 900); // + position discovery every 15 min
  assert.equal(oldPerDay, 149_760);
  assert.equal(newPerDay, 5_760 + 960);
  assert.ok(oldPerDay / newPerDay > 5, "≥5x reduction");
  assert.equal(creditsPerDay(10, 0), 0);
});

// ---------------------------------------------------------------- spot / equity

test("spotFromActiveId matches the SDK's bin price (4 bps and 10 bps pools)", () => {
  for (const [id, step] of [[-5543, 4], [-2217, 10], [0, 10], [123, 1]] as const) {
    const sdk = Number(getPriceOfBinByBinId(id, step).toString()) * 1000;
    const ours = spotFromActiveId(id, step, 1000);
    assert.ok(Math.abs(ours / sdk - 1) < 1e-9, `${id}/${step}: ${ours} vs ${sdk}`);
  }
  assert.ok(Math.abs(spotFromActiveId(-5543, 4, 1000) - 108.96) < 0.01);
  assert.ok(Number.isNaN(spotFromActiveId(NaN, 4, 1000)));
  assert.ok(Number.isNaN(spotFromActiveId(1, 0, 1000)));
});

const K = "62bF5f9ZSFnmkRN84cD6kL48F4rzz3RYk9g5wPxSYyi5";
const K2 = "8FDtGJ6mP8QXiwRDaiGwE5xqF6aQjJXY36ZMzgWNvqrS";
const pos = (key: string, x: number, y: number, feeX = 0, feeY = 0, ok = true) => ({ key, ok, x, y, feeX, feeY });

test("equityFromSnapshot: wallet + position (incl. unclaimed fees), same math as probeEquity", () => {
  const e = equityFromSnapshot({
    spotUsd: 100,
    nativeLamports: 120_000_000, // 0.12 SOL
    wsolRaw: 30_000_000, // 0.03 SOL
    usdcRaw: 5_000_000, // $5
    positions: [pos(K, 3_000_000_000, 70_000_000, 10_000_000, 500_000)],
    missing: [],
    expectedKey: K,
  });
  assert.equal(e.ok, true);
  assert.equal(e.walletUsd, 5 + 15);
  assert.equal(e.activePositionUsd, 3.01 * 100 + 70.5);
  assert.equal(e.totalUsd, 20 + 371.5);
  assert.equal(e.positionCount, 1);
});

test("equityFromSnapshot: extra (untracked) positions are counted like before", () => {
  const e = equityFromSnapshot({
    spotUsd: 100, nativeLamports: 0, wsolRaw: 0, usdcRaw: 0,
    positions: [pos(K, 1e9, 0), pos(K2, 0, 10e6)],
    missing: [], expectedKey: K,
  });
  assert.equal(e.ok, true);
  assert.equal(e.totalUsd, 110);
  assert.equal(e.activePositionUsd, 100);
});

test("equityFromSnapshot fails closed: missing / partial / non-finite / bad spot", () => {
  const base = { spotUsd: 100, nativeLamports: 1, wsolRaw: 0, usdcRaw: 0, missing: [] as string[], expectedKey: K };
  assert.match(String(equityFromSnapshot({ ...base, positions: [], missing: [K] }).reason), /missing from read/);
  assert.match(String(equityFromSnapshot({ ...base, positions: [] }).reason), /missing from read/);
  assert.match(String(equityFromSnapshot({ ...base, positions: [pos(K, 0, 0, 0, 0, false)] }).reason), /partial read/);
  assert.match(String(equityFromSnapshot({ ...base, positions: [pos(K, NaN, 1)] }).reason), /non-finite/);
  assert.equal(equityFromSnapshot({ ...base, spotUsd: 0, positions: [pos(K, 1, 1)] }).ok, false);
  assert.equal(equityFromSnapshot({ ...base, nativeLamports: NaN, positions: [pos(K, 1, 1)] }).ok, false);
  // a closed EXTRA position does not fail the read; the active one must be there
  assert.equal(equityFromSnapshot({ ...base, positions: [pos(K, 1, 1)], missing: [K2] }).ok, true);
});

test("equityFromSnapshot without an expected position = wallet only (cash mode)", () => {
  const e = equityFromSnapshot({ spotUsd: 100, nativeLamports: 1e9, wsolRaw: 0, usdcRaw: 2e6, positions: [], missing: [], expectedKey: null });
  assert.equal(e.ok, true);
  assert.equal(e.totalUsd, 102);
  assert.equal(walletUsdFromRaw(100, 1e9, 0, 2e6), 102);
});

test("idleUsdUpperBound: never below the top-up's own idle figure; unknown spot → probe", () => {
  const reserve = 120_000_000;
  // native 0.15 + WSOL 0.05 SOL, $3 USDC at $100: (0.2 − 0.12) × 100 + 3 = 11
  assert.ok(Math.abs(idleUsdUpperBound(100, 150_000_000, 50_000_000, 3_000_000, reserve) - 11) < 1e-9);
  // what topUpExistingPosition computes after unwrapping WSOL (minus a tx fee) is ≤ that
  const afterUnwrap = 3 + (Math.max(0, 150_000_000 + 50_000_000 - 5000 - reserve) / 1e9) * 100;
  assert.ok(idleUsdUpperBound(100, 150_000_000, 50_000_000, 3_000_000, reserve) >= afterUnwrap);
  assert.equal(idleUsdUpperBound(100, 100_000_000, 0, 0, reserve), 0);
  assert.equal(idleUsdUpperBound(NaN, 0, 0, 0, reserve), Infinity);
});

test("isDue", () => {
  assert.equal(isDue(1000, 0, 900), true);
  assert.equal(isDue(1000, 500, 900), false);
  assert.equal(isDue(1400, 500, 900), true);
  assert.equal(isDue(1000, 999, 900, true), true);
});

// ---------------------------------------------------------------- TickReader fails closed

function fakeReader(getMultipleAccountsInfo: (...a: any[]) => Promise<any>) {
  const calls: number[] = [];
  const conn: any = {
    getMultipleAccountsInfo: async (keys: any[], ...rest: any[]) => {
      calls.push(keys.length);
      return getMultipleAccountsInfo(keys, ...rest);
    },
  };
  const dlmm: any = { pubkey: new PublicKey(K2), program: { programId: new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo") } };
  const r = new TickReader(conn, dlmm, new PublicKey(K), new PublicKey(K), new PublicKey(K), 1000);
  return { r, calls };
}

test("TickReader: one batched request; RPC error / short list / missing pool → ok:false", async () => {
  {
    const { r, calls } = fakeReader(async () => {
      throw new Error("429 Too Many Requests");
    });
    const s = await r.read([new PublicKey(K)]);
    assert.equal(s.ok, false);
    assert.match(String(s.reason), /batched read failed/);
    assert.deepEqual(calls, [6]); // pool, clock, wallet, USDC ATA, WSOL ATA, position — one request
  }
  {
    const { r } = fakeReader(async () => [null]);
    assert.match(String((await r.read([])).reason), /short list/);
  }
  {
    const { r } = fakeReader(async (keys: any[]) => keys.map(() => null));
    const s = await r.read([new PublicKey(K)]);
    assert.equal(s.ok, false);
    assert.match(String(s.reason), /pool account not returned/);
    assert.ok(Number.isNaN(s.spotUsd));
  }
});
