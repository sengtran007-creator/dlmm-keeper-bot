/**
 * /transfer_out — allow-listed, confirmed transfer of funds OUT of the LP wallet (pure helpers, unit-tested in
 * tests/transferout.test.ts). index.ts wires these to Telegram, the chain and the capital accounting.
 *
 * Safety model:
 *  - Disabled entirely unless TRANSFER_OUT_ALLOWLIST holds exactly ONE valid address that is neither the LP
 *    wallet nor the revenue wallet. The destination is NEVER taken from a Telegram message.
 *  - Only the configured TELEGRAM_CHAT_ID (required, strict match) and, if set, TRANSFER_OUT_USER_IDS may use it.
 *  - Only while the bot is PAUSED and the position was partly withdrawn (/withdraw_pct) or there is no position.
 *  - Two steps: `/transfer_out <usd|pct%>` quotes an exact plan + a one-time 6-digit code; `/confirm <code>`
 *    from the same chat and user within 60 s sends exactly the quoted amounts (re-validated against fresh balances).
 *  - Capped (TRANSFER_OUT_MAX_USD and a share of equity) and never takes native SOL below
 *    GAS_RESERVE + margin + tx fee (+ the destination USDC account rent when the bot has to create it).
 *  - Every transfer carries an on-chain memo (USD value, spot, position, entry equity after) so the capital
 *    accounting is re-derived from chain at boot — no env edit needed for P&L.
 */

import { sweepRawFromParsedTx, solSweepLamportsFromParsedTx, isSignedBy, memosFromParsedTx, SWEEP_MEMO_PREFIX } from "./feesweep";

export const TRANSFER_OUT_MEMO_KIND = "transfer-out";
export const TRANSFER_OUT_MEMO_TAG = `${SWEEP_MEMO_PREFIX}${TRANSFER_OUT_MEMO_KIND}`;
export const TRANSFER_OUT_CONFIRM_TTL_MS = 60_000;
export const TRANSFER_OUT_MAX_CODE_ATTEMPTS = 3;
/** Typo guard: no single transfer above this, whatever TRANSFER_OUT_MAX_USD says. */
export const TRANSFER_OUT_HARD_CEILING_USD = 5_000;
export const TRANSFER_OUT_DEFAULT_MAX_USD = 600;
export const TRANSFER_OUT_DEFAULT_MAX_EQUITY_PCT = 60;
/** Below this the SOL leg is dropped (a new destination account needs ≥ 890,880 lamports rent-exempt). */
export const TRANSFER_OUT_MIN_SOL_LEG_LAMPORTS = 1_000_000;
/** Rent for a new associated token account (165 bytes). */
export const ATA_RENT_LAMPORTS = 2_039_280;
/** The feature ships after this time; boot scans of the LP wallet stop here (complete = reached it). */
export const TRANSFER_OUT_FEATURE_EPOCH_UNIX = 1_791_504_000; // 2026-10-09T00:00:00Z

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------------------------------------------------------------- config

export interface AllowlistResult {
  enabled: boolean;
  address: string | null;
  reason: string;
}

/**
 * TRANSFER_OUT_ALLOWLIST → the single allowed destination. Anything else (unset, several addresses, not base58,
 * the LP wallet itself, the revenue wallet — that would be counted as a fee sweep) disables the command.
 * `isValidPubkey` is injected (index.ts: new PublicKey(x) + on-curve check) to keep this module pure.
 */
export function parseTransferAllowlist(
  raw: string | undefined | null,
  ctx: { lpWallet: string; revenueWallet: string; isValidPubkey?: (s: string) => boolean }
): AllowlistResult {
  const s = String(raw ?? "").trim();
  if (!s) return { enabled: false, address: null, reason: "TRANSFER_OUT_ALLOWLIST unset" };
  const parts = s.split(/[\s,;]+/).filter(Boolean);
  if (parts.length !== 1) return { enabled: false, address: null, reason: "TRANSFER_OUT_ALLOWLIST must hold exactly one address" };
  const a = parts[0];
  if (!BASE58_RE.test(a) || (ctx.isValidPubkey && !ctx.isValidPubkey(a))) {
    return { enabled: false, address: null, reason: "TRANSFER_OUT_ALLOWLIST is not a valid wallet address" };
  }
  if (a === ctx.lpWallet) return { enabled: false, address: null, reason: "TRANSFER_OUT_ALLOWLIST is this bot's own wallet" };
  if (a === ctx.revenueWallet) {
    return { enabled: false, address: null, reason: "TRANSFER_OUT_ALLOWLIST is the revenue wallet (would be counted as a fee sweep)" };
  }
  return { enabled: true, address: a, reason: "ok" };
}

