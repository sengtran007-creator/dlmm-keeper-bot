/**
 * Fee-sweep helpers (pure / dependency-injected, unit-tested in tests/feesweep.test.ts).
 *
 * - FEE_CLAIM ledger fields that value BOTH halves of a claim (USDC + SOL × spot) exactly once.
 * - Native-SOL fallback sweep sizing that never takes the LP wallet below the gas reserve + margin.
 * - Parsing of on-chain sweeps (USDC transfers + native SOL transfers LP → revenue, signed by the LP wallet)
 *   and of the bot's own sweep memos (USD value stored at sweep time; catch-up markers).
 * - "Did this signature land?" logic that waits for blockhash expiry, so a retry can never double-send.
 */

export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const SWEEP_MEMO_PREFIX = "dlmm-keeper:";

// ---------------------------------------------------------------- FEE_CLAIM ledger fields

export interface FeeClaimLedgerFields {
  /** USDC + SOL × spot (USD). The dashboard sums this column for FEE_CLAIM rows. */
  fees_claimed_usd: number;
  fees_sol: number;
  fees_usdc: number;
  fees_sol_usd: number;
  fee_spot_usd: number | undefined;
  notes: string;
}

/**
 * Both halves of a claim, valued once.
 * NOTE: notes deliberately do NOT contain the legacy token "feeX(SOL)=" — the Executive PnL "Fees earned"
 * formula adds REGEXEXTRACT(notes,"feeX\(SOL\)=…") × spot on top of fees_claimed_usd for old rows, which
 * would count the SOL half twice now that fees_claimed_usd already includes it.
 * If spot is unusable the SOL half is left out of fees_claimed_usd (USDC only) and the note says so.
 */
export function feeClaimLedgerFields(claimedUsdcRaw: number, claimedSolLamports: number, spotUsd: number): FeeClaimLedgerFields {
  const usdc = Math.max(0, claimedUsdcRaw) / 1e6;
  const sol = Math.max(0, claimedSolLamports) / 1e9;
  const spotOk = Number.isFinite(spotUsd) && spotUsd > 0;
  const solUsd = spotOk ? sol * spotUsd : 0;
  const total = round6(usdc + solUsd);
  const notes =
    `fees_sol=${sol.toFixed(9)} fees_usdc=${usdc.toFixed(6)} ` +
    (spotOk
      ? `spot=${spotUsd.toFixed(4)} sol_usd=${solUsd.toFixed(6)} (fees_claimed_usd = USDC + SOL x spot at claim)`
      : `spot=n/a (SOL half NOT valued; fees_claimed_usd = USDC only)`);
  return {
    fees_claimed_usd: total,
    fees_sol: round9(sol),
    fees_usdc: round6(usdc),
    fees_sol_usd: round6(solUsd),
    fee_spot_usd: spotOk ? spotUsd : undefined,
    notes,
  };
}

/** The legacy dashboard regex. Exported so tests can assert new notes never match it. */
export const LEGACY_FEEX_NOTE_RE = /feeX\(SOL\)=([0-9.]+)/;

// ---------------------------------------------------------------- SOL sweep sizing

export interface SolSweepSizing {
  lamports: number;
  /** Lamports that would still be left in the wallet after the transfer + fee. */
  remainingLamports: number;
  reason: string;
}

/**
 * How much native SOL may go to the revenue wallet: min(requested, native − reserve − margin − txFee),
 * and nothing if that is below minLamports. Never returns a value that takes the wallet below reserve + margin.
 */
