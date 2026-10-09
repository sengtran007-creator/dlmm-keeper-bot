import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATA_RENT_LAMPORTS,
  TRANSFER_OUT_HARD_CEILING_USD,
  TransferConfirmations,
  addToHistory,
  applyTransferOut,
  baselineWithTransfersOut,
  buildTransferOutMemo,
  checkTransferPreconditions,
  effectivePinnedEntryEquity,
  emptyTransferOutHistory,
  parseConfirmCommand,
  parseTransferAllowlist,
  parseTransferOutCommand,
  parseTransferOutMemo,
  parseTransferOutTx,
  parseUserIds,
  planTransferOut,
  resolveMaxEquityPct,
  resolveMaxUsd,
  revalidateQuotedPlan,
  signatureHasTransferOutMemo,
} from "../transferout";
import { parseSweepMemo, parseSweepTx } from "../feesweep";

// Public addresses only.
const LP = "6BGjJLPU33KqwCCZ3a6PZyAmpXakpcuNRuUHNV4onzzp";
const REV = "ErDjEoMTh1Rjrkoz1Ri1h48XifkzwW8ffZZUxwPUj5K6";
const DEST = "7h2ziXFfUjouCLCoxuRJXVKgjeKGKLtyZPoYRKgmdwqw"; // test fixture only; runtime value comes from env
const OTHER = "ErDjVMHs96sNrfWACBFEetwTkPvVuHdAJ1YgC35G55K6";
const LP_USDC_ATA = "74wLb5cmJCRT1emQagBWVp3ouVBheiUgnM7LcoocsG7H";
const DEST_USDC_ATA = "CqvVauh17X3AuJcTrWUUfGTghDpGQ54D6TeWgaBG7cfK";
const REV_USDC_ATA = "3hDFzbEPBLXGrYZzhzGq4FuZpd2C1ASFPCPct2SdhBRy";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POS = "8FDtKtJ6xAzeGg3J8rYxE6Ld8mH4Nf9VLyy8Ce3hQnZx";

const RES = 120_000_000;
const MARGIN = 10_000_000;
const FEE = 10_000;
const base = {
  usdcRaw: 230_000_000, // $230 USDC withdrawn
  nativeLamports: 1_700_000_000, // 1.70 SOL native
  spotUsd: 150,
  equityUsd: 917,
  gasReserveLamports: RES,
  marginLamports: MARGIN,
  txFeeLamports: FEE,
  ataRentLamports: ATA_RENT_LAMPORTS,
  maxUsd: 600,
  maxEquityPct: 60,
};

// ---------------------------------------------------------------- allowlist
test("allowlist: disabled when unset / blank", () => {
  const ctx = { lpWallet: LP, revenueWallet: REV };
  for (const raw of [undefined, null, "", "   "]) {
    const r = parseTransferAllowlist(raw as any, ctx);
    assert.equal(r.enabled, false);
    assert.equal(r.address, null);
  }
  const gate = checkTransferPreconditions({
    enabled: false, disabledReason: "TRANSFER_OUT_ALLOWLIST unset", chatIdConfigured: true, chatMatches: true,
    userAllowed: true, paused: true, partialWithdrawPending: true, hasOpenPosition: true, busy: false,
  });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /disabled/);
});

test("allowlist: exactly one valid address; never the LP or revenue wallet", () => {
  const ctx = { lpWallet: LP, revenueWallet: REV };
  assert.deepEqual(parseTransferAllowlist(` ${DEST} `, ctx), { enabled: true, address: DEST, reason: "ok" });
  assert.equal(parseTransferAllowlist(`${DEST},${OTHER}`, ctx).enabled, false);
  assert.equal(parseTransferAllowlist("not-an-address", ctx).enabled, false);
  assert.equal(parseTransferAllowlist("0OIl" + DEST.slice(4), ctx).enabled, false); // non-base58 chars
  assert.equal(parseTransferAllowlist(LP, ctx).enabled, false);
  assert.match(parseTransferAllowlist(REV, ctx).reason, /revenue/);
  assert.equal(parseTransferAllowlist(DEST, { ...ctx, isValidPubkey: () => false }).enabled, false);
});

