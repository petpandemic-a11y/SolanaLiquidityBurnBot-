import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

// Retry logika – hogy ne álljon le, ha a Birdeye épp lassú
async function safeApiCall(url, headers = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, { headers, timeout: 7000 });
      return res.data;
    } catch (e) {
      if (i < retries - 1) {
        console.warn(`Birdeye API hiba: ${e.message} → újrapróbálkozás ${i + 1}/${retries}`);
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        console.error(`Birdeye API végleg nem elérhető: ${url}`);
        return null;
      }
    }
  }
}

// Token infó lekérése Birdeye API-ról
async function fetchTokenInfo(tokenAddress) {
  const url = `https://api.birdeye.so/public/v1/token?address=${tokenAddress}&chain=solana`;
  const data = await safeApiCall(url, {
    "X-API-KEY": BIRDEYE_API_KEY,
    "accept": "application/json",
  });
  return data?.data || null;
}

// Fő LP burn figyelő függvény
async function fetchBurnEvents() {
  console.log("🔄 Ellenőrzés indul...");

  try {
    const url = "https://api.birdeye.so/public/v1/tokenlist?sort=marketcap&sort_type=desc&offset=0&limit=100&chain=solana";
    const data = await safeApiCall(url, {
      "X-API-KEY": BIRDEYE_API_KEY,
      "accept": "application/json",
    });

    const tokens = data?.data?.tokens || [];

    for (const token of tokens) {
      const liquidityUSD = token.liquidity || 0;

      // Ha LP likviditás = 0 → teljes LP burn
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

// 10 mp-enként frissítünk
setInterval(fetchBurnEvents, 10000);
