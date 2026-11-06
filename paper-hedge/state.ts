import fs from "fs";
import path from "path";
import { Book, freshBook } from "./engine";

const VERSION = 1;

export function encodeState(book: Book): string {
  return JSON.stringify({ version: VERSION, book }, null, 2);
}

export function decodeState(raw: string, fallback: Book): { book: Book; ok: boolean; reason?: string } {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== VERSION || !parsed.book || typeof parsed.book !== "object") {
      return { book: fallback, ok: false, reason: "unexpected state shape" };
    }
    const b = parsed.book;
    const book: Book = {
      ...freshBook(Number(b.baselineUsd) || fallback.baselineUsd),
      shortSol: finite(b.shortSol, 0),
      avgEntrySolPx: finite(b.avgEntrySolPx, 0),
      realizedUsd: finite(b.realizedUsd, 0),
      feesUsd: finite(b.feesUsd, 0),
      fundingUsd: finite(b.fundingUsd, 0),
      appliedFunding: b.appliedFunding && typeof b.appliedFunding === "object" ? b.appliedFunding : {},
      fingerprint: typeof b.fingerprint === "string" ? b.fingerprint : null,
      baselineUsd: finite(b.baselineUsd, fallback.baselineUsd),
      lastLogMs: finite(b.lastLogMs, 0),
      lastMarkSolPx: finite(b.lastMarkSolPx, 0),
      watchedFundingMs: b.watchedFundingMs == null ? null : finite(b.watchedFundingMs, 0) || null,
      openedAtMs: b.openedAtMs == null ? null : finite(b.openedAtMs, 0) || null,
    };
    if (book.shortSol < 0 || !Number.isFinite(book.shortSol)) return { book: fallback, ok: false, reason: "bad short" };
    return { book, ok: true };
  } catch (err: any) {
    return { book: fallback, ok: false, reason: err?.message || "parse error" };
  }
}

function finite(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function readStateFile(file: string, fallback: Book): { book: Book; loaded: boolean; reason?: string } {
  try {
    if (!fs.existsSync(file)) return { book: fallback, loaded: false, reason: "no state file" };
    const decoded = decodeState(fs.readFileSync(file, "utf8"), fallback);
    return { book: decoded.book, loaded: decoded.ok, reason: decoded.reason };
  } catch (err: any) {
    return { book: fallback, loaded: false, reason: err?.message || "read failed" };
  }
}

export function writeStateFile(file: string, book: Book): void {
  const dir = path.dirname(file);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, encodeState(book));
  fs.renameSync(tmp, file);
}
