// Full-cycle rehearsal: runs the REAL bot (dist/index.js) against a local solana-test-validator that has the
// Meteora DLMM program + the 4bps SOL/USDC pool cloned from mainnet. Throwaway keys only (rehearsal/.state).
// Steps: open → fees → recenter-below → take-profit-above → restart-mid-close (before + after the close lands)
// → stop-out. Invariants are asserted after every step; results go to rehearsal/.state/report.json.
// Prereqs: `bash rehearsal/start-validator.sh` running, `npm run build`. Usage: node rehearsal/run.js [steps,...]
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const L = require("./lib");
const market = require("./market");
const stubs = require("./stubs");

const ROOT = path.join(__dirname, "..");
const RUN_DIR = path.join(L.STATE_DIR, "run"); // bot cwd: no .env here, so dotenv loads nothing real
const BOT_LOG = path.join(L.STATE_DIR, "bot.log");
const GAS_RESERVE = 120_000_000;
const results = [];
let bot = null;
let logBuf = "";

const bk = L.loadOrCreateKey("bot");
const revenue = L.loadOrCreateKey("revenue");
const whale = L.loadOrCreateKey("whale");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(`[rehearsal ${now()}]`, ...a);

function botEnv(extra = {}) {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "",
    RPC_URL: L.RPC, BOT_PRIVATE_KEY: L.bs58.encode(bk.secretKey), REVENUE_WALLET_PUBKEY: revenue.publicKey.toBase58(),
    POOL_ADDRESS: L.POOL.address, INSTANCE_LABEL: "rehearsal", BOT_NAME: "rehearsal",
    TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", TELEGRAM_COMMANDS_ENABLED: "false",
    GOOGLE_SHEET_WEBHOOK_URL: `http://127.0.0.1:${stubs.PORT}/ledger`, JUPITER_API_BASE: `http://127.0.0.1:${stubs.PORT}/jup`, JUPITER_API_KEY: "",
    BELOW_RANGE_TICKS: "2", RECENTER_COOLDOWN_SEC: "30", RECENTER_FAIL_RETRY_SEC: "30", SNAPSHOT_INTERVAL_SEC: "120",
    TOPUP_COOLDOWN_SEC: "60", POSITION_DISCOVERY_SEC: "120", RPC_CREDIT_LOG_SEC: "600",
    ...extra,
  };
}
function startBot(extra = {}) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const out = fs.openSync(BOT_LOG, "a");
  fs.writeSync(out, `\n===== bot start ${new Date().toISOString()} ${JSON.stringify(extra)} =====\n`);
  bot = spawn(process.execPath, [path.join(ROOT, "dist", "index.js")], { cwd: RUN_DIR, env: botEnv(extra) });
  const mark = logBuf.length;
  const onData = (d) => { const s = d.toString(); logBuf += s; fs.writeSync(out, s); };
  bot.stdout.on("data", onData);
  bot.stderr.on("data", onData);
  bot.on("exit", (code, sig) => { say(`bot exited code=${code} sig=${sig}`); });
  return mark;
}
function killBot() { if (bot && bot.exitCode == null) { bot.kill("SIGKILL"); } bot = null; }
async function waitLog(re, from, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const m = logBuf.slice(from).match(re);
    if (m) return { m, at: from + logBuf.slice(from).search(re) };
    await sleep(500);
  }
  return null;
}
function ledgerRows() {
  if (!fs.existsSync(stubs.LEDGER)) return [];
  return fs.readFileSync(stubs.LEDGER, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function chain() {
  const conn = market.conn;
  const p = await market.pool();
  const s = await market.spot();
  const native = await conn.getBalance(bk.publicKey, "confirmed");
  const tok = async (owner, mint) => {
    try { return Number((await L.spl.getAccount(conn, L.spl.getAssociatedTokenAddressSync(mint, owner))).amount); } catch { return 0; }
  };
  const usdc = await tok(bk.publicKey, L.USDC_MINT);
  const wsol = await tok(bk.publicKey, L.WSOL_MINT);
  const { userPositions } = await p.getPositionsByUserAndLbPair(bk.publicKey);
  const positions = userPositions.map((u) => ({
    key: u.publicKey.toBase58(), lower: u.positionData.lowerBinId, upper: u.positionData.upperBinId,
    x: Number(u.positionData.totalXAmount), y: Number(u.positionData.totalYAmount),
    feeX: Number(u.positionData.feeX ?? 0), feeY: Number(u.positionData.feeY ?? 0),
  }));
  // Position-account rent is refundable on close, so it counts toward equity here (the bot's own equity excludes it).
  const rentInfos = positions.length ? await conn.getMultipleAccountsInfo(positions.map((q) => new PublicKey(q.key))) : [];
  positions.forEach((q, i) => (q.rent = rentInfos[i]?.lamports ?? 0));
  const posUsd = positions.reduce((a, q) => a + ((q.x + q.rent) / 1e9) * s.price + q.y / 1e6, 0);
  const walletUsd = ((native + wsol) / 1e9) * s.price + usdc / 1e6;
  const revNative = await conn.getBalance(revenue.publicKey, "confirmed");
  const revUsdc = await tok(revenue.publicKey, L.USDC_MINT);
  return { spot: s.price, binId: s.binId, native, usdc, wsol, positions, posUsd, walletUsd, equityUsd: walletUsd + posUsd, revNative, revUsdc };
}
function valueAt(c, spot) {
  return ((c.native + c.wsol) / 1e9) * spot + c.usdc / 1e6 + c.positions.reduce((a, q) => a + ((q.x + (q.rent || 0)) / 1e9) * spot + q.y / 1e6, 0);
}
function revenueUsd(c, spot) { return (c.revNative / 1e9) * spot + c.revUsdc / 1e6; }

function check(step, name, ok, detail) {
  results.push({ step, name, ok: !!ok, detail });
  say(`${ok ? "PASS" : "FAIL"} [${step}] ${name} — ${detail}`);
}
function lastMatch(re, from = 0) {
  const all = [...logBuf.slice(from).matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))];
  return all.length ? all[all.length - 1] : null;
}

/** Shared invariants after a step that should leave exactly one managed position. */
async function positionInvariants(step, from, pre, opts = {}) {
  const c = await chain();
  const deployed = lastMatch(/Position: <code>([1-9A-HJ-NP-Za-km-z]{32,44})<\/code>|POSITION ADOPTED\]<\/b> <code>([1-9A-HJ-NP-Za-km-z]{32,44})/, from) || lastMatch(/Re-attached to still-open position ([1-9A-HJ-NP-Za-km-z]{32,44})/, from) || lastMatch(/\[ATTACH\][^\n]*?([1-9A-HJ-NP-Za-km-z]{43,44})/, from);
  check(step, "exactly one position on chain (no orphans)", c.positions.length === 1, `${c.positions.length} position(s): ${c.positions.map((q) => q.key.slice(0, 8)).join(",")}`);
  const dKey = deployed ? deployed[1] || deployed[2] : null;
  if (dKey && c.positions.length) check(step, "bot tracks the on-chain position", c.positions.some((q) => q.key === dKey), `bot says ${dKey.slice(0, 8)}`);
  if (!opts.skipReserve) check(step, "native SOL ≥ GAS_RESERVE after open", c.native >= GAS_RESERVE, `native ${(c.native / 1e9).toFixed(6)} SOL (reserve 0.12)`);
  const stop = lastMatch(/Floor Stop: \$([\d.]+)/, from) || lastMatch(/floor stop \$([\d.]+)/i, from) || lastMatch(/Floor Stop: \$([\d.]+)/);
  check(step, "stops armed (price stop logged > 0)", stop && Number(stop[1]) > 0 && !/STOPS BLIND/.test(logBuf.slice(from)), stop ? `price stop $${stop[1]}` : "no stop line");
  if (pre) {
    // Equity conservation at (nearly) the same spot: Δequity + Δrevenue should be ≈ −(costs); IL is zero when the
    // price is held still by the harness during the bot's operation.
    const dEq = c.equityUsd - valueAt(pre, c.spot);
    const dRev = revenueUsd(c, c.spot) - revenueUsd(pre, c.spot);
    const spotMove = Math.abs(c.spot / pre.spot - 1);
    const tol = Math.max(1.0, pre.equityUsd * (0.004 + spotMove * 0.5));
    const net = dEq + dRev;
    check(step, "equity conserved (Δequity + Δrevenue within fees/costs)", net <= 0.5 && net >= -tol,
      `Δequity ${dEq.toFixed(2)} + Δrevenue ${dRev.toFixed(2)} = ${net.toFixed(2)} (tol −${tol.toFixed(2)}, spot ${pre.spot.toFixed(3)}→${c.spot.toFixed(3)})`);
  }
  return c;
}

