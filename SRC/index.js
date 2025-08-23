import express from "express";
import bodyParser from "body-parser";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// Telegram bot inicializálás
const bot = new TelegramBot(process.env.BOT_TOKEN);

// Webhook endpoint a Helius számára
app.post("/webhook", async (req, res) => {
    console.log("📩 Webhook esemény érkezett:", JSON.stringify(req.body, null, 2));

    try {
        const events = req.body;

        if (events && Array.isArray(events)) {
            for (const event of events) {
                if (event.type === "BURN") {
                    const signature = event.signature;
                    const amount = event.amount || "Ismeretlen";
                    const token = event.tokenSymbol || "Ismeretlen token";

                    const message = `🔥 **LP BURN ÉSZLELVE** 🔥\n\nToken: ${token}\nÖsszeg: ${amount}\nTx: https://solscan.io/tx/${signature}`;

                    await bot.sendMessage(process.env.CHANNEL_ID, message, {
                        parse_mode: "Markdown",
                    });
                }
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Hiba a webhook feldolgozásakor:", error);
        res.sendStatus(500);
    }
});

// Render a 10000-es portot használja
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook szerver fut a ${PORT}-es porton`);
});
