// H2: the entry (spot, equity, locked stop %) of every position the bot opens is written on chain as an SPL memo
// (one tiny memo-only tx from the LP wallet right after the open). At boot the bot recovers the entry of the
// position it attaches to from the wallet's signature list (getSignaturesForAddress returns memo text, so no
// getTransaction is needed). ENTRY_* pins stay an optional override. Pure helpers here; I/O lives in index.ts.
import { SWEEP_MEMO_PREFIX } from "./feesweep";

export const ENTRY_MEMO_KIND = "entry";
export const ENTRY_MEMO_TAG = `${SWEEP_MEMO_PREFIX}${ENTRY_MEMO_KIND}`;
export const ENTRY_MEMO_VERSION = 1;

export type EntrySource = "deploy" | "recenter" | "take-profit" | "resume" | "adopt" | "boot";

export interface EntryMemo {
  pos: string;
  spot: number;
  eq: number;
  stopPct: number;
  regime: string;
  cooldownSec: number;
  src: string;
}

/** 32-bit FNV-1a over the canonical field string: catches truncated / hand-edited / garbled memos. */
export function memoChecksum(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function canonical(m: EntryMemo): string {
  return [
    `v=${ENTRY_MEMO_VERSION}`,
    `pos=${m.pos}`,
    `spot=${m.spot.toFixed(4)}`,
    `eq=${m.eq.toFixed(2)}`,
    `stop=${m.stopPct.toFixed(4)}`,
    `regime=${m.regime}`,
    `cd=${Math.round(m.cooldownSec)}`,
    `src=${m.src}`,
  ].join(" ");
}

export function buildEntryMemo(m: EntryMemo): string {
  const c = canonical(m);
  return `${ENTRY_MEMO_TAG} ${c} ck=${memoChecksum(c)}`;
}

export type ParsedEntryMemo = { ok: true; memo: EntryMemo } | { ok: false; reason: string };

/**
 * Parses one memo text (a getSignaturesForAddress memo field may hold several memos: "[len] text; [len] text").
 * Returns null when no entry tag is present at all; ok:false when the tag is there but the memo is corrupt.
 */
export function parseEntryMemo(text: string | null | undefined): ParsedEntryMemo | null {
  if (!text) return null;
  const s = String(text);
  const at = s.indexOf(ENTRY_MEMO_TAG + " ");
  if (at < 0) return null;
  let rest = s.slice(at + ENTRY_MEMO_TAG.length + 1);
  const semi = rest.indexOf(";");
  if (semi >= 0) rest = rest.slice(0, semi);
  rest = rest.trim();
  const ckAt = rest.lastIndexOf(" ck=");
  if (ckAt < 0) return { ok: false, reason: "no checksum" };
  const body = rest.slice(0, ckAt);
  const ck = rest.slice(ckAt + 4).trim();
  if (memoChecksum(body) !== ck) return { ok: false, reason: "checksum mismatch" };
  const f: Record<string, string> = {};
  for (const part of body.split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) f[part.slice(0, eq)] = part.slice(eq + 1);
  }
  if (Number(f.v) !== ENTRY_MEMO_VERSION) return { ok: false, reason: `unsupported version ${f.v}` };
  const memo: EntryMemo = {
    pos: f.pos || "",
    spot: Number(f.spot),
    eq: Number(f.eq),
    stopPct: Number(f.stop),
    regime: f.regime || "",
    cooldownSec: Number(f.cd),
    src: f.src || "",
  };
  const v = validateEntryMemo(memo);
  if (v.ok === false) return { ok: false, reason: (v as { reason: string }).reason };
  return { ok: true, memo };
}

export function validateEntryMemo(m: EntryMemo): { ok: true } | { ok: false; reason: string } {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m.pos)) return { ok: false, reason: "bad position key" };
  if (!(Number.isFinite(m.spot) && m.spot > 0)) return { ok: false, reason: "bad spot" };
  if (!(Number.isFinite(m.eq) && m.eq > 0)) return { ok: false, reason: "bad equity" };
  if (!(Number.isFinite(m.stopPct) && m.stopPct >= 0.005 && m.stopPct <= 0.5)) return { ok: false, reason: "bad stop pct" };
  if (!(Number.isFinite(m.cooldownSec) && m.cooldownSec >= 0)) return { ok: false, reason: "bad cooldown" };
  return { ok: true };
}

