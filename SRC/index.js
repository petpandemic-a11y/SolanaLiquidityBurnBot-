import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

const BIRDEYE_GRAPHQL = "https://public-api.birdeye.so/graphql";

// GraphQL lekérdezés küldése Birdeye API-ra
async function birdeyeQuery(query, variables = {}) {
  try {
    const res = await axios.post(
      BIRDEYE_GRAPHQL,
      { query, variables },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": BIRDEYE_API_KEY,
        },
        timeout: 8000,
      }
    );
    return res.data.data;
  } catch (err) {
    console.error("Birdeye API hiba:", err.message);
    return null;
  }
}

// Token lista lekérése (TOP 100 marketcap szerint)
async function fetchTokenList() {
  const query = `
    query TokenList {
      tokens(chain: "solana", sort: MARKETCAP, limit: 100, order: DESC) {
        address
        symbol
        name
        liquidityUSD
      }
    }
  `;
  const data = await birdeyeQuery(query);
  return data?.tokens || [];
}

// Token részletes adatok (ár, mcap, holders)
async function fetchTokenDetails(address) {
  const query = `
    query TokenDetails($address: String!) {
      token(chain: "solana", address: $address) {
        priceUSD
        marketCapUSD
        holders
      }
    }
  `;
  const data = await birdeyeQuery(query, { address });
  return data?.token || null;
}

// LP burn figyelő
async function fetchBurnEvents() {
  console.log("🔄 Ellenőrzés indul...");

  const tokens = await fetchTokenList();
  for (const token of tokens) {
    if (token.liquidityUSD === 0) {
      const details = await fetchTokenDetails(token.address);

      const msg = `
🔥 *100% LP Burn Detected!* 🔥

💎 *Token:* ${token.name} (${token.symbol})
📜 *Contract:* \`${token.address}\`
💰 *Price:* $${details?.priceUSD?.toFixed(6) || "N/A"}
📈 *Market Cap:* $${details?.marketCapUSD?.toLocaleString() || "N/A"}
👥 *Holders:* ${details?.holders || "N/A"}
🔗 [View on Birdeye](https://birdeye.so/token/${token.address}?chain=solana)
      `;

      await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
    }
  }
}

// 10 másodpercenként futtatjuk
setInterval(fetchBurnEvents, 10000);