export function resolveMaxUsd(raw: string | undefined | null): number {
  const n = Number(String(raw ?? "").trim() || NaN);
  const v = Number.isFinite(n) && n > 0 ? n : TRANSFER_OUT_DEFAULT_MAX_USD;
  return Math.min(v, TRANSFER_OUT_HARD_CEILING_USD);
}

export function resolveMaxEquityPct(raw: string | undefined | null): number {
  const n = Number(String(raw ?? "").trim() || NaN);
  const v = Number.isFinite(n) && n > 0 ? n : TRANSFER_OUT_DEFAULT_MAX_EQUITY_PCT;
  return Math.min(v, 90);
}

/** "123, 456" → Set of Telegram user ids ("" → empty = any user in the configured chat). */
export function parseUserIds(raw: string | undefined | null): Set<string> {
  return new Set(String(raw ?? "").split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^-?\d+$/.test(x)));
}

// ---------------------------------------------------------------- command

export type TransferMode = "mix" | "usdc";
export interface TransferRequest {
  kind: "usd" | "pct";
  value: number;
  mode: TransferMode;
}

/**
 * `/transfer_out 461` (USD), `/transfer_out 461 usdc` (USDC only), `/transfer_out 100%` (share of what is
 * transferable: wallet USDC + native SOL above the gas floor). Also accepts "$461" and "/transfer_out@botname".
 * Never accepts an address — the destination comes from env only.
 */
export function parseTransferOutCommand(text: string): { ok: true; req: TransferRequest } | { ok: false; error: string } {
  const usage = "Usage: /transfer_out <usd> | <pct>% [usdc]  e.g. /transfer_out 461  or  /transfer_out 100%";
  const tokens = String(text ?? "").trim().split(/\s+/);
  const cmd = (tokens.shift() || "").toLowerCase().replace(/@\S+$/, "");
  if (cmd !== "/transfer_out") return { ok: false, error: usage };
  if (tokens.length < 1 || tokens.length > 2) return { ok: false, error: usage };
  let mode: TransferMode = "mix";
  if (tokens.length === 2) {
    const m = tokens[1].toLowerCase();
    if (m === "usdc") mode = "usdc";
    else if (m === "mix" || m === "all") mode = "mix";
    else return { ok: false, error: usage };
  }
  const amt = tokens[0].replace(/^\$/, "");
  const isPct = amt.endsWith("%");
  const num = isPct ? amt.slice(0, -1) : amt;
  if (!/^\d+(\.\d{1,6})?$/.test(num)) return { ok: false, error: usage };
  const value = Number(num);
  if (!(value > 0)) return { ok: false, error: "Amount must be > 0." };
  if (isPct && value > 100) return { ok: false, error: "Percent must be 1–100." };
  return { ok: true, req: { kind: isPct ? "pct" : "usd", value, mode } };
}

