import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;

// Új univerzális DexScreener API
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/pairs";

async function fetchBurnEvents() {
  console.log("🔄 Ellenőrzés indul...");

  try {
    // Lekérjük az összes elérhető párt
    const res = await axios.get(DEXSCREENER_API, { timeout: 20000 });
    const pairs = res.data?.pairs || [];

    // Csak Solana hálózatot nézünk
    const solanaPairs = pairs.filter(pair => pair.chainId === "solana");

    for (const pair of solanaPairs) {
      const liquidityUSD = pair.liquidity?.usd || 0;

      // Ha LP = 0 → teljes LP burn
      if (liquidityUSD === 0) {
        const msg = `
🔥 *100% LP Burn Detected!* 🔥

💎 *Token:* ${pair.baseToken.name} (${pair.baseToken.symbol})
📜 *Contract:* \`${pair.baseToken.address}\`
💰 *Price:* $${pair.priceUsd || "N/A"}
📈 *FDV:* $${pair.fdv || "N/A"}
💧 *Liquidity:* $${liquidityUSD}
🔗 [View on DexScreener](${pair.url})
        `;

        await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
      }
    }
  } catch (e) {
    console.error("API hiba:", e.message);
  }
}

// 10 mp-enként frissít
setInterval(fetchBurnEvents, 10000);
