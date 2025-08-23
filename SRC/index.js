import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config();

// === Telegram beállítások ===
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;

// === API URL-ek ===
const RAYDIUM_API = "https://api-v3.raydium.io/pools";
const JUPITER_API = "https://quote-api.jup.ag/v6/tokens";
const BITQUERY_API = "https://graphql.bitquery.io";

// === Környezeti változók ===
const BITQUERY_KEY = process.env.BITQUERY_API_KEY;

// === Debug log ===
const log = (msg, type = "info") => {
    const colors = {
        info: chalk.blue,
        success: chalk.green,
        error: chalk.red,
        warn: chalk.yellow,
    };
    console.log(colors[type](`[Bot] ${msg}`));
};

// === LP poolok tárolása ===
let watchedPools = new Map();

// === LP poolok frissítése Raydium API-ról ===
async function updatePools() {
    try {
        log("LP poolok frissítése indul...", "info");
        const res = await axios.get(RAYDIUM_API, { timeout: 10000 });
        if (!res.data || !res.data.data) throw new Error("Raydium üres adat");

        watchedPools.clear();

        res.data.data.slice(0, 50).forEach(pool => {
            watchedPools.set(pool.id, {
                name: pool.name,
                baseMint: pool.baseMint,
                lpSupply: pool.lpSupply,
                liquidity: pool.liquidity,
                price: pool.price,
            });
        });

        log(`✅ LP pool lista frissítve: ${watchedPools.size} pool figyelve.`, "success");
    } catch (err) {
        log(`Raydium API hiba: ${err.message}`, "error");
        await fallbackWithJupiter();
    }
}

// === Jupiter API fallback ===
async function fallbackWithJupiter() {
    try {
        log("Jupiter fallback indul...", "warn");
        const res = await axios.get(JUPITER_API, { timeout: 10000 });
        if (!res.data) throw new Error("Jupiter üres adat");

        res.data.slice(0, 20).forEach(token => {
            watchedPools.set(token.address, {
                name: token.name,
                baseMint: token.address,
                price: token.price || "N/A",
                liquidity: token.liquidity || "N/A",
            });
        });

        log(`✅ Jupiter fallback sikeres, ${watchedPools.size} pool figyelve.`, "success");
    } catch (err) {
        log(`❌ Jupiter API hiba: ${err.message}`, "error");
    }
}

// === Bitquery fallback LP burn ellenőrzés ===
async function checkBurnFromBitquery(contract) {
    try {
        const query = {
            query: `
            query MyQuery {
              solana {
                transfers(
                  where: {
                    transferType: {is: burn}
                    currency: {is: "${contract}"}
                  }
                ) {
                  amount
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

// === LP burn események ellenőrzése ===
async function checkBurns() {
    log("🔄 Ellenőrzés indul...", "info");

    for (const [poolId, pool] of watchedPools.entries()) {
        if (parseFloat(pool.lpSupply) === 0) {
            const isBurned = await checkBurnFromBitquery(pool.baseMint);

            if (isBurned) {
                const msg = `
🔥 *LP Burn esemény!* 🔥
💎 Token: ${pool.name}
📜 Contract: \`${pool.baseMint}\`
💰 MarketCap: ${pool.price ? `$${pool.price}` : "N/A"}
🌊 Likviditás: ${pool.liquidity || "N/A"}
`;
                await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
                log(`🔥 LP burn észlelve: ${pool.name}`, "success");
            }
        }
    }
}

// === Bot indítása ===
async function startBot() {
    log("🚀 LP Burn Bot indul...", "info");
    await updatePools();
    setInterval(checkBurns, 10_000);
}

startBot();
