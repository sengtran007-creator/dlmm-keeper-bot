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
  const deployed = lastMatch(/Position: <code>([1-9A-HJ-NP-Za-km-z]{32,44})<\/code>/, from) || lastMatch(/Re-attached to still-open position ([1-9A-HJ-NP-Za-km-z]{32,44})/, from) || lastMatch(/\[ATTACH\][^\n]*?([1-9A-HJ-NP-Za-km-z]{43,44})/, from);
  check(step, "exactly one position on chain (no orphans)", c.positions.length === 1, `${c.positions.length} position(s): ${c.positions.map((q) => q.key.slice(0, 8)).join(",")}`);
  if (deployed && c.positions.length) check(step, "bot tracks the on-chain position", c.positions.some((q) => q.key === deployed[1]), `bot says ${deployed[1].slice(0, 8)}`);
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
  for (const r of ev("DEPLOY")) {
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
    check(step, "DEPLOY row USDC = liquidity added (reserve delta)", Math.abs(ledgerUsdc - liqUsdc) <= 2, `ledger ${(ledgerUsdc / 1e6).toFixed(6)} vs reserve Δ ${(liqUsdc / 1e6).toFixed(6)}`);
    check(step, "DEPLOY row SOL = liquidity added (no rent in 'deposited')", Math.abs(ledgerSol - liqSol) <= 20_000,
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
const rangeOf = (c) => (c.positions[0] ? { lower: c.positions[0].lower, upper: c.positions[0].upper } : null);

const STEPS = {
  async open() {
    killBot();
    const from = startBot();
    const booted = await waitLog(/BOOTED IN 100% USDC|Re-attached|\[ATTACH\]|ATTACHED/i, from, 120_000);
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
  async recenterDeployFail() {
    // Recenter closes the position, then the redeploy's Jupiter rebalance fails (injected: expired blockhash).
    // Expectation for a safe bot: the SOL inventory is still protected by the (kept) entry stop, or re-deployed.
    const c0 = await ensurePosition("recenter-deploy-fail");
    const r = rangeOf(c0);
    if (!r) return check("recenter-deploy-fail", "precondition: position", false, "none");
    const from = logBuf.length;
    await fetch(`http://127.0.0.1:${stubs.PORT}/control`, { method: "POST", body: JSON.stringify({ jupiterFail: 50, mode: "expire" }) });
    await market.moveToBin(whale, r.lower - 3);
    const fail = await waitLog(/DEPLOYMENT FAILED|GRID DEPLOYED/, from, 300_000);
    check("recenter-deploy-fail", "deploy failure surfaced", fail && /DEPLOYMENT FAILED/.test(fail.m[0]), fail ? fail.m[0] : "none");
    const c1 = await chain();
    const solExposure = ((c1.native - GAS_RESERVE) / 1e9) * c1.spot;
    say(`flat after failed redeploy: ${(c1.native / 1e9).toFixed(4)} SOL (≈$${solExposure.toFixed(2)} above reserve) + $${(c1.usdc / 1e6).toFixed(2)} USDC`);
    const entry = lastMatch(/keeping original entry spot=\$([\d.]+)|\[ENTRY\][^\n]*spot=\$([\d.]+)/, 0);
    const stopLine = lastMatch(/Floor Stop: \$([\d.]+)/, 0);
    const priceStop = stopLine ? Number(stopLine[1]) : NaN;
    // Crash the price through the entry stop while the bot is flat holding SOL.
    const s = await market.spot();
    const binsDown = Math.ceil(Math.log(priceStop / s.price) / Math.log(1.0004)) - 4;
    const from2 = logBuf.length;
    await market.moveToBin(whale, s.binId + binsDown, { stepSol: 2500, stepUsdc: 275000 });
    await sleep(45_000); // 3 ticks below the stop
    const c2 = await chain();
    const fired = /CIRCUIT BREAKER/.test(logBuf.slice(from2));
    const lossUsd = ((c1.native - GAS_RESERVE) / 1e9) * (c1.spot - c2.spot);
    check("recenter-deploy-fail", "SOL held while flat is still protected by the price stop", fired || c1.native - GAS_RESERVE < 0.05e9,
      fired ? "CB fired" : `spot ${c1.spot.toFixed(2)}→${c2.spot.toFixed(2)} (stop $${priceStop}) — no stop evaluated; ${(c1.native / 1e9).toFixed(4)} SOL held, ≈$${lossUsd.toFixed(2)} lost unprotected`);
    await fetch(`http://127.0.0.1:${stubs.PORT}/control`, { method: "POST", body: JSON.stringify({ jupiterFail: 0 }) });
    // Recovery: price back up, does the bot redeploy?
    const from3 = logBuf.length;
    await market.moveToBin(whale, c1.binId + 5, { stepSol: 2500, stepUsdc: 275000 });
    const t3 = Date.now();
    const dep = await waitLog(/GRID DEPLOYED/, from3, 780_000);
    check("recenter-deploy-fail", "bot recovers (redeploys) within 4 min after Jupiter is healthy", dep && Date.now() - t3 < 240_000,
      dep ? `redeployed after ${((Date.now() - t3) / 60000).toFixed(1)} min (600 s deploy-failure cooldown + Gate 3)` : "still flat after 13 min");
    if (dep) { await sleep(3000); await positionInvariants("recenter-deploy-fail", from3, null); }
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
    const boot = await waitLog(/BOOTED IN 100% USDC|ATTACH/i, from, 120_000);
    const idleStart = Date.now();
    const solUsd = ((c1.native - GAS_RESERVE) / 1e9) * c1.spot;
    check("restart-mid-close(b)", "reboot recognises it is flat", boot && /BOOTED IN 100% USDC/.test(boot.m[0]), boot ? boot.m[0] : "none");
    const dep = await waitLog(/GRID DEPLOYED/, from, 240_000);
    const idleMin = (Date.now() - idleStart) / 60000;
    check("restart-mid-close(b)", "idle funds redeployed (or protected) within 4 min", !!dep,
      dep ? `redeployed after ${idleMin.toFixed(1)} min` : `still flat after ${idleMin.toFixed(1)} min holding ${((c1.native) / 1e9).toFixed(4)} SOL (≈$${solUsd.toFixed(2)} of SOL exposure above reserve) with NO price/equity stop evaluated (cash mode skips stops)`);
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
  const want = (process.argv[2] || "open,tpLowGas,fees,recenterBelow,takeProfit,recenterDeployFail,restartMidClose,stopOut").split(",");
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
