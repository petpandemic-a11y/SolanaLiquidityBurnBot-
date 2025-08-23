import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

// Retry logika: ne álljon le, ha Birdeye lassú vagy időszakosan hibázik
async function safeApiCall(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, {
        headers: {
          "X-API-KEY": BIRDEYE_API_KEY,
          "accept": "application/json",
        },
        timeout: 8000,
      });
      return res.data;
    } catch (e) {
      if (i < retries - 1) {
        console.warn(`API hiba: ${e.message} → újrapróbálkozás ${i + 1}/${retries}`);
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        console.error(`Birdeye API végleg nem elérhető: ${url}`);
        return null;
      }
    }
  }
}

// Token részletes infók lekérése
async function fetchTokenOverview(tokenAddress) {
  const url = `https://api.birdeye.so/defi/token_overview?address=${tokenAddress}&chain=solana`;
  const data = await safeApiCall(url);
  return data?.data || null;
}

// Token lista lekérése (marketcap szerint)
async function fetchTokenList() {
  const url = "https://api.birdeye.so/defi/tokenlist?sort=marketcap&sort_type=desc&chain=solana";
  const data = await safeApiCall(url);
  return data?.data?.tokens || [];
}

// Fő LP burn figyelő függvény
async function fetchBurnEvents() {
  console.log("🔄 Ellenőrzés indul...");

  try {
    const tokens = await fetchTokenList();

    for (const token of tokens) {
      const liquidityUSD = token.liquidity || 0;

      // Csak akkor posztolunk, ha a likviditás = 0 → 100% LP burn
      if (liquidityUSD === 0) {
        const tokenInfo = await fetchTokenOverview(token.address);

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