/** Ledger rows written during the step reconcile with on-chain wallet deltas. */
async function ledgerInvariants(step, rowsFrom, pre, post) {
  const rows = ledgerRows().slice(rowsFrom);
  const ev = (e) => rows.filter((r) => (r.event || r.event_type) === e);
  const sweptUsdcLedger = ev("FEE_SWEEP").filter((r) => !(r.sol_swept > 0)).reduce((a, r) => a + Number(r.swept_to_revenue_usd || 0), 0);
  const sweptSolLedger = ev("FEE_SWEEP").reduce((a, r) => a + Number(r.sol_swept || 0), 0);
  check(step, "FEE_SWEEP USDC rows = revenue USDC delta", Math.abs(sweptUsdcLedger - (post.revUsdc - pre.revUsdc) / 1e6) < 0.000002,
    `ledger ${sweptUsdcLedger.toFixed(6)} vs chain ${((post.revUsdc - pre.revUsdc) / 1e6).toFixed(6)}`);
  check(step, "FEE_SWEEP SOL rows = revenue SOL delta", Math.abs(sweptSolLedger * 1e9 - (post.revNative - pre.revNative)) < 2,
    `ledger ${sweptSolLedger.toFixed(9)} vs chain ${((post.revNative - pre.revNative) / 1e9).toFixed(9)}`);
  // Each swept $ must come from a FEE_CLAIM (fees counted once).
  const claimed = ev("FEE_CLAIM").reduce((a, r) => a + Number(r.fees_claimed_usd || 0), 0);
  const swept = ev("FEE_SWEEP").reduce((a, r) => a + Number(r.swept_to_revenue_usd || 0), 0);
  if (swept > 0 || claimed > 0) check(step, "swept ≤ claimed (+1% for SOL repricing)", swept <= claimed * 1.01 + 0.01, `claimed $${claimed.toFixed(4)} swept $${swept.toFixed(4)}`);
  // CLOSE row legs vs tx meta of its signatures.
  for (const r of ev("CLOSE")) {
    let sol = 0, usdc = 0;
    for (const sig of String(r.tx_sig || "").split(",").filter(Boolean)) {
      const tx = await market.conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).staticAccountKeys.map(String);
      const i = keys.indexOf(bk.publicKey.toBase58());
      sol += tx.meta.postBalances[i] - tx.meta.preBalances[i] + tx.meta.fee;
      const tb = (arr) => (arr || []).filter((b) => b.owner === bk.publicKey.toBase58());
      for (const b of tb(tx.meta.postTokenBalances)) if (b.mint === L.USDC_MINT.toBase58()) usdc += Number(b.uiTokenAmount.amount);
      for (const b of tb(tx.meta.preTokenBalances)) if (b.mint === L.USDC_MINT.toBase58()) usdc -= Number(b.uiTokenAmount.amount);
      for (const b of tb(tx.meta.postTokenBalances)) if (b.mint === L.WSOL_MINT.toBase58()) sol += Number(b.uiTokenAmount.amount);
      for (const b of tb(tx.meta.preTokenBalances)) if (b.mint === L.WSOL_MINT.toBase58()) sol -= Number(b.uiTokenAmount.amount);
    }
    check(step, "CLOSE row USDC = tx meta", Math.abs(Number(r.swap_out_amount || 0) * 1e6 - usdc) <= 1, `ledger ${Number(r.swap_out_amount || 0).toFixed(6)} vs meta ${(usdc / 1e6).toFixed(6)}`);
    check(step, "CLOSE row SOL ≈ tx meta (fee-adjusted)", Math.abs(Number(r.swap_in_amount || 0) * 1e9 - sol) <= 20_000, `ledger ${Number(r.swap_in_amount || 0).toFixed(9)} vs meta ${(sol / 1e9).toFixed(9)} (incl. rent refund)`);
  }
  for (const r of ev("SWAP")) {
    check(step, "SWAP row is actual (not estimate)", r.is_estimate === false, `${r.swap_direction} in ${r.swap_in_amount} out ${r.swap_out_amount}`);
  }
  for (const r of [...ev("DEPLOY"), ...ev("TOPUP")]) {
    const kind = r.event || r.event_type;
    // Liquidity actually added = the pool reserves' token deltas in the deploy tx (the last signature).
    const sig = String(r.tx_sig || "").split(",").filter(Boolean).pop();
    const m = /SOL=([\d.]+) USDC=([\d.]+)/.exec(r.notes || "");
    if (!sig || !m) continue;
    const tx = await market.conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).staticAccountKeys.map(String);
    const delta = (acct) => {
      const i = keys.indexOf(acct);
      const f = (arr) => Number((arr || []).find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? 0);
      return f(tx.meta.postTokenBalances) - f(tx.meta.preTokenBalances);
    };
    const liqSol = delta(L.POOL.reserveX), liqUsdc = delta(L.POOL.reserveY);
    const ledgerSol = Number(m[1]) * 1e9, ledgerUsdc = Number(m[2]) * 1e6;
    check(step, `${kind} row USDC = liquidity added (reserve delta)`, Math.abs(ledgerUsdc - liqUsdc) <= 2, `ledger ${(ledgerUsdc / 1e6).toFixed(6)} vs reserve Δ ${(liqUsdc / 1e6).toFixed(6)}`);
    check(step, `${kind} row SOL = liquidity added (no rent in 'deposited')`, Math.abs(ledgerSol - liqSol) <= 20_000,
      `ledger ${(ledgerSol / 1e9).toFixed(6)} vs reserve Δ ${(liqSol / 1e9).toFixed(6)} (over by ${((ledgerSol - liqSol) / 1e9).toFixed(6)} SOL ≈ $${(((ledgerSol - liqSol) / 1e9) * Number(r.spot_usd || 0)).toFixed(2)})`);
  }
  return rows;
}


