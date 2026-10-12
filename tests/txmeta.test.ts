import { test } from "node:test";
import assert from "node:assert/strict";
import { unsupportedTxVersion, walletDeltasFromRawParsedTx } from "../txmeta";

const W = "6BGjJLPU33KqwCCZ3a6PZyAmpXakpcuNRuUHNV4onzzp";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("L2: unsupported version parsed from the web3 error", () => {
  assert.equal(unsupportedTxVersion("Transaction version (1) is not supported by the requesting client"), 1);
  assert.equal(unsupportedTxVersion("blockhash not found"), null);
});

test("L2: raw jsonParsed deltas (v1 tx)", () => {
  const tx = {
    version: 1,
    transaction: { message: { accountKeys: [{ pubkey: W }, { pubkey: "Other" }] } },
    meta: {
      fee: 5000,
      preBalances: [1_000_000_000, 0],
      postBalances: [899_995_000, 0],
      preTokenBalances: [{ mint: USDC, owner: W, uiTokenAmount: { amount: "1000000" } }],
      postTokenBalances: [
        { mint: USDC, owner: W, uiTokenAmount: { amount: "11000000" } },
        { mint: USDC, owner: "Other", uiTokenAmount: { amount: "5" } },
      ],
    },
  };
  const d = walletDeltasFromRawParsedTx(tx, W, WSOL, USDC);
  assert.equal(d.ok, true);
  assert.equal(d.feeLamports, 5000);
  assert.equal(d.nativeLamportsDelta, -100_005_000);
  assert.equal(d.usdcRawDelta, 10_000_000);
  assert.equal(walletDeltasFromRawParsedTx({}, W, WSOL, USDC).ok, false);
});
