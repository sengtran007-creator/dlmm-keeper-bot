/**
 * Public, unauthenticated Kalshi margin market data for KXSOLPERP.
 * No API key is read or sent. Fee-tier endpoints require auth and are not called.
 */
import { FundingSnap, Quote, RiskParams } from "./engine";
import { redact } from "./redact";

export interface KalshiPull {
  fetchedAtMs: number;
  quote: Quote | null;
  funding: FundingSnap | null;
  risk: RiskParams | null;
  errors: string[];
}

export function bestLevel(levels: unknown, side: "bid" | "ask"): { price: number; size: number } | null {
  if (!Array.isArray(levels)) return null;
  let best: { price: number; size: number } | null = null;
  for (const lvl of levels) {
    if (!Array.isArray(lvl) || lvl.length < 2) continue;
    const price = Number(lvl[0]);
    const size = Number(lvl[1]);
    if (!(price > 0) || !Number.isFinite(size)) continue;
    if (!best || (side === "bid" ? price > best.price : price < best.price)) best = { price, size };
    else if (price === best.price) best = { price, size: best.size + size };
  }
  return best;
}

/** Book is not reliably best-first on the public API, so best bid is max and best ask is min. */
export function buildQuote(marketBody: any, bookBody: any, fetchedAtMs: number): Quote | null {
  const m = marketBody?.market ?? marketBody ?? {};
  const ob = bookBody?.orderbook ?? bookBody ?? {};
  const bidL = bestLevel(ob?.bids, "bid");
  const askL = bestLevel(ob?.asks, "ask");
  const bid = bidL?.price ?? Number(m?.bid);
  const ask = askL?.price ?? Number(m?.ask);
  const mark = Number(m?.settlement_mark_price?.price ?? m?.price);
  const contractSol = Number(m?.contract_size);
  if (!(bid > 0) || !(ask > 0) || !(mark > 0)) return null;
  const tsCandidates = [m?.settlement_mark_price?.ts_ms, m?.reference_price?.ts_ms, m?.liquidation_mark_price?.ts_ms]
    .map((v: unknown) => Number(v))
    .filter((n: number) => n > 0);
  const estimates = m?.short_leverage_estimates;
  return {
    bidContract: bid,
    askContract: ask,
    markContract: mark,
    contractSol: contractSol > 0 ? contractSol : NaN,
    tsMs: tsCandidates.length ? Math.min(...tsCandidates) : fetchedAtMs,
    fetchedAtMs,
    bidSizeContracts: bidL?.size ?? NaN,
    askSizeContracts: askL?.size ?? NaN,
    shortLeverageEstimates: estimates && typeof estimates === "object" ? estimates : null,
  };
}

export function buildFunding(estimate: any, historical: any, fetchedAtMs: number): FundingSnap {
  const rates = [];
  const list = Array.isArray(historical?.funding_rates) ? historical.funding_rates : [];
  for (const r of list) {
    const time = String(r?.funding_time ?? "");
    const timeMs = Date.parse(time);
    const rate = Number(r?.funding_rate);
    const markContract = Number(r?.mark_price);
    if (!time || !Number.isFinite(timeMs) || !Number.isFinite(rate)) continue;
    rates.push({ time, timeMs, rate, markContract: Number.isFinite(markContract) ? markContract : NaN });
  }
  const next = Date.parse(estimate?.next_funding_time ?? "");
  return { fetchedAtMs, nextFundingTimeMs: Number.isFinite(next) ? next : null, rates };
}

export function buildRisk(body: any, ticker: string, fallback: Pick<RiskParams, "liquidationRatio" | "queueRatio" | "initialMultiplier">): RiskParams {
  const mult = Number(body?.initial_margin_multiplier?.[ticker]);
  const liq = Number(body?.liquidation_margin_ratio_threshold);
  const queue = Number(body?.queue_entry_margin_ratio_threshold);
  const published = (liq > 0 && Number.isFinite(liq)) || (queue > 0 && Number.isFinite(queue)) || (mult > 0 && Number.isFinite(mult));
  return {
    liquidationRatio: liq > 0 ? liq : fallback.liquidationRatio,
    queueRatio: queue > 0 ? queue : fallback.queueRatio,
    initialMultiplier: mult > 0 ? mult : fallback.initialMultiplier,
    source: published ? "published" : "fallback",
  };
}

async function getJson(url: string, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split("?")[0]}`);
  return res.json();
}

export interface KalshiClient {
  fetch(nowMs?: number): Promise<KalshiPull>;
}

export function createKalshiClient(opts: {
  base: string;
  ticker: string;
  timeoutMs: number;
  riskFallback: Pick<RiskParams, "liquidationRatio" | "queueRatio" | "initialMultiplier">;
  riskEveryMs?: number;
}): KalshiClient {
  let risk: RiskParams | null = null;
  let riskAt = 0;
  const riskEvery = opts.riskEveryMs ?? 10 * 60 * 1000;
  const base = opts.base.replace(/\/+$/, "");
  const ticker = encodeURIComponent(opts.ticker);

  return {
    async fetch(nowMs = Date.now()): Promise<KalshiPull> {
      const errors: string[] = [];
      const start = Math.floor(nowMs / 1000) - 3 * 86400;
      const end = Math.floor(nowMs / 1000) + 60;
      const marketUrl = `${base}/margin/markets/${ticker}`;
      const bookUrl = `${base}/margin/markets/${ticker}/orderbook?depth=10`;
      const estUrl = `${base}/margin/funding_rates/estimate?ticker=${ticker}`;
      const histUrl = `${base}/margin/funding_rates/historical?ticker=${ticker}&start_ts=${start}&end_ts=${end}`;

      const [marketR, bookR, estR, histR] = await Promise.all([
        getJson(marketUrl, opts.timeoutMs).catch((e) => { errors.push(`market ${redact(e?.message || e)}`); return null; }),
        getJson(bookUrl, opts.timeoutMs).catch((e) => { errors.push(`book ${redact(e?.message || e)}`); return null; }),
        getJson(estUrl, opts.timeoutMs).catch((e) => { errors.push(`funding_est ${redact(e?.message || e)}`); return null; }),
        getJson(histUrl, opts.timeoutMs).catch((e) => { errors.push(`funding_hist ${redact(e?.message || e)}`); return null; }),
      ]);

      if (nowMs - riskAt >= riskEvery || !risk) {
        try {
          const body = await getJson(`${base}/margin/risk_parameters`, opts.timeoutMs);
          const parsed = buildRisk(body, opts.ticker, opts.riskFallback);
          if (parsed.source === "published") {
            risk = parsed;
            riskAt = nowMs;
          }
        } catch (e: any) {
          errors.push(`risk ${redact(e?.message || e)}`);
        }
      }

      const fetchedAtMs = Date.now();
      const quote = marketR || bookR ? buildQuote(marketR, bookR, fetchedAtMs) : null;
      if ((marketR || bookR) && !quote) errors.push("quote unparsable");
      const funding = estR || histR ? buildFunding(estR, histR, fetchedAtMs) : null;
      if (!estR && !histR) errors.push("funding unavailable");
      return { fetchedAtMs, quote, funding, risk, errors };
    },
  };
}
