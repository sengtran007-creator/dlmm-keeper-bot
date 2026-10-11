// Gas-reserve accounting for opening a position (deploy / take-profit redeploy / recenter redeploy).
//
// Bug this fixes: the deploy path sized the SOL leg as `native − GAS_RESERVE` and then paid the new
// position's rent (+ any bin-array / bitmap rent + tx fees) out of what was left, so every open landed at
// GAS_RESERVE − positionRent − fees (0.12 − 0.0419 − 0.00001 ≈ 0.0781 SOL on SOL-USDC), whatever the
// starting balance. Here the one-off open cost is held back too, so native SOL after the open is
// ≥ GAS_RESERVE (+ a small fee buffer that the fees then consume).
//
// Pure helpers only (no RPC) so they can be unit tested; index.ts gathers the inputs.

import BN from "bn.js";
import { BIN_ARRAY_FEE, calculatePositionSize } from "@meteora-ag/dlmm";

/** Anchor account discriminator: the on-chain position account is calculatePositionSize() + 8 bytes. */
export const ACCOUNT_DISCRIMINATOR_BYTES = 8;

/** Data size of a new position account covering `binCount` bins (8120 bytes for ≤ 70 bins). */
export function positionAccountBytes(binCount: number): number {
  const n = Math.max(1, Math.floor(binCount));
  return (calculatePositionSize(new BN(n) as any) as any).toNumber() + ACCOUNT_DISCRIMINATOR_BYTES;
}

/** SDK estimate of rent for one new bin array, in lamports (0.07143744 SOL). */
export const BIN_ARRAY_RENT_LAMPORTS = Math.round(BIN_ARRAY_FEE * 1e9);

export interface OpenCostInput {
  /** Rent-exempt minimum for the new position account (getMinimumBalanceForRentExemption). */
  positionRentLamports: number;
  /** Bin arrays the open will create (0 when they already exist — the usual case). */
  binArraysToCreate: number;
  /** Rent per bin array (default: SDK BIN_ARRAY_FEE). */
  binArrayRentLamports?: number;
  /** Bitmap-extension rent when the range overflows the default bitmap (rare), lamports. */
  bitmapExtensionLamports?: number;
}

/** One-off SOL cost of opening a position: position rent + new bin arrays + bitmap extension. */
export function openCostLamports(i: OpenCostInput): number {
  const pos = Math.max(0, Math.ceil(i.positionRentLamports || 0));
  const arrays = Math.max(0, Math.floor(i.binArraysToCreate || 0));
  const perArray = Math.max(0, Math.ceil(i.binArrayRentLamports ?? BIN_ARRAY_RENT_LAMPORTS));
  const bitmap = Math.max(0, Math.ceil(i.bitmapExtensionLamports || 0));
  return pos + arrays * perArray + bitmap;
}

/** Native SOL that must stay out of the position: reserve + open cost + fee buffer. */
export function deployHoldbackLamports(reserveLamports: number, openCost: number, feeBufferLamports: number): number {
  return Math.max(0, reserveLamports) + Math.max(0, openCost) + Math.max(0, feeBufferLamports);
}

/** SOL (lamports) that may go into the position's X leg: min(target ask, native − holdback), never < 0. */
export function deploySolLamports(nativeLamports: number, holdbackLamports: number, targetAskLamports: number): number {
  const avail = Math.floor(nativeLamports - holdbackLamports);
  return Math.max(0, Math.min(avail, Math.floor(targetAskLamports)));
}

/** Native SOL expected after the open (before tx fees), for logging / the post-open check. */
export function expectedNativeAfterOpen(nativeLamports: number, depositLamports: number, openCost: number): number {
  return nativeLamports - depositLamports - openCost;
}
