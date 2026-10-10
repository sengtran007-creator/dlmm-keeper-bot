/**
 * RPC credit accounting (Helius-style weights) + an optional per-method call counter that wraps a
 * web3.js Connection. Pure helpers are unit-tested; the counter never logs arguments (no URLs/keys).
 */

/** Methods Helius bills at 10 credits (everything else standard is 1). */
const TEN_CREDIT_METHODS = new Set([
  "getProgramAccounts",
  "getSignaturesForAddress",
  "getTransaction",
  "getBlock",
  "getBlocks",
  "getBlockTime",
  "getInflationReward",
  "getConfirmedBlock",
  "getConfirmedTransaction",
  "getConfirmedSignaturesForAddress2",
]);

/** Credits one JSON-RPC request costs. getSignatureStatuses is 10 only with searchTransactionHistory. */
export function rpcCredits(method: string, args?: any[]): number {
  if (TEN_CREDIT_METHODS.has(method)) return 10;
  if (method === "getSignatureStatuses") {
    const cfg = Array.isArray(args) ? args[1] : undefined;
    return cfg && cfg.searchTransactionHistory ? 10 : 1;
  }
  return 1;
}

export interface MethodStats {
  calls: number;
  credits: number;
}

export class RpcCallCounter {
  byMethod = new Map<string, MethodStats>();
  add(method: string, args?: any[]): void {
    const s = this.byMethod.get(method) ?? { calls: 0, credits: 0 };
    s.calls += 1;
    s.credits += rpcCredits(method, args);
    this.byMethod.set(method, s);
  }
  totalCredits(): number {
    let t = 0;
    for (const s of this.byMethod.values()) t += s.credits;
    return t;
  }
  totalCalls(): number {
    let t = 0;
    for (const s of this.byMethod.values()) t += s.calls;
    return t;
  }
  reset(): void {
    this.byMethod.clear();
  }
  /** "getMultipleAccounts 240×=240, getProgramAccounts 4×=40" sorted by credits desc. */
  summary(): string {
    return [...this.byMethod.entries()]
      .sort((a, b) => b[1].credits - a[1].credits)
      .map(([m, s]) => `${m} ${s.calls}×=${s.credits}`)
      .join(", ");
  }
  snapshot(): Record<string, MethodStats> {
    const o: Record<string, MethodStats> = {};
    for (const [m, s] of this.byMethod) o[m] = { ...s };
    return o;
  }
}

/**
 * Count every JSON-RPC request a Connection makes (single + batch). Patches the instance's internal
 * request functions (web3.js 1.x `_rpcRequest` / `_rpcBatchRequest`); a no-op if they are absent.
 */
export function attachRpcCounter(connection: any, counter: RpcCallCounter): boolean {
  let attached = false;
  const single = connection?._rpcRequest;
  if (typeof single === "function") {
    connection._rpcRequest = (method: string, args: any[]) => {
      counter.add(method, args);
      return single.call(connection, method, args);
    };
    attached = true;
  }
  const batch = connection?._rpcBatchRequest;
  if (typeof batch === "function") {
    connection._rpcBatchRequest = (requests: { methodName: string; args: any[] }[]) => {
      for (const r of requests || []) counter.add(r.methodName, r.args);
      return batch.call(connection, requests);
    };
    attached = true;
  }
  return attached;
}

/** Credits/day for something that costs `creditsPerRun` every `everySec` seconds. */
export function creditsPerDay(creditsPerRun: number, everySec: number): number {
  if (!(everySec > 0)) return 0;
  return Math.round((creditsPerRun * 86_400) / everySec);
}
