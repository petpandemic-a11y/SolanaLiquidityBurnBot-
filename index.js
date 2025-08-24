import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// Telegram config
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// JSON body feldolgozása
app.use(express.json());

// Webhook endpoint Helius számára
app.post("/webhook", async (req, res) => {
    try {
        const events = req.body;

        if (!Array.isArray(events)) {
            console.log("❌ Hibás webhook payload:", events);
            return res.status(400).send("Invalid payload");
        }

        console.log(`📩 Új webhook érkezett, események száma: ${events.length}`);

        for (const tx of events) {
            // Csak az LP burn típusú tranzakciókat nézzük
            if (tx.type === "BURN") {
                const signature = tx.signature || "Ismeretlen";
                const token = tx.token || "Ismeretlen token";
                const amount = tx.amount || "Ismeretlen összeg";

                const msg = `🔥 LP BURN ÉSZLELVE 🔥\n\n` +
                            `Token: ${token}\n` +
                            `Összeg: ${amount}\n` +
                            `Tx: https://solscan.io/tx/${signature}`;

                console.log(msg);

                // Küldés Telegramra
                await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        chat_id: TELEGRAM_CHAT_ID,
                        text: msg
                    })
                });
            }
        }

        res.status(200).send("OK");
    } catch (error) {
        console.error("❌ Webhook feldolgozási hiba:", error);
        res.status(500).send("Internal error");
    }
});

// Healthcheck endpoint
app.get("/", (req, res) => {
    res.send("✅ Solana LP Burn Bot fut!");
});

app.listen(PORT, () => {
    console.log(`🚀 Szerver elindult a http://localhost:${PORT} címen`);
});
