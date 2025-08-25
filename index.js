import express from "express";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: false });

// webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;
    console.log("📩 Webhook event érkezett:", JSON.stringify(data, null, 2));

    if (!data || !data[0]?.events?.token) {
      return res.status(200).send("OK");
    }

    for (const event of data[0].events.token) {
      if (event.tokenAmount === "0" && event.tokenStandard === "Fungible") {
        const mint = event.mint || "Ismeretlen";
        const msg = `🔥 ÚJ LP BURN!\nToken: ${mint}\nTx: ${data[0].signature}`;
        console.log(msg);

        await bot.sendMessage(TG_CHAT_ID, msg);
      }
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Feldolgozási hiba:", err);
    res.status(500).send("ERROR");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server fut a porton: ${PORT}`);
});
