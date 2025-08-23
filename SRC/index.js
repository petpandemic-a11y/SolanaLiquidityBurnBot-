// ===========================
// Solana Burn Bot - FINAL
// ===========================

import fetch from "node-fetch";
import { Telegraf } from "telegraf";
import dotenv from "dotenv";

dotenv.config();

// === ENV CONFIG ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;
const MIN_SOL = parseFloat(process.env.MIN_SOL || "0.1");
const MAX_MCAP_SOL = parseFloat(process.env.MAX_MCAP_SOL || "0");
const POLL_INTERVAL_SEC = parseInt(process.env.POLL_INTERVAL_SEC || "10");
const POLL_LOOKBACK_SEC = parseInt(process.env.POLL_LOOKBACK_SEC || "12");
const DEDUP_MINUTES = parseInt(process.env.DEDUP_MINUTES || "10");

const ADMIN_ID = process.env.ADMIN_ID;

// === TELEGRAM BOT ===
const bot = new Telegraf(BOT_TOKEN);

// === GLOBAL STATE ===
let dedupCache = new Map();
let lpMode = "strict";
let pollInterval = POLL_INTERVAL_SEC;

// === HELPERS ===
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSolUsd() {
  try {
    const r = await fetch("https://public-api.birdeye.so/public/price?address=So11111111111111111111111111111111111111112", {
      headers: { "X-API-KEY": BIRDEYE_API_KEY }
    });
    const j = await r.json();
    return j?.data?.value || null;
  } catch (e) {
    console.error("[Birdeye SOL price]", e.message);
    return null;
  }
}

async function getTokenPrice(mint) {
  try {
    const r = await fetch(`https://public-api.birdeye.so/public/price?address=${mint}`, {
      headers: { "X-API-KEY": BIRDEYE_API_KEY }
    });
    const j = await r.json();
    return j?.data?.value || null;
  } catch {
    return null;
  }
}

async function fetchBurns() {
  const query = `
    query {
      Solana {
        Instructions(
          where: { Instruction: { Program: { is: "spl-token" }, Method: { is: "burn" } } }
          limit: { count: 500 }
          orderBy: { descending: Block_Time }
        ) {
          Transaction {
            Signature
          }
          Instruction {
            Accounts {
              Account
            }
            Data {
              Parsed {
                Info {
                  Amount
                }
              }
            }
          }
          Block {
            Time
          }
        }
      }
    }`;
  try {
    const r = await fetch("https://streaming.bitquery.io/eap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": BITQUERY_API_KEY
      },
      body: JSON.stringify({ query })
    });
    const j = await r.json();
    return j.data?.Solana?.Instructions || [];
  } catch (e) {
    console.error("[Bitquery] fetch error:", e.message);
    return [];
  }
}

function shouldSkip(sig) {
  const last = dedupCache.get(sig);
  const now = Date.now();
  if (last && now - last < DEDUP_MINUTES * 60_000) return true;
  dedupCache.set(sig, now);
  return false;
}

async function postBurn(burn) {
  const {
    sig,
    mint,
    burnSol,
    priceUsd,
    mcapSol,
    liqUsd
  } = burn;

  if (burnSol < MIN_SOL) return;
  if (MAX_MCAP_SOL > 0 && mcapSol && mcapSol > MAX_MCAP_SOL) return;
  if (lpMode === "strict" && liqUsd !== 0) return;

  const tokenPrice = priceUsd ? `${(priceUsd).toFixed(6)} USD` : "n/a";
  const burnSolFmt = `${burnSol.toFixed(4)} ◎`;
  const mcapFmt = mcapSol ? `${mcapSol.toFixed(2)} ◎` : "n/a";
  const liqFmt = liqUsd !== undefined ? `${liqUsd}` : "n/a";

  const text = `🔥 **TOKEN BURN DETECTED** 🔥
━━━━━━━━━━━━━━━━━━━━━━
**Token:** [${mint}](https://solscan.io/token/${mint})
**Amount burned:** ${burnSolFmt}
**Price:** ${tokenPrice}
**Marketcap:** ${mcapFmt}
**Liquidity:** ${liqFmt}
━━━━━━━━━━━━━━━━━━━━━━
[Solscan](https://solscan.io/tx/${sig}) | [Birdeye](https://birdeye.so/token/${mint}) | [DexScreener](https://dexscreener.com/solana/${mint})`;

  await bot.telegram.sendMessage(CHANNEL_ID, text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true
  });
}

// === POLLING ===
async function poll() {
  console.log("[POLL] start", new Date().toISOString());
  const burns = await fetchBurns();
  const solUsd = await getSolUsd();

  for (const b of burns) {
    const sig = b.Transaction.Signature;
    if (shouldSkip(sig)) continue;

    const mint = b.Instruction.Accounts[0]?.Account || "unknown";
    const amount = parseFloat(b.Instruction.Data.Parsed.Info.Amount || "0");
    const priceUsd = await getTokenPrice(mint);
    const burnSol = priceUsd && solUsd ? amount * priceUsd / solUsd : 0;

    await postBurn({
      sig,
      mint,
      burnSol,
      priceUsd,
      mcapSol: null,
      liqUsd: 0
    });
  }
}

// === HEARTBEAT ===
setInterval(() => {
  console.log("[HEARTBEAT]", new Date().toISOString());
}, 15_000);

// === COMMANDS ===
bot.command("ping", (ctx) => ctx.reply("pong"));
bot.command("status", (ctx) =>
  ctx.reply(`MIN_SOL=${MIN_SOL} ◎\nMAX_MCAP_SOL=${MAX_MCAP_SOL}\nLP Mode=${lpMode}\nInterval=${pollInterval}s`)
);
bot.command("setminsol", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const val = parseFloat(ctx.message.text.split(" ")[1]);
  if (!isNaN(val)) {
    process.env.MIN_SOL = val;
    ctx.reply(`✅ MIN_SOL updated: ${val} ◎`);
  }
});
bot.command("setmaxmcap", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const val = parseFloat(ctx.message.text.split(" ")[1]);
  if (!isNaN(val)) {
    process.env.MAX_MCAP_SOL = val;
    ctx.reply(`✅ MAX_MCAP_SOL updated: ${val} ◎`);
  }
});
bot.command("setlp", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const mode = ctx.message.text.split(" ")[1];
  if (mode === "strict" || mode === "relaxed") {
    lpMode = mode;
    ctx.reply(`✅ LP mode: ${mode}`);
  }
});
bot.command("setinterval", (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const val = parseInt(ctx.message.text.split(" ")[1]);
  if (!isNaN(val) && val >= 5) {
    pollInterval = val;
    ctx.reply(`✅ Interval updated: ${val}s`);
  }
});
bot.command("debugpoll", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  ctx.reply("🔄 Manual poll...");
  await poll();
  ctx.reply("✅ Done!");
});

// === START ===
(async () => {
  await bot.launch();
  console.log("[BOT] started");

  // Start polling loop
  setInterval(poll, pollInterval * 1000);
})();
