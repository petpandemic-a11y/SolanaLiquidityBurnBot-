import axios from "axios";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// API URL-ek
const RAYDIUM_API = "https://api.raydium.io/v2/main/pairs";
const JUPITER_API = "https://quote-api.jup.ag/v6/pools";
const BIRDEYE_API = "https://public-api.birdeye.so/defi/tokenlist?chain=solana";

// Egyszerű log segédfüggvény
function log(title, message) {
  console.log(`\x1b[36m[${title}]\x1b[0m ${message}`);
}

// Raydium poolok lekérése
async function fetchRaydiumPools() {
  try {
    log("Raydium", "Lekérdezés indul...");
    const res = await axios.get(RAYDIUM_API, { timeout: 15000 });
    const pools = Object.values(res.data);

    log("Raydium", `Siker ✅ ${pools.length} pool érkezett`);
    console.log(pools.slice(0, 3).map(p => ({
      name: p.name,
      lpMint: p.lpMintAddress
    })));

    return pools.map(p => p.lpMintAddress);
  } catch (err) {
    log("Raydium", `Hiba ❌ ${err.code || err.message}`);
    return [];
  }
}

// Jupiter poolok lekérése
async function fetchJupiterPools() {
  try {
    log("Jupiter", "Lekérdezés indul...");
    const res = await axios.get(JUPITER_API, { timeout: 15000 });
    const pools = res.data || [];

    log("Jupiter", `Siker ✅ ${pools.length} pool érkezett`);
    console.log(pools.slice(0, 3));

    return pools.map(p => p.lpMintAddress).filter(Boolean);
  } catch (err) {
    log("Jupiter", `Hiba ❌ ${err.code || err.message}`);
    return [];
  }
}

// Birdeye fallback LP lista
async function fetchBirdeyePools() {
  if (!BIRDEYE_API_KEY) {
    log("Birdeye", "❌ API kulcs hiányzik — kihagyva");
    return [];
  }

  try {
    log("Birdeye", "Fallback lekérdezés indul...");
    const res = await axios.get(BIRDEYE_API, {
      headers: { "X-API-KEY": BIRDEYE_API_KEY },
      timeout: 20000
    });

    const pools = res.data?.data?.tokens || [];
    log("Birdeye", `Siker ✅ ${pools.length} token érkezett`);
    console.log(pools.slice(0, 3));

    return pools.map(p => p.address);
  } catch (err) {
    log("Birdeye", `Hiba ❌ ${err.code || err.message}`);
    return [];
  }
}

// Poolok összegyűjtése minden forrásból
async function fetchAllPools() {
  const raydiumPools = await fetchRaydiumPools();
  const jupiterPools = await fetchJupiterPools();
  const birdeyePools = await fetchBirdeyePools();

  const allPools = [...new Set([...raydiumPools, ...jupiterPools, ...birdeyePools])];

  log("Összesítés", `Összesen ${allPools.length} pool figyelve`);
  return allPools;
}

// LP burn események ellenőrzése Bitquery-n
async function checkLpBurnEvents(poolAddresses) {
  if (!BITQUERY_API_KEY) {
    log("Bitquery", "❌ API kulcs hiányzik!");
    return [];
  }

  const query = `
    query MyQuery {
      solana {
        transfers(
          options: {limit: 10, desc: "block.timestamp.time"}
          where: {
            amount: {_eq: "0"},
            currency: {mintAddress: {_in: ${JSON.stringify(poolAddresses)}}}
          }
        ) {
          block {
            timestamp {
              time
            }
          }
          currency {
            symbol
            mintAddress
          }
          amount
        }
      }
    }`;

  try {
    const res = await axios.post(
      "https://graphql.bitquery.io",
      { query },
      { headers: { "X-API-KEY": BITQUERY_API_KEY }, timeout: 20000 }
    );

    return res.data?.data?.solana?.transfers || [];
  } catch (err) {
    log("Bitquery", `Hiba ❌ ${err.code || err.message}`);
    return [];
  }
}

// Bot indítása
async function startBot() {
  log("Bot", "🚀 LP Burn Bot indul...");
  const poolAddresses = await fetchAllPools();

  log("Bot", "🔄 LP burn események ellenőrzése...");
  const burns = await checkLpBurnEvents(poolAddresses);

  if (burns.length === 0) {
    log("Bot", "ℹ️ Nincs új LP burn esemény.");
    return;
  }

  for (const burn of burns) {
    const msg = `🔥 Új LP burn esemény!
💧 Token: ${burn.currency.symbol}
📜 Cím: ${burn.currency.mintAddress}
⏱ Idő: ${burn.block.timestamp.time}`;

    await bot.sendMessage(CHANNEL_ID, msg);
    log("Bot", `Üzenet elküldve: ${burn.currency.symbol}`);
  }
}

startBot();
