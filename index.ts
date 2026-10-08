import DLMM, {
  StrategyType,
  DEFAULT_BIN_PER_POSITION,
  getVariableFee,
} from "@meteora-ag/dlmm";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  getAccount,
} from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import bs58 from "bs58";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// ==================== ENVIRONMENT CONFIGURATION ====================
function requireEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Environment variable ${key} is required but not set.`);
  }
  return value;
}

const RPC_URL = process.env.RPC_URL?.trim() || process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
const BOT_PRIVATE_KEY = requireEnv("BOT_PRIVATE_KEY");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim() || "";
// Optional: sheet logging disabled when unset (no hardcoded webhook in source).
const GOOGLE_SHEET_WEBHOOK_URL = process.env.GOOGLE_SHEET_WEBHOOK_URL?.trim() || "";
// Required: fee harvest destination. Fail fast — silent sweeps to a wrong/missing vault are worse.
const REVENUE_WALLET_PUBKEY = requireEnv("REVENUE_WALLET_PUBKEY");
// Optional startup baseline override (USD). If unset, computed from wallet equity after pool init.
const BASELINE_USD_ENV = process.env.BASELINE_USD?.trim() || "";

// Public Meteora SOL-USDC ~10bps DLMM pool + well-known mints (safe to keep in source).
const SOL_USDC_POOL = new PublicKey("BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const LP_REVENUE_VAULT = new PublicKey(REVENUE_WALLET_PUBKEY);

const PRICE_DECIMAL_FACTOR = 1000;

// Gas: keep a hard reserve for rent/fees, but warn only when well below it
// (exactly ~reserve always looked "Low" before because ops leave ~0.349 SOL).
const GAS_RESERVE_LAMPORTS = Number(process.env.GAS_RESERVE_LAMPORTS ?? 350_000_000); // 0.35 SOL
const GAS_WARN_LAMPORTS = Number(process.env.GAS_WARN_LAMPORTS ?? 250_000_000); // 0.25 SOL

// Jupiter Swap API base (lite free tier). Override with JUPITER_API_BASE or set JUPITER_API_KEY for api.jup.ag.
const JUPITER_API_BASE = (process.env.JUPITER_API_BASE?.trim() || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, "");
const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim() || "";
const JUPITER_SLIPPAGE_BPS = Number(process.env.JUPITER_SLIPPAGE_BPS ?? 50);

// Gate 2: max allowed *variable* fee in basis points before re-entry is blocked.
// (Not variableFeeControl — that is a static pool config constant, often ~40000.)
const GATE2_MAX_VARIABLE_FEE_BPS = Number(process.env.GATE2_MAX_VARIABLE_FEE_BPS ?? 15);

// Meteora initializePosition width = maxBinId - minBinId + 1 must be in [1, DEFAULT_BIN_PER_POSITION].
const MAX_POSITION_WIDTH = DEFAULT_BIN_PER_POSITION.toNumber(); // 70

// ==================== SYSTEM STATE ====================
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(BOT_PRIVATE_KEY));

let dlmmPoolInstance: DLMM | null = null;
let activePositionPubkey: PublicKey | null = null;
let lowestBinPrice = 0;
let highestBinPrice = 0;
let inCooldownUntil = 0;
let lastSweepTime = Math.floor(Date.now() / 1000);
let isDeploying = false;
let isBotPaused = false;
let isLiquidating = false;
/** True while any unwind path (circuit breaker / take-profit / emergency) is in flight. */
let isExiting = false;
/** Prevents overlapping setInterval keeper ticks (async re-entrancy). */
let keeperTickRunning = false;
let deployedCapitalBaselineUsd = 0;
let lastExitPriceUsd = 0; 

// ==================== NOTIFICATIONS & LOGS ====================
async function notify(msg: string) {
  console.log(msg);
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID.trim(),
      text: msg,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err: any) {
    try {
      const plainText = msg.replace(/<[^>]*>/g, "");
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID.trim(),
        text: plainText,
        disable_web_page_preview: true,
      });
    } catch (fallbackErr: any) {
      console.error("[TELEGRAM SEND FAILED]:", fallbackErr.response?.data || fallbackErr.message);
    }
  }
}

let sheetLoggingWarned = false;
async function logSheet(
  eventType: string,
  grossRevenueUsd: number,
  netPnlUsd: number,
  sweptUsd: number,
  txSignature: string,
  notes: string = ""
) {
  if (!GOOGLE_SHEET_WEBHOOK_URL) {
    if (!sheetLoggingWarned) {
      console.warn("[SHEET] GOOGLE_SHEET_WEBHOOK_URL unset — sheet logging disabled.");
      sheetLoggingWarned = true;
    }
    return;
  }
  try {
    const payload = {
      timestamp: new Date().toISOString().replace("T", " ").substring(0, 19),
      event_type: eventType,
      pool_name: "SOL-USDC 10bps",
      gross_revenue_usd: grossRevenueUsd,
      gas_fee_usd: 0,
      slippage_usd: 0,
      net_pnl_usd: netPnlUsd,
      swept_usd: sweptUsd,
      tx_signature: txSignature,
      notes: notes,
    };
    await axios.post(GOOGLE_SHEET_WEBHOOK_URL, payload, { timeout: 12000 });
  } catch (err: any) {
    console.error("[SHEET LOG ERROR]:", err.message);
  }
}

// ==================== DETERMINISTIC BIN PRICE HELPER ====================
function calculateBinPriceUsd(activeSpotUsd: number, activeBinId: number, targetBinId: number, binStepBps: number = 10): number {
  try {
    const binDiff = targetBinId - activeBinId;
    return activeSpotUsd * Math.pow(1 + binStepBps / 10000, binDiff);
  } catch {
    return 0;
  }
}

// ==================== GATE 2 VOLATILITY HELPER ====================
/**
 * Gate 2 previously compared `lbPair.parameters.variableFeeControl` (a STATIC pool
 * config knob, often ~40000) to `baseFactor * 1.5` (~15). That comparison can never
 * pass, so re-entry stayed blocked forever ("40000 > 15").
 *
 * Correct signal: runtime `vParameters.volatilityAccumulator`, converted into the
 * *variable fee rate* via Meteora's formula (see docs):
 *   variableFee = ceil(variableFeeControl * (volAcc * binStep)^2 / 1e11)
 * in FEE_PRECISION units where 1e9 = 100%, so 1 bps = 1e5.
 * We gate on variable-fee bps <= GATE2_MAX_VARIABLE_FEE_BPS (env, default 15).
 */
function getGate2VolatilityState(dlmmPool: DLMM): {
  volAcc: number;
  variableFeeBps: number;
  thresholdBps: number;
  passed: boolean;
  detail: string;
} {
  const lbPair = (dlmmPool as any).lbPair;
  const volAcc = Number(lbPair?.vParameters?.volatilityAccumulator ?? 0);
  const binStep = Number(lbPair?.binStep ?? 10);
  const sParameters = lbPair?.parameters;
  const vParameters = lbPair?.vParameters;
  let variableFeeBps = 0;
  if (sParameters && vParameters) {
    try {
      const feeRaw = getVariableFee(binStep, sParameters, vParameters);
      variableFeeBps = Number(feeRaw.toString()) / 1e5; // FEE_PRECISION → bps
    } catch (err: any) {
      console.warn("[Gate2] getVariableFee failed:", err?.message || err);
    }
  }
  const thresholdBps = GATE2_MAX_VARIABLE_FEE_BPS;
  const passed = variableFeeBps <= thresholdBps;
  const detail = passed
    ? `✅ Passed (${variableFeeBps.toFixed(2)} bps ≤ ${thresholdBps} bps, volAcc=${volAcc})`
    : `⏳ High Volatility (${variableFeeBps.toFixed(2)} bps > ${thresholdBps} bps, volAcc=${volAcc})`;
  return { volAcc, variableFeeBps, thresholdBps, passed, detail };
}

/** Clamp bid/ask bins so inclusive width (max-min+1) ≤ DEFAULT_BIN_PER_POSITION (70). */
function clampBinRange(
  activeBinId: number,
  bidBins: number,
  askBins: number
): { minBinId: number; maxBinId: number; bidBins: number; askBins: number; width: number } {
  let bid = Math.max(0, Math.floor(bidBins));
  let ask = Math.max(0, Math.floor(askBins));
  // Inclusive width = bid + ask + 1 (active bin counted once).
  let width = bid + ask + 1;
  if (width > MAX_POSITION_WIDTH) {
    const budget = MAX_POSITION_WIDTH - 1; // bins excluding active
    const totalSide = Math.max(1, bid + ask);
    bid = Math.max(0, Math.floor((budget * bid) / totalSide));
    ask = Math.max(0, budget - bid);
    width = bid + ask + 1;
    console.warn(
      `[BIN CLAMP] Regime width exceeded ${MAX_POSITION_WIDTH}; clamped to bid=${bid} ask=${ask} (width=${width})`
    );
  }
  if (width < 1) {
    bid = 0;
    ask = 0;
    width = 1;
  }
  const minBinId = activeBinId - bid;
  const maxBinId = activeBinId + ask;
  return { minBinId, maxBinId, bidBins: bid, askBins: ask, width };
}

function gasBufferLabel(lamports: number): string {
  if (lamports >= GAS_RESERVE_LAMPORTS) return `🟢 Healthy (≥${(GAS_RESERVE_LAMPORTS / 1e9).toFixed(2)} SOL)`;
  if (lamports >= GAS_WARN_LAMPORTS) return `🟡 OK reserve (${(lamports / 1e9).toFixed(3)} SOL; warn<${(GAS_WARN_LAMPORTS / 1e9).toFixed(2)})`;
  return `⚠️ Low (<${(GAS_WARN_LAMPORTS / 1e9).toFixed(2)} SOL)`;
}


// ==================== RESILIENT CANDLE FETCHER ====================
async function fetchRecent15mKlines(): Promise<number[][] | null> {
  const urls = [
    "https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=15m&limit=3",
    "https://api.binance.us/api/v3/klines?symbol=SOLUSDT&interval=15m&limit=3",
  ];

  for (const url of urls) {
    try {
      const res = await axios.get(url, { timeout: 4000 });
      if (res.data && Array.isArray(res.data) && res.data.length >= 3) {
        return res.data;
      }
    } catch {}
  }
  return null;
}

// ==================== MACRO REGIME SENTINEL ====================
export type MarketRegime = "BULL_EXPANSION" | "RANGE_CHOP" | "BEAR_DEFENSIVE";

export interface RegimeConfig {
  regime: MarketRegime;
  score: number;
  bidBins: number;
  askBins: number;
  floorStopPct: number;
  cooldownSec: number;
  capitalDeployPct: number;
  details: {
    solPrice: number;
    sma200: number;
    fundingAnnual: number;
    turnoverRatio: number;
  };
}

class MacroSentinel {
  private lastEvaluationTime: number = 0;
  private cachedConfig: RegimeConfig | null = null;

  async evaluateRegime(dlmmPoolAddress: string, force: boolean = false): Promise<RegimeConfig> {
    const now = Math.floor(Date.now() / 1000);
    if (!force && this.cachedConfig && now - this.lastEvaluationTime < 3600) {
      return this.cachedConfig;
    }

    try {
      const [cgRes, hlRes] = await Promise.all([
        axios.get("https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=200&interval=daily", { timeout: 8000 }),
        axios.post("https://api.hyperliquid.xyz/info", { type: "predictedFundings" }, { timeout: 8000 }),
      ]);

      const prices: number[] = cgRes.data.prices.map((p: any) => p[1]);
      const currentSolPrice = prices[prices.length - 1];
      const sma200 = prices.reduce((a, b) => a + b, 0) / prices.length;
      const isAbove200Sma = currentSolPrice > sma200;

      let fundingAnnual = 10.0;
      try {
        const solEntry = hlRes.data.find((item: any) => item[0] === "SOL");
        if (solEntry && solEntry[1]?.[0]?.[1]?.fundingRate) {
          const hlFundingRate = parseFloat(solEntry[1][0][1].fundingRate);
          fundingAnnual = hlFundingRate * 24 * 365 * 100;
        }
      } catch {}

      let score = 50;
      score += isAbove200Sma ? 25 : -25;
      if (fundingAnnual > 5 && fundingAnnual < 40) score += 25;
      else if (fundingAnnual <= 0) score -= 25;

      let regime: MarketRegime = "RANGE_CHOP";
      let bidBins = 30;
      let askBins = 30;
      let floorStopPct = 0.05;
      let cooldownSec = 3600;
      let capitalDeployPct = 0.85;

      if (score >= 70) {
        regime = "BULL_EXPANSION";
        bidBins = 25;
        askBins = 35;
        floorStopPct = 0.04;
        cooldownSec = 1800;
        capitalDeployPct = 0.85;
      } else if (score < 40) {
        regime = "BEAR_DEFENSIVE";
        bidBins = 45;
        askBins = 15;
        floorStopPct = 0.06;
        cooldownSec = 14400;
        capitalDeployPct = 0.60;
      }

      this.cachedConfig = {
        regime,
        score,
        bidBins,
        askBins,
        floorStopPct,
        cooldownSec,
        capitalDeployPct,
        details: { solPrice: currentSolPrice, sma200, fundingAnnual, turnoverRatio: 0.15 },
      };

      this.lastEvaluationTime = now;
      return this.cachedConfig;
    } catch (err: any) {
      if (this.cachedConfig) return this.cachedConfig;
      return {
        regime: "BULL_EXPANSION",
        score: 65,
        bidBins: 25,
        askBins: 35,
        floorStopPct: 0.04,
        cooldownSec: 1800,
        capitalDeployPct: 0.85,
        details: { solPrice: 110, sma200: 105, fundingAnnual: 10, turnoverRatio: 0.15 },
      };
    }
  }
}

const macroSentinel = new MacroSentinel();

// ==================== JUPITER SWAP EXECUTION ====================
async function executeJupiterSwap(inputMint: PublicKey, outputMint: PublicKey, amountLamports: string): Promise<string> {
  try {
    // quote-api.jup.ag/v6 is dead (ENOTFOUND). Current Swap API: lite-api.jup.ag/swap/v1 (or api.jup.ag/swap/v1 + key).
    const headers: Record<string, string> = { Accept: "application/json" };
    if (JUPITER_API_KEY) headers["x-api-key"] = JUPITER_API_KEY;

    const quoteUrl =
      `${JUPITER_API_BASE}/quote?inputMint=${inputMint.toBase58()}` +
      `&outputMint=${outputMint.toBase58()}&amount=${amountLamports}` +
      `&slippageBps=${JUPITER_SLIPPAGE_BPS}&restrictIntermediateTokens=true`;
    const quoteRes = await axios.get(quoteUrl, { timeout: 10000, headers });
    const quoteResponse = quoteRes.data;
    if (!quoteResponse || quoteResponse.error || !quoteResponse.outAmount) {
      throw new Error(`Bad Jupiter quote: ${JSON.stringify(quoteResponse)?.slice(0, 200)}`);
    }

    const swapRes = await axios.post(
      `${JUPITER_API_BASE}/swap`,
      {
        quoteResponse,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      },
      { timeout: 10000, headers: { ...headers, "Content-Type": "application/json" } }
    );

    const { swapTransaction } = swapRes.data;
    if (!swapTransaction) {
      throw new Error(`Bad Jupiter swap response: ${JSON.stringify(swapRes.data)?.slice(0, 200)}`);
    }
    const swapTxBuf = Buffer.from(swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(swapTxBuf);
    tx.sign([wallet]);

    const txid = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(txid, "confirmed");
    return txid;
  } catch (err: any) {
    console.error("[JUPITER SWAP ERROR]:", err.response?.data || err.message);
    return "";
  }
}

// ==================== PROFIT SWEEP TO LP REVENUE ====================
async function sweepRevenueToVault(dlmmPool: DLMM): Promise<number> {
  try {
    if (!activePositionPubkey) return 0;
    await dlmmPool.refetchStates();

    const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    const revUsdcAta = await getAssociatedTokenAddress(USDC_MINT, LP_REVENUE_VAULT);

    const solBefore = await connection.getBalance(wallet.publicKey);
    let usdcBefore = 0n;
    try {
      const accBefore = await getAccount(connection, botUsdcAta);
      usdcBefore = accBefore.amount;
    } catch {}

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const targetPos = userPositions.find((p: any) => p.publicKey.equals(activePositionPubkey!));
    if (!targetPos) return 0;

    try {
      const claimTx = await (dlmmPool as any).claimSwapFee({
        owner: wallet.publicKey,
        position: targetPos,
      });

      if (Array.isArray(claimTx)) {
        for (const tx of claimTx) {
          await sendAndConfirmTransaction(connection, tx, [wallet]);
        }
      } else if (claimTx) {
        await sendAndConfirmTransaction(connection, claimTx, [wallet]);
      }
    } catch (claimErr: any) {
      if (claimErr?.message?.includes("No fee to claim") || claimErr?.message?.includes("0x1771")) {
        return 0;
      }
      throw claimErr;
    }

    const solAfter = await connection.getBalance(wallet.publicKey);
    const claimedSolLamports = solAfter > solBefore ? solAfter - solBefore : 0;
    const surplusSolToSwap = Math.max(0, solAfter - GAS_RESERVE_LAMPORTS);

    if (claimedSolLamports >= 5_000_000 && surplusSolToSwap >= 5_000_000) {
      const swapAmount = Math.min(claimedSolLamports, surplusSolToSwap);
      try {
        await notify(`🔄 Swapping ${(swapAmount / 1e9).toFixed(4)} claimed fee SOL to USDC...`);
        await executeJupiterSwap(WSOL_MINT, USDC_MINT, swapAmount.toString());
      } catch (swapErr: any) {
        console.error("Fee SOL-to-USDC swap note:", swapErr.message);
      }
    }

    const finalUsdcAcc = await getAccount(connection, botUsdcAta);
    const freshlyClaimedUsdc = finalUsdcAcc.amount > usdcBefore ? (finalUsdcAcc.amount - usdcBefore) : 0n;

    if (freshlyClaimedUsdc >= 50_000n) {
      const sweepTx = new Transaction().add(
        createTransferCheckedInstruction(
          botUsdcAta,
          USDC_MINT,
          revUsdcAta,
          wallet.publicKey,
          freshlyClaimedUsdc,
          6
        )
      );
      const sig = await sendAndConfirmTransaction(connection, sweepTx, [wallet]);
      const sweptAmountUsd = Number(freshlyClaimedUsdc) / 1e6;

      await notify(
        `💰 <b>[FEE SWEEP]</b> Harvested & Swept <b>$${sweptAmountUsd.toFixed(2)} USDC</b> to LP Revenue!\n` +
        `• Destination: <code>${LP_REVENUE_VAULT.toBase58()}</code>\n` +
        `• Tx: <code>${sig}</code>`
      );
      await logSheet("FEE_HARVEST", sweptAmountUsd, sweptAmountUsd, sweptAmountUsd, sig, "Automated delta fee sweep to LP Revenue");
      return sweptAmountUsd;
    }
  } catch (err: any) {
    if (!err.message?.includes("No fee to claim")) {
      console.error("[FEE SWEEP ERROR]:", err.message);
    }
  }
  return 0;
}

// ==================== MANUAL & AUTOMATED TEARDOWN ====================
async function closePositionAndReclaim(dlmmPool: DLMM): Promise<boolean> {
  try {
    await dlmmPool.refetchStates();
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    if (userPositions.length === 0) return true; // already flat

    for (const pos of userPositions) {
      try {
        // Re-check on-chain ownership before each close to avoid AccountOwnedByWrongProgram
        // after a concurrent exit already closed the account (owner becomes System Program).
        const info = await connection.getAccountInfo(pos.publicKey);
        if (!info || info.owner.equals(SystemProgram.programId) || info.data.length === 0) {
          console.warn(`[CLOSE] Skipping ${pos.publicKey.toBase58()}: already closed/absent`);
          continue;
        }

        const closeTx = await (dlmmPool as any).closePosition({
          owner: wallet.publicKey,
          position: pos,
        });

        if (Array.isArray(closeTx)) {
          for (const tx of closeTx) {
            await sendAndConfirmTransaction(connection, tx, [wallet]);
          }
        } else if (closeTx) {
          await sendAndConfirmTransaction(connection, closeTx, [wallet]);
        }
      } catch (closeErr: any) {
        const msg = closeErr?.message || String(closeErr);
        // Benign if a racing exit already closed it.
        if (/AccountOwnedByWrongProgram|3007|0xbbf|already been closed/i.test(msg)) {
          console.warn("[CLOSE] Position already gone (benign race):", msg.slice(0, 160));
          continue;
        }
        console.error("Close position error:", msg);
      }
    }
    return true;
  } catch (err: any) {
    console.error("[CLOSE RECLAIM ERROR]:", err.message);
    return false;
  }
}

// ==================== GATE 4: POSITION DEPLOYMENT ====================
async function deployAsymmetricPosition(dlmmPool: DLMM) {
  if (isDeploying || isBotPaused || isExiting || isLiquidating) return;
  isDeploying = true;

  try {
    await dlmmPool.refetchStates();
    const activeBin = await dlmmPool.getActiveBin();
    const spotPriceUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;
    const config = await macroSentinel.evaluateRegime(SOL_USDC_POOL.toBase58());

    const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
    let usdcBalanceUnits = 0;
    try {
      const acc = await getAccount(connection, botUsdcAta);
      usdcBalanceUnits = Number(acc.amount) / 1e6;
    } catch {}

    const totalWorkingCapital = usdcBalanceUnits > 10 ? usdcBalanceUnits : deployedCapitalBaselineUsd;
    const targetDeployCapital = totalWorkingCapital * config.capitalDeployPct;
    
    // Strict ratio allocation based on bin distribution
    const totalBins = config.bidBins + config.askBins;
    const askRatio = config.askBins / totalBins;
    const bidRatio = config.bidBins / totalBins;

    const targetSolBuyUsd = targetDeployCapital * askRatio;
    const targetBidUsdcUsd = targetDeployCapital * bidRatio;

    let swapSig = "";
    if (targetSolBuyUsd > 15) {
      await notify(`🔄 Rebalancing $${targetSolBuyUsd.toFixed(2)} USDC to SOL for ask inventory...`);
      swapSig = await executeJupiterSwap(USDC_MINT, WSOL_MINT, Math.floor(targetSolBuyUsd * 1e6).toString());
      if (!swapSig) {
        throw new Error("Jupiter swap failed to acquire required SOL. Aborting deployment.");
      }
    }

    const solBal = await connection.getBalance(wallet.publicKey);
    const usableSolLamports = Math.max(0, solBal - GAS_RESERVE_LAMPORTS); // Keep rent/gas reserve

    // Sync native SOL into WSOL ATA so Meteora DLMM can deposit Token X
    const botWsolAta = await getAssociatedTokenAddress(WSOL_MINT, wallet.publicKey);
    if (usableSolLamports > 0) {
      const wrapTx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          botWsolAta,
          wallet.publicKey,
          WSOL_MINT
        ),
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: botWsolAta,
          lamports: usableSolLamports,
        }),
        createSyncNativeInstruction(botWsolAta)
      );
      await sendAndConfirmTransaction(connection, wrapTx, [wallet]);
    }

    // Clamp so inclusive width ≤ DEFAULT_BIN_PER_POSITION (70) to avoid InvalidPositionWidth (6040).
    const activeBinIdNum = Number(activeBin.binId);
    const clamped = clampBinRange(activeBinIdNum, config.bidBins, config.askBins);
    const minBinId = clamped.minBinId;
    const maxBinId = clamped.maxBinId;
    const newPositionKeypair = Keypair.generate();

    // Respect exact bid capital allocation according to regime
    const postSwapUsdcAcc = await getAccount(connection, botUsdcAta);
    const availableUsdcUnits = Number(postSwapUsdcAcc.amount) / 1e6;
    const finalBidUsdcUnits = Math.min(availableUsdcUnits, targetBidUsdcUsd);
    const usableUsdcRaw = Math.floor(finalBidUsdcUnits * 1e6);

    const createPositionTx = await (dlmmPool as any).initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newPositionKeypair.publicKey,
      user: wallet.publicKey,
      totalXAmount: new BN(usableSolLamports),
      totalYAmount: new BN(usableUsdcRaw),
      strategy: {
        maxBinId,
        minBinId,
        strategyType: StrategyType.Spot,
      },
    });

    if (Array.isArray(createPositionTx)) {
      for (const tx of createPositionTx) {
        await sendAndConfirmTransaction(connection, tx, [wallet, newPositionKeypair]);
      }
    } else {
      await sendAndConfirmTransaction(connection, createPositionTx, [wallet, newPositionKeypair]);
    }

    activePositionPubkey = newPositionKeypair.publicKey;
    lowestBinPrice = calculateBinPriceUsd(spotPriceUsd, activeBin.binId, minBinId, 10);
    highestBinPrice = calculateBinPriceUsd(spotPriceUsd, activeBin.binId, maxBinId, 10);

    const deployedSolValueUsd = (usableSolLamports / 1e9) * spotPriceUsd;
    const deployedUsdcValueUsd = usableUsdcRaw / 1e6;
    deployedCapitalBaselineUsd = Number((deployedSolValueUsd + deployedUsdcValueUsd).toFixed(2));

    await notify(
      `✅ <b>[GRID DEPLOYED - ${config.regime}]</b>\n` +
      `• Position: <code>${activePositionPubkey.toBase58()}</code>\n` +
      `• Spot: $${spotPriceUsd.toFixed(2)}\n` +
      `• Range: $${lowestBinPrice.toFixed(2)} ➔ $${highestBinPrice.toFixed(2)}\n` +
      `• Floor Stop: $${(lowestBinPrice * (1 - config.floorStopPct)).toFixed(2)} (-${(config.floorStopPct * 100).toFixed(1)}%)\n` +
      `• Baseline Capital: <b>$${deployedCapitalBaselineUsd.toFixed(2)} USDC</b>`
    );
    await logSheet("REBALANCE", 0, 0, 0, swapSig || "ON-CHAIN", `Grid deployed (${config.regime}) - $${deployedCapitalBaselineUsd.toFixed(2)} committed`);
  } catch (err: any) {
    console.error("Deployment failed:", err.message);
    await notify(`⚠️ [DEPLOYMENT FAILED] ${err.message}. Standing by.`);
    inCooldownUntil = Math.floor(Date.now() / 1000) + 600;
  } finally {
    isDeploying = false;
  }
}

// ==================== MANUAL EMERGENCY EXIT ====================
async function executeFullEmergencyExit(dlmmPool: DLMM) {
  if (isExiting) {
    await notify("⏳ Emergency exit already in progress.");
    return;
  }
  isExiting = true;
  isLiquidating = true;
  isBotPaused = true;
  try {
  await notify("🚨 <b>[EMERGENCY EXIT INITIATED]</b> Closing all positions and liquidating to 100% USDC...");

  if (activePositionPubkey) {
    await sweepRevenueToVault(dlmmPool);
  }
  await closePositionAndReclaim(dlmmPool);

  const solBal = await connection.getBalance(wallet.publicKey);
  const dumpSolLamports = Math.floor(solBal - GAS_RESERVE_LAMPORTS);
  let swapSig = "";

  if (dumpSolLamports > 0.05 * 1e9) {
    swapSig = await executeJupiterSwap(WSOL_MINT, USDC_MINT, dumpSolLamports.toString());
  }

  const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
  let postLiquidationUsdc = 0;
  try {
    const accAfter = await getAccount(connection, botUsdcAta);
    postLiquidationUsdc = Number(accAfter.amount) / 1e6;
  } catch {}

  const realizedDrawdownUsd = Number((postLiquidationUsdc - deployedCapitalBaselineUsd).toFixed(2));
  const pnlSign = realizedDrawdownUsd >= 0 ? "+$" : "-$";

  activePositionPubkey = null;
  lowestBinPrice = 0;
  highestBinPrice = 0;
  
  await dlmmPool.refetchStates();
  const activeBin = await dlmmPool.getActiveBin();
  lastExitPriceUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;

  await notify(
    `🛡️ <b>[EMERGENCY EXIT COMPLETE]</b> Bot is paused. Funds held in USDC.\n` +
    `• Recovered: $${postLiquidationUsdc.toFixed(2)}\n` +
    `• Net PnL: ${pnlSign}${Math.abs(realizedDrawdownUsd).toFixed(2)}\n` +
    `• Tx: <code>${swapSig || "N/A"}</code>`
  );
  await logSheet("MANUAL_EMERGENCY_EXIT", 0, realizedDrawdownUsd, 0, swapSig || "N/A", `Manual Emergency Exit. Net PnL: ${pnlSign}${Math.abs(realizedDrawdownUsd).toFixed(2)}`);
  
  deployedCapitalBaselineUsd = postLiquidationUsdc;
  } finally {
    isExiting = false;
    isLiquidating = false;
  }
}

// ==================== RESILIENT TELEGRAM COMMAND LISTENER ====================
async function listenTelegramCommands() {
  if (!TELEGRAM_BOT_TOKEN) return;

  let offset = 0;
  console.log("🤖 Telegram Interactive Command Listener active.");

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=15`;
      const response = await axios.get(url, { timeout: 20000 });
      const updates = response.data?.result || [];

      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || !msg.text) continue;

        const incomingChatId = String(msg.chat.id);
        if (TELEGRAM_CHAT_ID && incomingChatId !== TELEGRAM_CHAT_ID.trim()) continue;

        const text = msg.text.trim().toLowerCase();

        if (text === "/start" || text === "/help" || text === "help") {
          const helpMsg =
            `🛠 <b>DLMM Automated Keeper Commands</b>\n\n` +
            `• <b>/status</b> - Spot price, verified range, stops, and live 4-Gate breakdown\n` +
            `• <b>/regime</b> - Live Macro Sentinel regime, 200-SMA, and funding metrics\n` +
            `• <b>/balance</b> - Liquid balances & gas reserve safety check\n` +
            `• <b>/harvest</b> - Trigger an immediate swap-fee sweep to LP Revenue\n` +
            `• <b>/emergency_exit</b> - Pull liquidity, swap 100% to USDC, and pause\n` +
            `• <b>/pause</b> - Freeze automated redeployments\n` +
            `• <b>/resume</b> - Unpause bot and resume strategy loops`;
          await notify(helpMsg);
        } else if (text === "/regime") {
          await notify("🔍 Querying Macro Sentinel feeds...");
          const config = await macroSentinel.evaluateRegime(SOL_USDC_POOL.toBase58(), true);
          const rMsg =
            `🌐 <b>Macro Sentinel State</b>\n\n` +
            `• <b>Regime:</b> <code>${config.regime}</code> (Score: <b>${config.score}/100</b>)\n` +
            `• <b>SOL Spot:</b> $${config.details.solPrice.toFixed(2)} (200-SMA: $${config.details.sma200.toFixed(2)})\n` +
            `• <b>Trend:</b> ${config.details.solPrice > config.details.sma200 ? "🟢 Above 200-SMA" : "🔴 Below 200-SMA"}\n` +
            `• <b>Perp Funding:</b> ${config.details.fundingAnnual.toFixed(1)}% APR\n` +
            `• <b>Active Profile:</b> -${(config.bidBins * 0.1).toFixed(1)}% Bids / +${(config.askBins * 0.1).toFixed(1)}% Asks\n` +
            `• <b>Target Deploy:</b> ${(config.capitalDeployPct * 100).toFixed(0)}%`;
          await notify(rMsg);
        } else if (text === "/emergency_exit") {
          if (dlmmPoolInstance) await executeFullEmergencyExit(dlmmPoolInstance);
        } else if (text === "/pause") {
          isBotPaused = true;
          await notify("⏸️ <b>[PAUSED]</b> Deployments frozen. Standing by in current state.");
        } else if (text === "/resume") {
          isBotPaused = false;
          inCooldownUntil = 0;
          await notify("▶️ <b>[RESUMED]</b> Keeper active. Re-centering liquidity grid...");
          if (dlmmPoolInstance && !activePositionPubkey) {
            await deployAsymmetricPosition(dlmmPoolInstance);
          }
        } else if (text === "/balance" || text === "balance" || text === "bal") {
          const rawSolBal = await connection.getBalance(wallet.publicKey);
          const solBal = (rawSolBal / 1e9).toFixed(4);

          let usdcBal = "0.00";
          try {
            const usdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
            const usdcAcc = await getAccount(connection, usdcAta);
            usdcBal = (Number(usdcAcc.amount) / 1e6).toFixed(2);
          } catch {}

          const balMsg =
            `💳 <b>LP Capital Wallet Overview</b>\n\n` +
            `• <b>Address:</b> <code>${wallet.publicKey.toBase58()}</code>\n` +
            `• <b>Liquid SOL:</b> ${solBal} SOL\n` +
            `• <b>Liquid USDC:</b> $${usdcBal} USDC\n` +
            `• <b>Tracked Baseline:</b> $${deployedCapitalBaselineUsd.toFixed(2)} USDC\n` +
            `• <b>Bot State:</b> ${isBotPaused ? "⏸️ PAUSED" : "🟢 ACTIVE"}\n` +
            `• <b>Gas Buffer:</b> ${gasBufferLabel(rawSolBal)}`;
          await notify(balMsg);
        } else if (text === "/status" || text === "status") {
          if (!dlmmPoolInstance) continue;

          await dlmmPoolInstance.refetchStates();
          const activeBin = await dlmmPoolInstance.getActiveBin();
          const currentPrice = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;
          const config = await macroSentinel.evaluateRegime(SOL_USDC_POOL.toBase58());

          const { userPositions } = await dlmmPoolInstance.getPositionsByUserAndLbPair(wallet.publicKey);
          const hasActivePosition = userPositions.length > 0;

          if (hasActivePosition) {
            const pos = userPositions.find((p: any) => activePositionPubkey && p.publicKey.equals(activePositionPubkey)) || userPositions[0];
            activePositionPubkey = pos.publicKey;
            lowestBinPrice = calculateBinPriceUsd(currentPrice, activeBin.binId, pos.positionData.lowerBinId, 10);
            highestBinPrice = calculateBinPriceUsd(currentPrice, activeBin.binId, pos.positionData.upperBinId, 10);
          } else {
            activePositionPubkey = null;
            lowestBinPrice = 0;
            highestBinPrice = 0;
          }

          const hardStopPrice = lowestBinPrice > 0 ? lowestBinPrice * (1 - config.floorStopPct) : 0;
          const rangeDisplay = hasActivePosition
            ? `$${lowestBinPrice.toFixed(2)} ➔ $${highestBinPrice.toFixed(2)}`
            : "None (Liquidated to 100% USDC)";
          const stopDisplay = hasActivePosition ? `$${hardStopPrice.toFixed(2)}` : "N/A";

          const nowSec = Math.floor(Date.now() / 1000);
          let gateTelemetry = "";

          if (isBotPaused) {
            gateTelemetry = "⏸️ <b>PAUSED:</b> Deployments frozen by operator.";
          } else if (hasActivePosition) {
            gateTelemetry = "🟢 <b>Active:</b> Monitoring open on-chain grid.";
          } else {
            const g1Remaining = Math.max(0, inCooldownUntil - nowSec);
            const g1Passed = g1Remaining === 0;

            // Gate 2: live variable-fee bps (NOT static variableFeeControl).
            const gate2 = getGate2VolatilityState(dlmmPoolInstance);
            const g2Passed = gate2.passed;

            let g3Passed = false;
            let g3Detail = "";
            const isVReclaim = lastExitPriceUsd > 0 && currentPrice >= (lastExitPriceUsd * 1.01);

            const klines = await fetchRecent15mKlines();
            if (klines && klines.length >= 3) {
              const low2 = parseFloat(klines[1][3].toString());
              const low3 = parseFloat(klines[2][3].toString());
              const minLow = Math.min(parseFloat(klines[0][3].toString()), low2, low3);
              const isConsolidating = (currentPrice > minLow) && (low3 >= low2);

              if (isConsolidating) {
                g3Passed = true;
                g3Detail = `Consolidation (L3: $${low3.toFixed(2)} >= L2: $${low2.toFixed(2)})`;
              } else if (isVReclaim) {
                g3Passed = true;
                g3Detail = `V-Reclaim (+${(((currentPrice - lastExitPriceUsd) / lastExitPriceUsd) * 100).toFixed(1)}%)`;
              } else {
                g3Detail = `Descending (L3: $${low3.toFixed(2)} < L2: $${low2.toFixed(2)})`;
              }
            } else {
              if (isVReclaim) {
                g3Passed = true;
                g3Detail = "V-Reclaim Active (API fallback)";
              } else {
                g3Detail = "Awaiting candle confirmation (API limited)";
              }
            }

            const g1Status = g1Passed ? "✅ Passed" : `⏳ Locked (${g1Remaining}s left)`;
            const g2Status = gate2.detail;
            const g3Status = g3Passed ? `✅ Passed (${g3Detail})` : `⏳ Blocked (${g3Detail})`;
            const g4Status = (g1Passed && g2Passed && g3Passed) ? "🚀 Armed (Deploying next tick)" : "⏳ Awaiting Gates 1-3";

            gateTelemetry =
              `🛡️ <b>Re-Entry Gate Radar (100% USDC):</b>\n` +
              `  • <b>Gate 1 (Time Lock):</b> ${g1Status}\n` +
              `  • <b>Gate 2 (Fee Volatility):</b> ${g2Status}\n` +
              `  • <b>Gate 3 (Price Structure):</b> ${g3Status}\n` +
              `  • <b>Gate 4 (Execution):</b> ${g4Status}`;
          }

          const statusMsg =
            `📊 <b>DLMM Keeper Status</b>\n\n` +
            `• <b>Regime:</b> <code>${config.regime}</code>\n` +
            `• <b>Spot:</b> $${currentPrice.toFixed(2)}\n` +
            `• <b>Exact On-Chain Range:</b> ${rangeDisplay}\n` +
            `• <b>Floor Stop:</b> ${stopDisplay}\n` +
            `• <b>Tracked Baseline:</b> $${deployedCapitalBaselineUsd.toFixed(2)}\n` +
            `• <b>Position NFT:</b> <code>${activePositionPubkey ? activePositionPubkey.toBase58() : "None (Holding Cash)"}</code>\n\n` +
            `${gateTelemetry}`;
          await notify(statusMsg);
        } else if (text === "/harvest" || text === "harvest" || text === "sweep") {
          if (!dlmmPoolInstance || !activePositionPubkey) {
            await notify("⚠️ Cannot harvest: No active open DLMM position detected.");
            continue;
          }
          await notify("⏳ Checking and sweeping fees to USDC...");
          const sweptAmount = await sweepRevenueToVault(dlmmPoolInstance);
          if (sweptAmount > 0) {
            await notify(`✅ Sweep complete: $${sweptAmount.toFixed(2)} USDC sent to LP Revenue.`);
          } else {
            await notify("ℹ️ No surplus fees available to sweep.");
          }
        }
      }
    } catch (err: any) {
      if (err.response?.status === 409) {
        // Common during Railway rolling deploys when old+new both poll getUpdates.
        console.error("❌ [TELEGRAM 409 CONFLICT] Duplicate bot instance detected. Backing off 30s...");
        await new Promise((resolve) => setTimeout(resolve, 30000));
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// ==================== MAIN LIFECYCLE CONTROLLER ====================
async function runKeeper() {
  await notify("🚀 DLMM Automated Keeper initialized on Railway.");
  dlmmPoolInstance = await DLMM.create(connection, SOL_USDC_POOL);

  // Baseline: BASELINE_USD env, else live wallet equity (USDC + SOL*spot).
  try {
    if (BASELINE_USD_ENV && Number(BASELINE_USD_ENV) > 0) {
      deployedCapitalBaselineUsd = Number(BASELINE_USD_ENV);
    } else {
      const activeBin = await dlmmPoolInstance.getActiveBin();
      const spotUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;
      const solLamports = await connection.getBalance(wallet.publicKey);
      const solUsd = (solLamports / 1e9) * spotUsd;
      let usdcUsd = 0;
      try {
        const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
        const usdcAcc = await getAccount(connection, botUsdcAta);
        usdcUsd = Number(usdcAcc.amount) / 1e6;
      } catch {}
      deployedCapitalBaselineUsd = Number((usdcUsd + solUsd).toFixed(2));
    }
  } catch (err: any) {
    console.warn("[BASELINE] Equity probe failed:", err?.message || err);
    if (BASELINE_USD_ENV && Number(BASELINE_USD_ENV) > 0) {
      deployedCapitalBaselineUsd = Number(BASELINE_USD_ENV);
    } else {
      throw new Error("Unable to derive startup baseline. Set BASELINE_USD or ensure RPC + USDC ATA are reachable.");
    }
  }

  listenTelegramCommands().catch((e) => console.error("Command listener error:", e));

  const { userPositions } = await dlmmPoolInstance.getPositionsByUserAndLbPair(wallet.publicKey);
  const config = await macroSentinel.evaluateRegime(SOL_USDC_POOL.toBase58());

  if (userPositions.length > 0) {
    const activePos = userPositions[0];
    activePositionPubkey = activePos.publicKey;

    const activeBin = await dlmmPoolInstance.getActiveBin();
    const spotPriceUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;

    lowestBinPrice = calculateBinPriceUsd(spotPriceUsd, activeBin.binId, activePos.positionData.lowerBinId, 10);
    highestBinPrice = calculateBinPriceUsd(spotPriceUsd, activeBin.binId, activePos.positionData.upperBinId, 10);

    await notify(
      `🔗 <b>[ATTACHED TO LIVE ON-CHAIN POSITION]</b>\n` +
      `• Position: <code>${activePositionPubkey.toBase58()}</code>\n` +
      `• Regime: <code>${config.regime}</code>\n` +
      `• Spot: $${spotPriceUsd.toFixed(2)}\n` +
      `• Exact Range: $${lowestBinPrice.toFixed(2)} ➔ $${highestBinPrice.toFixed(2)}\n` +
      `• Floor Stop: $${(lowestBinPrice * (1 - config.floorStopPct)).toFixed(2)}\n` +
      `• Baseline Capital: $${deployedCapitalBaselineUsd.toFixed(2)}`
    );
  } else {
    // STANDBY IN CASH: Do NOT deploy blindly on boot
    lowestBinPrice = 0;
    highestBinPrice = 0;
    activePositionPubkey = null;
    const activeBin = await dlmmPoolInstance.getActiveBin();
    lastExitPriceUsd = Number(activeBin.price) * PRICE_DECIMAL_FACTOR; // Anchor price to prevent premature Gate 3 bypass
    await notify(`🟢 <b>[BOOTED IN 100% USDC]</b> Baseline: $${deployedCapitalBaselineUsd.toFixed(2)}. Standing by for Gate 1-3 clearance.`);
  }

  // Master Strategy Polling Loop (Every 15s)
  setInterval(async () => {
    // Skip overlapping ticks — setInterval does not await the previous callback.
    if (keeperTickRunning) return;
    keeperTickRunning = true;
    try {
      if (isBotPaused || isExiting) return;

      const now = Math.floor(Date.now() / 1000);
      if (now < inCooldownUntil) return;

      await dlmmPoolInstance!.refetchStates();
      const activeBin = await dlmmPoolInstance!.getActiveBin();
      const currentPrice = Number(activeBin.price) * PRICE_DECIMAL_FACTOR;

      const currentConfig = await macroSentinel.evaluateRegime(SOL_USDC_POOL.toBase58());

      if (now - lastSweepTime > 86400) {
        await sweepRevenueToVault(dlmmPoolInstance!);
        lastSweepTime = now;
      }

      // Re-entry evaluation if parked in 100% USDC
      if (!activePositionPubkey) {
        // Gate 2: live variable-fee bps from volatilityAccumulator (see getGate2VolatilityState).
        const gate2 = getGate2VolatilityState(dlmmPoolInstance!);
        if (gate2.passed) {
          let isConsolidating = false;
          let isVReclaim = lastExitPriceUsd > 0 && currentPrice >= (lastExitPriceUsd * 1.01);
          
          const klines = await fetchRecent15mKlines();
          if (klines && klines.length >= 3) {
            const low1 = parseFloat(klines[0][3].toString());
            const low2 = parseFloat(klines[1][3].toString());
            const low3 = parseFloat(klines[2][3].toString());
            const minLow = Math.min(low1, low2, low3);
            isConsolidating = (currentPrice > minLow) && (low3 >= low2);
          }

          // Gate 3: Require consolidation base or confirmed V-reclaim
          if (isConsolidating || isVReclaim) {
            await notify(`✅ <b>[GATE 3 CLEARED]</b> ${gate2.detail}. Price base confirmed. Re-centering grid...`);
            await deployAsymmetricPosition(dlmmPoolInstance!);
          }
        }
        return;
      }

      // Circuit Breaker Stop
      const hardStopPrice = lowestBinPrice > 0 ? lowestBinPrice * (1 - currentConfig.floorStopPct) : 0;

      if (lowestBinPrice > 0 && currentPrice <= hardStopPrice) {
        // Atomic in-flight lock: set BEFORE any await to stop double-trigger races
        // (overlapping setInterval ticks caused double close → AccountOwnedByWrongProgram 3007).
        if (isLiquidating || isExiting || now < inCooldownUntil) return;
        isLiquidating = true;
        isExiting = true;

        inCooldownUntil = now + currentConfig.cooldownSec;
        const targetPos = activePositionPubkey;
        activePositionPubkey = null;
        lowestBinPrice = 0;
        highestBinPrice = 0;

        try {
          await notify(
            `🚨 <b>[CIRCUIT BREAKER TRIGGERED]</b> Price ($${currentPrice.toFixed(2)}) breached stop ($${hardStopPrice.toFixed(2)})!\n` +
            `• Closing position and liquidating inventory to 100% USDC...`
          );

          if (dlmmPoolInstance && targetPos) {
            try {
              await sweepRevenueToVault(dlmmPoolInstance);
            } catch (sweepErr: any) {
              console.warn("Pre-close fee sweep note:", sweepErr.message);
            }
          }

          if (dlmmPoolInstance) {
            await closePositionAndReclaim(dlmmPoolInstance);
          }

          const solBal = await connection.getBalance(wallet.publicKey);
          const dumpSolLamports = Math.floor(solBal - GAS_RESERVE_LAMPORTS);
          let swapSig = "";

          if (dumpSolLamports > 0.05 * 1e9) {
            try {
              swapSig = await executeJupiterSwap(WSOL_MINT, USDC_MINT, dumpSolLamports.toString());
            } catch (swapErr: any) {
              console.error("Emergency Jupiter swap note:", swapErr.message);
            }
          }

          const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
          let postLiquidationUsdc = 0;
          try {
            const accAfter = await getAccount(connection, botUsdcAta);
            postLiquidationUsdc = Number(accAfter.amount) / 1e6;
          } catch {}

          const realizedDrawdownUsd = Number((postLiquidationUsdc - deployedCapitalBaselineUsd).toFixed(2));
          const drawdownPct = deployedCapitalBaselineUsd > 0
            ? ((realizedDrawdownUsd / deployedCapitalBaselineUsd) * 100).toFixed(2)
            : "0.00";

          lastExitPriceUsd = currentPrice;

          await notify(
            `🛡️ <b>[CIRCUIT BREAKER COMPLETE]</b>\n` +
            `• Liquidated Balance: <b>$${postLiquidationUsdc.toFixed(2)} USDC</b>\n` +
            `• Realized Drawdown: <b>-$${Math.abs(realizedDrawdownUsd).toFixed(2)} (${drawdownPct}%)</b>\n` +
            `• Cooldown: Locked for ${currentConfig.cooldownSec / 60} minutes\n` +
            `• Swap Tx: <code>${swapSig || "N/A"}</code>`
          );

          await logSheet(
            "CIRCUIT_BREAKER_STOP",
            0,
            realizedDrawdownUsd,
            0,
            swapSig || "N/A",
            `Stop loss hit at $${currentPrice.toFixed(2)}. Ending USDC: $${postLiquidationUsdc.toFixed(2)} (${drawdownPct}%)`
          );

          deployedCapitalBaselineUsd = postLiquidationUsdc;
        } finally {
          isLiquidating = false;
          isExiting = false;
        }
        return;
      }

      // Take-Profit Upper Bound Recycling
      if (highestBinPrice > 0 && currentPrice >= highestBinPrice) {
        if (isExiting || isLiquidating) return;
        isExiting = true;
        try {
        await notify(`🎯 <b>[TAKE-PROFIT]</b> Price ($${currentPrice.toFixed(2)}) cleared upper bins! Sweeping fees and unwinding...`);
        
        await sweepRevenueToVault(dlmmPoolInstance!);
        await closePositionAndReclaim(dlmmPoolInstance!);
        
        const botUsdcAta = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
        let postTpUsdc = 0;
        try {
          const acc = await getAccount(connection, botUsdcAta);
          postTpUsdc = Number(acc.amount) / 1e6;
        } catch {}

        const realizedGainUsd = Number((postTpUsdc - deployedCapitalBaselineUsd).toFixed(2));
        const pnlSign = realizedGainUsd >= 0 ? "+$" : "-$";
        const gainPct = deployedCapitalBaselineUsd > 0 ? ((realizedGainUsd / deployedCapitalBaselineUsd) * 100).toFixed(2) : "0.00";
        
        lastExitPriceUsd = currentPrice;

        await notify(
          `📈 <b>[REBALANCING GRID]</b>\n` +
          `• Capital Returned: $${postTpUsdc.toFixed(2)}\n` +
          `• Net PnL: ${pnlSign}${Math.abs(realizedGainUsd).toFixed(2)} (${realizedGainUsd >= 0 ? "+" : ""}${gainPct}%)\n` +
          `Recycling grid higher...`
        );
        
        if (realizedGainUsd !== 0) {
          await logSheet(
            "TAKE_PROFIT",
            0,
            realizedGainUsd,
            0,
            "N/A",
            `Grid cleared upper bound at $${currentPrice.toFixed(2)}. Net PnL: ${pnlSign}${Math.abs(realizedGainUsd).toFixed(2)}`
          );
        }

        activePositionPubkey = null;
        lowestBinPrice = 0;
        highestBinPrice = 0;
        await deployAsymmetricPosition(dlmmPoolInstance!);
        } finally {
          isExiting = false;
        }
      }
    } catch (err: any) {
      console.error("[Keeper Loop Error]:", err.message);
    } finally {
      keeperTickRunning = false;
    }
  }, 15000);
}

runKeeper().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