/** Make sure the bot holds a position (pump +1.2% for the Gate 3 V-reclaim if flat; waits out a deploy cooldown). */
async function ensurePosition(tag) {
  let c = await chain();
  if (c.positions.length) return c;
  const from = logBuf.length;
  say(`${tag}: bot is flat — pumping +1.2% for re-entry`);
  await market.moveToBin(whale, c.binId + 30);
  const dep = await waitLog(/GRID DEPLOYED/, from, 780_000);
  if (!dep) say(`${tag}: no re-entry within 13 min`);
  await sleep(3000);
  return chain();
}
const tgEnv = () => ({
  TELEGRAM_BOT_TOKEN: "rehearsal-fake-token", TELEGRAM_CHAT_ID: stubs.TG_CHAT, TELEGRAM_COMMANDS_ENABLED: "true",
  TELEGRAM_API_BASE: `http://127.0.0.1:${stubs.PORT}/tg`,
});
const tgCmd = (text) => fetch(`http://127.0.0.1:${stubs.PORT}/tg-cmd`, { method: "POST", body: JSON.stringify({ text }) });
const ctl = (b) => fetch(`http://127.0.0.1:${stubs.PORT}/control`, { method: "POST", body: JSON.stringify(b) });
/** Restart the bot (optionally with extra env) and wait for its boot line. */
async function restart(extra = {}, wait = /BOOTED|ATTACHED TO LIVE|FLAT WITH SOL/i) {
  killBot();
  const f = startBot(extra);
  const b = await waitLog(wait, f, 150_000);
  return { from: f, boot: b };
}
/** Entry restored at boot must equal the entry before the restart (not the live spot). */
async function checkEntryRecovered(step, want) {
  const { from, boot } = await restart({ BELOW_RANGE_TICKS: "10000" });
  check(step, "reboot attaches", boot && /ATTACHED TO LIVE/.test(boot.m[0]), boot ? boot.m[0] : "no boot line");
  const how = await waitLog(/\[ENTRY\] boot entry: (\w+) — ([^\n]*)/, from, 5_000) || { m: lastMatch(/\[ENTRY\] boot entry: (\w+) — ([^\n]*)/, from) };
  check(step, "entry recovered from the on-chain memo (no pins set)", how.m && how.m[1] === "memo", how.m ? how.m[0].slice(0, 160) : "no boot-entry line");
  const att = lastMatch(/\(entry \$([\d.]+)\)/, from);
  check(step, "recovered entry spot = entry before restart", att && Math.abs(Number(att[1]) - want.spot) < 0.01, att ? `boot entry $${att[1]} vs before $${want.spot.toFixed(2)}` : "no entry in attach line");
  const st = lastMatch(/Floor Stop: \$([\d.]+)/, from);
  check(step, "price stop unchanged across restart", st && Math.abs(Number(st[1]) - want.stop) < 0.02, st ? `$${st[1]} vs $${want.stop}` : "no stop line");
  await sleep(35_000);
  check(step, "no STOPS BLIND after reboot", !/STOPS BLIND/.test(logBuf.slice(from)), "log");
  return from;
}
function entryBefore(from) {
  const m = lastMatch(/\[ENTRY\] memo written \((\w+)\)[^\n]* spot=([\d.]+) eq=([\d.]+) stop=([\d.]+)/, from);
  const st = lastMatch(/Floor Stop: \$([\d.]+)/, from) || lastMatch(/Floor Stop: \$([\d.]+)/);
  return m ? { src: m[1], spot: Number(m[2]), eq: Number(m[3]), stopPct: Number(m[4]), stop: st ? Number(st[1]) : NaN } : null;
}
const rangeOf = (c) => (c.positions[0] ? { lower: c.positions[0].lower, upper: c.positions[0].upper } : null);

