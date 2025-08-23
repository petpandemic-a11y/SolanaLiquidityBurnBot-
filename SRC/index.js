import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

// ====== TELEGRAM BOT ======
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

// ====== API URL-ek ======
const BITQUERY_URL = "https://graphql.bitquery.io";
const RAYDIUM_API = "https://api.raydium.io/v2/sdk/liquidity/mainnet.json";
const ORCA_API = "https://api.orca.so/pools";

// ====== AXIOS ALAPBEÁLLÍTÁS ======
const axiosInstance = axios.create({
  timeout: 5000, // 5 másodperc
});

// ====== LP TOKEN LISTA ======
let LP_TOKENS = [];

// ====== LP POOL LISTA FRISSÍTÉS ======
async function updatePools() {
  console.log("🔹 LP poolok frissítése indul...");
  let rayPools = [];
  let orcaPools = [];

  // Raydium poolok
  try {
    const rayRes = await axiosInstance.get(RAYDIUM_API);
    rayPools = Object.values(rayRes.data).map(p => p.lpMint);
    console.log(`✅ Raydium API OK: ${rayPools.length} pool`);
  } catch (err) {
    console.error("❌ Raydium API hiba:", err.code || err.message);
  }

  // Orca poolok
  try {
    const orcaRes = await axiosInstance.get(ORCA_API);
    orcaPools = Object.values(orcaRes.data).map(p => p.poolTokenMint);
    console.log(`✅ Orca API OK: ${orcaPools.length} pool`);
  } catch (err) {
    console.error("❌ Orca API hiba:", err.code || err.message);
  }

  // LP tokenek egyesítése
  LP_TOKENS = [...new Set([...rayPools, ...orcaPools])];

  if (LP_TOKENS.length > 0) {
    console.log(`✅ LP pool lista frissítve: ${LP_TOKENS.length} pool figyelve.`);
  } else {
    console.warn("⚠️ Figyelem: nincs elérhető LP pool lista!");
  }
}

// ====== LP BURN LEKÉRÉS ======
async function fetchLPBurns(limit = 30) {
  if (LP_TOKENS.length === 0) {
    console.warn("⚠️ Nincs LP pool lista, kihagyjuk a lekérdezést!");
    return [];
  }

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
    const res = await axiosInstance.post(
      BITQUERY_URL,
      { query, variables: { limit, lpTokens: LP_TOKENS } },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${BITQUERY_API_KEY}`,
        },
      }
    );

    const transfers = res.data?.data?.solana?.transfers || [];
    console.log(`📊 Lekérdezve: ${transfers.length} LP burn esemény.`);
    return transfers;
  } catch (e) {
    console.error("❌ Bitquery API hiba:", e.response?.data || e.message);
    return [];
  }
}

// ====== LP BURN POSZTOLÁS TELEGRAMRA ======
async function checkBurnEvents() {
  console.log("🔄 Ellenőrzés indul...");

  const burns = await fetchLPBurns(30);

  if (burns.length === 0) {
    console.log("ℹ️ Nincs új LP burn esemény.");
    return;
  }

  for (const burn of burns) {
    const msg = `
🔥 *LP Token Burn Detected!* 🔥

💎 *Token:* ${burn.currency.name || "Ismeretlen"} (${burn.currency.symbol || "N/A"})
📜 *LP Token Contract:* \`${burn.currency.address}\`
📥 *Burn Address:* \`${burn.receiver.address}\`
💰 *Amount Burned:* ${burn.amount}
⏰ *Time:* ${burn.block.timestamp.time}
🔗 [Tx on Solscan](https://solscan.io/tx/${burn.transaction.signature})
    `;

    try {
      await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
      console.log(`📩 Telegram üzenet elküldve: ${burn.currency.symbol}`);
    } catch (err) {
      console.error("❌ Telegram küldési hiba:", err.message);
    }
  }
}

// ====== BOT INDÍTÁS ======
console.log("🚀 Solana LP Burn Bot indul...");

// LP pool lista frissítés az induláskor
await updatePools();

// LP pool lista frissítés óránként
setInterval(updatePools, 3600 * 1000);

// LP burn események figyelése 10 másodpercenként
setInterval(checkBurnEvents, 10 * 1000);
