import express from "express";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();
const app = express();
const port = process.env.PORT || 10000;

// Telegram bot inicializálás
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

// Bejövő JSON feldolgozása
app.use(express.json());

// Teszt endpoint
app.get("/", (req, res) => {
  res.send("✅ Solana LP Burn Bot él!");
});

// Webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    console.log("=== ÚJ WEBHOOK ÉRKEZETT ===");
    console.log(JSON.stringify(req.body, null, 2)); // teljes Helius payload logolása

    const events = req.body?.events || [];
    if (!events.length) {
      console.log("⚠️ Nincsenek események ebben a webhookban.");
      return res.status(200).send("OK");
    }

    for (const event of events) {
      const tx = event.signature || "Ismeretlen";
      const token = event.tokenTransfers?.[0]?.mint || "Ismeretlen token";
      const amount = event.tokenTransfers?.[0]?.amount || "Ismeretlen mennyiség";

      // Ellenőrzés: csak LP burn címekre figyelünk
      const toAddr = event.tokenTransfers?.[0]?.toUserAccount || "";
      const burnAddresses = [
        "11111111111111111111111111111111",
        "Burn1111111111111111111111111111111111111",
        "DEAD111111111111111111111111111111111111"
      ];

      if (burnAddresses.includes(toAddr)) {
        const msg = `🔥 **LP BURN ÉSZLELVE** 🔥\n\n` +
                    `🔹 Token: ${token}\n` +
                    `🔹 Összeg: ${amount}\n` +
                    `🔹 Tx: https://solscan.io/tx/${tx}`;

        console.log("📤 Telegram üzenet:", msg);
        await bot.sendMessage(process.env.CHANNEL_ID, msg, { parse_mode: "Markdown" });
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Webhook feldolgozási hiba:", error);
    res.status(500).send("Hiba");
  }
});

// Indítás
app.listen(port, () => {
  console.log(`🚀 Webhook szerver fut a ${port}-es porton`);
});