test("command never takes a destination; parses usd, pct and usdc-only", () => {
  assert.deepEqual(parseTransferOutCommand("/transfer_out 461"), { ok: true, req: { kind: "usd", value: 461, mode: "mix" } });
  assert.deepEqual(parseTransferOutCommand("/transfer_out $461.50 usdc"), { ok: true, req: { kind: "usd", value: 461.5, mode: "usdc" } });
  assert.deepEqual(parseTransferOutCommand("/transfer_out@dalmm_bot 100%"), { ok: true, req: { kind: "pct", value: 100, mode: "mix" } });
  assert.equal(parseTransferOutCommand(`/transfer_out 461 ${OTHER}`).ok, false);
  assert.equal(parseTransferOutCommand(`/transfer_out ${OTHER} 461`).ok, false);
  assert.equal(parseTransferOutCommand("/transfer_out").ok, false);
  assert.equal(parseTransferOutCommand("/transfer_out -5").ok, false);
  assert.equal(parseTransferOutCommand("/transfer_out 0").ok, false);
  assert.equal(parseTransferOutCommand("/transfer_out 150%").ok, false);
  assert.equal(parseTransferOutCommand("/transfer_out 1e9").ok, false);
  assert.equal(parseConfirmCommand("/confirm 012345"), "012345");
  assert.equal(parseConfirmCommand("/confirm 12345"), null);
  assert.equal(parseConfirmCommand("/confirm"), null);
});

test("preconditions: configured chat, allowed user, paused, partly withdrawn, not busy", () => {
  const ok = {
    enabled: true, chatIdConfigured: true, chatMatches: true, userAllowed: true,
    paused: true, partialWithdrawPending: true, hasOpenPosition: true, busy: false,
  };
  assert.equal(checkTransferPreconditions(ok).ok, true);
  assert.equal(checkTransferPreconditions({ ...ok, chatIdConfigured: false }).ok, false);
  assert.equal(checkTransferPreconditions({ ...ok, chatMatches: false }).ok, false);
  assert.equal(checkTransferPreconditions({ ...ok, userAllowed: false }).ok, false);
  assert.match(checkTransferPreconditions({ ...ok, paused: false }).reason, /not paused/);
  assert.match(checkTransferPreconditions({ ...ok, partialWithdrawPending: false }).reason, /withdraw_pct/);
  // No position at all (e.g. after /emergency_exit) + paused → allowed.
  assert.equal(checkTransferPreconditions({ ...ok, partialWithdrawPending: false, hasOpenPosition: false }).ok, true);
  assert.equal(checkTransferPreconditions({ ...ok, busy: true }).ok, false);
  assert.deepEqual([...parseUserIds("123, -456 abc")], ["123", "-456"]);
});

// ---------------------------------------------------------------- sizing
test("plan: USDC first, then SOL above the gas floor", () => {
  const p = planTransferOut({ ...base, req: { kind: "usd", value: 461, mode: "mix" } });
  assert.equal(p.ok, true);
  assert.equal(p.usdcRaw, 230_000_000);
  // remaining $231 in SOL @150 = 1.54 SOL
  assert.equal(p.lamports, 1_540_000_000);
  assert.ok(Math.abs(p.usd - 461) < 0.01);
  assert.ok(p.remainingLamports >= RES + MARGIN, `remaining ${p.remainingLamports}`);
});

