// L2: web3.js getTransaction(maxSupportedTransactionVersion: 0) throws "Transaction version (N) is not supported"
// for newer tx versions, and DEPLOY/CLOSE/SWAP rows then fell back to snapshot estimates. index.ts retries with a
// raw jsonParsed request at that version; these pure helpers parse the error and the raw meta.

/** Version number from an "unsupported transaction version" error, else null. */
export function unsupportedTxVersion(message: string | null | undefined): number | null {
  const m = /Transaction version \((\d+)\) is not supported/i.exec(String(message || ""));
  return m ? Number(m[1]) : null;
}

export interface RawWalletDeltas {
  ok: boolean;
  feeLamports: number | null;
  nativeLamportsDelta: number;
  wsolRawDelta: number;
  usdcRawDelta: number;
  solEffectiveDelta: number;
}

/** Wallet deltas from a raw jsonParsed getTransaction result (accountKeys are objects with .pubkey). */
export function walletDeltasFromRawParsedTx(tx: any, wallet: string, wsolMint: string, usdcMint: string): RawWalletDeltas {
  const empty: RawWalletDeltas = { ok: false, feeLamports: null, nativeLamportsDelta: 0, wsolRawDelta: 0, usdcRawDelta: 0, solEffectiveDelta: 0 };
  const meta = tx?.meta;
  const keys: any[] = tx?.transaction?.message?.accountKeys ?? [];
  if (!meta || !Array.isArray(keys)) return empty;
  const strKeys = keys.map((k) => (typeof k === "string" ? k : String(k?.pubkey ?? "")));
  let i = strKeys.indexOf(wallet);
  if (i < 0) i = 0;
  const native = Number(meta.postBalances?.[i] ?? 0) - Number(meta.preBalances?.[i] ?? 0);
  const sum = (arr: any[] | undefined, mint: string) =>
    (arr || []).filter((b) => b.mint === mint && (!b.owner || b.owner === wallet)).reduce((a, b) => a + Number(b.uiTokenAmount?.amount ?? 0), 0);
  const wsol = sum(meta.postTokenBalances, wsolMint) - sum(meta.preTokenBalances, wsolMint);
  const usdc = sum(meta.postTokenBalances, usdcMint) - sum(meta.preTokenBalances, usdcMint);
  return {
    ok: true,
    feeLamports: typeof meta.fee === "number" ? meta.fee : null,
    nativeLamportsDelta: native,
    wsolRawDelta: wsol,
    usdcRawDelta: usdc,
    solEffectiveDelta: native + wsol,
  };
}
