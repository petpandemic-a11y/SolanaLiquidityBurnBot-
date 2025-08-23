import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

const BITQUERY_URL = "https://graphql.bitquery.io";
const RAYDIUM_API = "https://api.raydium.io/v2/sdk/liquidity/mainnet.json";
const ORCA_API = "https://api.orca.so/pools";

let LP_TOKENS = [];

// 🔹 LP poolok automatikus frissítése Raydium + Orca API-ról
async function updatePools() {
  try {
    const [rayRes, orcaRes] = await Promise.all([
      axios.get(RAYDIUM_API),
      axios.get(ORCA_API),
    ]);

    const rayPools = Object.values(rayRes.data).map(p => p.lpMint);
    const orcaPools = Object.values(orcaRes.data).map(p => p.poolTokenMint);

    LP_TOKENS = [...new Set([...rayPools, ...orcaPools])];

    console.log(`✅ LP pool lista frissítve: ${LP_TOKENS.length} pool figyelve.`);
  } catch (err) {
    console.error("LP pool frissítési hiba:", err.message);
  }
}

// 🔹 LP burn tranzakciók lekérése Bitquery v2 API-ból
async function fetchLPBurns(limit = 30) {
  if (LP_TOKENS.length === 0) return [];

  const query = `
    query LPBurns($limit: Int!, $lpTokens: [String!]) {
      solana {
        transfers(
          options: {limit: $limit, desc: "block.timestamp.time"}
          transferType: burn
          currency: {in: $lpTokens}
        ) {
          block {
            timestamp {
              time
            }
          }
          currency {
            address
            symbol
            name
          }
          amount
          sender {
            address
          }
          receiver {
            address
          }
          transaction {
            signature
          }
        }
      }
    }
  `;

  try {
    const res = await axios.post(
      BITQUERY_URL,
      { query, variables: { limit, lpTokens: LP_TOKENS } },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${BITQUERY_API_KEY}`,
        },
      }
    );

    return res.data.data?.solana?.transfers || [];
  } catch (e) {
    console.error("Bitquery API hiba:", e.response?.data || e.message);
    return [];
  }
}

// 🔹 LP burn események figyelése és posztolása Telegramra
async function checkBurnEvents() {
  console.log("🔄 Ellenőrzés indul...");

  const burns = await fetchLPBurns(30);

  for (const burn of burns) {
    const msg = `
🔥 *LP Token Burn Detected!* 🔥

💎 *Token:* ${burn.currency.name} (${burn.currency.symbol})
📜 *LP Token Contract:* \`${burn.currency.address}\`
📥 *Burn Address:* \`${burn.receiver.address}\`
💰 *Amount Burned:* ${burn.amount}
⏰ *Time:* ${burn.block.timestamp.time}
🔗 [Tx on Solscan](https://solscan.io/tx/${burn.transaction.signature})
    `;

    await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
  }
}

// 🔹 Indítás
await updatePools();
setInterval(updatePools, 3600 * 1000);
setInterval(checkBurnEvents, 10 * 1000);
