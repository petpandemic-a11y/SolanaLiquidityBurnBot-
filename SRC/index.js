import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import fs from "fs";
import { fetchLPTokens } from "./pools.js";

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const channelId = process.env.TELEGRAM_CHANNEL_ID;
const heliusKey = process.env.HELIUS_API_KEY;
const cachePath = "./SRC/lp-cache.json";
const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
const checkInterval = parseInt(process.env.CHECK_INTERVAL) || 10000;

// Előzőleg figyelt LP tokenek
let lpTokens = fs.existsSync(cachePath)
  ? JSON.parse(fs.readFileSync(cachePath))
  : [];

// LP tokenek frissítése 10 percenként
setInterval(async () => {
  lpTokens = await fetchLPTokens();
}, 10 * 60 * 1000);

// LP-burn ellenőrzés
async function checkBurns() {
  try {
    for (const lpMint of lpTokens) {
      const body = {
        jsonrpc: "2.0",
        id: "burn-check",
        method: "getTokenSupply",
        params: [lpMint],
      };

      const res = await axios.post(heliusUrl, body);
      const totalSupply = parseInt(res.data.result.value.amount);

      if (totalSupply === 0) {
        console.log(`[Bot] 100% LP-burn észlelve: ${lpMint}`);
        await sendBurnAlert(lpMint);
      }
    }
  } catch (err) {
    console.error("[Bot] Hiba az LP-burn ellenőrzésnél:", err.message);
  }
}

// Telegram értesítés
async function sendBurnAlert(lpMint) {
  const msg = `
🔥 <b>100% LP BURN ÉSZLELVE</b> 🔥

LP Token: <code>${lpMint}</code>
Tranzakció: https://solscan.io/token/${lpMint}
`;
  await bot.sendMessage(channelId, msg, { parse_mode: "HTML" });
}

// Időzített ellenőrzés
setInterval(checkBurns, checkInterval);

console.log("[Bot] LP-burn figyelő bot elindult...");
