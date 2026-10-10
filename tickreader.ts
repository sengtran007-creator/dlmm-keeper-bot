/**
 * One batched account read per keeper tick (1 RPC credit): pool (lbPair → active bin → spot), clock,
 * LP wallet (native SOL), USDC + WSOL ATAs, every tracked position account and the bin arrays covering
 * them. Replaces refetchStates + getActiveBin×2 + getBalance + getAccount×2 + getPositionsByUserAndLbPair
 * (a 10-credit getProgramAccounts) on every 15 s tick. Positions are decoded with the SDK's own
 * wrapPosition + DLMM.processPosition, so amounts/fees are computed exactly as the SDK does.
 */
import DLMM, { ClockLayout, decodeAccount, getPriceOfBinByBinId, wrapPosition } from "@meteora-ag/dlmm";
import { AccountInfo, Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { AccountLayout, ACCOUNT_SIZE, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PositionAmounts } from "./tickstate";

export interface TickPosition {
  publicKey: PublicKey;
  positionData: any;
}

export interface TickSnapshot {
  ok: boolean;
  reason?: string;
  /** Pool active bin + derived spot (USD/SOL). */
  activeBinId: number;
  spotUsd: number;
  lbPair: any;
  nativeLamports: number;
  wsolRaw: number;
  usdcRaw: number;
  /** Tracked positions that were read and decoded. */
  positions: TickPosition[];
  /** Pure amounts for equityFromSnapshot (ok:false entries = partial read). */
  amounts: PositionAmounts[];
  /** Tracked position keys whose account is absent (closed / not returned). */
  missing: string[];
  /** RPC requests this read took (1 normally; 2 when a position's bin-array coverage changed). */
  requests: number;
}

function numField(v: any): number {
  if (v == null) return NaN;
  return Number(v?.toString?.() ?? v);
}

function tokenAmount(info: AccountInfo<Buffer> | null, label: string): number {
  if (!info) return 0; // ATA not created yet → 0 (same as getAccount's TokenAccountNotFound path)
  const owner = info.owner;
  if (!(owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID)) || info.data.length < ACCOUNT_SIZE) {
    throw new Error(`${label} account is not a token account`);
  }
  return Number(AccountLayout.decode(info.data.subarray(0, ACCOUNT_SIZE)).amount);
}

export class TickReader {
  /** Bin-array keys covering each position (a position's bin range is fixed, so this rarely changes). */
  private coverage = new Map<string, PublicKey[]>();

  constructor(
    private connection: Connection,
    private dlmm: DLMM,
    private owner: PublicKey,
    private usdcAta: PublicKey,
    private wsolAta: PublicKey,
    private priceFactor: number,
    /** When true, write the fresh lbPair/clock back onto the DLMM instance (Gate 2 reads lbPair). */
    private updatePool = true
  ) {}

  /** Forget cached coverage (call after a deploy/close). */
  reset(): void {
    this.coverage.clear();
  }

