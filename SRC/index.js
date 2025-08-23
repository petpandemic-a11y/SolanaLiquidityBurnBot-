import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

// --- ENV változók ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY || null;

// --- Telegram bot inicializálás ---
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// --- Raydium v3 API ---
const RAYDIUM_API = "https://api-v3.raydium.io/pools";

// --- Jupiter fallback ---
const JUPITER_API = "https://price.jup.ag/v4/tokens";

// --- Időzítés ---
const CHECK_INTERVAL = 10000; // 10 mp

// --- LP burn figyelés ---
let watchedPools = [];

// Raydium poolok lekérése
async function fetchRaydiumPools() {
  try {
    console.log("[Bot] 🔄 Raydium poolok lekérése...");
    const { data } = await axios.get(RAYDIUM_API);

    if (!data || !data.data) throw new Error("Üres adat a Raydium API-ból");

    watchedPools = data.data
      .filter(p => p.lp && p.lp.locked === true)
      .map(p => ({
        name: p.name,
        lpMint: p.lp.mint,
        contract: p.lp.mint,
        tvl: p.tvl || 0,
      }));

    console.log(`[Bot] ✅ ${watchedPools.length} pool figyelve.`);
  } catch (err) {
    console.error("[Bot] Raydium API hiba:", err.message);
    await fetchJupiterFallback();
  }
}

// Jupiter fallback poolok
async function fetchJupiterFallback() {
  try {
    console.log("[Bot] 🌐 Jupiter fallback indul...");
    const { data } = await axios.get(JUPITER_API);
    watchedPools = Object.values(data.data).slice(0, 50);
    console.log(`[Bot] ✅ Jupiter fallback sikeres: ${watchedPools.length} pool figyelve.`);
  } catch (err) {
    console.error("[Bot] ❌ Jupiter API hiba:", err.message);
  }
}

// Bitquery lekérés LP burn ellenőrzéshez
async function fetchBitqueryBurns(pool) {
  if (!BITQUERY_API_KEY) return null;

  try {
    const query = `
      query {
        solana(network: solana) {
          transfers(
            options: {limit: 1, desc: "block.timestamp.iso8601"}
            amount: {gt: 0}
            currency: {is: "${pool.lpMint}"}
            sender: {is: "${pool.lpMint}"}
          ) {
            amount
            block {
              timestamp {
                iso8601
              }
            }
            transaction {
              signature
            }
          }
        }
      }`;

    const { data } = await axios.post(
      "https://graphql.bitquery.io",
      { query },
      { headers: { "X-API-KEY": BITQUERY_API_KEY } }
    );

    return data.data.solana.transfers.length > 0
      ? data.data.solana.transfers[0]
      : null;
  } catch (err) {
    console.error(`[Bot] Bitquery API hiba: ${err.message}`);
    return null;
  }
}

// Esemény ellenőrzés és Telegram posztolás
async function checkForLpBurns() {
  console.log("[Bot] 🔄 Ellenőrzés indul...");

  for (const pool of watchedPools) {
    const burn = await fetchBitqueryBurns(pool);

    if (burn) {
      const message = `
🔥 *LP BURN ÉSZLELVE!*
🪙 Token: *${pool.name}*
📜 Contract: \`${pool.contract}\`
💰 Market Cap: $${pool.tvl.toLocaleString()}
🔗 [Tx link](https://solscan.io/tx/${burn.transaction.signature})
      `;

      await bot.sendMessage(CHANNEL_ID, message, { parse_mode: "Markdown" });
      console.log(`[Bot] 🚀 Új LP burn: ${pool.name}`);
    }
  }
}

// Bot indítás
async function startBot() {
  console.log("[Bot] 🚀 LP Burn Bot indul...");
  await fetchRaydiumPools();
  setInterval(checkForLpBurns, CHECK_INTERVAL);
}

startBot();
