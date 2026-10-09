import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_FEEX_NOTE_RE,
  buildSweepMemo,
  decideCatchup,
  feeClaimLedgerFields,
  parseSweepMemo,
  parseSweepTx,
  resolveLanded,
  solSweepLamports,
  solSweepLamportsFromParsedTx,
  sweepRawFromParsedTx,
} from "../feesweep";

// Public addresses only (from the Oct 9 2026 incident).
const LP = "6BGjJLPU33KqwCCZ3a6PZyAmpXakpcuNRuUHNV4onzzp";
const REV = "ErDjEoMTh1Rjrkoz1Ri1h48XifkzwW8ffZZUxwPUj5K6";
const LOOKALIKE = "ErDjVMHs96sNrfWACBFEetwTkPvVuHdAJ1YgC35G55K6";
const LP_USDC_ATA = "74wLb5cmJCRT1emQagBWVp3ouVBheiUgnM7LcoocsG7H";
const REV_USDC_ATA = "3hDFzbEPBLXGrYZzhzGq4FuZpd2C1ASFPCPct2SdhBRy";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CTX = { lpWallet: LP, revWallet: REV, lpUsdcAta: LP_USDC_ATA, revUsdcAta: REV_USDC_ATA, usdcMint: USDC };

function ptx(opts: { signers: string[]; ixs: any[]; inner?: any[]; err?: any }) {
  return {
    meta: { err: opts.err ?? null, innerInstructions: opts.inner ? [{ index: 0, instructions: opts.inner }] : [] },
    transaction: {
      signatures: ["SIG"],
      message: {
        accountKeys: opts.signers.map((k) => ({ pubkey: k, signer: true, writable: true })),
        instructions: opts.ixs,
      },
    },
  };
}
const solXfer = (source: string, destination: string, lamports: number) => ({
  program: "system", programId: "11111111111111111111111111111111", parsed: { type: "transfer", info: { source, destination, lamports } },
});
const memoIx = (text: string) => ({ program: "spl-memo", programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: text });
const usdcXfer = (source: string, destination: string, authority: string, amount: string) => ({
  program: "spl-token",
  parsed: { type: "transferChecked", info: { source, destination, authority, mint: USDC, tokenAmount: { amount } } },
});

// ------------------------------------------------------------ FEE_CLAIM amount calc

test("FEE_CLAIM values both halves once: Oct 9 claim = 1.848715 USDC + 0.017390554 SOL @ 109.50 ≈ $3.75", () => {
  const f = feeClaimLedgerFields(1_848_715, 17_390_554, 109.5);
  assert.equal(f.fees_usdc, 1.848715);
  assert.equal(f.fees_sol, 0.017390554);
  assert.ok(Math.abs(f.fees_sol_usd - 1.904266) < 1e-6);
  assert.ok(Math.abs(f.fees_claimed_usd - 3.752981) < 1e-6);
  assert.equal(f.fees_claimed_usd.toFixed(2), "3.75");
  assert.match(f.notes, /fees_sol=0\.017390554/);
  assert.match(f.notes, /fees_usdc=1\.848715/);
  assert.match(f.notes, /spot=109\.5000/);
});

test("FEE_CLAIM notes never match the dashboard's legacy feeX(SOL)= regex (no double count)", () => {
  for (const spot of [109.5, NaN, 0]) {
    const f = feeClaimLedgerFields(1_000_000, 5_000_000, spot);
    assert.equal(LEGACY_FEEX_NOTE_RE.test(f.notes), false);
  }
  // sanity: the old format does match
  assert.equal(LEGACY_FEEX_NOTE_RE.test("feeX(SOL)=0.017391 feeY(USDC)=1.848715"), true);
});

test("FEE_CLAIM without a usable spot records USDC only and says so", () => {
  const f = feeClaimLedgerFields(1_848_715, 17_390_554, NaN);
  assert.equal(f.fees_claimed_usd, 1.848715);
  assert.equal(f.fees_sol_usd, 0);
  assert.equal(f.fee_spot_usd, undefined);
  assert.match(f.notes, /SOL half NOT valued/);
});

