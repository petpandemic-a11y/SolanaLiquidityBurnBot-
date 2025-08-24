import express from "express";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const app = express();
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

app.use(express.json());

const CHANNEL_ID = process.env.CHANNEL_ID;

// Webhook endpoint - Helius innen küldi a burn eventeket
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body;

    console.log("🔥 ÚJ WEBHOOK ÉRKEZETT:", JSON.stringify(events, null, 2));

    if (!events || !Array.isArray(events)) {
      return res.status(400).send("Nincs érvényes esemény");
    }

    for (const event of events) {
      // Csak LP-burn események érdekelnek
      if (
        event.type === "BURN" ||
        (event.description && event.description.toLowerCase().includes("burn"))
      ) {
        const signature = event.signature || "Ismeretlen";
        const token = event.tokenSymbol || "Ismeretlen token";
        const amount = event.amount || "Ismeretlen összeg";

        const msg = `
🔥 *LP BURN ÉSZLELVE* 🔥

💎 Token: *${token}*
📉 Összeg: *${amount}*
🔗 [Solscan](https://solscan.io/tx/${signature})
        `;

        await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
        console.log("✅ Telegramra küldve:", token, amount);
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Hiba a webhook feldolgozásában:", error);
    res.status(500).send("Hiba");
  }
});

// Render web service port
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook szerver fut a ${PORT}-es porton`);
});