test("plan: gas floor — native SOL never goes below reserve + margin + fee + ATA rent", () => {
  const p = planTransferOut({ ...base, req: { kind: "pct", value: 100, mode: "mix" } });
  assert.equal(p.ok, true);
  const floor = RES + MARGIN + FEE + ATA_RENT_LAMPORTS;
  assert.equal(p.lamports, base.nativeLamports - floor);
  assert.equal(p.remainingLamports, RES + MARGIN);
  // Asking for more than transferable is refused, not silently trimmed.
  const tooMuch = planTransferOut({ ...base, req: { kind: "usd", value: 500, mode: "mix" } });
  assert.equal(tooMuch.ok, false);
  assert.match(tooMuch.reason, /only \$\d+/);
  // Native SOL at/below the floor → USDC only.
  const low = planTransferOut({ ...base, nativeLamports: RES - 5_000, req: { kind: "pct", value: 100, mode: "mix" } });
  assert.equal(low.ok, true);
  assert.equal(low.lamports, 0);
  assert.equal(low.usdcRaw, 230_000_000);
  // usdc mode never touches SOL
  const u = planTransferOut({ ...base, req: { kind: "usd", value: 300, mode: "usdc" } });
  assert.equal(u.ok, false);
  const u2 = planTransferOut({ ...base, req: { kind: "pct", value: 100, mode: "usdc" } });
  assert.equal(u2.lamports, 0);
});

test("plan: caps (USD cap, hard ceiling, share of equity, unknown equity)", () => {
  assert.equal(planTransferOut({ ...base, maxUsd: 400, req: { kind: "usd", value: 461, mode: "mix" } }).ok, false);
  assert.match(planTransferOut({ ...base, maxUsd: 400, req: { kind: "usd", value: 461, mode: "mix" } }).reason, /cap/);
  assert.equal(planTransferOut({ ...base, equityUsd: 700, req: { kind: "usd", value: 461, mode: "mix" } }).ok, false); // 60% of 700 = 420
  assert.equal(planTransferOut({ ...base, equityUsd: null, req: { kind: "usd", value: 10, mode: "mix" } }).ok, false);
  assert.equal(planTransferOut({ ...base, spotUsd: NaN, req: { kind: "usd", value: 10, mode: "mix" } }).ok, false);
  assert.equal(resolveMaxUsd(undefined), 600);
  assert.equal(resolveMaxUsd("1000000"), TRANSFER_OUT_HARD_CEILING_USD);
  assert.equal(resolveMaxUsd("abc"), 600);
  assert.equal(resolveMaxEquityPct("95"), 90);
  // tiny SOL leg (< 0.001 SOL) dropped — a new destination account would not be rent-exempt
  const tiny = planTransferOut({ ...base, req: { kind: "usd", value: 230.05, mode: "mix" } });
  assert.equal(tiny.lamports, 0);
});

test("revalidate at /confirm: quoted amounts only if they still fit", () => {
  const q = { usdcRaw: 230_000_000, lamports: 1_540_000_000 };
  const fresh = { ...base };
  assert.equal(revalidateQuotedPlan(q, fresh).ok, true);
  assert.equal(revalidateQuotedPlan(q, { ...fresh, usdcRaw: 229_000_000 }).ok, false);
  assert.equal(revalidateQuotedPlan(q, { ...fresh, nativeLamports: 1_600_000_000 }).ok, false); // would breach floor
  assert.equal(revalidateQuotedPlan(q, { ...fresh, spotUsd: 400 }).ok, false); // value now > cap
  assert.equal(revalidateQuotedPlan(q, { ...fresh, equityUsd: null }).ok, false);
});