export function parseConfirmCommand(text: string): string | null {
  const m = /^\/confirm(?:@\S+)?\s+(\d{6})\s*$/i.exec(String(text ?? "").trim());
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- preconditions

export interface TransferGate {
  enabled: boolean;
  disabledReason?: string;
  chatIdConfigured: boolean;
  chatMatches: boolean;
  userAllowed: boolean;
  paused: boolean;
  partialWithdrawPending: boolean;
  hasOpenPosition: boolean;
  busy: boolean;
}

export function checkTransferPreconditions(g: TransferGate): { ok: boolean; reason: string } {
  if (!g.enabled) return { ok: false, reason: `/transfer_out is disabled (${g.disabledReason || "TRANSFER_OUT_ALLOWLIST unset"}).` };
  if (!g.chatIdConfigured) return { ok: false, reason: "/transfer_out needs TELEGRAM_CHAT_ID set (commands from any chat are refused)." };
  if (!g.chatMatches) return { ok: false, reason: "wrong chat" };
  if (!g.userAllowed) return { ok: false, reason: "this Telegram user is not in TRANSFER_OUT_USER_IDS." };
  if (!g.paused) return { ok: false, reason: "bot is not paused — run /withdraw_pct N first (it pauses the bot)." };
  if (g.hasOpenPosition && !g.partialWithdrawPending) {
    return { ok: false, reason: "position is open and nothing was withdrawn — run /withdraw_pct N first." };
  }
  if (g.busy) return { ok: false, reason: "another position action or SOL transfer is in flight — try again in a minute." };
  return { ok: true, reason: "ok" };
}

// ---------------------------------------------------------------- sizing

export interface TransferPlanInput {
  req: TransferRequest;
  usdcRaw: number;
  nativeLamports: number;
  spotUsd: number;
  /** Live total equity (position + wallet), for the share-of-equity cap. null/NaN = unknown → refuse. */
  equityUsd: number | null;
  gasReserveLamports: number;
  marginLamports: number;
  txFeeLamports: number;
  /** 0 when the destination USDC account exists (or no USDC leg); ATA_RENT_LAMPORTS otherwise. */
  ataRentLamports: number;
  maxUsd: number;
  maxEquityPct: number;
  minSolLegLamports?: number;
}

export interface TransferPlan {
  ok: boolean;
  reason: string;
  usdcRaw: number;
  lamports: number;
  usd: number;
  /** Everything that could leave (USDC + SOL above floor), USD. */
  transferableUsd: number;
  /** Native SOL that stays in the LP wallet after the transfer + fee (+ ATA rent). */
  remainingLamports: number;
  floorLamports: number;
}

export function planTransferOut(p: TransferPlanInput): TransferPlan {
  const minSol = p.minSolLegLamports ?? TRANSFER_OUT_MIN_SOL_LEG_LAMPORTS;
  const usdcRaw = Math.max(0, Math.floor(p.usdcRaw || 0));
  const native = Math.max(0, Math.floor(p.nativeLamports || 0));
  const floor = Math.max(0, p.gasReserveLamports) + Math.max(0, p.marginLamports) + Math.max(0, p.txFeeLamports) + Math.max(0, p.ataRentLamports);
  const solFree = p.req.mode === "usdc" ? 0 : Math.max(0, native - floor);
  const fail = (reason: string, transferableUsd = 0): TransferPlan => ({
    ok: false, reason, usdcRaw: 0, lamports: 0, usd: 0, transferableUsd, remainingLamports: native, floorLamports: floor,
  });
  if (!(p.spotUsd > 0) || !Number.isFinite(p.spotUsd)) return fail("invalid spot price");
  const transferableUsd = usdcRaw / 1e6 + (solFree / 1e9) * p.spotUsd;
  if (!(transferableUsd > 0)) return fail("nothing transferable (no USDC and native SOL is at the gas floor)", 0);
  const target = p.req.kind === "pct" ? (transferableUsd * p.req.value) / 100 : p.req.value;
  if (!(target > 0)) return fail("amount must be > 0", transferableUsd);
  if (target > p.maxUsd + 1e-9) return fail(`$${target.toFixed(2)} is above the cap $${p.maxUsd.toFixed(2)} (TRANSFER_OUT_MAX_USD)`, transferableUsd);
  if (p.equityUsd == null || !Number.isFinite(p.equityUsd) || !(p.equityUsd > 0)) {
    return fail("live equity unreadable — refusing (cap is a share of equity)", transferableUsd);
  }
  const eqCap = (p.equityUsd * p.maxEquityPct) / 100;
  if (target > eqCap + 1e-9) {
    return fail(`$${target.toFixed(2)} is above ${p.maxEquityPct}% of equity ($${eqCap.toFixed(2)}; TRANSFER_OUT_MAX_EQUITY_PCT)`, transferableUsd);
  }
  if (target > transferableUsd + 0.005) {
    return fail(
      `only $${transferableUsd.toFixed(2)} is transferable (${(usdcRaw / 1e6).toFixed(2)} USDC` +
        (p.req.mode === "usdc" ? ", USDC only" : ` + ${(solFree / 1e9).toFixed(4)} SOL above the ${(floor / 1e9).toFixed(4)} SOL floor`) +
        `) — /withdraw_pct more first`,
      transferableUsd
    );
  }
  const usdcLeg = Math.min(usdcRaw, Math.floor(target * 1e6 + 1e-6));
  const restUsd = Math.max(0, target - usdcLeg / 1e6);
  let lamports = Math.min(solFree, Math.floor((restUsd / p.spotUsd) * 1e9));
  if (lamports > 0 && lamports < minSol) lamports = 0;
  const usd = usdcLeg / 1e6 + (lamports / 1e9) * p.spotUsd;
  if (!(usd > 0)) return fail("amount rounds to zero", transferableUsd);
  const usedRent = usdcLeg > 0 ? Math.max(0, p.ataRentLamports) : 0;
  return {
    ok: true,
    reason: "ok",
    usdcRaw: usdcLeg,
    lamports,
    usd: Number(usd.toFixed(6)),
    transferableUsd,
    remainingLamports: native - lamports - Math.max(0, p.txFeeLamports) - usedRent,
    floorLamports: floor,
  };
}

/**
 * At /confirm: the QUOTED amounts are sent unchanged, but only if they still fit fresh balances, the gas floor
 * and the caps at the fresh spot. Otherwise refuse (re-quote).
 */
export function revalidateQuotedPlan(
  quoted: { usdcRaw: number; lamports: number },
  fresh: Omit<TransferPlanInput, "req">
): { ok: boolean; reason: string; usd: number } {
  const floor = Math.max(0, fresh.gasReserveLamports) + Math.max(0, fresh.marginLamports) + Math.max(0, fresh.txFeeLamports) +
    (quoted.usdcRaw > 0 ? Math.max(0, fresh.ataRentLamports) : 0);
  if (!(fresh.spotUsd > 0)) return { ok: false, reason: "invalid spot price", usd: 0 };
  if (quoted.usdcRaw > Math.floor(fresh.usdcRaw)) return { ok: false, reason: "wallet USDC dropped since the quote", usd: 0 };
  if (quoted.lamports > 0 && fresh.nativeLamports - quoted.lamports < floor) {
    return { ok: false, reason: "native SOL would drop below the gas floor at current balances", usd: 0 };
  }
  const usd = quoted.usdcRaw / 1e6 + (quoted.lamports / 1e9) * fresh.spotUsd;
  if (usd > fresh.maxUsd + 1e-9) return { ok: false, reason: `value now $${usd.toFixed(2)} > cap $${fresh.maxUsd.toFixed(2)}`, usd };
  if (fresh.equityUsd == null || !(fresh.equityUsd > 0)) return { ok: false, reason: "live equity unreadable", usd };
  if (usd > (fresh.equityUsd * fresh.maxEquityPct) / 100 + 1e-9) return { ok: false, reason: `value now above ${fresh.maxEquityPct}% of equity`, usd };
  return { ok: true, reason: "ok", usd: Number(usd.toFixed(6)) };
}

// ---------------------------------------------------------------- confirmation

export interface PendingTransfer<P> {
  code: string;
  chatId: string;
  userId: string;
  createdMs: number;
  expiresMs: number;
  plan: P;
  attempts: number;
}

/** One pending transfer at a time; a code is single-use, expires after ttlMs, and dies after 3 wrong codes. */
export class TransferConfirmations<P> {
  private pending: PendingTransfer<P> | null = null;
  constructor(private ttlMs = TRANSFER_OUT_CONFIRM_TTL_MS, private maxAttempts = TRANSFER_OUT_MAX_CODE_ATTEMPTS) {}

  create(plan: P, chatId: string, userId: string, nowMs: number, code: string): PendingTransfer<P> {
    if (!/^\d{6}$/.test(code)) throw new Error("confirmation code must be 6 digits");
    this.pending = { code, chatId, userId, createdMs: nowMs, expiresMs: nowMs + this.ttlMs, plan, attempts: 0 };
    return this.pending;
  }

  peek(nowMs: number): PendingTransfer<P> | null {
    if (this.pending && nowMs > this.pending.expiresMs) this.pending = null;
    return this.pending;
  }

  cancel(): boolean {
    const had = !!this.pending;
    this.pending = null;
    return had;
  }

  /** Consumes the pending transfer on success (or when it expired / ran out of attempts). */
  confirm(code: string, chatId: string, userId: string, nowMs: number):
    | { ok: true; pending: PendingTransfer<P> }
    | { ok: false; reason: "none" | "expired" | "wrong_chat" | "wrong_user" | "wrong_code" | "too_many_attempts" } {
    const p = this.pending;
    if (!p) return { ok: false, reason: "none" };
    if (nowMs > p.expiresMs) {
      this.pending = null;
      return { ok: false, reason: "expired" };
    }
    if (chatId !== p.chatId) return { ok: false, reason: "wrong_chat" };
    if (userId !== p.userId) return { ok: false, reason: "wrong_user" };
    if (code !== p.code) {
      p.attempts += 1;
      if (p.attempts >= this.maxAttempts) {
        this.pending = null;
        return { ok: false, reason: "too_many_attempts" };
      }
      return { ok: false, reason: "wrong_code" };
    }
    this.pending = null;
    return { ok: true, pending: p };
  }
}

// ---------------------------------------------------------------- memo

export interface TransferOutMemo {
  to: string;
  usd?: number;
  usdcRaw?: number;
  lamports?: number;
  spot?: number;
  /** Position open at transfer time ("none" if none). */
  pos?: string;
  /** Entry equity (USD) after the transfer — caps a stale ENTRY_EQUITY_USD pin for that position at boot. */
  eqAfter?: number;
}

export function buildTransferOutMemo(m: TransferOutMemo): string {
  const parts = [TRANSFER_OUT_MEMO_TAG, `to=${m.to}`];
  if (m.usd != null && Number.isFinite(m.usd)) parts.push(`usd=${m.usd.toFixed(6)}`);
  if (m.usdcRaw != null) parts.push(`usdc=${Math.floor(m.usdcRaw)}`);
  if (m.lamports != null) parts.push(`lamports=${Math.floor(m.lamports)}`);
  if (m.spot != null && Number.isFinite(m.spot)) parts.push(`spot=${m.spot.toFixed(4)}`);
  parts.push(`pos=${m.pos || "none"}`);
  if (m.eqAfter != null && Number.isFinite(m.eqAfter)) parts.push(`eq_after=${m.eqAfter.toFixed(2)}`);
  return parts.join(" ");
}

export function parseTransferOutMemo(text: string | null | undefined): TransferOutMemo | null {
  if (!text) return null;
  const s = String(text);
  const at = s.indexOf(TRANSFER_OUT_MEMO_TAG);
  if (at < 0) return null;
  const rest = s.slice(at + TRANSFER_OUT_MEMO_TAG.length);
  if (rest && !/^\s/.test(rest)) return null;
  const out: Partial<TransferOutMemo> = {};
  for (const t of rest.trim().split(/\s+/)) {
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq);
    const v = t.slice(eq + 1).replace(/["';]+$/, "");
    if (k === "to" && BASE58_RE.test(v)) out.to = v;
    else if (k === "pos" && (v === "none" || BASE58_RE.test(v))) out.pos = v;
    else if ((k === "usdc" || k === "lamports") && /^\d+$/.test(v)) out[k === "usdc" ? "usdcRaw" : "lamports"] = Number(v);
    else if ((k === "usd" || k === "spot" || k === "eq_after") && /^\d+(\.\d+)?$/.test(v)) out[k === "eq_after" ? "eqAfter" : k] = Number(v);
  }
  return out.to ? (out as TransferOutMemo) : null;
}

// ---------------------------------------------------------------- on-chain history

export interface ParsedTransferOut {
  to: string;
  usdcRaw: number;
  lamports: number;
  usd: number;
  memo: TransferOutMemo;
}

/**
 * A transfer-out the LP wallet actually made: memo in a tx SIGNED by the LP wallet (not failed), amounts read
 * from the transfers themselves (LP USDC ATA → destination USDC ATA with the LP wallet as authority, and native
 * SOL LP → destination), valued with the memo's spot. Returns null for anything else.
 */
export function parseTransferOutTx(
  tx: any,
  ctx: { lpWallet: string; lpUsdcAta: string; usdcMint: string; usdcAtaOf: (owner: string) => string }
): ParsedTransferOut | null {
  if (!tx || tx.meta?.err) return null;
  if (!isSignedBy(tx, ctx.lpWallet)) return null;
  const memo = memosFromParsedTx(tx).map(parseTransferOutMemo).find((m) => m != null) ?? null;
  if (!memo) return null;
  let destAta = "";
  try {
    destAta = ctx.usdcAtaOf(memo.to);
  } catch {
    destAta = "";
  }
  const usdcRaw = destAta ? sweepRawFromParsedTx(tx, ctx.lpWallet, ctx.lpUsdcAta, destAta, ctx.usdcMint) : 0;
  const lamports = solSweepLamportsFromParsedTx(tx, ctx.lpWallet, memo.to);
  if (usdcRaw <= 0 && lamports <= 0) return null;
  let usd: number;
  if (memo.spot != null && memo.spot > 0) usd = usdcRaw / 1e6 + (lamports / 1e9) * memo.spot;
  else if (memo.usd != null) usd = memo.usd;
  else usd = usdcRaw / 1e6; // no spot recorded: SOL leg unvalued (never happens for bot-written memos)
  return { to: memo.to, usdcRaw, lamports, usd: Number(usd.toFixed(6)), memo };
}

export interface TransferOutHistory {
  ok: boolean;
  /** Reached TRANSFER_OUT_FEATURE_EPOCH (or the start of the wallet's history) within the scan budget. */
  complete: boolean;
  totalUsd: number;
  count: number;
  /** Lowest entry-equity-after per position (from memos), to cap a stale ENTRY_EQUITY_USD pin. */
  eqAfterByPosition: Map<string, number>;
  scannedSigs: number;
}

export function emptyTransferOutHistory(): TransferOutHistory {
  return { ok: false, complete: false, totalUsd: 0, count: 0, eqAfterByPosition: new Map(), scannedSigs: 0 };
}

export function addToHistory(h: TransferOutHistory, t: ParsedTransferOut): void {
  h.totalUsd = Number((h.totalUsd + t.usd).toFixed(6));
  h.count += 1;
  const pos = t.memo.pos;
  if (pos && pos !== "none" && t.memo.eqAfter != null) {
    const prev = h.eqAfterByPosition.get(pos);
    h.eqAfterByPosition.set(pos, prev == null ? t.memo.eqAfter : Math.min(prev, t.memo.eqAfter));
  }
}

/** getSignaturesForAddress entries carry the memo text: only these need a full transaction fetch. */
export function signatureHasTransferOutMemo(sig: { memo?: string | null; err?: any }): boolean {
  return !sig.err && typeof sig.memo === "string" && sig.memo.includes(TRANSFER_OUT_MEMO_TAG);
}

// ---------------------------------------------------------------- accounting

/**
 * Capital baseline after transfers out. Env baseline (STARTING_CAPITAL_USD + NET_DEPOSITS_USD) does NOT know
 * about bot transfers → subtract the on-chain total. A boot-equity baseline already reflects them → unchanged.
 */
export function baselineWithTransfersOut(p: {
  source: "env" | "boot-equity";
  baselineUsd: number;
  priorTransferOutUsd: number;
}): number {
  if (p.source !== "env") return p.baselineUsd;
  return Number((p.baselineUsd - Math.max(0, p.priorTransferOutUsd)).toFixed(2));
}

/** Runtime: a transfer just landed. Capital baseline and entry equity both drop by its USD value. */
export function applyTransferOut(
  s: { capitalBaselineUsd: number; entryEquityUsd: number; transferredOutUsd: number },
  usd: number
): { capitalBaselineUsd: number; entryEquityUsd: number; transferredOutUsd: number } {
  const u = Math.max(0, usd);
  return {
    capitalBaselineUsd: Number((s.capitalBaselineUsd - u).toFixed(2)),
    entryEquityUsd: s.entryEquityUsd > 0 ? Number(Math.max(0, s.entryEquityUsd - u).toFixed(2)) : s.entryEquityUsd,
    transferredOutUsd: Number((s.transferredOutUsd + u).toFixed(6)),
  };
}

/**
 * Boot attach with an ENTRY_EQUITY_USD pin for `position`: if this bot transferred funds out of that position's
 * wallet after the pin was taken, a stale (pre-transfer) pin would fire the equity stop at once. Use the lower of
 * the pin and the on-chain entry-equity-after. A lower pin wins (the operator already updated it).
 */
export function effectivePinnedEntryEquity(
  pinUsd: number,
  position: string,
  eqAfterByPosition: Map<string, number>
): { usd: number; adjusted: boolean } {
  const after = eqAfterByPosition.get(position);
  if (after != null && after > 0 && after < pinUsd) return { usd: after, adjusted: true };
  return { usd: pinUsd, adjusted: false };
}