export function solSweepLamports(p: {
  requestedLamports: number;
  nativeLamports: number;
  gasReserveLamports: number;
  marginLamports: number;
  txFeeLamports: number;
  minLamports: number;
}): SolSweepSizing {
  const req = Math.max(0, Math.floor(p.requestedLamports || 0));
  const native = Math.max(0, Math.floor(p.nativeLamports || 0));
  const floor = Math.max(0, p.gasReserveLamports) + Math.max(0, p.marginLamports) + Math.max(0, p.txFeeLamports);
  const headroom = Math.max(0, native - floor);
  const lamports = Math.min(req, headroom);
  if (req <= 0) return { lamports: 0, remainingLamports: native, reason: "nothing requested" };
  if (lamports < Math.max(1, p.minLamports)) {
    return {
      lamports: 0,
      remainingLamports: native,
      reason:
        headroom < req
          ? `gas floor: wallet ${(native / 1e9).toFixed(6)} SOL, floor ${(floor / 1e9).toFixed(6)} SOL (reserve+margin+fee) leaves ${(headroom / 1e9).toFixed(6)} SOL`
          : `below minimum ${(p.minLamports / 1e9).toFixed(6)} SOL`,
    };
  }
  return {
    lamports,
    remainingLamports: native - lamports - Math.max(0, p.txFeeLamports),
    reason: lamports < req ? `capped by gas floor (requested ${(req / 1e9).toFixed(6)} SOL)` : "full amount",
  };
}

// ---------------------------------------------------------------- memos

export interface SweepMemo {
  kind: "fee-sol-sweep" | "catchup-sol-sweep";
  usd?: number;
  spot?: number;
  lamports?: number;
  id?: string;
}

export function buildSweepMemo(m: SweepMemo): string {
  const parts = [`${SWEEP_MEMO_PREFIX}${m.kind}`];
  if (m.id) parts.push(`id=${m.id.replace(/[^A-Za-z0-9_.\-]/g, "").slice(0, 32)}`);
  if (m.lamports != null) parts.push(`lamports=${Math.floor(m.lamports)}`);
  if (m.usd != null && Number.isFinite(m.usd)) parts.push(`usd=${m.usd.toFixed(6)}`);
  if (m.spot != null && Number.isFinite(m.spot)) parts.push(`spot=${m.spot.toFixed(4)}`);
  return parts.join(" ");
}

