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

// helper log
function log(level, msg, obj = null) {
  const ts = new Date().toISOString();
  if (obj) {
    console.log(`[${ts}] [${level}] ${msg}`, JSON.stringify(obj, null, 2));
  } else {
    console.log(`[${ts}] [${level}] ${msg}`);
  }
}

// webhook endpoint
app.post("/webhook", async (req, res) => {
  log("INFO", "Webhook hívás érkezett");

  try {
    const data = req.body;
    log("DEBUG", "Nyers webhook payload", data);

    if (!Array.isArray(data) || !data[0]?.events?.token) {
      log("WARN", "Nem volt token event a payloadban");
      return res.status(200).send("OK");
    }

    for (const event of data[0].events.token) {
      log("DEBUG", "Token event feldolgozás", event);

      // LP burn filter
      if (event.tokenAmount === "0" && event.tokenStandard === "Fungible") {
        const mint = event.mint || "Ismeretlen";
        const sig = data[0].signature || "n/a";

        const msg = `🔥 ÚJ LP BURN DETEKTÁLVA\nToken mint: ${mint}\nTx: ${sig}`;
        log("INFO", "LP burn megfelelt a filternek → Telegramra küldés", { mint, sig });

        try {
          await bot.sendMessage(TG_CHAT_ID, msg);
          log("INFO", "Telegram üzenet sikeresen elküldve", { chat: TG_CHAT_ID });
        } catch (tgErr) {
          log("ERROR", "Telegram küldési hiba", tgErr.message);
        }
      } else {
        log("DEBUG", "Token event NEM LP burn, kihagyva");
      }
    }

    res.status(200).send("OK");
  } catch (err) {
    log("ERROR", "Webhook feldolgozási hiba", err.message || err);
    res.status(500).send("ERROR");
  }
});

app.listen(PORT, () => {
  log("INFO", `🚀 Server elindult a porton: ${PORT}`);
});
