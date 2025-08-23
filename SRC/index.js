import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const app = express();
app.use(bodyParser.json());

const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.CHANNEL_ID;
const HELIUS_RPC = process.env.HELIUS_RPC_URL;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;
    if (!data || !data[0]) return res.sendStatus(200);

    const tx = data[0];
    if (tx.type !== "BURN") return res.sendStatus(200);

    const tokenMint = tx.tokenTransfers?.[0]?.mint;
    const amountBurned = tx.tokenTransfers?.[0]?.tokenAmount || 0;
    const owner = tx.tokenTransfers?.[0]?.fromUserAccount;

    // Lekérdezzük az aktuális LP egyenleget
    const balanceResponse = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenSupply",
        params: [tokenMint]
      }),
    });

    const balanceData = await balanceResponse.json();
    const remaining = balanceData?.result?.value?.uiAmount || 0;

    // Csak akkor posztolunk, ha a teljes LP elégett
    if (remaining === 0) {
      const msg = `🔥 **LP BURN ÉSZLELVE** 🔥
      
Token: \`${tokenMint}\`
Elégetett mennyiség: ${amountBurned}
Burn cím: ${owner}
Tx: https://solscan.io/tx/${tx.signature}`;

      await bot.sendMessage(TELEGRAM_CHANNEL_ID, msg, { parse_mode: "Markdown" });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook hiba:", err);
    res.sendStatus(500);
  }
});

app.listen(10000, () => {
  console.log("🚀 Webhook szerver fut a 10000-es porton");
});
