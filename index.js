import express from "express";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Környezetváltozók ----
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const HELIUS_WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET;

// LP pool program ID-k (Raydium, Orca, Jupiter)
const LP_PROGRAMS = [
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium
    "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", // Orca
    "2ZnVuidTHpi5WWKUwFXauYGhvdT9jRKYv5MDahtbwtYr"  // Jupiter
];

// Burn címek → bárki ide küldi, az örökre elvész
const BURN_ADDRESSES = [
    "11111111111111111111111111111111", // Null address
    "1nc1nerator11111111111111111111111111111", // Incinerator
    "Burn111111111111111111111111111111111111111" // Burn address
];

// Telegram bot inicializálása
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Middleware webhookhoz
app.use(express.json({ limit: "5mb" }));

// Health check
app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        mode: "webhook",
        webhook: "/webhook",
        burnAddresses: BURN_ADDRESSES.length,
        lpPrograms: LP_PROGRAMS.length,
        telegram: ALERT_CHAT_ID,
        timestamp: new Date().toISOString(),
    });
});

// ---- Helius webhook endpoint ----
app.post("/webhook", async (req, res) => {
    try {
        const event = req.body;

        // Titkos kulcs ellenőrzése
        const signature = req.headers["x-helius-signature"];
        if (!signature || signature !== HELIUS_WEBHOOK_SECRET) {
            console.log("❌ Helius webhook signature mismatch");
            return res.status(403).send("Forbidden");
        }

        if (!event || !event[0]?.transactions) {
            return res.status(200).send("OK");
        }

        for (const tx of event[0].transactions) {
            const sig = tx.signature;
            const instructions = tx.transaction.message.instructions || [];
            const accounts = tx.transaction.message.accountKeys || [];

            // Ellenőrizzük, hogy LP pool programból jött-e
            const isFromLpProgram = accounts.some(a => LP_PROGRAMS.includes(a));
            if (!isFromLpProgram) continue;

            // Ellenőrizzük, hogy burn címre ment-e
            const burnTransfers = tx.tokenTransfers?.filter(t => 
                BURN_ADDRESSES.includes(t.toUserAccount)
            ) || [];

            if (burnTransfers.length === 0) continue;

            // Ha van token burn → megnézzük, hogy 100% LP ment-e el
            for (const burn of burnTransfers) {
                const preBalance = burn.tokenAmount.preAmount || 0;
                const postBalance = burn.tokenAmount.postAmount || 0;

                if (Number(postBalance) === 0 && Number(preBalance) > 0) {
                    console.log(`🔥 100% LP burn detected! Tx: ${sig}`);

                    const message = `🔥 **100% LP BURN ÉSZLELVE!** 🔥

💰 **Token:** ${burn.mint || "Ismeretlen"}
🔥 **Égetett mennyiség:** ${Number(preBalance).toLocaleString()}
🏦 **Pool program:** ${accounts.find(a => LP_PROGRAMS.includes(a)) || "Ismeretlen"}
📌 **Burn cím:** \`${burn.toUserAccount}\`
⏰ **Időpont:** ${new Date().toLocaleString("hu-HU")}
🔗 [Solscan link](https://solscan.io/tx/${sig})

#LPBurn #Solana #DeFi`;

                    await bot.sendMessage(ALERT_CHAT_ID, message, { parse_mode: "Markdown" });
                }
            }
        }

        return res.status(200).send("OK");
    } catch (error) {
        console.error("❌ Webhook error:", error.message);
        return res.status(500).send("Webhook Error");
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`🔔 Webhook URL: https://YOUR-RENDER-URL/webhook`);
});
