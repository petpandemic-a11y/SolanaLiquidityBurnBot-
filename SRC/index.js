import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

// ====== TELEGRAM BOT ======
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;

// ====== API URL-ek ======
const BITQUERY_URL = "https://graphql.bitquery.io";
const RAYDIUM_API = "https://api.raydium.io/v2/main/pairs";
const JUPITER_API = "https://quote-api.jup.ag/v6/pools";
const BIRDEYE_API = "https://public-api.birdeye.so/defi/tokenlist?chain=solana";

// ====== AXIOS BEÁLLÍTÁS ======
const http = axios.create({
  timeout: 5000, // 5 másodperc timeout minden API-ra
});

// ====== LP TOKEN LISTA ======
let LP_TOKENS = [];

// ====== RAYDIUM LP POOLOK LEKÉRÉSE ======
async function fetchRaydiumPools() {
  try {
    const res = await http.get(RAYDIUM_API);
    const rayPools = Object.values(res.data).map(p => p.lpMintAddress);
    console.log(`✅ Raydium API OK: ${rayPools.length} pool`);
    return rayPools;
  } catch (err) {
    console.error("❌ Raydium API hiba:", err.code || err.message);
    return [];
  }
}

// ====== JUPITER LP POOLOK LEKÉRÉSE ======
async function fetchJupiterPools() {
  try {
    const res = await http.get(JUPITER_API);
    const jupPools = res.data?.data?.map(p => p.lpMint) || [];
    console.log(`✅ Jupiter API OK: ${jupPools.length} pool`);
    return jupPools;
  } catch (err) {
    console.error("❌ Jupiter API hiba:", err.code || err.message);
    return [];
  }
}

// ====== BIRDEYE FALLBACK LP POOL LISTA ======
async function fetchBirdeyePools() {
  try {
    const res = await http.get(BIRDEYE_API, {
      headers: { "X-API-KEY": process.env.BIRDEYE_API_KEY || "" },
    });
    const tokens = res.data?.data?.tokens || [];
    const lpTokens = tokens
      .filter(t => t.symbol?.includes("LP") || t.name?.toLowerCase().includes("lp"))
      .map(t => t.address);
    console.log(`✅ Birdeye fallback OK: ${lpTokens.length} pool`);
    return lpTokens;
  } catch (err) {
    console.error("❌ Birdeye API hiba:", err.code || err.message);
    return [];
  }
}

// ====== LP POOL LISTA FRISSÍTÉS ======
async function updatePools() {
  console.log("🔹 LP poolok frissítése indul...");
  const rayPools = await fetchRaydiumPools();
  const jupPools = await fetchJupiterPools();

  let mergedPools = [...rayPools, ...jupPools];

  if (mergedPools.length < 50) {
    console.warn("⚠️ Kevés LP pool, Birdeye fallback indul...");
    const birdeyePools = await fetchBirdeyePools();
    mergedPools = [...mergedPools, ...birdeyePools];
  }

  LP_TOKENS = [...new Set(mergedPools)];
  console.log(`ℹ️ LP pool lista frissítve, figyelt poolok száma: ${LP_TOKENS.length}`);
}

// ====== LP BURN LEKÉRÉS BITQUERY-BŐL ======
async function fetchLPBurns(limit = 30) {
  if (!LP_TOKENS.length) {
    console.warn("⚠️ Nincs LP token lista, kihagyjuk...");
    return [];
  }

  const query = `
    query ($limit: Int!, $lpTokens: [String!]) {
      solana {
        transfers(
          options: {limit: $limit, desc: "block.timestamp.time"},
          transferType: burn,
          currency: {in: $lpTokens}
        ) {
          block { timestamp { time } }
          currency { address symbol name }
          amount
          receiver { address }
          transaction { signature }
        }
      }
    }
  `;

  try {
    const { data } = await http.post(
      BITQUERY_URL,
      { query, variables: { limit, lpTokens: LP_TOKENS } },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.BITQUERY_API_KEY}`,
        },
      }
    );
    const transfers = data?.data?.solana?.transfers || [];
    console.log(`📊 Bitquery lekérdezés sikeres – talált események: ${transfers.length}`);
    return transfers;
  } catch (err) {
    console.error("❌ Bitquery API hiba:", err.response?.data || err.message);
    return [];
  }
}

// ====== LP BURN POSZTOLÁS TELEGRAMRA ======
async function checkBurnEvents() {
  console.log("🔄 Ellenőrzés indul...");
  const burns = await fetchLPBurns();

  if (!burns.length) {
    console.log("ℹ️ Nincs új LP burn esemény.");
    return;
  }

  for (const burn of burns) {
    const msg = `
🔥 *LP Token Burn Detected!* 🔥

💎 *Token:* ${burn.currency.name || "Ismeretlen"} (${burn.currency.symbol || "?"})
📜 *LP Token Contract:* \`${burn.currency.address}\`
📥 *Burn cím:* \`${burn.receiver.address}\`
💰 *Mennyiség:* ${burn.amount}
⏰ *Idő:* ${burn.block.timestamp.time}
🔗 [Tranzakció](https://solscan.io/tx/${burn.transaction.signature})
`;

    try {
      await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
      console.log("📩 Telegram üzenet elküldve:", burn.currency.symbol);
    } catch (e) {
      console.error("❌ Telegram küldési hiba:", e.message);
    }
  }
}

// ====== BOT INDÍTÁS ======
console.log("🚀 LP Burn Bot indul...");
await updatePools();
setInterval(updatePools, 3600 * 1000);
setInterval(checkBurnEvents, 10 * 1000);
