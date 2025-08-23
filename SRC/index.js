import fetch from "node-fetch";
import dotenv from "dotenv";
import { Telegraf } from "telegraf";

dotenv.config();

// ====== ENV ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

let MIN_SOL = parseFloat(process.env.MIN_SOL || "0");
let MAX_MCAP_SOL = parseFloat(process.env.MAX_MCAP_SOL || "0");
let POLL_INTERVAL_SEC = parseInt(process.env.POLL_INTERVAL_SEC || "10");
let POLL_LOOKBACK_SEC = parseInt(process.env.POLL_LOOKBACK_SEC || "12");
let DEDUP_MINUTES = parseInt(process.env.DEDUP_MINUTES || "10");

let LP_MODE = "relaxed"; // alapértelmezett: relaxed

const bot = new Telegraf(BOT_TOKEN);

// Dedup cache
const seenTx = new Map();

// ========== GET PRICE (BIRDEYE) ==========
async function getTokenPrice(mint) {
  try {
    const url = `https://public-api.birdeye.so/defi/price?address=${mint}`;
    const res = await fetch(url, {
      headers: {
        "accept": "application/json",
        "X-API-KEY": BIRDEYE_API_KEY
      }
    });
    const data = await res.json();
    return data?.data?.value || null;
  } catch (e) {
    console.error(`[birdeye price] fail for ${mint}`, e.message);
    return null;
  }
}

async function getSolPrice() {
  return await getTokenPrice("So11111111111111111111111111111111111111112");
}

// ========== BITQUERY GRAPHQL ==========
async function fetchBurns() {
  const query = `
  query {
    Solana {
      TokenSupplyUpdates(
        where: {
          Instruction: { Program: { Method: { is: "burn" }}},
          Block: { Time: { since: "${new Date(Date.now() - POLL_LOOKBACK_SEC * 1000).toISOString()}" }}
        }
        limit: { count: 500 }
      ) {
        Transaction {
          Signature
        }
        Currency {
          Mint
        }
        Amount
      }
    }
  }`;

  const res = await fetch("https://streaming.bitquery.io/eap", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": BITQUERY_API_KEY
    },
    body: JSON.stringify({ query })
  });

  const json = await res.json();
  return json?.data?.Solana?.TokenSupplyUpdates || [];
}

// ========== FORMAT NUMBER ==========
function formatSol(sol) {
  return parseFloat(sol).toFixed(4);
}

// ========== TELEGRAM POST ==========
async function postBurn(burn) {
  const { sig, mint, burnSol, priceUsd, mcapUsd, liqUsd } = burn;

  const solPrice = await getSolPrice();
  const burnInSol = burnSol;
  const priceInSol = priceUsd && solPrice ? priceUsd / solPrice : null;
  const mcapInSol = mcapUsd && solPrice ? mcapUsd / solPrice : null;

  let txt = `🔥 **Token Burn Detected**\n\n`;
  txt += `**Token:** \`${mint}\`\n`;
  txt += `**Burned:** ${formatSol(burnInSol)} SOL\n`;
  txt += `**Price:** ${priceInSol ? formatSol(priceInSol) + " SOL" : "n/a"}\n`;
  txt += `**Marketcap:** ${mcapInSol ? formatSol(mcapInSol) + " SOL" : "n/a"}\n`;
  txt += `**Liquidity:** ${liqUsd === 0 ? "💧 0 (LP burned)" : "n/a"}\n\n`;
  txt += `[🔎 Solscan](https://solscan.io/tx/${sig}) | [📊 Birdeye](https://birdeye.so/token/${mint})`;

  await bot.telegram.sendMessage(CHANNEL_ID, txt, { parse_mode: "Markdown", disable_web_page_preview: true });
}

// ========== POLLING LOOP ==========
async function poll() {
  try {
    const burns = await fetchBurns();

    for (const b of burns) {
      const sig = b.Transaction.Signature;
      const mint = b.Currency.Mint;
      const amount = Math.abs(parseFloat(b.Amount));

      // Dedup
      if (seenTx.has(sig)) continue;
      seenTx.set(sig, Date.now());
      setTimeout(() => seenTx.delete(sig), DEDUP_MINUTES * 60 * 1000);

      const solPrice = await getSolPrice();
      const burnSol = solPrice ? amount * solPrice : amount;

      if (burnSol < MIN_SOL) {
        console.log(`[SKIP < MIN_SOL] sig=${sig} burnSol=${burnSol}`);
        continue;
      }

      // Ha van mcap limit
      if (MAX_MCAP_SOL > 0 && b.mcapUsd && solPrice) {
        const mcapInSol = b.mcapUsd / solPrice;
        if (mcapInSol > MAX_MCAP_SOL) {
          console.log(`[SKIP > MAX_MCAP] sig=${sig} mcapSol=${mcapInSol}`);
          continue;
        }
      }

      // LP filter
      if (LP_MODE === "strict" && b.liqUsd && b.liqUsd > 0) {
        console.log(`[SKIP LP not fully burned] sig=${sig}`);
        continue;
      }

      await postBurn({ sig, mint, burnSol: amount, priceUsd: b.priceUsd, mcapUsd: b.mcapUsd, liqUsd: b.liqUsd });
    }

    console.log(`[POLL] parsed ${burns.length}`);
  } catch (e) {
    console.error("[poll error]", e.message);
  }
}

// ========== HEARTBEAT ==========
setInterval(() => {
  console.log(`[HEARTBEAT] ${new Date().toISOString()}`);
}, 15000);

// ========== LOOP ==========
setInterval(poll, POLL_INTERVAL_SEC * 1000);

// ========== BOT COMMANDS ==========
bot.command("ping", ctx => ctx.reply("pong"));
bot.command("status", ctx => {
  ctx.reply(`⚙️ **Config:**\nMIN_SOL=${MIN_SOL} SOL\nMAX_MCAP_SOL=${MAX_MCAP_SOL} SOL\nLP_MODE=${LP_MODE}\nInterval=${POLL_INTERVAL_SEC}s`, { parse_mode: "Markdown" });
});
bot.command("setminsol", ctx => {
  const val = parseFloat(ctx.message.text.split(" ")[1]);
  if (!isNaN(val)) {
    MIN_SOL = val;
    ctx.reply(`✅ MIN_SOL updated to ${MIN_SOL}`);
  }
});
bot.command("setmaxmcap", ctx => {
  const val = parseFloat(ctx.message.text.split(" ")[1]);
  if (!isNaN(val)) {
    MAX_MCAP_SOL = val;
    ctx.reply(`✅ MAX_MCAP_SOL updated to ${MAX_MCAP_SOL}`);
  }
});
bot.command("setlp", ctx => {
  const mode = ctx.message.text.split(" ")[1];
  if (["strict", "relaxed"].includes(mode)) {
    LP_MODE = mode;
    ctx.reply(`✅ LP_MODE set to ${LP_MODE}`);
  }
});

// ========== START ==========
bot.launch();
console.log("🚀 Bot started...");