// ---------------------------------------------------------------- confirmation
test("confirmation: single-use code, 60s expiry, same chat + user, 3 wrong codes cancel", () => {
  const book = new TransferConfirmations<{ usd: number }>(60_000);
  const t0 = 1_000_000;
  book.create({ usd: 461 }, "chat", "u1", t0, "123456");
  assert.equal(book.confirm("123456", "other", "u1", t0 + 1000).ok, false);
  assert.deepEqual(book.confirm("123456", "chat", "u2", t0 + 1000), { ok: false, reason: "wrong_user" });
  const ok = book.confirm("123456", "chat", "u1", t0 + 59_000);
  assert.equal(ok.ok, true);
  assert.deepEqual(book.confirm("123456", "chat", "u1", t0 + 59_500), { ok: false, reason: "none" }); // single use

  book.create({ usd: 1 }, "chat", "u1", t0, "654321");
  assert.deepEqual(book.confirm("654321", "chat", "u1", t0 + 60_001), { ok: false, reason: "expired" });
  assert.deepEqual(book.confirm("654321", "chat", "u1", t0 + 60_002), { ok: false, reason: "none" });

  book.create({ usd: 1 }, "chat", "u1", t0, "111111");
  assert.deepEqual(book.confirm("000000", "chat", "u1", t0 + 1), { ok: false, reason: "wrong_code" });
  assert.deepEqual(book.confirm("000001", "chat", "u1", t0 + 2), { ok: false, reason: "wrong_code" });
  assert.deepEqual(book.confirm("000002", "chat", "u1", t0 + 3), { ok: false, reason: "too_many_attempts" });
  assert.deepEqual(book.confirm("111111", "chat", "u1", t0 + 4), { ok: false, reason: "none" });

  book.create({ usd: 1 }, "chat", "u1", t0, "222222");
  assert.equal(book.cancel(), true);
  assert.equal(book.peek(t0 + 1), null);
  assert.throws(() => book.create({ usd: 1 }, "chat", "u1", t0, "12ab56"));
});

// ---------------------------------------------------------------- memo + on-chain history
function ptx(opts: { signers: string[]; ixs: any[]; err?: any }) {
  return {
    meta: { err: opts.err ?? null, innerInstructions: [] },
    transaction: { signatures: ["SIG"], message: { accountKeys: opts.signers.map((k) => ({ pubkey: k, signer: true })), instructions: opts.ixs } },
  };
}
const usdcXfer = (src: string, dst: string, auth: string, amount: number) => ({
  program: "spl-token", parsed: { type: "transferChecked", info: { source: src, destination: dst, authority: auth, mint: USDC, tokenAmount: { amount: String(amount) } } },
});
const solXfer = (src: string, dst: string, lamports: number) => ({
  program: "system", programId: "11111111111111111111111111111111", parsed: { type: "transfer", info: { source: src, destination: dst, lamports } },
});
const memoIx = (t: string) => ({ program: "spl-memo", parsed: t });
const ctx = { lpWallet: LP, lpUsdcAta: LP_USDC_ATA, usdcMint: USDC, usdcAtaOf: (o: string) => (o === DEST ? DEST_USDC_ATA : "UnknownAta1111111111111111111111111111111111") };

test("memo round-trip; not mistaken for a fee-sweep memo", () => {
  const m = buildTransferOutMemo({ to: DEST, usd: 461.2, usdcRaw: 230_000_000, lamports: 1_540_000_000, spot: 150, pos: POS, eqAfter: 455.8 });
  assert.deepEqual(parseTransferOutMemo(`[120] ${m}`), { to: DEST, usd: 461.2, usdcRaw: 230_000_000, lamports: 1_540_000_000, spot: 150, pos: POS, eqAfter: 455.8 });
  assert.equal(parseSweepMemo(m), null);
  assert.equal(parseTransferOutMemo("dlmm-keeper:transfer-outX to=" + DEST), null);
  assert.equal(signatureHasTransferOutMemo({ memo: `[1] ${m}`, err: null }), true);
  assert.equal(signatureHasTransferOutMemo({ memo: `[1] ${m}`, err: { x: 1 } }), false);
  assert.equal(signatureHasTransferOutMemo({ memo: null }), false);
});

