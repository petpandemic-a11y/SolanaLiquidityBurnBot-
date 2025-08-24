import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Webhook végpont
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;

    if (data?.events) {
      for (const event of data.events) {
        if (event.type === "BURN") {
          const signature = event.signature;
          const amount = event.amount || "Ismeretlen";
          const token = event.token || "Ismeretlen token";

          await bot.sendMessage(
            CHANNEL_ID,
            `🔥 LP BURN ÉSZLELVE 🔥\n\n` +
              `Token: ${token}\n` +
              `Összeg: ${amount}\n` +
              `Tx: https://solscan.io/tx/${signature}`
          );
        }
      }
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook feldolgozási hiba:", err);
    res.status(500).send("Hiba");
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("🚀 Solana LP-burn bot fut!");
});

// Render által adott port
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Szerver fut a ${PORT} porton`);
});
