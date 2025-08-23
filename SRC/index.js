import axios from "axios";
import dotenv from "dotenv";
import { Telegraf } from "telegraf";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const bot = new Telegraf(BOT_TOKEN);

const RAYDIUM_API = "https://api-v3.raydium.io/pools";
const JUPITER_API = "https://price.jup.ag/v6/pools";

// Ellenőrzési intervallum (ms)
const CHECK_INTERVAL = 20000;

// Hibakezelés: Telegramra is megy az üzenet
async function notify(message) {
    console.log(`[Bot] ${message}`);
    try {
        await bot.telegram.sendMessage(CHANNEL_ID, message);
    } catch (err) {
        console.error("[Bot] Telegram küldési hiba:", err.message);
    }
}

// LP poolok lekérése Raydium / Jupiter API-ról
async function fetchPools() {
    try {
        console.log("[Bot] 🌊 Raydium poolok lekérése...");
        const response = await axios.get(RAYDIUM_API);
        if (response.data?.data?.length) {
            console.log(`[Bot] ✅ Raydium API OK: ${response.data.data.length} pool`);
            return response.data.data;
        } else {
            throw new Error("Üres Raydium API válasz");
        }
    } catch (err) {
        console.log("[Bot] ⚠️ Raydium API hiba:", err.message);
        console.log("[Bot] 🌐 Jupiter fallback indul...");

        try {
            const jupiterRes = await axios.get(JUPITER_API);
            console.log(`[Bot] ✅ Jupiter API OK: ${jupiterRes.data.length} pool`);
            return jupiterRes.data;
        } catch (jupErr) {
            console.error("[Bot] ❌ Jupiter API hiba:", jupErr.message);
            await notify("⚠️ Nem elérhető sem a Raydium, sem a Jupiter API!");
            return [];
        }
    }
}

// LP burn események figyelése
async function checkBurnEvents() {
    try {
        const pools = await fetchPools();

        if (!pools.length) {
            console.log("[Bot] ❌ Nincs elérhető pool adat!");
            return;
        }

        // Keresés LP burn eseményekre
        const burns = pools.filter(pool => pool.name?.toLowerCase().includes("burn"));
        if (burns.length) {
            for (const burn of burns) {
                await notify(`🔥 LP burn esemény: ${burn.name} | Pool ID: ${burn.id || burn.address}`);
            }
        } else {
            console.log("[Bot] ℹ️ Nincs új LP burn esemény.");
        }
    } catch (err) {
        console.error("[Bot] Ellenőrzési hiba:", err.message);
    }
}

// Indítás
(async () => {
    console.clear();
    console.log("🚀 LP Burn Bot indul...");
    await notify("🚀 LP Burn Bot elindult és figyeli az LP burn eseményeket!");

    // Ismételt ellenőrzés
    setInterval(async () => {
        console.log("[Bot] 🔄 Ellenőrzés indul...");
        await checkBurnEvents();
    }, CHECK_INTERVAL);
})();
