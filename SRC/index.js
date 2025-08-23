import axios from "axios";
import chalk from "chalk";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

// === TELEGRAM BOT ===
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;

// === API VÉGPONTOK ===
const RAYDIUM_API = "https://api.raydium.io/v2/sdk/liquidity/mainnet.json";
const ORCA_API = "https://api.orca.so/allPools";
const JUPITER_API = "https://quote-api.jup.ag/v6/tokens";
const BITQUERY_API = "https://graphql.bitquery.io";

// === KULCSOK ===
const BITQUERY_KEY = process.env.BITQUERY_API_KEY;

// === KONFIG ===
const CHECK_INTERVAL = 10_000; // 10 másodperc
let lastBurns = new Set();

// === SEGÉDFÜGGVÉNY: Debug log ===
const log = (msg, type = "info") => {
  const colors = { info: chalk.blue, success: chalk.green, error: chalk.red, warn: chalk.yellow };
  console.log(colors[type](`[Bot] ${msg}`));
};

// === POOL LISTA LEKÉRÉSE (Raydium + fallback) ===
async function getLiquidityPools() {
  try {
    log("Raydium poolok lekérése...", "info");
    const { data } = await axios.get(RAYDIUM_API, { timeout: 10000 });

    if (data && data.official) {
      const pools = Object.values(data.official);
      log(`✅ Raydium poolok: ${pools.length}`, "success");
      return pools;
    } else {
      log("⚠️ Raydium nem adott adatot, Orca fallback...", "warn");
      return getOrcaPools();
    }
  } catch {
    log("❌ Raydium API hiba, Orca fallback indul...", "error");
    return getOrcaPools();
  }
}

// === ORCA POOL FALLBACK ===
async function getOrcaPools() {
  try {
    const { data } = await axios.get(ORCA_API, { timeout: 10000 });
    const pools = Object.values(data);
    log(`✅ Orca poolok: ${pools.length}`, "success");
    return pools;
  } catch {
    log("❌ Orca API hiba, Jupiter fallback indul...", "error");
    return getJupiterPools();
  }
}

// === JUPITER POOL FALLBACK ===
async function getJupiterPools() {
  try {
    const { data } = await axios.get(JUPITER_API, { timeout: 10000 });
    log(`✅ Jupiter tokenek: ${data.length}`, "success");
    return data;
  } catch {
    log("❌ Jupiter API sem elérhető.", "error");
    return [];
  }
}

// === BITQUERY LP BURN ELLENŐRZÉS ===
async function checkLpBurn(contract) {
  try {
    const query = {
      query: `
        query {
          solana {
            transfers(
              options: {limit: 1, desc: "block.timestamp.time"}
              where: {
                transferType: {is: burn}
                currency: {is: "${contract}"}
              }
            ) {
              amount
              block { timestamp { time } }
            }
          }
        }`,
    };

    const res = await axios.post(BITQUERY_API, query, {
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": BITQUERY_KEY,
      },
    });

    return res.data?.data?.solana?.transfers?.length > 0;
  } catch {
    return false;
  }
}

// === LP BURN KERESÉS ===
async function getBurnEvents(pools) {
  const burns = [];

  for (const pool of pools) {
    const lpMint = pool.lpMint || pool.lp_mint || pool.mint || null;
    if (!lpMint) continue;

    const lpSupply = Number(pool.lpSupply || pool.lp_supply || 0);

    // Ha az LP supply nulla → Bitquery-vel ellenőrizzük
    if (lpSupply === 0 && !lastBurns.has(lpMint)) {
      const isBurned = await checkLpBurn(lpMint);
      if (isBurned) {
        burns.push(pool);
        lastBurns.add(lpMint);
      }
    }
  }
  return burns;
}

// === TELEGRAM ÜZENET ===
async function sendTelegramMessage(pool) {
  const msg = `
🔥 *LP Burn esemény* 🔥
💎 Token: ${pool.name || "Ismeretlen"}
📜 Contract: \`${pool.lpMint}\`
💰 MarketCap: ${pool.price ? `$${pool.price}` : "N/A"}
🌊 Likviditás: ${pool.liquidity || "N/A"}
`;

  try {
    await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
    log(`📢 Telegram üzenet küldve: ${pool.name || pool.lpMint}`, "success");
  } catch (err) {
    log(`❌ Telegram API hiba: ${err.message}`, "error");
  }
}

// === FŐ ELLENŐRZŐ FOLYAMAT ===
async function checkBurns() {
  log("🔄 LP burn ellenőrzés indul...", "info");

  const pools = await getLiquidityPools();
  if (!pools || pools.length === 0) {
    log("⚠️ Nem sikerült pool adatot lekérni!", "warn");
    return;
  }

  const burns = await getBurnEvents(pools);

  if (burns.length > 0) {
    log(`🔥 ${burns.length} új LP burn esemény találat!`, "success");
    for (const burn of burns) {
      await sendTelegramMessage(burn);
    }
  } else {
    log("ℹ️ Nincs új LP burn esemény.", "info");
  }
}

// === BOT INDÍTÁSA ===
log("🚀 LP Burn Bot indul...", "info");
setInterval(checkBurns, CHECK_INTERVAL);