// ------------------------------------------------------------ gas floor

const RES = 125_000_000; // GAS_RESERVE 0.125 SOL
const MARGIN = 5_000_000;
const FEE = 10_000;

test("SOL sweep: full amount when the wallet stays above reserve + margin (Oct 9 numbers)", () => {
  const r = solSweepLamports({ requestedLamports: 17_390_554, nativeLamports: 154_369_445, gasReserveLamports: RES, marginLamports: MARGIN, txFeeLamports: FEE, minLamports: 1_000_000 });
  assert.equal(r.lamports, 17_390_554);
  assert.ok(r.remainingLamports >= RES + MARGIN);
  assert.equal(r.reason, "full amount");
});

test("SOL sweep: capped so the wallet never goes below reserve + margin + fee", () => {
  const native = RES + MARGIN + FEE + 3_000_000;
  const r = solSweepLamports({ requestedLamports: 17_390_554, nativeLamports: native, gasReserveLamports: RES, marginLamports: MARGIN, txFeeLamports: FEE, minLamports: 1_000_000 });
  assert.equal(r.lamports, 3_000_000);
  assert.equal(r.remainingLamports, RES + MARGIN);
  assert.match(r.reason, /capped/);
});

test("SOL sweep: nothing when the headroom is below the minimum or the wallet is under the floor", () => {
  const a = solSweepLamports({ requestedLamports: 17_390_554, nativeLamports: RES + MARGIN + FEE + 500_000, gasReserveLamports: RES, marginLamports: MARGIN, txFeeLamports: FEE, minLamports: 1_000_000 });
  assert.equal(a.lamports, 0);
  assert.match(a.reason, /gas floor/);
  const b = solSweepLamports({ requestedLamports: 17_390_554, nativeLamports: 100_000_000, gasReserveLamports: RES, marginLamports: MARGIN, txFeeLamports: FEE, minLamports: 1_000_000 });
  assert.equal(b.lamports, 0);
  const c = solSweepLamports({ requestedLamports: 500_000, nativeLamports: 200_000_000, gasReserveLamports: RES, marginLamports: MARGIN, txFeeLamports: FEE, minLamports: 1_000_000 });
  assert.equal(c.lamports, 0);
  assert.match(c.reason, /below minimum/);
});

// ------------------------------------------------------------ double-send guard (catch-up)

const baseCatchup = {
  configuredLamports: 17_390_554,
  capLamports: 50_000_000,
  id: "2026-10-09",
  scanOk: true,
  scanComplete: true,
  priorCatchupIds: new Set<string>(),
  sentThisProcess: false,
  nativeLamports: 154_369_445,
  gasReserveLamports: RES,
  marginLamports: MARGIN,
  txFeeLamports: FEE,
};

test("catch-up: sends exactly once when nothing is on chain yet", () => {
  const d = decideCatchup(baseCatchup);
  assert.equal(d.send, true);
  assert.equal(d.lamports, 17_390_554);
});

test("catch-up: skipped when the memo id is already on chain (restart after success)", () => {
  const d = decideCatchup({ ...baseCatchup, priorCatchupIds: new Set(["2026-10-09"]) });
  assert.equal(d.send, false);
  assert.match(d.reason, /already done/);
  // a different id is a different catch-up
  assert.equal(decideCatchup({ ...baseCatchup, priorCatchupIds: ["2026-10-01"] }).send, true);
});

test("catch-up: fails closed on scan failure / incomplete scan, and never twice per process", () => {
  assert.equal(decideCatchup({ ...baseCatchup, scanOk: false }).send, false);
  assert.equal(decideCatchup({ ...baseCatchup, scanComplete: false }).send, false);
  assert.equal(decideCatchup({ ...baseCatchup, sentThisProcess: true }).send, false);
});