  async read(positionKeys: PublicKey[]): Promise<TickSnapshot> {
    const fail = (reason: string, requests: number): TickSnapshot => ({
      ok: false, reason, activeBinId: NaN, spotUsd: NaN, lbPair: null, nativeLamports: NaN, wsolRaw: NaN, usdcRaw: NaN,
      positions: [], amounts: [], missing: [], requests,
    });
    const program: any = (this.dlmm as any).program;
    const programId: PublicKey = program.programId;
    const uniqPositions = [...new Map(positionKeys.map((k) => [k.toBase58(), k])).values()];
    const cachedArrays = new Map<string, PublicKey>();
    for (const k of uniqPositions) for (const b of this.coverage.get(k.toBase58()) ?? []) cachedArrays.set(b.toBase58(), b);
    const base = [this.dlmm.pubkey, SYSVAR_CLOCK_PUBKEY, this.owner, this.usdcAta, this.wsolAta];
    const keys = [...base, ...uniqPositions, ...cachedArrays.values()];
    let requests = 0;
    let infos: (AccountInfo<Buffer> | null)[];
    try {
      requests++;
      infos = await this.connection.getMultipleAccountsInfo(keys, "confirmed");
    } catch (err: any) {
      return fail(`batched read failed: ${err?.message || err}`, requests);
    }
    if (!Array.isArray(infos) || infos.length !== keys.length) return fail("batched read returned a short list", requests);
    const [lbInfo, clockInfo, walletInfo, usdcInfo, wsolInfo] = infos;
    if (!lbInfo) return fail("pool account not returned", requests);
    if (!clockInfo) return fail("clock sysvar not returned", requests);
    let lbPair: any;
    let clock: any;
    let nativeLamports: number;
    let usdcRaw: number;
    let wsolRaw: number;
    try {
      lbPair = decodeAccount(program, "lbPair", lbInfo.data);
      clock = ClockLayout.decode(clockInfo.data);
      nativeLamports = walletInfo ? walletInfo.lamports : 0;
      usdcRaw = tokenAmount(usdcInfo, "USDC ATA");
      wsolRaw = tokenAmount(wsolInfo, "WSOL ATA");
    } catch (err: any) {
      return fail(`decode failed: ${err?.message || err}`, requests);
    }
    const activeBinId = Number(lbPair?.activeId);
    const binStep = Number(lbPair?.binStep);
    const spotUsd = Number(getPriceOfBinByBinId(activeBinId, binStep).toString()) * this.priceFactor;

    const binArrays = new Map<string, any>();
    const posInfos = infos.slice(base.length, base.length + uniqPositions.length);
    const arrInfos = infos.slice(base.length + uniqPositions.length);
    const arrKeys = [...cachedArrays.values()];
    const decodeArr = (k: PublicKey, info: AccountInfo<Buffer> | null) => {
      if (info) binArrays.set(k.toBase58(), decodeAccount(program, "binArray", info.data));
    };
    try {
      arrKeys.forEach((k, i) => decodeArr(k, arrInfos[i]));
    } catch (err: any) {
      return fail(`bin array decode failed: ${err?.message || err}`, requests);
    }

    const missing: string[] = [];
    const wrappers: { key: PublicKey; wrapper: any }[] = [];
    const needArrays = new Map<string, PublicKey>();
    for (let i = 0; i < uniqPositions.length; i++) {
      const key = uniqPositions[i];
      const info = posInfos[i];
      if (!info || info.data.length === 0 || !info.owner.equals(programId)) {
        missing.push(key.toBase58());
        this.coverage.delete(key.toBase58());
        continue;
      }
      try {
        const wrapper = wrapPosition(program, key, info as any);
        const cov: PublicKey[] = wrapper.getBinArrayKeysCoverage(programId);
        this.coverage.set(key.toBase58(), cov);
        for (const b of cov) if (!cachedArrays.has(b.toBase58())) needArrays.set(b.toBase58(), b);
        wrappers.push({ key, wrapper });
      } catch (err: any) {
        return fail(`position ${key.toBase58().slice(0, 8)} decode failed: ${err?.message || err}`, requests);
      }
    }
    if (needArrays.size > 0) {
      // First read of a position (or its range changed): fetch its bin arrays once; cached afterwards.
      const ks = [...needArrays.values()];
      try {
        requests++;
        const more = await this.connection.getMultipleAccountsInfo(ks, "confirmed");
        ks.forEach((k, i) => decodeArr(k, more?.[i] ?? null));
      } catch (err: any) {
        return fail(`bin array read failed: ${err?.message || err}`, requests);
      }
    }

    const positions: TickPosition[] = [];
    const amounts: PositionAmounts[] = [];
    const t: any = this.dlmm as any;
    for (const { key, wrapper } of wrappers) {
      let pd: any = null;
      try {
        pd = await (DLMM as any).processPosition(
          program, lbPair, clock, wrapper, t.tokenX.mint, t.tokenY.mint, t.rewards?.[0]?.mint, t.rewards?.[1]?.mint, binArrays
        );
      } catch (err: any) {
        pd = null;
      }
      if (pd) positions.push({ publicKey: key, positionData: pd });
      amounts.push({
        key: key.toBase58(),
        ok: !!pd,
        x: numField(pd?.totalXAmount),
        y: numField(pd?.totalYAmount),
        feeX: numField(pd?.feeX),
        feeY: numField(pd?.feeY),
      });
    }

    if (this.updatePool) {
      t.lbPair = lbPair;
      t.clock = clock;
    }
    return { ok: true, activeBinId, spotUsd, lbPair, nativeLamports, wsolRaw, usdcRaw, positions, amounts, missing, requests };
  }
}
