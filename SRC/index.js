import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

// Birdeye token infó lekérése
async function fetchTokenInfo(tokenAddress) {
  try {
    const res = await axios.get(
      `https://api.birdeye.so/public/v1/token?address=${tokenAddress}&chain=solana`,
      {
        headers: {
          "X-API-KEY": BIRDEYE_API_KEY,
          "accept": "application/json",
        },
      }
    );
    return res.data?.data || null;
  } catch (e) {
    console.error("Token info hiba:", e.message);
    return null;
  }
}

// LP burn figyelése
async function fetchBurnEvents() {
  try {
    const res = await axios.get(
      "https://api.birdeye.so/public/v1/tokenlist?sort=marketcap&sort_type=desc&offset=0&limit=50&chain=solana",
      {
        headers: {
          "X-API-KEY": BIRDEYE_API_KEY,
          "accept": "application/json",
        },
      }
    );

    const tokens = res.data?.data?.tokens || [];

    for (const token of tokens) {
      const liquidityUSD = token.liquidity || 0;

      // Ha LP = 0 → teljes LP burn
      if (liquidityUSD === 0) {
        const tokenInfo = await fetchTokenInfo(token.address);

        const msg = `
🔥 *100% LP Burn Detected!* 🔥

💎 *Token:* ${tokenInfo?.name || token.symbol} (${token.symbol})
📜 *Contract:* \`${token.address}\`
💰 *Price:* $${tokenInfo?.price?.toFixed(6) || "N/A"}
📈 *Market Cap:* $${tokenInfo?.mc?.toLocaleString() || "N/A"}
👥 *Holders:* ${tokenInfo?.holder || "N/A"}
🔗 [View on Birdeye](https://birdeye.so/token/${token.address}?chain=solana)
        `;

        await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
      }
    }
  } catch (e) {
    console.error("LP burn lekérés hiba:", e.message);
  }
}

// 10 mp-enként ellenőrzés
setInterval(fetchBurnEvents, 10000);