const STEPS = {
  async restartAfterRecenter() {
    // H2: the entry is kept across a recenter and must survive a restart with NO ENTRY_* pins (on-chain memo).
    const c0 = await ensurePosition("restart-after-recenter");
    const r = rangeOf(c0);
    if (!r) return check("restart-after-recenter", "precondition: position", false, "none");
    const from = logBuf.length;
    await market.moveToBin(whale, r.lower - 3);
    const dep = await waitLog(/GRID DEPLOYED|DEPLOYMENT FAILED/, from, 300_000);
    check("restart-after-recenter", "recenter redeployed", dep && /GRID DEPLOYED/.test(dep.m[0]), dep ? dep.m[0] : "none");
    const mw = await waitLog(/\[ENTRY\] memo written \(recenter\)/, from, 30_000);
    check("restart-after-recenter", "entry memo written for the new position (src=recenter)", !!mw, mw ? "yes" : "no memo line");
    const want = entryBefore(from);
    const kept = lastMatch(/Recenter deploy: keeping original entry spot=\$([\d.]+)/, from);
    check("restart-after-recenter", "memo carries the ORIGINAL entry", want && kept && Math.abs(want.spot - Number(kept[1])) < 0.01, want && kept ? `memo $${want.spot} vs kept $${kept[1]}` : "missing");
    // A newer CORRUPT memo for the same position must be ignored (valid older one wins).
    const c1 = await chain();
    const posKey = c1.positions[0]?.key;
    if (posKey && want) {
      const memoProgram = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
      const bad = `dlmm-keeper:entry v=1 pos=${posKey} spot=${(want.spot * 0.9).toFixed(4)} eq=${want.eq.toFixed(2)} stop=0.0500 regime=X cd=0 src=deploy ck=deadbeef`;
      const tx = new Transaction().add({ programId: memoProgram, keys: [], data: Buffer.from(bad) });
      await sendAndConfirmTransaction(market.conn, tx, [bk], { commitment: "confirmed" });
    }
    await sleep(2000);
    if (want) await checkEntryRecovered("restart-after-recenter", want);
    const bl = lastMatch(/\[BOOT\] entry memos found in wallet history: (\d+)/);
    check("restart-after-recenter", "boot scan found the memos", bl && Number(bl[1]) >= 1, bl ? bl[0] : "none");
  },
  async restartAfterTP() {
    // H2: a take-profit opens with a NEW entry; after a restart that new entry must come back (not the old one, not live).
    const { from: f0 } = await restart({}, /ATTACHED TO LIVE|BOOTED|FLAT WITH SOL/i);
    await sleep(20_000);
    const c0 = await ensurePosition("restart-after-tp");
    const r = rangeOf(c0);
    if (!r) return check("restart-after-tp", "precondition: position", false, "none");
    const from = logBuf.length;
    await market.moveToBin(whale, r.upper + 3);
    const dep = await waitLog(/GRID DEPLOYED|DEPLOYMENT FAILED/, from, 300_000);
    check("restart-after-tp", "TP redeployed", dep && /GRID DEPLOYED/.test(dep.m[0]), dep ? dep.m[0] : "none");
    const mw = await waitLog(/\[ENTRY\] memo written \(deploy\)/, from, 30_000);
    check("restart-after-tp", "entry memo written (src=deploy, fresh entry)", !!mw, mw ? "yes" : "no memo line");
    const want = entryBefore(from);
    if (want) await checkEntryRecovered("restart-after-tp", want);
    void f0;
  },
  async deployUnknown() {
    // C2: the create lands but the bot sees an error (timeout) → it must find + adopt the position, never open a second.
    const { from: f0 } = await restart({ REHEARSAL_FAULT: "deploy-unknown,memo-fail", ENTRY_MEMO_RETRY_SEC: "45" });
    await sleep(20_000);
    const c0 = await ensurePosition("deploy-unknown");
    const r = rangeOf(c0);
    if (!r) return check("deploy-unknown", "precondition: position", false, "none");
    const from = logBuf.length;
    await market.moveToBin(whale, r.lower - 3);
    const fail = await waitLog(/Deployment failed: REHEARSAL fault/, from, 300_000);
    check("deploy-unknown", "deploy outcome reported unknown (injected)", !!fail, fail ? "yes" : "no fault line");
    const ad = await waitLog(/\[ADOPT\] Adopted position ([1-9A-HJ-NP-Za-km-z]{32,44})/, from, 60_000);
    check("deploy-unknown", "landed position adopted (chain re-check before any retry)", !!ad, ad ? ad.m[0].slice(0, 120) : "no adopt");
    await sleep(40_000);
    check("deploy-unknown", "no second deploy", (logBuf.slice(from).match(/GRID DEPLOYED/g) || []).length === 0, "no GRID DEPLOYED after the adopt");
    await positionInvariants("deploy-unknown", from, null);
    // memo-fail: the adopt memo's first write fails → alert, then retried on a later tick.
    check("deploy-unknown", "failed memo alerted", /ENTRY NOT PERSISTED/.test(logBuf.slice(f0)), "alert line");
    const retried = await waitLog(/\[ENTRY\] memo written \(adopt\)/, from, 120_000);
    check("deploy-unknown", "memo retried and written", !!retried, retried ? "yes" : "not written in 120 s");
    await restart({}, /ATTACHED TO LIVE|BOOTED/i);
    await sleep(20_000);
  },
  async sweepDuringWithdraw() {
    // H1: a fee sweep in flight when /withdraw_pct arrives must not sweep the withdrawn USDC.
    await ensurePosition("sweep-during-withdraw");
    await market.washTrade(whale, 6, 20);
    const pre = await chain();
    const rowsFrom = ledgerRows().length;
    const { from } = await restart({ ...tgEnv(), REHEARSAL_FAULT: "sweep-due,slow-sweep", BELOW_RANGE_TICKS: "10000" }, /ATTACHED TO LIVE/i);
    const hold = await waitLog(/slow sweep holding/, from, 120_000);
    check("sweep-during-withdraw", "sweep in flight (held 40 s)", !!hold, hold ? "yes" : "no sweep");
    await tgCmd("/withdraw_pct 30");
    const wd = await waitLog(/PARTIAL WITHDRAW 30%\]<\/b> Moved to wallet: ([\d.]+) SOL \+ \$([\d.]+) USDC/, from, 180_000);
    check("sweep-during-withdraw", "withdrawal landed", !!wd, wd ? wd.m[0].slice(0, 120) : "none");
    const sw = lastMatch(/\[FEE SWEEP\][^\n]*/, from);
    const tSweep = logBuf.slice(from).search(/USDC → revenue|No surplus|\[FEE SWEEP\]/);
    const tWd = wd ? wd.at - from : -1;
    check("sweep-during-withdraw", "withdrawal waited for the sweep (money lock)", tSweep >= 0 && tWd > tSweep, `sweep@${tSweep} withdraw@${tWd}`);
    await sleep(5000);
    const post = await chain();
    const rows = ledgerRows().slice(rowsFrom);
    const claimed = rows.filter((x) => x.event === "FEE_CLAIM").reduce((a, x) => a + Number(x.fees_claimed_usd || 0), 0);
    const revDelta = revenueUsd(post, post.spot) - revenueUsd(pre, post.spot);
    check("sweep-during-withdraw", "revenue received ≤ fees claimed (no capital swept)", revDelta <= claimed * 1.01 + 0.01, `revenue +$${revDelta.toFixed(4)} vs claimed $${claimed.toFixed(4)}`);
    const wUsdc = wd ? Number(wd.m[2]) : 0;
    check("sweep-during-withdraw", "withdrawn USDC still in the LP wallet", post.usdc / 1e6 >= wUsdc - 0.01, `wallet $${(post.usdc / 1e6).toFixed(2)} vs withdrawn $${wUsdc.toFixed(2)}`);
    await ledgerInvariants("sweep-during-withdraw", rowsFrom, pre, post);
    void sw;
    // /resume re-bases entry equity and persists it (memo src=resume); idle funds are topped back in.
    const f2 = logBuf.length;
    await tgCmd("/resume");
    const rb = await waitLog(/Entry equity re-based/, f2, 60_000);
    check("sweep-during-withdraw", "/resume re-based entry equity", !!rb, rb ? "yes" : "none");
    const mr = await waitLog(/\[ENTRY\] memo written \(resume\)/, f2, 60_000);
    check("sweep-during-withdraw", "re-based entry persisted on chain (memo src=resume)", !!mr, mr ? "yes" : "none");
  },
  async pausedWithPosition() {
    // M3: paused with a position → the price stop stays live and fires a full exit.
    const { from } = await restart({ ...tgEnv(), BELOW_RANGE_TICKS: "10000" }, /ATTACHED TO LIVE|BOOTED/i);
    await sleep(20_000);
    const c0 = await ensurePosition("paused-with-position");
    if (!c0.positions.length) return check("paused-with-position", "precondition: position", false, "none");
    await tgCmd("/pause");
    const al = await waitLog(/PAUSED WITH POSITION\][^\n]*Price stop \$([\d.]+) stays ACTIVE/, from, 60_000);
    check("paused-with-position", "paused-with-position alert names the live price stop", !!al, al ? al.m[0].slice(0, 140) : "none");
    const priceStop = al ? Number(al.m[1]) : NaN;
    await sleep(70_000);
    check("paused-with-position", "no STOPS BLIND while paused with a position", !/STOPS BLIND/.test(logBuf.slice(from)), "log");
    const s = await market.spot();
    const binsDown = Math.ceil(Math.log(priceStop / s.price) / Math.log(1.0004)) - 3;
    const f2 = logBuf.length;
    await market.moveToBin(whale, s.binId + binsDown, { stepSol: 2500, stepUsdc: 275000 });
    const st = await waitLog(/STOP WHILE PAUSED/, f2, 90_000);
    check("paused-with-position", "price stop fired while paused", !!st, st ? "yes" : "no stop");
    const ex = await waitLog(/EMERGENCY EXIT COMPLETE|EMERGENCY EXIT INCOMPLETE/, f2, 240_000);
    check("paused-with-position", "full exit completed", ex && /COMPLETE/.test(ex.m[0]) && !/INCOMPLETE/.test(ex.m[0]), ex ? ex.m[0] : "none");
    await sleep(3000);
    const post = await chain();
    check("paused-with-position", "no position left", post.positions.length === 0, `${post.positions.length}`);
    check("paused-with-position", "native SOL ≥ reserve after the exit dump (L1)", post.native >= GAS_RESERVE, `native ${(post.native / 1e9).toFixed(6)}`);
    await restart({}, /BOOTED|FLAT WITH SOL|ATTACHED/i);
    await sleep(20_000);
  },
  async open() {
    killBot();
    const from = startBot();
    const booted = await waitLog(/BOOTED IN 100% USDC|FLAT WITH SOL|Re-attached|\[ATTACH\]|ATTACHED/i, from, 120_000);
    check("open", "bot boots", !!booted, booted ? booted.m[0] : "no boot line in 120s");
    const pre = await chain();
    const rowsFrom = ledgerRows().length;
    if (pre.positions.length === 0) {
      // Gate 3 V-reclaim needs spot ≥ boot spot × 1.01.
      say("pumping +1.2% for Gate 3 V-reclaim");
      await market.moveToBin(whale, pre.binId + 30);
    }
    const preAtSpot = pre; // valued at the post-deploy spot in positionInvariants (wallet-only before open)
    const dep = await waitLog(/GRID DEPLOYED|DEPLOYMENT FAILED/, from, 300_000);
    check("open", "bot opened a position", dep && /GRID DEPLOYED/.test(dep.m[0]), dep ? dep.m[0] : "no deploy in 300s");
    await sleep(3000);
    const post = await positionInvariants("open", from, preAtSpot);
    await ledgerInvariants("open", rowsFrom, preAtSpot, post);
  },
  async tpLowGas() {
    // LIVE INCIDENT (4bps, Oct 11 6:05 PM PT): a position opened by pre-ae5242d code leaves native ≈ 0.0781 SOL. The TP close
    // refunds rent → ≈ 0.122 SOL, all capital in USDC. The redeploy's USDC→SOL swap is gated on native ≥ reserve + 0.005
    // (0.125), but that swap is what would add SOL, so every redeploy fails: deadlock with 100% USDC idle.
    const c0 = await ensurePosition("tp-low-gas");
    const r = rangeOf(c0);
    if (!r) return check("tp-low-gas", "precondition: position", false, "none");
    // Native after the TP close = target + position rent refund (+ claimed fee SOL) ≈ 0.1220, like the live wallet (0.121951516).
    const target = 121_950_000 - (c0.positions[0].rent || 0) - 500_000;
    if (c0.native > target) {
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: bk.publicKey, toPubkey: whale.publicKey, lamports: c0.native - target }));
      await sendAndConfirmTransaction(market.conn, tx, [bk], { commitment: "confirmed" });
    }
    say(`bot native set to ${((await market.conn.getBalance(bk.publicKey)) / 1e9).toFixed(4)} SOL while positioned`);
    const from = logBuf.length;
    await market.moveToBin(whale, r.upper + 3);
    const tp = await waitLog(/\[TAKE-PROFIT\]/, from, 180_000);
    check("tp-low-gas", "take-profit triggered", !!tp, tp ? "yes" : "no TP");
    const dep = await waitLog(/GRID DEPLOYED|DEPLOYMENT FAILED/, from, 240_000);
    const c1 = await chain();
    const gateMsg = lastMatch(/Native SOL [\d.]+ below reserve\+buffer [\d.]+[^\n]*/, from);
    check("tp-low-gas", "redeploy succeeds after a USDC-heavy TP with native just below reserve", dep && /GRID DEPLOYED/.test(dep.m[0]),
      dep ? `${dep.m[0]}; native ${(c1.native / 1e9).toFixed(4)} SOL, USDC $${(c1.usdc / 1e6).toFixed(2)}${gateMsg ? `; gate: "${gateMsg[0].slice(0, 90)}"` : ""}` : "no deploy outcome in 240 s");
    if (dep && /GRID DEPLOYED/.test(dep.m[0])) {
      check("tp-low-gas", "holdback shortfall bought from USDC (H0 fix path)", /short of the holdback — buying it from USDC/.test(logBuf.slice(from)), "log line");
      await sleep(3000);
      await positionInvariants("tp-low-gas", from, null);
    }
    if (dep && /DEPLOYMENT FAILED/.test(dep.m[0])) {
      // Prove it is a deadlock, not a one-off: the next attempt (after the 600 s cooldown) hits the same gate.
      const t0 = Date.now();
      const dep2 = await waitLog(/GRID DEPLOYED|DEPLOYMENT FAILED/, dep.at + 20, 720_000);
      check("tp-low-gas", "retry also deadlocks (same gate) — expected FAIL on current code", dep2 && /GRID DEPLOYED/.test(dep2.m[0]),
        dep2 ? `${dep2.m[0]} after ${((Date.now() - t0) / 60000).toFixed(1)} min` : "no retry within 12 min");
      // Recover like Peter would: top up SOL, restart (clears the in-memory cooldown).
      await market.airdrop(bk.publicKey, 0.1);
      killBot();
      const f2 = startBot();
      await waitLog(/BOOTED|ATTACH/i, f2, 120_000);
      await ensurePosition("tp-low-gas recovery");
    }
  },
  async fees() {
    say("wash-trading to accrue LP fees");
    await market.washTrade(whale, 6, 20);
    const c = await chain();
    check("fees", "position accrued fees", c.positions[0] && (c.positions[0].feeX > 0 || c.positions[0].feeY > 0), c.positions[0] ? `feeX ${c.positions[0].feeX} feeY ${c.positions[0].feeY}` : "no position");
  },
  async recenterBelow() {
    const c0 = await ensurePosition("recenter-below");
    const r = rangeOf(c0);
    if (!r) return check("recenter-below", "precondition: position", false, "none");
    const from = logBuf.length;
    const rowsFrom = ledgerRows().length;
    say(`moving below range floor bin ${r.lower}`);
    await market.moveToBin(whale, r.lower - 3);
    const pre = await chain();
    const rec = await waitLog(/BELOW-RANGE RECENTER/, from, 180_000);
    check("recenter-below", "recenter triggered", !!rec, rec ? "yes" : "no recenter in 180s");
    const dep = await waitLog(/GRID DEPLOYED|DEPLOYMENT FAILED|RECENTER INCOMPLETE/, from, 240_000);
    check("recenter-below", "redeployed after recenter", dep && /GRID DEPLOYED/.test(dep.m[0]), dep ? dep.m[0] : "no redeploy in 240s");
    await sleep(3000);
    const post = await positionInvariants("recenter-below", from, pre);
    check("recenter-below", "old position closed", !post.positions.some((q) => q.key === c0.positions[0].key), `old ${c0.positions[0].key.slice(0, 8)}`);
    check("recenter-below", "entry kept across recenter", /Recenter deploy: keeping original entry/.test(logBuf.slice(from)), "log line");
    await ledgerInvariants("recenter-below", rowsFrom, pre, post);
  },
  async takeProfit() {
    const c0 = await ensurePosition("take-profit");
    const r = rangeOf(c0);
    if (!r) return check("take-profit", "precondition: position", false, "none");
    const from = logBuf.length;
    const rowsFrom = ledgerRows().length;
    say(`moving above range top bin ${r.upper}`);
    await market.moveToBin(whale, r.upper + 3);
    const pre = await chain();
    const tp = await waitLog(/\[TAKE-PROFIT\]/, from, 180_000);
    check("take-profit", "take-profit triggered", !!tp, tp ? "yes" : "no TP in 180s");
    const dep = await waitLog(/GRID DEPLOYED|DEPLOYMENT FAILED/, from, 240_000);
    check("take-profit", "redeployed after TP", dep && /GRID DEPLOYED/.test(dep.m[0]), dep ? dep.m[0] : "no redeploy in 240s");
    await sleep(3000);
    const post = await positionInvariants("take-profit", from, pre);
    await ledgerInvariants("take-profit", rowsFrom, pre, post);
  },
  async jupiterFaults() {
    // Live 4bps Oct 11: redeploy rebalances failed on Jupiter 0x1771 (slippage, 7:00 PM PT) and HTTP 503 (7:10 PM PT),
    // each costing a whole deploy cycle. (a) take-profit redeploy (USDC→SOL) with quotes 1.2% optimistic: must re-quote
    // at a higher slippage cap and land in the SAME deploy. (b) recenter redeploy (SOL→USDC) with two 503s: backoff + land.
    const ctl = (b) => fetch(`http://127.0.0.1:${stubs.PORT}/control`, { method: "POST", body: JSON.stringify(b) });
    for (const sub of [
      { tag: "jupiter-faults(a) 0x1771", fault: { jupiterFail: 1000, mode: "slippage" }, move: (r) => r.upper + 3, want: /re-quoting at \d+ bps/ },
      { tag: "jupiter-faults(b) 503", fault: { jupiterFail: 2, mode: "http503" }, move: (r) => r.lower - 3, want: /transient failure[^\n]*retry/ },
    ]) {
      const c0 = await ensurePosition(sub.tag);
      const r = rangeOf(c0);
      if (!r) { check(sub.tag, "precondition: position", false, "none"); continue; }
      const from = logBuf.length;
      const rowsFrom = ledgerRows().length;
      await ctl(sub.fault);
      await market.moveToBin(whale, sub.move(r));
      const pre = await chain();
      const dep = await waitLog(/GRID DEPLOYED|DEPLOYMENT FAILED/, from, 300_000);
      await ctl({ jupiterFail: 0, mode: "expire" });
      check(sub.tag, "redeploy lands in the same cycle despite the fault", dep && /GRID DEPLOYED/.test(dep.m[0]), dep ? dep.m[0] : "no outcome in 300 s");
      const retried = lastMatch(sub.want, from);
      check(sub.tag, "swap retried in-process with the right policy", !!retried, retried ? retried[0].slice(0, 120) : "no retry line");
      const landed = lastMatch(/swap landed on attempt (\d+)[^\n]*/, from);
      check(sub.tag, "swap landed on a retry", landed && Number(landed[1]) >= 2, landed ? landed[0] : "none");
      await sleep(3000);
      const post = await positionInvariants(sub.tag, from, pre);
      const rows = await ledgerInvariants(sub.tag, rowsFrom, pre, post);
      const swaps = rows.filter((x) => x.event === "SWAP");
      check(sub.tag, "exactly one SWAP landed for the rebalance (no double swap)", swaps.length === 1, `${swaps.length} SWAP row(s)`);
    }
  },
  async jupiter429() {
    // Live 4bps Oct 12 2026 from 5:33 AM PT: every Jupiter call 429 for 30+ min; each redeploy burned 3 quick retries
    // and the bot sat flat with ~$453 of SOL. (a) two 429s with x-ratelimit-reset 3 s ahead → honoured, lands via
    // Jupiter in the same deploy. (b) Jupiter fully rate-limited → direct Meteora-pool swap fallback, same deploy.
    const ctl = (b) => fetch(`http://127.0.0.1:${stubs.PORT}/control`, { method: "POST", body: JSON.stringify(b) });
    for (const sub of [
      { tag: "jupiter-429(a) reset header", fault: { jupiterFail: 2, mode: "http429", resetSec: 3 }, move: (r) => r.lower - 3,
        want: /rate limited \(429[^\n]*x-ratelimit-reset[^\n]*retry 2\/3 in [2-5]\.\ds/, via: /swap landed on attempt [23]/ },
      { tag: "jupiter-429(b) pool fallback", fault: { jupiterFail: 100000, mode: "http429", resetSec: 1 }, move: (r) => r.upper + 3,
        want: /falling back to a direct swap in the Meteora pool/, via: /\[POOL SWAP\] /, poolRow: true },
    ]) {
      const c0 = await ensurePosition(sub.tag);
      const r = rangeOf(c0);
      if (!r) { check(sub.tag, "precondition: position", false, "none"); continue; }
      const from = logBuf.length;
      const rowsFrom = ledgerRows().length;
      await ctl(sub.fault);
      await market.moveToBin(whale, sub.move(r));
      const pre = await chain();
      const dep = await waitLog(/GRID DEPLOYED|DEPLOYMENT FAILED/, from, 300_000);
      await ctl({ jupiterFail: 0, mode: "expire" });
      check(sub.tag, "redeploy lands in the same cycle despite 429s", dep && /GRID DEPLOYED/.test(dep.m[0]), dep ? dep.m[0] : "no outcome in 300 s");
      const w = lastMatch(sub.want, from);
      check(sub.tag, "429 handled with the right policy", !!w, w ? w[0].slice(0, 160) : "no matching log line");
      const v = lastMatch(sub.via, from);
      check(sub.tag, "swap landed via the expected route", !!v, v ? v[0].slice(0, 120) : "none");
      await sleep(3000);
      const post = await positionInvariants(sub.tag, from, pre);
      const rows = await ledgerInvariants(sub.tag, rowsFrom, pre, post);
      const swaps = rows.filter((x) => x.event === "SWAP");
      check(sub.tag, "exactly one SWAP landed for the rebalance (no double swap)", swaps.length === 1, `${swaps.length} SWAP row(s)`);
      if (sub.poolRow) check(sub.tag, "SWAP row marks the pool fallback", swaps.some((x) => /Direct Meteora pool swap/.test(x.notes || "")), swaps.map((x) => x.notes).join(" | ").slice(0, 120));
    }
  },
  async recenterDeployRetry() {
    // Recenter closes, the redeploy's Jupiter swap fails once (injected), Jupiter heals: the owed redeploy must be
    // retried on the short backoff (60 s) — not the 600 s cooldown + Gate 3 — and the SOL stays guarded meanwhile.
    // These steps need the deploy to FAIL: turn off jup-ratelimit's direct-pool fallback (it would land the swap).
    await restart({ JUPITER_POOL_FALLBACK: "false" }, /ATTACHED TO LIVE|BOOTED|FLAT WITH SOL/i);
    await sleep(20_000);
    const c0 = await ensurePosition("recenter-deploy-retry");
    const r = rangeOf(c0);
    if (!r) return check("recenter-deploy-retry", "precondition: position", false, "none");
    const from = logBuf.length;
    await fetch(`http://127.0.0.1:${stubs.PORT}/control`, { method: "POST", body: JSON.stringify({ jupiterFail: 50, mode: "expire" }) });
    await market.moveToBin(whale, r.lower - 3);
    const fail = await waitLog(/DEPLOYMENT FAILED|GRID DEPLOYED/, from, 300_000);
    check("recenter-deploy-retry", "deploy failure surfaced", fail && /DEPLOYMENT FAILED/.test(fail.m[0]), fail ? fail.m[0] : "none");
    await fetch(`http://127.0.0.1:${stubs.PORT}/control`, { method: "POST", body: JSON.stringify({ jupiterFail: 0 }) });
    const tFail = Date.now();
    const retryMsg = lastMatch(/redeploy retry (\d+)\/(\d+) in ~(\d+)s/, from);
    check("recenter-deploy-retry", "retry scheduled on short backoff (≤ 120 s)", retryMsg && Number(retryMsg[3]) <= 120, retryMsg ? retryMsg[0] : "no retry line");
    const guard = await waitLog(/FLAT WITH SOL/, from, 30_000);
    check("recenter-deploy-retry", "'FLAT WITH SOL' alert while flat holding SOL", !!guard, guard ? "yes" : "no alert");
    const dep = await waitLog(/GRID DEPLOYED/, fail ? fail.at : from, 240_000);
    check("recenter-deploy-retry", "owed redeploy lands within 4 min of Jupiter healing", !!dep,
      dep ? `redeployed ${((Date.now() - tFail) / 60000).toFixed(1)} min after heal` : "still flat after 4 min");
    check("recenter-deploy-retry", "no STOPS BLIND while flat", !/STOPS BLIND/.test(logBuf.slice(from)), "log");
    if (dep) {
      await sleep(3000);
      await positionInvariants("recenter-deploy-retry", from, null);
      check("recenter-deploy-retry", "entry kept across the retried recenter", /Recenter deploy: keeping original entry/.test(logBuf.slice(from)), "log line");
    }
  },
  async recenterDeployFail() {
    // Recenter closes the position, then the redeploy's Jupiter rebalance keeps failing (injected: expired blockhash)
    // while the price crashes through the kept entry stop. The flat guard must fire on the SOL held while flat and,
    // once Jupiter heals, liquidate it to USDC (like the circuit breaker would have).
    // These steps need the deploy to FAIL: turn off jup-ratelimit's direct-pool fallback (it would land the swap).
    await restart({ JUPITER_POOL_FALLBACK: "false" }, /ATTACHED TO LIVE|BOOTED|FLAT WITH SOL/i);
    await sleep(20_000);
    const c0 = await ensurePosition("recenter-deploy-fail");
    const r = rangeOf(c0);
    if (!r) return check("recenter-deploy-fail", "precondition: position", false, "none");
    const from = logBuf.length;
    await fetch(`http://127.0.0.1:${stubs.PORT}/control`, { method: "POST", body: JSON.stringify({ jupiterFail: 500, mode: "expire" }) });
    await market.moveToBin(whale, r.lower - 3);
    const fail = await waitLog(/DEPLOYMENT FAILED|GRID DEPLOYED/, from, 300_000);
    check("recenter-deploy-fail", "deploy failure surfaced", fail && /DEPLOYMENT FAILED/.test(fail.m[0]), fail ? fail.m[0] : "none");
    const c1 = await chain();
    const solExposure = ((c1.native - GAS_RESERVE) / 1e9) * c1.spot;
    say(`flat after failed redeploy: ${(c1.native / 1e9).toFixed(4)} SOL (≈$${solExposure.toFixed(2)} above reserve) + $${(c1.usdc / 1e6).toFixed(2)} USDC`);
    const stopLine = lastMatch(/Floor Stop: \$([\d.]+)/, 0);
    const priceStop = stopLine ? Number(stopLine[1]) : NaN;
    const flatStop = lastMatch(/Flat stop: \$([\d.]+)|flat stop \$([\d.]+)/, from);
    check("recenter-deploy-fail", "flat stop armed = kept entry stop", flatStop && Math.abs(Number(flatStop[1] || flatStop[2]) - priceStop) < 0.02,
      flatStop ? `flat $${flatStop[1] || flatStop[2]} vs entry stop $${priceStop}` : "no flat stop line");
    // Crash the price through the entry stop while the bot is flat holding SOL.
    const s = await market.spot();
    const binsDown = Math.ceil(Math.log(priceStop / s.price) / Math.log(1.0004)) - 4;
    const from2 = logBuf.length;
    await market.moveToBin(whale, s.binId + binsDown, { stepSol: 2500, stepUsdc: 275000 });
    const fired = await waitLog(/FLAT STOP TRIGGERED|CIRCUIT BREAKER/, from2, 60_000);
    const c2 = await chain();
    check("recenter-deploy-fail", "SOL held while flat is still protected by the price stop", !!fired,
      fired ? `${fired.m[0]} at spot ≈ $${c2.spot.toFixed(2)} (stop $${priceStop})` : `spot ${c1.spot.toFixed(2)}→${c2.spot.toFixed(2)} — no stop evaluated`);
    check("recenter-deploy-fail", "no STOPS BLIND while flat", !/STOPS BLIND/.test(logBuf.slice(from)), "log");
    // Jupiter heals: the pending liquidation must complete.
    await fetch(`http://127.0.0.1:${stubs.PORT}/control`, { method: "POST", body: JSON.stringify({ jupiterFail: 0 }) });
    const rowsFrom = ledgerRows().length;
    const pre = await chain();
    const done = await waitLog(/CIRCUIT BREAKER COMPLETE/, from2, 420_000);
    check("recenter-deploy-fail", "flat liquidation completes after Jupiter heals", !!done, done ? "CIRCUIT BREAKER COMPLETE (flat-with-SOL stop)" : "no completion in 7 min");
    await sleep(3000);
    const post = await chain();
    check("recenter-deploy-fail", "no position left", post.positions.length === 0, `${post.positions.length}`);
    check("recenter-deploy-fail", "SOL sold to USDC (native ≤ reserve + 0.06)", post.native <= GAS_RESERVE + 60_000_000, `native ${(post.native / 1e9).toFixed(4)} SOL, USDC $${(post.usdc / 1e6).toFixed(2)}`);
    check("recenter-deploy-fail", "native SOL ≥ reserve after liquidation", post.native >= GAS_RESERVE, `native ${(post.native / 1e9).toFixed(6)}`);
    const cbRow = ledgerRows().slice(rowsFrom).find((x) => x.event === "CIRCUIT_BREAKER");
    check("recenter-deploy-fail", "CIRCUIT_BREAKER ledger row equity = chain equity (±$0.5)", cbRow && Math.abs(Number(cbRow.total_equity_usd) - post.equityUsd) < 0.5, cbRow ? `row $${cbRow.total_equity_usd} vs chain $${post.equityUsd.toFixed(2)}` : "no row");
    await ledgerInvariants("recenter-deploy-fail", rowsFrom, pre, post);
    // The stop cooldown is in memory: restart so the following steps can re-enter.
    killBot();
    const f = startBot();
    await waitLog(/BOOTED|ATTACH/i, f, 120_000);
    await sleep(20_000);
  },
  async topUp() {
    // H3: a positioned bot whose native SOL sits below the reserve (pre-ae5242d opens left 0.0781) receives idle
    // USDC. The top-up must buy the gas shortfall from USDC and add the rest, ending with native ≥ reserve.
    const c0 = await ensurePosition("top-up");
    if (!c0.positions.length) return check("top-up", "precondition: position", false, "none");
    const target = 80_000_000;
    if (c0.native > target) {
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: bk.publicKey, toPubkey: whale.publicKey, lamports: c0.native - target }));
      await sendAndConfirmTransaction(market.conn, tx, [bk], { commitment: "confirmed" });
    }
    const usdcIn = 60_000_000;
    const wAta = L.spl.getAssociatedTokenAddressSync(L.USDC_MINT, whale.publicKey);
    const bAta = L.spl.getAssociatedTokenAddressSync(L.USDC_MINT, bk.publicKey);
    const ix = [];
    try { await L.spl.getAccount(market.conn, bAta); } catch { ix.push(L.spl.createAssociatedTokenAccountIdempotentInstruction(whale.publicKey, bAta, bk.publicKey, L.USDC_MINT)); }
    ix.push(L.spl.createTransferCheckedInstruction(wAta, L.USDC_MINT, bAta, whale.publicKey, usdcIn, 6));
    await sendAndConfirmTransaction(market.conn, new Transaction().add(...ix), [whale], { commitment: "confirmed" });
    const pre = await chain();
    say(`top-up setup: native ${(pre.native / 1e9).toFixed(4)} SOL, USDC $${(pre.usdc / 1e6).toFixed(2)}`);
    const from = logBuf.length;
    const rowsFrom = ledgerRows().length;
    const t = await waitLog(/\[TOP-UP\]|\[TOPUP ERROR\]|\[TOPUP\] Abort/, from, 300_000);
    check("top-up", "top-up landed with native below reserve", t && /\[TOP-UP\]/.test(t.m[0]), t ? t.m[0] + (lastMatch(/\[TOPUP ERROR\][^\n]*|\[GAS\][^\n]*/, from)?.[0] ? ` — ${lastMatch(/\[TOPUP ERROR\][^\n]*|\[GAS\][^\n]*/, from)[0].slice(0, 120)}` : "") : "no top-up in 300 s");
    await sleep(3000);
    const post = await positionInvariants("top-up", from, pre);
    check("top-up", "position liquidity increased", post.positions[0] && post.posUsd > valueAt({ native: 0, wsol: 0, usdc: 0, positions: pre.positions }, post.spot) + 20,
      `position $${valueAt({ native: 0, wsol: 0, usdc: 0, positions: pre.positions }, post.spot).toFixed(2)} → $${post.posUsd.toFixed(2)}`);
    check("top-up", "idle USDC used (≤ $1 left)", post.usdc <= 1_000_000 + 0, `USDC $${(post.usdc / 1e6).toFixed(2)}`);
    await ledgerInvariants("top-up", rowsFrom, pre, post);
  },
  async restartMidClose() {
    // (a) crash right after the recenter decision, before the close lands → restart must re-attach the old position.
    let c0 = await ensurePosition("restart-mid-close");
    let r = rangeOf(c0);
    if (!r) return check("restart-mid-close", "precondition: position", false, "none");
    let from = logBuf.length;
    await market.moveToBin(whale, r.lower - 3);
    const rec = await waitLog(/BELOW-RANGE RECENTER/, from, 180_000);
    killBot();
    say("SIGKILL at recenter start (before close)");
    let c1 = await chain();
    check("restart-mid-close(a)", "kill landed before close", c1.positions.some((q) => q.key === c0.positions[0].key), `${c1.positions.length} position(s)`);
    from = startBot({ BELOW_RANGE_TICKS: "10000" }); // no further recenter while we inspect the reboot
    const att = await waitLog(/Re-attached|ATTACH|BOOTED IN 100% USDC/i, from, 120_000);
    check("restart-mid-close(a)", "reboot attaches the still-open position", att && !/BOOTED IN 100% USDC/.test(att.m[0]), att ? att.m[0] : "no boot line");
    await sleep(35_000); // ≥ 2 ticks
    await positionInvariants("restart-mid-close(a)", from, null, { skipReserve: true });

    // (b) crash after the close tx landed, before the redeploy → funds idle; what does the reboot do?
    killBot();
    from = startBot();
    await waitLog(/Re-attached|ATTACH|BOOTED/i, from, 120_000);
    c0 = await chain();
    const key = c0.positions[0]?.key;
    const rec2 = await waitLog(/BELOW-RANGE RECENTER/, from, 180_000);
    let closedAt = 0;
    for (let i = 0; i < 600 && rec2; i++) {
      const info = await market.conn.getAccountInfo(new PublicKey(key), "confirmed");
      if (!info) { closedAt = Date.now(); break; }
      await sleep(100);
    }
    killBot();
    say(`SIGKILL ${closedAt ? "right after the close landed" : "(close not observed)"}`);
    c1 = await chain();
    check("restart-mid-close(b)", "kill landed between close and redeploy", closedAt > 0 && c1.positions.length === 0, `${c1.positions.length} position(s); wallet ${(c1.native / 1e9).toFixed(4)} SOL + $${(c1.usdc / 1e6).toFixed(2)}`);
    from = startBot();
    const boot = await waitLog(/BOOTED IN 100% USDC|FLAT WITH SOL|ATTACH/i, from, 120_000);
    const idleStart = Date.now();
    const solUsd = ((c1.native - GAS_RESERVE) / 1e9) * c1.spot;
    check("restart-mid-close(b)", "reboot recognises it is flat holding SOL", boot && /FLAT WITH SOL/.test(boot.m[0]), boot ? boot.m[0] : "none");
    const bootStop = lastMatch(/Flat stop: \$([\d.]+) — ([^\n]*)/, from);
    check("restart-mid-close(b)", "flat stop recovered at boot (below spot)", bootStop && Number(bootStop[1]) > 0 && Number(bootStop[1]) < c1.spot,
      bootStop ? `$${bootStop[1]} — ${bootStop[2].slice(0, 100)}` : "no flat stop line");
    // Protection, not a blind boot deploy: the flat stop must be evaluated on ticks (no STOPS BLIND), then the
    // normal Gate 3 re-entry redeploys (pump +1.2% for the V-reclaim, like a fresh boot).
    await sleep(60_000);
    check("restart-mid-close(b)", "no STOPS BLIND while flat", !/STOPS BLIND/.test(logBuf.slice(from)), "log");
    check("restart-mid-close(b)", "no blind redeploy at boot", !/GRID DEPLOYED/.test(logBuf.slice(from)), "waits for Gate 1-3");
    await market.moveToBin(whale, c1.binId + 30);
    const dep = await waitLog(/GRID DEPLOYED/, from, 300_000);
    const idleMin = (Date.now() - idleStart) / 60000;
    check("restart-mid-close(b)", "re-enters via Gate 3 once it clears", !!dep, dep ? `redeployed after ${idleMin.toFixed(1)} min` : `still flat after ${idleMin.toFixed(1)} min`);
    if (dep) await positionInvariants("restart-mid-close(b)", from, null);
  },
  async stopOut() {
    killBot();
    let from = startBot({ BELOW_RANGE_TICKS: "10000" }); // isolate the stop from the recenter
    await waitLog(/Re-attached|ATTACH|BOOTED/i, from, 120_000);
    let c0 = await chain();
    if (c0.positions.length === 0) {
      say("flat — pumping for re-entry first");
      await market.moveToBin(whale, c0.binId + 30);
      await waitLog(/GRID DEPLOYED/, from, 300_000);
      c0 = await chain();
    }
    await sleep(20_000);
    const stopM = lastMatch(/stop \$?([\d.]+)|Floor Stop: \$([\d.]+)|floor stop \$([\d.]+)/i, 0);
    const stopLine = lastMatch(/Floor Stop: \$([\d.]+)|floor stop[^$]*\$([\d.]+)|price stop[^$]*\$([\d.]+)/i, 0);
    const priceStop = stopLine ? Number(stopLine[1] || stopLine[2] || stopLine[3]) : NaN;
    say(`price stop parsed: ${priceStop}`);
    const rowsFrom = ledgerRows().length;
    from = logBuf.length;
    // Target a bin just under the price stop.
    const s = await market.spot();
    const binsDown = Math.ceil(Math.log(priceStop / s.price) / Math.log(1.0004)) - 3;
    await market.moveToBin(whale, s.binId + binsDown, { stepSol: 2500, stepUsdc: 275000 });
    const pre = await chain();
    const cb = await waitLog(/CIRCUIT BREAKER COMPLETE|CIRCUIT BREAKER INCOMPLETE/, from, 240_000);
    check("stop-out", "circuit breaker fired and completed", cb && /CIRCUIT BREAKER COMPLETE/.test(cb.m[0]), cb ? cb.m[0] : `no CB in 240s (spot ${pre.spot.toFixed(2)}, stop ${priceStop})`);
    await sleep(3000);
    const post = await chain();
    check("stop-out", "no position left", post.positions.length === 0, `${post.positions.length}`);
    check("stop-out", "SOL liquidated to USDC (native ≤ reserve + 0.06)", post.native <= GAS_RESERVE + 60_000_000, `native ${(post.native / 1e9).toFixed(4)} SOL, USDC $${(post.usdc / 1e6).toFixed(2)}`);
    check("stop-out", "native SOL ≥ reserve after liquidation", post.native >= GAS_RESERVE - 1_000_000, `native ${(post.native / 1e9).toFixed(6)}`);
    const dEq = post.equityUsd - valueAt(pre, post.spot) + (revenueUsd(post, post.spot) - revenueUsd(pre, post.spot));
    check("stop-out", "equity conserved through liquidation (≤0.6% cost)", dEq <= 0.5 && dEq >= -Math.max(1, pre.equityUsd * 0.006), `Δ ${dEq.toFixed(2)} on $${pre.equityUsd.toFixed(2)}`);
    await ledgerInvariants("stop-out", rowsFrom, pre, post);
    const cbRow = ledgerRows().slice(rowsFrom).find((r) => r.event === "CIRCUIT_BREAKER");
    check("stop-out", "CIRCUIT_BREAKER ledger row equity = chain equity (±$0.5)", cbRow && Math.abs(Number(cbRow.total_equity_usd) - post.equityUsd) < 0.5, cbRow ? `row $${cbRow.total_equity_usd} vs chain $${post.equityUsd.toFixed(2)}` : "no row");
  },
};

