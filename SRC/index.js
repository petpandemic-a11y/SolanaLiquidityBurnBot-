import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

// Birdeye API token info lekérés (ár, mcap, holders)
async function fetchTokenInfo(tokenAddress) {
  try {
    const res = await axios.get(`https://public-api.birdeye.so/public/token?address=${tokenAddress}`, {
      headers: { "X-API-KEY": BIRDEYE_API_KEY },
    });

    const data = res.data?.data || {};
    return {
      price: data.price || 0,
      mcap: data.mc || 0,
      holders: data.holder || 0,
      symbol: data.symbol || "N/A",
      name: data.name || "Unknown",
    };
  } catch (e) {
    console.error("Token info hiba:", e.message);
    return {};
  }
}

// DexScreener API – legfrissebb Solana tranzakciók
async function fetchBurnEvents() {
  try {
    const res = await axios.get("https://api.dexscreener.com/latest/dex/tokens/solana");
    const pairs = res.data?.pairs || [];

    for (const pair of pairs) {
      const tokenAddress = pair.baseToken.address;
      const tokenSymbol = pair.baseToken.symbol;
      const liquidityUSD = pair.liquidity?.usd || 0;

      // Ha LP likviditás = 0 → teljes LP burn
      if (liquidityUSD === 0) {
        const tokenInfo = await fetchTokenInfo(tokenAddress);

        const msg = `
🔥 *100% LP Burn Detected!* 🔥

💎 *Token:* ${tokenInfo.name} (${tokenSymbol})
📜 *Contract:* \`${tokenAddress}\`
💰 *Price:* $${tokenInfo.price.toFixed(6)}
📈 *Market Cap:* $${tokenInfo.mcap ? tokenInfo.mcap.toLocaleString() : "N/A"}
👥 *Holders:* ${tokenInfo.holders || "N/A"}
🔗 [View on DexScreener](https://dexscreener.com/solana/${tokenAddress})
        `;

        await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
      }
    }
  } catch (e) {
    console.error("Burn lekérés hiba:", e.message);
  }
}

// 10 másodpercenként figyelünk
setInterval(fetchBurnEvents, 10000);
