/**
 * Read-only view of one wallet's SOL exposure in a Meteora SOL/USDC DLMM pool.
 * Uses public account reads only. Never builds, signs, or sends a transaction.
 */
import DLMM from "@meteora-ag/dlmm";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TickReader } from "../tickreader";
import { equityFromSnapshot, positionSolUnitsFromAmounts } from "../tickstate";
import { lpSolFromParts, positionFingerprint } from "./engine";
import { redact } from "./redact";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const PRICE_FACTOR = 1000;

export interface ChainSample {
  ok: boolean;
  reason?: string;
  fetchedAtMs: number;
  solPrice: number;
  lpSol: number;
  lpEquity: number;
  positionSol: number;
  idleSol: number;
  binStep: number;
  positionIds: string[];
  fingerprint: string;
}

function failed(reason: string): ChainSample {
  return {
    ok: false,
    reason: redact(reason),
    fetchedAtMs: Date.now(),
    solPrice: NaN,
    lpSol: NaN,
    lpEquity: NaN,
    positionSol: NaN,
    idleSol: NaN,
    binStep: 0,
    positionIds: [],
    fingerprint: "",
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export class ChainObserver {
  private dlmm: DLMM | null = null;
  private reader: TickReader | null = null;

  constructor(
    private connection: Connection,
    private pool: PublicKey,
    private owner: PublicKey,
    private gasReserveLamports: number,
    private bucketSol: number,
    private timeoutMs = 20000
  ) {}

  async read(): Promise<ChainSample> {
    try {
      if (!this.dlmm || !this.reader) {
        const dlmm = await withTimeout(DLMM.create(this.connection, this.pool), this.timeoutMs, "DLMM.create");
        const lb: any = (dlmm as any).lbPair;
        const xMint = lb?.tokenXMint?.toBase58?.();
        const yMint = lb?.tokenYMint?.toBase58?.();
        if (xMint !== WSOL_MINT.toBase58() || yMint !== USDC_MINT.toBase58()) {
          return failed(`pool is not SOL(X)/USDC(Y) (X=${xMint} Y=${yMint})`);
        }
        this.dlmm = dlmm;
        this.reader = new TickReader(
          this.connection,
          dlmm,
          this.owner,
          getAssociatedTokenAddressSync(USDC_MINT, this.owner),
          getAssociatedTokenAddressSync(WSOL_MINT, this.owner),
          PRICE_FACTOR,
          true
        );
      }
      const found: any = await withTimeout(
        this.dlmm.getPositionsByUserAndLbPair(this.owner),
        this.timeoutMs,
        "getPositionsByUserAndLbPair"
      );
      const list: any[] = found?.userPositions ?? [];
      const keys: PublicKey[] = [];
      for (const p of list) {
        const k = p?.publicKey;
        if (k instanceof PublicKey) keys.push(k);
        else if (typeof k?.toBase58 === "function") keys.push(new PublicKey(k.toBase58()));
      }
      const snap = await withTimeout(this.reader.read(keys), this.timeoutMs, "tick read");
      if (!snap.ok) return failed(snap.reason || "tick read failed");
      const equity = equityFromSnapshot({
        spotUsd: snap.spotUsd,
        nativeLamports: snap.nativeLamports,
        wsolRaw: snap.wsolRaw,
        usdcRaw: snap.usdcRaw,
        positions: snap.amounts,
        missing: snap.missing,
        expectedKey: null,
      });
      if (!equity.ok || equity.totalUsd == null) return failed(equity.reason || "equity incomplete");
      const positionSol = positionSolUnitsFromAmounts(snap.amounts);
      const idleLamports = Math.max(0, snap.nativeLamports + snap.wsolRaw - this.gasReserveLamports);
      const lpSol = lpSolFromParts(positionSol, snap.nativeLamports, snap.wsolRaw, this.gasReserveLamports);
      const positionIds = snap.amounts.filter((a) => a.ok).map((a) => a.key).sort();
      return {
        ok: true,
        fetchedAtMs: Date.now(),
        solPrice: snap.spotUsd,
        lpSol,
        lpEquity: equity.totalUsd,
        positionSol,
        idleSol: idleLamports / 1e9,
        binStep: Number(snap.lbPair?.binStep) || 0,
        positionIds,
        fingerprint: positionFingerprint(snap.amounts, this.bucketSol),
      };
    } catch (err: any) {
      this.dlmm = null;
      this.reader = null;
      return failed(err?.message || String(err));
    }
  }
}
