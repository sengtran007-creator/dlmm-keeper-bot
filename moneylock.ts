// H1: one async mutex around every action that moves money (tick operations, Telegram money commands, the
// catch-up sweep). Re-entrant within the same async call chain (e.g. /emergency_exit → fee sweep), so nested
// money actions never deadlock, while a concurrent caller waits (or, for the tick, skips).
import { AsyncLocalStorage } from "node:async_hooks";

export class MoneyLock {
  private tail: Promise<void> = Promise.resolve();
  private holderLabel: string | null = null;
  private als = new AsyncLocalStorage<symbol>();
  /** Token of the current acquisition: async contexts that outlive it (timers scheduled inside) do not hold it. */
  private token: symbol | null = null;
  private queued = 0;

  get holder(): string | null {
    return this.holderLabel;
  }

  /** True when the current async chain already holds the lock. */
  get heldByMe(): boolean {
    const t = this.als.getStore();
    return t != null && t === this.token;
  }

  /** Runs fn exclusively; waits for the current holder (up to timeoutMs, then throws). */
  async run<T>(label: string, fn: () => Promise<T>, timeoutMs = 300_000): Promise<T> {
    if (this.heldByMe) return fn();
    let release!: () => void;
    const prev = this.tail;
    const mine = new Promise<void>((r) => (release = r));
    this.tail = prev.then(() => mine);
    let timer: NodeJS.Timeout | null = null;
    this.queued += 1;
    try {
      await Promise.race([
        prev,
        new Promise<void>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`money lock busy (${this.holderLabel ?? "?"}) for ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
        }),
      ]);
    } catch (e) {
      // Still queued behind prev: hand our slot through as soon as prev finishes.
      prev.then(() => release());
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      this.queued -= 1;
    }
    const token = Symbol(label);
    this.token = token;
    this.holderLabel = label;
    try {
      return await this.als.run(token, fn);
    } finally {
      this.holderLabel = null;
      this.token = null;
      release();
    }
  }

  /** Runs fn only if the lock is free right now (or already held by this chain); else returns {ran:false}. */
  async tryRun<T>(label: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false; holder: string | null }> {
    if (this.heldByMe) return { ran: true, value: await fn() };
    if (this.holderLabel != null || this.queued > 0) return { ran: false, holder: this.holderLabel ?? "queued" };
    return { ran: true, value: await this.run(label, fn) };
  }
}
