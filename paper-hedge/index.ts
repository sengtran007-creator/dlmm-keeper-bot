/**
 * Paper-only delta hedger. Separate process from the keeper (dist/index.js).
 *
 * Reads the bot wallet's DLMM SOL and Kalshi's public SOL perp book, simulates
 * a short, and appends rows to the Google Sheet webhook. It does not import the
 * keeper, does not sign, and exits if a wallet or Kalshi credential is present
 * in the environment.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { forbiddenPresent, loadConfig } from "./config";
import { ChainObserver } from "./chain";
import { createKalshiClient } from "./kalshi";
import { Book, StepInput, freshBook, step } from "./engine";
import { redact } from "./redact";
import { formatConsole, postLedger, rowPayload } from "./sheet";
import { readStateFile, writeStateFile } from "./state";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function untilStopped(isStopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (isStopped()) {
        clearInterval(t);
        resolve();
      }
    }, 250);
  });
}

async function main(): Promise<void> {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const secrets = forbiddenPresent(process.env);
  if (secrets.length) {
    console.error(
      `[PAPER] refusing to start. This process must not hold wallet or exchange credentials (${secrets.join(", ")}). ` +
        `Remove them from this service. The values were not logged.`
    );
    process.exit(1);
  }

  const cfg = loadConfig(process.env);
  if (!cfg.enabled) {
    console.log("[PAPER] PAPER_HEDGE_ENABLED is not true. Idling. No chain reads, no sheet posts, no orders.");
    await untilStopped(() => stopping);
    return;
  }
  if (!cfg.rpcUrl) {
    console.error("[PAPER] SOLANA_RPC_URL (or RPC_URL) is required when PAPER_HEDGE_ENABLED=true. Idling.");
    await untilStopped(() => stopping);
    return;
  }

  let owner: PublicKey;
  let pool: PublicKey;
  try {
    owner = new PublicKey(cfg.wallet);
    pool = new PublicKey(cfg.pool);
  } catch (err: any) {
    console.error("[PAPER] wallet or pool pubkey is invalid:", redact(err?.message || err));
    process.exit(1);
  }

  let book: Book = freshBook(cfg.capitalUsd);
  const loaded = readStateFile(cfg.statePath, book);
  book = loaded.book;
  if (loaded.loaded) console.log(`[PAPER] restored paper book from ${cfg.statePath} short=${book.shortSol} SOL`);
  else console.log(`[PAPER] no prior paper state (${loaded.reason || "fresh"}). The first fresh read opens the short.`);

  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const chain = new ChainObserver(connection, pool, owner, cfg.gasReserveLamports, cfg.positionBucketSol, 20000);
  const kalshi = createKalshiClient({
    base: cfg.kalshiBase,
    ticker: cfg.ticker,
    timeoutMs: cfg.httpTimeoutMs,
    riskFallback: {
      liquidationRatio: cfg.liquidationRatio,
      queueRatio: cfg.queueRatio,
      initialMultiplier: cfg.initialMarginMultiplier,
    },
  });

  console.log(
    `[PAPER] paper-only hedger wallet=${owner.toBase58()} pool=${pool.toBase58()} ticker=${cfg.ticker} ` +
      `poll=${cfg.pollMs / 1000}s stale=${cfg.staleMs / 1000}s band=${cfg.bandPct} capital=${cfg.capitalUsd} ` +
      `margin=${cfg.marginFraction} takerFee=${cfg.takerFeeRate} makerFee(unused)=${cfg.makerFeeRate} ` +
      `fundingSign=${cfg.fundingSign} fallbackRate=${cfg.fundingFallbackRate} gasReserve=${cfg.gasReserveLamports} ` +
      `sheet=${cfg.sheetUrl ? "on" : "off"} state=${cfg.statePath}`
  );
  if (cfg.sheetUrl) {
    console.log(
      "[PAPER] sheet rows use event PAPER_HEDGE. Paste paper-hedge/apps-script/PaperHedge.gs into the existing " +
        "Apps Script and redeploy it, or these rows will land on the keeper ledger tab."
    );
  }

  let sheetWarned = false;

  while (!stopping) {
    const started = Date.now();
    try {
      const [chainSample, kalshiPull] = await Promise.all([chain.read(), kalshi.fetch(started)]);
      if (kalshiPull.errors.length) console.warn("[PAPER] data:", kalshiPull.errors.join("; "));
      if (!chainSample.ok) console.warn("[PAPER] chain:", chainSample.reason);
      const input: StepInput = {
        nowMs: Date.now(),
        chainOk: chainSample.ok,
        chainTsMs: chainSample.fetchedAtMs,
        solPrice: chainSample.solPrice,
        lpSol: chainSample.lpSol,
        lpEquity: chainSample.lpEquity,
        fingerprint: chainSample.fingerprint,
        positionIds: chainSample.positionIds,
        idleSol: chainSample.idleSol,
        positionSol: chainSample.positionSol,
        binStep: chainSample.binStep,
        quote: kalshiPull.quote,
        funding: kalshiPull.funding,
        risk: kalshiPull.risk,
      };
      const out = step(book, input, cfg);
      book = out.book;
      if (out.row) {
        console.log(formatConsole(out.row));
        if (!cfg.sheetUrl && !sheetWarned) {
          console.warn("[PAPER] GOOGLE_SHEET_WEBHOOK_URL unset — logging to stdout only.");
          sheetWarned = true;
        }
        const poolName = chainSample.binStep ? `SOL-USDC ${chainSample.binStep}bps` : "SOL-USDC";
        await postLedger(cfg.sheetUrl, rowPayload(out.row, cfg.instance, poolName));
      } else if (out.stale) {
        console.log(`[PAPER] stale sample (${out.staleReasons.join(",")}); not trading, sheet cadence not due`);
      }
      try {
        writeStateFile(cfg.statePath, book);
      } catch (err: any) {
        console.error("[PAPER] state write failed:", redact(err?.message || err));
      }
    } catch (err: any) {
      console.error("[PAPER] tick failed:", redact(err?.message || err));
    }
    const wait = Math.max(0, cfg.pollMs - (Date.now() - started));
    const slice = 250;
    let left = wait;
    while (left > 0 && !stopping) {
      await sleep(Math.min(slice, left));
      left -= slice;
    }
  }
  try {
    writeStateFile(cfg.statePath, book);
  } catch {}
  console.log("[PAPER] stopped. Paper book saved. No orders were sent.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[PAPER] fatal:", redact(err?.message || err));
    process.exit(1);
  });
}