export interface SigWithMemo {
  signature: string;
  memo?: string | null;
  err?: any;
  blockTime?: number | null;
}

export interface EntryLookup {
  /** Newest valid memo for the requested position. */
  forPosition: (EntryMemo & { sig: string; blockTime: number | null }) | null;
  /** Newest valid memo for ANY position (flat-with-SOL boot uses it as the kept entry). */
  newest: (EntryMemo & { sig: string; blockTime: number | null }) | null;
  /** Corrupt entry memos seen (signature + reason). */
  corrupt: { sig: string; reason: string }[];
}

/** sigs newest-first (getSignaturesForAddress order). Failed txs are ignored. */
export function findEntryMemos(sigs: SigWithMemo[], position: string | null): EntryLookup {
  const out: EntryLookup = { forPosition: null, newest: null, corrupt: [] };
  for (const s of sigs) {
    if (s.err) continue;
    const p = parseEntryMemo(s.memo);
    if (!p) continue;
    if (p.ok === false) {
      out.corrupt.push({ sig: s.signature, reason: (p as { reason: string }).reason });
      continue;
    }
    const rec = { ...p.memo, sig: s.signature, blockTime: s.blockTime ?? null };
    if (!out.newest) out.newest = rec;
    if (position && !out.forPosition && p.memo.pos === position) out.forPosition = rec;
    if (out.newest && (out.forPosition || !position)) break;
  }
  return out;
}

export type EntryResolution =
  | { source: "pin"; spot: number | null; eq: number | null; stopPct: number | null; note: string }
  | { source: "memo"; spot: number; eq: number; stopPct: number; regime: string; cooldownSec: number; note: string }
  | { source: "live"; note: string; alert: string | null };

/**
 * Boot entry for the attached position. Precedence: a pin for THIS position (explicit override) > the on-chain
 * memo for this position (sanity-checked against spot) > live values (entry reset) with an alert.
 */
export function resolveBootEntry(p: {
  attachedKey: string;
  spotUsd: number;
  pinApplies: boolean;
  pinSpot: number | null;
  pinEquity: number | null;
  pinStopPct: number | null;
  lookup: EntryLookup | null;
  lookupError?: string | null;
  /** A memo whose entry spot is further than this from spot is rejected (garbage protection). */
  maxSpotDistance?: number;
}): EntryResolution {
  if (p.pinApplies) {
    return { source: "pin", spot: p.pinSpot, eq: p.pinEquity, stopPct: p.pinStopPct, note: "ENTRY_* pin (override) applied" };
  }
  const maxDist = p.maxSpotDistance ?? 0.3;
  const m = p.lookup?.forPosition ?? null;
  if (m) {
    const dist = Math.abs(m.spot / p.spotUsd - 1);
    if (Number.isFinite(dist) && dist <= maxDist) {
      return {
        source: "memo", spot: m.spot, eq: m.eq, stopPct: m.stopPct, regime: m.regime, cooldownSec: m.cooldownSec,
        note: `recovered from on-chain memo ${m.sig.slice(0, 8)}… (${m.src})`,
      };
    }
    return {
      source: "live",
      note: `on-chain memo rejected (entry $${m.spot.toFixed(2)} is ${(dist * 100).toFixed(1)}% from spot)`,
      alert: `Entry memo for ${p.attachedKey.slice(0, 8)}… rejected (entry $${m.spot.toFixed(2)} vs spot $${p.spotUsd.toFixed(2)}) — entry reset to live values.`,
    };
  }
  const why = p.lookupError
    ? `memo lookup failed (${p.lookupError})`
    : (p.lookup?.corrupt.length ?? 0) > 0
      ? `only corrupt entry memo(s) found (${p.lookup!.corrupt[0].reason})`
      : "no entry memo for this position (opened before memos, or the memo tx failed)";
  return {
    source: "live",
    note: why,
    alert: `Entry for ${p.attachedKey.slice(0, 8)}… could not be recovered: ${why}. Entry reset to live values (stop at the default %). Set ENTRY_* pins to override.`,
  };
}
