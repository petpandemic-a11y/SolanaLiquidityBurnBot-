import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;

// DexScreener Solana API
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens/solana";

async function fetchBurnEvents() {
  console.log("🔄 Ellenőrzés indul...");

  try {
    const res = await axios.get(DEXSCREENER_API, { timeout: 10000 });
    const tokens = res.data?.pairs || [];

    for (const token of tokens) {
      const liquidityUSD = token.liquidity?.usd || 0;

      // Ha LP = 0 → teljes LP burn
      if (liquidityUSD === 0) {
        const msg = `
🔥 *100% LP Burn Detected!* 🔥

💎 *Token:* ${token.baseToken.name} (${token.baseToken.symbol})
📜 *Contract:* \`${token.baseToken.address}\`
💰 *Price:* $${token.priceUsd || "N/A"}
📈 *Market Cap:* $${token.fdv || "N/A"}
👥 *Liquidity:* $${liquidityUSD}
🔗 [View on DexScreener](${token.url})
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
