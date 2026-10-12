import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEntryMemo, parseEntryMemo, findEntryMemos, resolveBootEntry, ENTRY_MEMO_TAG, EntryMemo } from "../entrymemo";

const POS_A = "3wwvwWXkgmgGAMCxFvpx4V2S8cuKwyDbREH64HCX1hCQ";
const POS_B = "DCPvPXcjqk1nGmqyCvHwYH3Bv1Yd3XA6xQw4vUiL9rbm";
const base: EntryMemo = { pos: POS_A, spot: 109.66, eq: 459.09, stopPct: 0.05, regime: "RANGE_CHOP", cooldownSec: 1800, src: "deploy" };

test("entry memo round-trips (incl. RPC '[len] text; [len] text' memo field)", () => {
  const m = buildEntryMemo(base);
  assert.ok(m.startsWith(ENTRY_MEMO_TAG + " "));
  assert.ok(Buffer.byteLength(m) < 566, "fits one memo instruction comfortably");
  const p = parseEntryMemo(`[${m.length}] ${m}; [10] other memo`);
  assert.ok(p && p.ok);
  if (p && p.ok) assert.deepEqual(p.memo, base);
});

test("no tag → null; corrupt memo → ok:false (checksum, truncation, bad fields)", () => {
  assert.equal(parseEntryMemo("dlmm-keeper:sweep id=1"), null);
  assert.equal(parseEntryMemo(null), null);
  const m = buildEntryMemo(base);
  const tampered = m.replace("spot=109.6600", "spot=10.6600");
  assert.deepEqual(parseEntryMemo(tampered), { ok: false, reason: "checksum mismatch" });
  const p2 = parseEntryMemo(m.slice(0, m.length - 12));
  assert.ok(p2 && p2.ok === false);
  const bad = buildEntryMemo({ ...base, eq: 0 });
  const p3 = parseEntryMemo(bad);
  assert.ok(p3 && p3.ok === false && /equity/.test((p3 as any).reason));
});

test("findEntryMemos: newest valid for the position wins; failed txs + corrupt memos skipped", () => {
  const recenter = buildEntryMemo({ ...base, src: "recenter" });
  const older = buildEntryMemo({ ...base, spot: 100, src: "deploy" });
  const other = buildEntryMemo({ ...base, pos: POS_B, spot: 120 });
  const sigs = [
    { signature: "s0", memo: buildEntryMemo({ ...base, spot: 1 }), err: { InstructionError: [0, "x"] } },
    { signature: "s1", memo: recenter.replace("ck=", "ck=0") },
    { signature: "s2", memo: other },
    { signature: "s3", memo: recenter, blockTime: 1760000000 },
    { signature: "s4", memo: older },
  ];
  const r = findEntryMemos(sigs, POS_A);
  assert.equal(r.forPosition?.sig, "s3");
  assert.equal(r.forPosition?.src, "recenter");
  assert.equal(r.newest?.sig, "s2");
  assert.equal(r.corrupt.length, 1);
});

test("resolveBootEntry precedence: pin > memo > live (with alert)", () => {
  const lookup = findEntryMemos([{ signature: "sig1", memo: buildEntryMemo(base) }], POS_A);
  const pin = resolveBootEntry({ attachedKey: POS_A, spotUsd: 108, pinApplies: true, pinSpot: 111, pinEquity: 400, pinStopPct: null, lookup });
  assert.equal(pin.source, "pin");
  const memo = resolveBootEntry({ attachedKey: POS_A, spotUsd: 108, pinApplies: false, pinSpot: null, pinEquity: null, pinStopPct: null, lookup });
  assert.equal(memo.source, "memo");
  if (memo.source === "memo") {
    assert.equal(memo.spot, 109.66);
    assert.equal(memo.eq, 459.09);
    assert.equal(memo.stopPct, 0.05);
  }
  const far = resolveBootEntry({ attachedKey: POS_A, spotUsd: 200, pinApplies: false, pinSpot: null, pinEquity: null, pinStopPct: null, lookup });
  assert.equal(far.source, "live");
  assert.ok((far as any).alert);
  const none = resolveBootEntry({ attachedKey: POS_B, spotUsd: 108, pinApplies: false, pinSpot: null, pinEquity: null, pinStopPct: null, lookup: findEntryMemos([], POS_B) });
  assert.equal(none.source, "live");
  assert.match((none as any).alert, /could not be recovered/);
  const err = resolveBootEntry({ attachedKey: POS_A, spotUsd: 108, pinApplies: false, pinSpot: null, pinEquity: null, pinStopPct: null, lookup: null, lookupError: "429" });
  assert.equal(err.source, "live");
  assert.match(err.note, /lookup failed/);
  const corrupt = findEntryMemos([{ signature: "c", memo: buildEntryMemo(base).replace("eq=459.09", "eq=999.09") }], POS_A);
  const rc = resolveBootEntry({ attachedKey: POS_A, spotUsd: 108, pinApplies: false, pinSpot: null, pinEquity: null, pinStopPct: null, lookup: corrupt });
  assert.equal(rc.source, "live");
  assert.match(rc.note, /corrupt/);
});

test("recenter + take-profit: memo for the new position carries the kept entry; TP memo carries the new one", () => {
  // Recenter keeps the ORIGINAL entry on the new position key; take-profit opens with a fresh entry.
  const sigs = [
    { signature: "tp", memo: buildEntryMemo({ ...base, pos: POS_B, spot: 118, eq: 470, src: "deploy" }) },
    { signature: "rc", memo: buildEntryMemo({ ...base, pos: POS_A, src: "recenter" }) },
  ];
  assert.equal(findEntryMemos(sigs, POS_A).forPosition?.spot, 109.66);
  assert.equal(findEntryMemos(sigs, POS_B).forPosition?.spot, 118);
});
