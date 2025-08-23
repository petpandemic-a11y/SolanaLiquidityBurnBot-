import { Telegraf } from "telegraf";
import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();

// Telegram bot inicializálás
const bot = new Telegraf(process.env.BOT_TOKEN);
const channelId = process.env.CHANNEL_ID;

// Burn címek
const BURN_ADDRESSES = [
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111"
];

// Helius WebSocket URL
const HELIUS_WS = `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

// WebSocket kapcsolat indítása
const ws = new WebSocket(HELIUS_WS);

ws.on("open", () => {
  console.log("🔗 Kapcsolódva a Helius WebSocket-hez!");

  // LP token mozgások figyelése
  const subscription = {
    jsonrpc: "2.0",
    id: 1,
    method: "transactionSubscribe",
    params: [
      {
        accountInclude: BURN_ADDRESSES,
      },
      { commitment: "confirmed" }
    ]
  };

  ws.send(JSON.stringify(subscription));
});

// Üzenet érkezésekor
ws.on("message", async (data) => {
  const msg = JSON.parse(data);

  if (msg.params?.result) {
    const tx = msg.params.result;
    const accounts = tx.transaction.message.accountKeys;

    // Ha LP token ment burn címre
    if (BURN_ADDRESSES.includes(accounts[1])) {
      const signature = tx.transaction.signatures[0];
      const amount = tx.meta?.postTokenBalances?.[0]?.uiTokenAmount?.uiAmountString || "Ismeretlen";

      const message = `🔥 **Új LP Burn észlelve!**\n\n` +
        `💰 Elégetett mennyiség: ${amount}\n` +
        `📜 Tranzakció: https://solscan.io/tx/${signature}`;

      console.log(message);
      await bot.telegram.sendMessage(channelId, message, { parse_mode: "Markdown" });
    }
  }
});

ws.on("error", (err) => {
  console.error("❌ WebSocket hiba:", err);
});

bot.launch();
