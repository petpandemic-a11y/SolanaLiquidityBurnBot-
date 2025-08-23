import axios from "axios";
import dotenv from "dotenv";
import { Telegraf } from "telegraf";

dotenv.config();

// --- ENV változók ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error("[Bot] ❌ BOT_TOKEN vagy CHANNEL_ID hiányzik a .env fájlból!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// --- API végpontok ---
const RAYDIUM_API = "https://api.raydium.io/v2/sdk/liquidity/mainnet.json";
const JUPITER_API = "https://quote-api.jup.ag/v6/tokens";

// --- Időzítés ---
const CHECK_INTERVAL = 15000; // 15 másodpercenként ellenőrzés

let pools = [];
let lastBurns = new Set();

// --- LP poolok betöltése Raydiumról ---
async function loadPools() {
  try {
    console.log("[Bot] 🌊 Raydium poolok lekérése...");
    const res = await axios.get(RAYDIUM_API, { timeout: 15000 });

    if (!res.data) throw new Error("Üres Raydium API válasz");

    pools = Object.values(res.data.official ?? {}).concat(Object.values(res.data.unOfficial ?? {}));

    console.log(`[Bot] ✅ Raydium poolok betöltve: ${pools.length} pool.`);
  } catch (err) {
    console.error("[Bot] ❌ Raydium API hiba:", err.message);
    console.log("[Bot] 🌐 Jupiter fallback indul...");
    await loadPoolsFromJupiter();
  }
}

// --- LP poolok betöltése Jupiter fallbackból ---
async function loadPoolsFromJupiter() {
  try {
    console.log("[Bot] 🌐 Jupiter poolok lekérése...");
    const res = await axios.get(JUPITER_API, { timeout: 15000 });

    if (!res.data) throw new Error("Üres Jupiter API válasz");

    pools = res.data;
    console.log(`[Bot] ✅ Jupiter poolok betöltve: ${pools.length} pool.`);
  } catch (err) {
    console.error("[Bot] ❌ Jupiter API hiba:", err.message);
    console.log("[Bot] ⚠️ Nem sikerült frissíteni a pool listát.");
  }
}

// --- LP burn események ellenőrzése ---
async function checkLpBurns() {
  console.log("[Bot] 🔄 Ellenőrzés indul...");

  try {
    const burnEvents = pools.filter(pool => {
      // Teszt logika: szűrjük azokat a poolokat, ahol 0 a likviditás
      return pool.baseReserve === "0" || pool.quoteReserve === "0";
    });

    if (burnEvents.length === 0) {
      console.log("[Bot] ℹ️ Nincs új LP burn esemény.");
      return;
    }

    for (const event of burnEvents) {
      if (lastBurns.has(event.id)) continue;
      lastBurns.add(event.id);

      const message = `
🔥 **Új LP Burn esemény!**
📌 Pool: ${event.name || "Ismeretlen"}
💧 Token A: ${event.baseMint || "-"}
💧 Token B: ${event.quoteMint || "-"}
`;

      await bot.telegram.sendMessage(CHANNEL_ID, message, { parse_mode: "Markdown" });
      console.log("[Bot] 📢 Új LP burn esemény küldve:", event.name);
    }
  } catch (err) {
    console.error("[Bot] ❌ Hibás LP burn ellenőrzés:", err.message);
  }
}

// --- Bot indítása ---
(async () => {
  console.log("[Bot] 🚀 LP Burn Bot indul...");

  await loadPools();

  setInterval(async () => {
    if (pools.length === 0) {
      await loadPools();
    }
    await checkLpBurns();
  }, CHECK_INTERVAL);
})();