test("on-chain history: only LP-signed, successful transfers with the bot memo count; never as a fee sweep", () => {
  const memo = buildTransferOutMemo({ to: DEST, usd: 461, usdcRaw: 230_000_000, lamports: 1_540_000_000, spot: 150, pos: POS, eqAfter: 456 });
  const good = ptx({ signers: [LP], ixs: [usdcXfer(LP_USDC_ATA, DEST_USDC_ATA, LP, 230_000_000), solXfer(LP, DEST, 1_540_000_000), memoIx(memo)] });
  const t = parseTransferOutTx(good, ctx)!;
  assert.equal(t.usdcRaw, 230_000_000);
  assert.equal(t.lamports, 1_540_000_000);
  assert.equal(t.usd, 461);
  // Not signed by LP (anyone can write the memo) → ignored
  assert.equal(parseTransferOutTx(ptx({ signers: [OTHER], ixs: good.transaction.message.instructions }), ctx), null);
  // Failed tx → ignored
  assert.equal(parseTransferOutTx(ptx({ signers: [LP], ixs: good.transaction.message.instructions, err: { e: 1 } }), ctx), null);
  // Memo names DEST but money went elsewhere → 0 → ignored
  assert.equal(parseTransferOutTx(ptx({ signers: [LP], ixs: [solXfer(LP, OTHER, 5), memoIx(memo)] }), ctx), null);
  // The sweep scanner never counts a transfer out as a fee sweep.
  const sw = parseSweepTx(good, { lpWallet: LP, revWallet: REV, lpUsdcAta: LP_USDC_ATA, revUsdcAta: REV_USDC_ATA, usdcMint: USDC });
  assert.equal(sw.usdcRaw, 0);
  assert.equal(sw.solLamports, 0);

  const h = emptyTransferOutHistory();
  addToHistory(h, t);
  addToHistory(h, { ...t, usd: 10, memo: { ...t.memo, eqAfter: 446 } });
  assert.equal(h.totalUsd, 471);
  assert.equal(h.count, 2);
  assert.equal(h.eqAfterByPosition.get(POS), 446);
});

// ---------------------------------------------------------------- accounting
test("accounting: runtime transfer lowers baseline + entry equity; boot re-derives from chain", () => {
  const after = applyTransferOut({ capitalBaselineUsd: 900, entryEquityUsd: 917, transferredOutUsd: 0 }, 461);
  assert.deepEqual(after, { capitalBaselineUsd: 439, entryEquityUsd: 456, transferredOutUsd: 461 });
  // P&L invariant: equity and baseline both drop by X → P&L unchanged.
  const pnl = (eq: number, bl: number) => eq - bl;
  assert.equal(pnl(917, 900), pnl(917 - 461, after.capitalBaselineUsd));
  // Unset entry equity stays unset (pending read).
  assert.equal(applyTransferOut({ capitalBaselineUsd: 0, entryEquityUsd: 0, transferredOutUsd: 0 }, 10).entryEquityUsd, 0);

  // Boot: env baseline subtracts the on-chain total; boot-equity baseline already reflects it.
  assert.equal(baselineWithTransfersOut({ source: "env", baselineUsd: 900, priorTransferOutUsd: 461 }), 439);
  assert.equal(baselineWithTransfersOut({ source: "boot-equity", baselineUsd: 456, priorTransferOutUsd: 461 }), 456);

  // Stale ENTRY_EQUITY_USD pin (pre-transfer $915) is capped so the equity stop can't misfire at boot.
  const m = new Map([[POS, 454]]);
  assert.deepEqual(effectivePinnedEntryEquity(915, POS, m), { usd: 454, adjusted: true });
  assert.deepEqual(effectivePinnedEntryEquity(452, POS, m), { usd: 452, adjusted: false }); // already updated
  assert.deepEqual(effectivePinnedEntryEquity(915, "OtherPos", m), { usd: 915, adjusted: false });
  // 915 pinned × (1 − 5%) = 869 > live 456 would fire; capped 454 × 0.95 = 431 < 456 does not.
  assert.ok(456 < 915 * 0.95 && 456 > 454 * 0.95);
});