(async () => {
  const want = (process.argv[2] || "open,tpLowGas,fees,recenterBelow,takeProfit,restartAfterRecenter,restartAfterTP,deployUnknown,sweepDuringWithdraw,pausedWithPosition,jupiterFaults,jupiter429,topUp,recenterDeployRetry,recenterDeployFail,restartMidClose,stopOut").split(",");
  const srv = await stubs.start();
  await market.airdrop(whale.publicKey, 20000).catch(() => {});
  const c = await chain();
  if (c.native < 1.4e9 && c.positions.length === 0) await market.airdrop(bk.publicKey, 1.5 - c.native / 1e9);
  say(`start: spot $${(await market.spot()).price.toFixed(3)}, bot ${(c.native / 1e9).toFixed(4)} SOL + $${(c.usdc / 1e6).toFixed(2)} USDC, ${c.positions.length} position(s)`);
  for (const s of want) {
    say(`=== step ${s} ===`);
    try {
      if (!bot && !["open", "stopOut"].includes(s)) {
        const f = startBot();
        await waitLog(/Re-attached|ATTACH|BOOTED/i, f, 120_000);
        await sleep(20_000);
      }
      await STEPS[s]();
    } catch (e) { check(s, "step ran without harness error", false, String(e?.stack || e).slice(0, 400)); }
  }
  killBot();
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(L.STATE_DIR, "report.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  say(`DONE: ${results.length - failed.length}/${results.length} invariants passed`);
  for (const f of failed) say(`  FAIL [${f.step}] ${f.name}: ${f.detail}`);
  srv.close();
  process.exit(failed.length ? 1 : 0);
})();
