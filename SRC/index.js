import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

// Telegram init
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;

// API URLs
const BITQUERY_URL = "https://graphql.bitquery.io";
const RAYDIUM_V3 = "https://api-v3.raydium.io/liquidity/list";
const ORCA_API = "https://api.orca.so/pools";
const JUPITER_API = "https://public-api.jup.ag/v6/pools"; // feltételezett publikus endpoint

// Axios instanc e with timeout
const http = axios.create({ timeout: 5000 });

let LP_TOKENS = [];

// 1. Frissít LP poolokat (Raydium v3, Orca, Jupiter)
async function updatePools() {
  console.log("🔹 LP poolok frissítése indul...");
  const pools = [];

  // Raydium v3
  try {
    const res = await http.get(RAYDIUM_V3);
    if (res.data?.data?.pools) {
      const rayPools = res.data.data.pools.map(p => p.lpMint);
      pools.push(...rayPools);
      console.log(`✅ Raydium v3 API OK: ${rayPools.length} pool`);
    }
  } catch (err) {
    console.error("❌ Raydium v3 API hiba:", err.code || err.message);
  }

  // Orca
  try {
    const res = await http.get(ORCA_API);
    const orcaPools = Object.values(res.data).map(p => p.poolTokenMint);
    pools.push(...orcaPools);
    console.log(`✅ Orca API OK: ${orcaPools.length} pool`);
  } catch (err) {
    console.error("❌ Orca API hiba:", err.code || err.message);
  }

  // Jupiter (ha elérhető)
  try {
    const res = await http.get(JUPITER_API);
    if (res.data?.data?.pools) {
      const jupPools = res.data.data.pools.map(p => p.lpMint);
      pools.push(...jupPools);
      console.log(`✅ Jupiter API OK: ${jupPools.length} pool`);
    }
  } catch (err) {
    console.error("❌ Jupiter API hiba (elhagyható):", err.code || err.message);
  }

  LP_TOKENS = [...new Set(pools)];
  console.log(`ℹ️ LP pool lista frissítve, figyelt poolok száma: ${LP_TOKENS.length}`);
}

// 2. Lekérdezi az LP burn eseményeket Bitquery v2-n
async function fetchLPBurns(limit = 30) {
  if (!LP_TOKENS.length) {
    console.warn("⚠️ Nincs LP token listája, kihagyjuk...");
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
    const { data } = await http.post(BITQUERY_URL, { query, variables: { limit, lpTokens: LP_TOKENS } }, {
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.BITQUERY_API_KEY}` }
    });
    const transfers = data?.data?.solana?.transfers || [];
    console.log(`📊 Bitquery lekérdezés sikeres – talált események: ${transfers.length}`);
    return transfers;
  } catch (err) {
    console.error("❌ Bitquery API hiba:", err.response?.data || err.message);
    return [];
  }
}

// 3. Figyeli az eseményeket és posztol Telegramra
async function checkBurnEvents() {
  console.log("🔄 Ellenőrzés indul...");
  const burns = await fetchLPBurns();
  if (!burns.length) return console.log("ℹ Nincs új LP burn esemény.");
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
      console.log("📩 Telegram üzenet küldve:", burn.currency.symbol);
    } catch (e) {
      console.error("❌ Telegram küldési hiba:", e.message);
    }
  }
}

// 4. Indítás
console.log("🚀 LP Burn Bot indul...");
await updatePools();
setInterval(updatePools, 3600 * 1000);
setInterval(checkBurnEvents, 10 * 1000);
