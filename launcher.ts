/**
 * Entry point (npm start). BOT_PAUSED=<anything truthy> → idle without loading any trading code (a real owner pause,
 * no start-command hacks; note: a paused SOL/USDC bot with an open position runs NO stops). BOT_MODE=lst_pair → the
 * JupSOL-JitoSOL LST mode (lstpair.ts); anything else → the SOL/USDC keeper (index.ts), unchanged.
 */
import { parsePausedEnv } from "./lstlogic";

const pausedRaw = process.env.BOT_PAUSED;
if (parsePausedEnv(pausedRaw)) {
  console.log(`[LAUNCHER] BOT_PAUSED is set (${String(pausedRaw).slice(0, 120)}) — idling; no trading code loaded. Unset BOT_PAUSED to run.`);
  setInterval(() => {}, 1 << 30);
} else if ((process.env.BOT_MODE || "").trim().toLowerCase() === "lst_pair") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("./lstpair").main().catch((e: any) => {
    console.error("[LAUNCHER] lst_pair crashed:", String(e?.message || e).slice(0, 300));
    process.exit(1);
  });
} else {
  require("./index");
}