test("catch-up: cap and no partial send under the gas floor", () => {
  assert.match(decideCatchup({ ...baseCatchup, configuredLamports: 60_000_000 }).reason, /cap/);
  const d = decideCatchup({ ...baseCatchup, nativeLamports: RES + MARGIN + FEE + 10_000_000 });
  assert.equal(d.send, false);
  assert.match(d.reason, /does not fit/);
  assert.equal(decideCatchup({ ...baseCatchup, configuredLamports: 0 }).send, false);
});

// ------------------------------------------------------------ memo

test("memo round trip (USD value stored at send time)", () => {
  const text = buildSweepMemo({ kind: "catchup-sol-sweep", id: "2026-10-09", lamports: 17_390_554, usd: 1.904266, spot: 109.5 });
  assert.equal(text, "dlmm-keeper:catchup-sol-sweep id=2026-10-09 lamports=17390554 usd=1.904266 spot=109.5000");
  const m = parseSweepMemo(`[90] ${text}`)!;
  assert.equal(m.kind, "catchup-sol-sweep");
  assert.equal(m.id, "2026-10-09");
  assert.equal(m.lamports, 17_390_554);
  assert.equal(m.usd, 1.904266);
  assert.equal(parseSweepMemo("hello"), null);
  assert.equal(parseSweepMemo("dlmm-keeper:something-else usd=1"), null);
});

// ------------------------------------------------------------ swept-total parsing

test("SOL transfer LP → revenue signed by LP counts; memo gives its USD value", () => {
  const memo = buildSweepMemo({ kind: "fee-sol-sweep", lamports: 17_390_554, usd: 1.904266, spot: 109.5 });
  const tx = ptx({ signers: [LP], ixs: [solXfer(LP, REV, 17_390_554), memoIx(memo)] });
  assert.equal(solSweepLamportsFromParsedTx(tx, LP, REV), 17_390_554);
  const p = parseSweepTx(tx, CTX);
  assert.equal(p.solLamports, 17_390_554);
  assert.ok(Math.abs((p.solUsdFromMemo ?? 0) - 1.904266) < 1e-9);
  assert.equal(p.usdcRaw, 0);
  assert.equal(p.memo?.kind, "fee-sol-sweep");
});

test("revenue → LP (Peter's Oct 8 23:03 transfer), lookalike dust, failed and unsigned txs count 0", () => {
  // 2DZNBVvJ…: revenue wallet → LP 0.016991878 SOL, signed by the revenue wallet
  assert.equal(solSweepLamportsFromParsedTx(ptx({ signers: [REV], ixs: [solXfer(REV, LP, 16_991_878)] }), LP, REV), 0);
  // poisoning: lookalike sends to LP
  assert.equal(solSweepLamportsFromParsedTx(ptx({ signers: [LOOKALIKE], ixs: [solXfer(LOOKALIKE, LP, 1000)] }), LP, REV), 0);
  // LP → lookalike is not a sweep to the configured revenue wallet
  assert.equal(solSweepLamportsFromParsedTx(ptx({ signers: [LP], ixs: [solXfer(LP, LOOKALIKE, 1000)] }), LP, REV), 0);
  // failed tx
  assert.equal(solSweepLamportsFromParsedTx(ptx({ signers: [LP], ixs: [solXfer(LP, REV, 5_000_000)], err: { InstructionError: [0, "x"] } }), LP, REV), 0);
  // LP listed but not a signer
  const notSigned = ptx({ signers: [REV], ixs: [solXfer(LP, REV, 5_000_000)] });
  assert.equal(solSweepLamportsFromParsedTx(notSigned, LP, REV), 0);
});

test("forged memo in a tx not signed by the LP wallet is ignored (cannot fake a catch-up marker)", () => {
  const memo = buildSweepMemo({ kind: "catchup-sol-sweep", id: "2026-10-09", lamports: 1, usd: 999 });
  const p = parseSweepTx(ptx({ signers: [LOOKALIKE], ixs: [memoIx(memo), solXfer(LOOKALIKE, REV, 1)] }), CTX);
  assert.equal(p.memo, null);
  assert.equal(p.solLamports, 0);
});

