import { test } from "node:test";
import assert from "node:assert/strict";
import { MoneyLock } from "../moneylock";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("run is exclusive and FIFO", async () => {
  const l = new MoneyLock();
  const log: string[] = [];
  const a = l.run("a", async () => { log.push("a+"); await sleep(30); log.push("a-"); });
  const b = l.run("b", async () => { log.push("b+"); await sleep(5); log.push("b-"); });
  await Promise.all([a, b]);
  assert.deepEqual(log, ["a+", "a-", "b+", "b-"]);
});

test("tryRun skips while held or queued (tick vs /withdraw_pct)", async () => {
  const l = new MoneyLock();
  let release!: () => void;
  const held = l.run("/withdraw_pct", () => new Promise<void>((r) => (release = r)));
  await sleep(1);
  const t = await l.tryRun("tick", async () => 1);
  assert.equal(t.ran, false);
  assert.equal((t as any).holder, "/withdraw_pct");
  release();
  await held;
  const t2 = await l.tryRun("tick", async () => 2);
  assert.deepEqual(t2, { ran: true, value: 2 });
});

test("re-entrant within one async chain (emergency exit → sweep), no deadlock", async () => {
  const l = new MoneyLock();
  const v = await l.run("outer", async () => {
    await sleep(1);
    const inner = await l.run("inner", async () => "x");
    const tr = await l.tryRun("inner2", async () => "y");
    return inner + (tr.ran ? (tr as any).value : "-");
  });
  assert.equal(v, "xy");
});

test("a timer scheduled inside a locked chain does NOT inherit the lock", async () => {
  const l = new MoneyLock();
  let later!: Promise<boolean>;
  await l.run("tick", async () => {
    later = new Promise((res) => setTimeout(() => res(l.heldByMe), 20));
  });
  let release!: () => void;
  const other = l.run("other", () => new Promise<void>((r) => (release = r)));
  assert.equal(await later, false);
  release();
  await other;
});

test("errors release the lock; run times out when held too long", async () => {
  const l = new MoneyLock();
  await assert.rejects(l.run("boom", async () => { throw new Error("x"); }));
  assert.equal(l.holder, null);
  let release!: () => void;
  const held = l.run("long", () => new Promise<void>((r) => (release = r)));
  await assert.rejects(l.run("waiter", async () => 1, 20), /money lock busy/);
  release();
  await held;
  assert.deepEqual(await l.tryRun("after", async () => 3), { ran: true, value: 3 });
});
