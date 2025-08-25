import express from "express";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import "dotenv/config.js";

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

// Token metadata lekérése
async function getTokenName(mint) {
  try {
    const url = `https://api.helius.xyz/v0/token-metadata?api-key=${process.env.HELIUS_KEY}&mint=${mint}`;
    const res = await axios.get(url);
    return res.data?.onChainMetadata?.metadata?.name || "Ismeretlen";
  } catch {
    return "Ismeretlen";
  }
}

// Webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body;

    for (const evt of events) {
      // Csak akkor dolgozzuk fel, ha a program a SPL Token program
      for (const inst of evt.instructions || []) {
        if (
          inst.programId ===
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        ) {
          if (inst.data?.startsWith("burn")) {
            const tokenMint = inst.accounts?.[0];
            const tokenName = await getTokenName(tokenMint);

            const msg = `🔥 Új LP burn!\nToken: ${tokenName}\nMint: ${tokenMint}`;
            console.log(msg);
            await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, msg);
          }
        }
      }
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook feldolgozási hiba:", err.message);
    res.status(500).send("error");
  }
});

// Render port figyelés
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 LP burn watcher fut a ${PORT} porton...`);
});