/** Parse a memo written by buildSweepMemo. Tolerates the "[len] " prefix some RPCs put on parsed memos. */
export function parseSweepMemo(text: string | null | undefined): SweepMemo | null {
  if (!text) return null;
  const s = String(text);
  const at = s.indexOf(SWEEP_MEMO_PREFIX);
  if (at < 0) return null;
  const tokens = s.slice(at + SWEEP_MEMO_PREFIX.length).trim().split(/\s+/);
  const kind = tokens.shift();
  if (kind !== "fee-sol-sweep" && kind !== "catchup-sol-sweep") return null;
  const out: SweepMemo = { kind };
  for (const t of tokens) {
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq);
    const v = t.slice(eq + 1).replace(/["']+$/, "");
    if (k === "id") out.id = v;
    else if (k === "lamports" && /^\d+$/.test(v)) out.lamports = Number(v);
    else if ((k === "usd" || k === "spot") && /^\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
  }
  return out;
}

// ---------------------------------------------------------------- parsed-tx (jsonParsed) helpers

function allInstructions(tx: any): any[] {
  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap((i: any) => i.instructions || []);
  return [...top, ...inner];
}

function keyStr(k: any): string {
  if (typeof k === "string") return k;
  return k?.pubkey?.toBase58?.() ?? k?.pubkey ?? k?.toBase58?.() ?? String(k);
}

/** Did `wallet` sign this parsed transaction? */
export function isSignedBy(tx: any, wallet: string): boolean {
  const keys: any[] = tx?.transaction?.message?.accountKeys || [];
  return keys.some((k: any) => k && typeof k === "object" && k.signer === true && keyStr(k) === wallet);
}

/** Memo strings in this parsed transaction (top-level + inner). */
export function memosFromParsedTx(tx: any): string[] {
  const out: string[] = [];
  for (const ix of allInstructions(tx)) {
    const isMemo = ix?.program === "spl-memo" || keyStr(ix?.programId) === MEMO_PROGRAM_ID;
    if (isMemo && typeof ix.parsed === "string") out.push(ix.parsed);
  }
  return out;
}

/**
 * USDC raw amount moved by THIS tx from the LP wallet's USDC ATA to the revenue wallet's USDC ATA,
 * signed by the LP wallet. Anything else (address-poisoning dust from lookalike wallets, transfers from
 * other sources, failed txs) counts as 0.
 */
export function sweepRawFromParsedTx(tx: any, lpWallet: string, lpUsdcAta: string, revUsdcAta: string, usdcMint: string): number {
  if (!tx || tx.meta?.err) return 0;
  let raw = 0;
  for (const ix of allInstructions(tx)) {
    const parsed = ix?.parsed;
    if (!parsed || ix.program !== "spl-token") continue;
    if (parsed.type !== "transfer" && parsed.type !== "transferChecked") continue;
    const info = parsed.info || {};
    if (info.source !== lpUsdcAta || info.destination !== revUsdcAta) continue;
    const authority = info.authority ?? info.multisigAuthority;
    if (authority !== lpWallet) continue;
    if (info.mint && info.mint !== usdcMint) continue;
    const amt = Number(info.tokenAmount?.amount ?? info.amount);
    if (Number.isFinite(amt) && amt > 0) raw += amt;
  }
  return raw;
}

/**
 * Native SOL lamports moved by THIS tx from the LP wallet to the revenue wallet (system transfer),
 * in a successful tx signed by the LP wallet. Revenue → LP transfers, lookalike-wallet dust and
 * anything not signed by the LP wallet count as 0.
 */
export function solSweepLamportsFromParsedTx(tx: any, lpWallet: string, revWallet: string): number {
  if (!tx || tx.meta?.err) return 0;
  if (!isSignedBy(tx, lpWallet)) return 0;
  let lamports = 0;
  for (const ix of allInstructions(tx)) {
    const parsed = ix?.parsed;
    const isSystem = ix?.program === "system" || keyStr(ix?.programId) === SYSTEM_PROGRAM_ID;
    if (!isSystem || !parsed || (parsed.type !== "transfer" && parsed.type !== "transferWithSeed")) continue;
    const info = parsed.info || {};
    if (info.source !== lpWallet || info.destination !== revWallet) continue;
    const amt = Number(info.lamports);
    if (Number.isFinite(amt) && amt > 0) lamports += amt;
  }
  return lamports;
}

export interface ParsedSweep {
  usdcRaw: number;
  solLamports: number;
  /** USD value of the SOL leg: memo usd (pro-rated if the memo covers a different amount), else null. */
  solUsdFromMemo: number | null;
  memo: SweepMemo | null;
}

/** One parsed tx → what it swept (USDC + SOL) and the bot memo (if any). */
export function parseSweepTx(
  tx: any,
  ctx: { lpWallet: string; revWallet: string; lpUsdcAta: string; revUsdcAta: string; usdcMint: string }
): ParsedSweep {
  const usdcRaw = sweepRawFromParsedTx(tx, ctx.lpWallet, ctx.lpUsdcAta, ctx.revUsdcAta, ctx.usdcMint);
  const solLamports = solSweepLamportsFromParsedTx(tx, ctx.lpWallet, ctx.revWallet);
  // Only memos in txs the LP wallet signed are trusted (anyone can attach a memo to their own tx).
  const memo = isSignedBy(tx, ctx.lpWallet) && !tx?.meta?.err
    ? memosFromParsedTx(tx).map(parseSweepMemo).find((m) => m != null) ?? null
    : null;
  let solUsdFromMemo: number | null = null;
  if (solLamports > 0 && memo?.usd != null) {
    solUsdFromMemo = memo.lamports && memo.lamports > 0 ? (memo.usd * solLamports) / memo.lamports : memo.usd;
  } else if (solLamports > 0 && memo?.spot != null && memo.spot > 0) {
    solUsdFromMemo = (solLamports / 1e9) * memo.spot;
  }
  return { usdcRaw, solLamports, solUsdFromMemo, memo };
}

// ---------------------------------------------------------------- landed / not-landed

export type LandedStatus = "landed" | "failed" | "not_landed" | "unknown";

export interface LandedDeps {
  /** getSignatureStatuses(…, searchTransactionHistory) → status or null. */
  getStatus: (sig: string) => Promise<{ err: any; confirmationStatus?: string | null } | null>;
  getBlockHeight: () => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * After a confirm timeout: poll until the signature is confirmed (landed / failed) or the blockhash has
 * expired (current block height > lastValidBlockHeight → the tx can never land → safe to retry).
 * Returns "unknown" only if neither happened within maxWaitMs — callers must NOT retry on "unknown".
 */
export async function resolveLanded(
  sig: string,
  lastValidBlockHeight: number,
  deps: LandedDeps,
  opts: { pollMs?: number; maxWaitMs?: number } = {}
): Promise<LandedStatus> {
  const pollMs = opts.pollMs ?? 2000;
  const maxWaitMs = opts.maxWaitMs ?? 120_000;
  const now = deps.now ?? (() => Date.now());
  const start = now();
  for (;;) {
    let st: { err: any; confirmationStatus?: string | null } | null = null;
    try {
      st = await deps.getStatus(sig);
    } catch {
      st = null;
    }
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      return st.err ? "failed" : "landed";
    }
    let height = -1;
    try {
      height = await deps.getBlockHeight();
    } catch {
      height = -1;
    }
    if (height > lastValidBlockHeight) {
      // Expired. One last status read (it may have landed in the final slots).
      try {
        st = await deps.getStatus(sig);
      } catch {
        return "unknown";
      }
      if (st && st.confirmationStatus && st.confirmationStatus !== "processed") return st.err ? "failed" : "landed";
      return st ? "unknown" : "not_landed";
    }
    if (now() - start >= maxWaitMs) return "unknown";
    await deps.sleep(pollMs);
  }
}

// ---------------------------------------------------------------- one-time catch-up

export interface CatchupDecision {
  send: boolean;
  lamports: number;
  reason: string;
}

/**
 * One-shot catch-up sweep guard. Sends only when: configured, ≤ cap, the on-chain scan succeeded AND was
 * complete, no prior catch-up memo with this id exists on chain, nothing was already sent in this process,
 * and the FULL amount fits above the gas floor (no partial catch-up: a partial send would still write the
 * "done" marker).
 */
export function decideCatchup(p: {
  configuredLamports: number;
  capLamports: number;
  id: string;
  scanOk: boolean;
  scanComplete: boolean;
  priorCatchupIds: Set<string> | string[];
  sentThisProcess: boolean;
  nativeLamports: number;
  gasReserveLamports: number;
  marginLamports: number;
  txFeeLamports: number;
}): CatchupDecision {
  const lamports = Math.floor(p.configuredLamports || 0);
  const no = (reason: string): CatchupDecision => ({ send: false, lamports: 0, reason });
  if (!(lamports > 0)) return no("not configured");
  if (!p.id) return no("missing catch-up id");
  if (lamports > p.capLamports) return no(`requested ${lamports} lamports > cap ${p.capLamports}`);
  if (p.sentThisProcess) return no("already sent in this process");
  if (!p.scanOk) return no("on-chain scan failed — refusing (fail closed)");
  const prior = p.priorCatchupIds instanceof Set ? p.priorCatchupIds : new Set(p.priorCatchupIds);
  if (prior.has(p.id)) return no(`already done on chain (memo id=${p.id})`);
  if (!p.scanComplete) return no("on-chain scan incomplete — cannot prove it was not already sent (fail closed)");
  const size = solSweepLamports({
    requestedLamports: lamports,
    nativeLamports: p.nativeLamports,
    gasReserveLamports: p.gasReserveLamports,
    marginLamports: p.marginLamports,
    txFeeLamports: p.txFeeLamports,
    minLamports: 1,
  });
  if (size.lamports !== lamports) return no(`full amount does not fit above gas floor (${size.reason})`);
  return { send: true, lamports, reason: "ok" };
}

function round6(n: number): number {
  return Number(n.toFixed(6));
}
function round9(n: number): number {
  return Number(n.toFixed(9));
}