test("USDC sweep parsing unchanged (ugch8tSt…: 1.848715 USDC), inner instructions included", () => {
  const tx = ptx({ signers: [LP], ixs: [usdcXfer(LP_USDC_ATA, REV_USDC_ATA, LP, "1848715")] });
  assert.equal(sweepRawFromParsedTx(tx, LP, LP_USDC_ATA, REV_USDC_ATA, USDC), 1_848_715);
  const inner = ptx({ signers: [LP], ixs: [], inner: [usdcXfer(LP_USDC_ATA, REV_USDC_ATA, LP, "100")] });
  assert.equal(sweepRawFromParsedTx(inner, LP, LP_USDC_ATA, REV_USDC_ATA, USDC), 100);
  // revenue wallet spending its USDC (krcHWQ9C… swap at 23:03) is not a sweep
  const out = ptx({ signers: [REV], ixs: [usdcXfer(REV_USDC_ATA, "J8gt2jBUi6DW6gdUdm1fkP9oGN4xXwPdQbCZkkN78R3Z", REV, "2000000")] });
  assert.equal(sweepRawFromParsedTx(out, LP, LP_USDC_ATA, REV_USDC_ATA, USDC), 0);
});

test("memo USD is pro-rated if the memo covers a different lamport amount; spot-only memo works", () => {
  const memo = buildSweepMemo({ kind: "fee-sol-sweep", lamports: 20_000_000, usd: 2.2 });
  const p = parseSweepTx(ptx({ signers: [LP], ixs: [solXfer(LP, REV, 10_000_000), memoIx(memo)] }), CTX);
  assert.ok(Math.abs((p.solUsdFromMemo ?? 0) - 1.1) < 1e-9);
  const p2 = parseSweepTx(ptx({ signers: [LP], ixs: [solXfer(LP, REV, 10_000_000), memoIx("dlmm-keeper:fee-sol-sweep spot=110")] }), CTX);
  assert.ok(Math.abs((p2.solUsdFromMemo ?? 0) - 1.1) < 1e-9);
  const p3 = parseSweepTx(ptx({ signers: [LP], ixs: [solXfer(LP, REV, 10_000_000)] }), CTX);
  assert.equal(p3.solUsdFromMemo, null); // caller prices it (historical) or marks the scan incomplete
});

// ------------------------------------------------------------ landed / retry safety

function fakeChain(seq: { status: any; height: number }[]) {
  let i = 0;
  const cur = () => seq[Math.min(i, seq.length - 1)];
  return {
    getStatus: async () => cur().status,
    getBlockHeight: async () => {
      const h = cur().height;
      i++;
      return h;
    },
    sleep: async () => {},
  };
}

test("resolveLanded: confirmed later → landed (the 30s-timeout case; no retry, no double swap)", async () => {
  const deps = fakeChain([
    { status: null, height: 100 },
    { status: { err: null, confirmationStatus: "confirmed" }, height: 101 },
  ]);
  assert.equal(await resolveLanded("s", 200, deps), "landed");
});

test("resolveLanded: blockhash expired with no status → not_landed (safe to retry)", async () => {
  const deps = fakeChain([
    { status: null, height: 150 },
    { status: null, height: 201 },
  ]);
  assert.equal(await resolveLanded("s", 200, deps), "not_landed");
});

test("resolveLanded: landed with an error → failed (nothing moved; safe to fall back)", async () => {
  const deps = fakeChain([{ status: { err: { InstructionError: [0, "x"] }, confirmationStatus: "confirmed" }, height: 100 }]);
  assert.equal(await resolveLanded("s", 200, deps), "failed");
});

test("resolveLanded: neither confirmed nor expired within the wait → unknown (caller must not retry)", async () => {
  let t = 0;
  const deps = { ...fakeChain([{ status: null, height: 100 }]), now: () => (t += 50_000) };
  assert.equal(await resolveLanded("s", 200, deps, { maxWaitMs: 120_000 }), "unknown");
});
