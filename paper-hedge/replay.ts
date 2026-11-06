/**
 * Replay the paper book over a JSONL file of public prices. No network.
 *
 * Each line: {"ts":ms,"lpSol":number,"lpEquity":number,"solPrice":number,
 *             "bid":contractPx,"ask":contractPx,"mark":contractPx,
 *             "contractSol":0.1,"fingerprint":"pos",
 *             "fundingRates":[{"time":"2026-11-06T13:00:00Z","rate":0.0001,"mark":9.0}]}
 *
 * Usage: npm run replay:paper-hedge -- paper-hedge/fixtures/sol-drop.jsonl
 */
import fs from "fs";
import { loadConfig } from "./config";
import {
  Book,
  FundingSnap,
  HedgeConfig,
  LedgerRow,
  Quote,
  StepInput,
  freshBook,
  hedgePnlUsd,
  step,
} from "./engine";

export interface ReplayTick {
  ts: number;
  lpSol: number;
  lpEquity: number;
  solPrice: number;
  bid: number;
  ask: number;
  mark: number;
  contractSol: number;
  fingerprint: string;
  fundingRates: { time: string; rate: number; mark: number }[];
  nextFundingTimeMs: number | null;
  chainStale: boolean;
  fundingStale: boolean;
  quoteStale: boolean;
  shortLeverage: Record<string, number> | null;
  positionIds: string[];
}

export function parseReplayLine(line: string): ReplayTick | null {
  const s = line.trim();
  if (!s || s.startsWith("#")) return null;
  const j = JSON.parse(s);
  return {
    ts: Number(j.ts),
    lpSol: Number(j.lpSol),
    lpEquity: Number(j.lpEquity),
    solPrice: Number(j.solPrice),
    bid: Number(j.bid),
    ask: Number(j.ask),
    mark: Number(j.mark),
    contractSol: j.contractSol != null ? Number(j.contractSol) : 0.1,
    fingerprint: j.fingerprint != null ? String(j.fingerprint) : "book",
    fundingRates: Array.isArray(j.fundingRates) ? j.fundingRates : [],
    nextFundingTimeMs: j.nextFundingTimeMs != null ? Number(j.nextFundingTimeMs) : null,
    chainStale: !!j.chainStale,
    fundingStale: !!j.fundingStale,
    quoteStale: !!j.quoteStale,
    shortLeverage: j.shortLeverage && typeof j.shortLeverage === "object" ? j.shortLeverage : null,
    positionIds: Array.isArray(j.positionIds) ? j.positionIds.map(String) : [],
  };
}

export function replayTickToInput(t: ReplayTick, cfg: HedgeConfig): StepInput {
  const contractSol = t.contractSol > 0 ? t.contractSol : cfg.contractSol;
  const qAge = t.quoteStale ? cfg.staleMs + 5 : 0;
  const quote: Quote = {
    bidContract: t.bid,
    askContract: t.ask,
    markContract: t.mark,
    contractSol,
    tsMs: t.ts - qAge,
    fetchedAtMs: t.ts - qAge,
    bidSizeContracts: Number.POSITIVE_INFINITY,
    askSizeContracts: Number.POSITIVE_INFINITY,
    shortLeverageEstimates: t.shortLeverage,
  };
  const funding: FundingSnap = {
    fetchedAtMs: t.fundingStale ? t.ts - cfg.staleMs - 5 : t.ts,
    nextFundingTimeMs: t.nextFundingTimeMs,
    rates: t.fundingRates.map((r) => ({
      time: r.time,
      timeMs: Date.parse(r.time),
      rate: Number(r.rate),
      markContract: Number(r.mark),
    })),
  };
  return {
    nowMs: t.ts,
    chainOk: !t.chainStale,
    chainTsMs: t.chainStale ? t.ts - cfg.staleMs - 5 : t.ts,
    solPrice: t.solPrice,
    lpSol: t.lpSol,
    lpEquity: t.lpEquity,
    fingerprint: t.fingerprint,
    positionIds: t.positionIds,
    quote,
    funding,
    risk: null,
  };
}

export interface ReplayResult {
  book: Book;
  rows: LedgerRow[];
  warnings: string[];
}

export function runReplay(ticks: ReplayTick[], cfg: HedgeConfig, start?: Book): ReplayResult {
  let book = start ?? freshBook(cfg.capitalUsd);
  const rows: LedgerRow[] = [];
  const warnings: string[] = [];
  for (const t of ticks) {
    const out = step(book, replayTickToInput(t, cfg), cfg);
    book = out.book;
    if (out.row) rows.push(out.row);
    warnings.push(...out.warnings);
  }
  return { book, rows, warnings };
}

export function replaySummary(result: ReplayResult): Record<string, unknown> {
  const last = result.rows[result.rows.length - 1];
  const mark = result.book.lastMarkSolPx;
  return {
    rows: result.rows.length,
    trades: result.rows.filter((r) => r.tradeSol !== 0).length,
    finalShortSol: result.book.shortSol,
    avgEntrySolPx: result.book.avgEntrySolPx,
    feesUsd: round(result.book.feesUsd),
    fundingUsd: round(result.book.fundingUsd),
    realizedUsd: round(result.book.realizedUsd),
    hedgePnlUsd: round(last?.hedgePnlUsd ?? hedgePnlUsd(result.book, mark)),
    unhedgedPnlUsd: last && Number.isFinite(last.unhedgedPnlUsd) ? round(last.unhedgedPnlUsd) : null,
    hedgedPnlUsd: last && Number.isFinite(last.hedgedPnlUsd) ? round(last.hedgedPnlUsd) : null,
    combinedEquityUsd: last && Number.isFinite(last.combinedEquityUsd) ? round(last.combinedEquityUsd) : null,
    warnings: [...new Set(result.warnings)],
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: npm run replay:paper-hedge -- <ticks.jsonl>");
    process.exit(2);
  }
  const cfg = loadConfig(process.env);
  const text = fs.readFileSync(file, "utf8");
  const ticks: ReplayTick[] = [];
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    const t = parseReplayLine(line);
    if (t) ticks.push(t);
  }
  const result = runReplay(ticks, cfg);
  console.log(JSON.stringify(replaySummary(result), null, 2));
}

if (require.main === module) main();
