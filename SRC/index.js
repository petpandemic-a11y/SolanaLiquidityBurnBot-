import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import WebSocket from "ws";

dotenv.config();

// ---- Környezeti változók ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN || !CHANNEL_ID || !HELIUS_API_KEY) {
  console.error("❌ Hiányzik egy vagy több environment változó!");
  process.exit(1);
}

// ---- Telegram bot inicializálás ----
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ---- Burn címek a Solana hálózaton ----
const BURN_ADDRESSES = [
  "11111111111111111111111111111111", // Null address
  "BurnXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" // Gyakori burn wallet
];

// ---- Helius WebSocket URL ----
const HELIUS_WS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// ---- WebSocket inicializálás ----
const ws = new WebSocket(HELIUS_WS);

ws.on("open", () => {
  console.log("🔗 Kapcsolódva a Helius WebSockethez!");

  // Feliratkozás a tranzakciós streamre
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "lp-burn-tracker",
      method: "transactionSubscribe",
      params: [{ commitment: "confirmed" }]
    })
  );
});

ws.on("message", async (msg) => {
  try {
    const data = JSON.parse(msg);

    if (data?.params?.result) {
      const tx = data.params.result;

      // Token átutalások keresése
      const tokenTransfers = tx.transaction?.message?.instructions
        ?.filter((ix) => ix.program === "spl-token")
        ?.map((ix) => ({
          source: ix.parsed?.info?.source,
          destination: ix.parsed?.info?.destination,
          amount: Number(ix.parsed?.info?.amount)
        }))
        ?.filter(Boolean);

      if (!tokenTransfers?.length) return;

      // Burn tranzakciók szűrése
      for (const transfer of tokenTransfers) {
        if (
          BURN_ADDRESSES.includes(transfer.destination) &&
          transfer.amount > 0
        ) {
          // Értesítés Telegramra
          const message = `
🔥 **LP Burn esemény!**
💧 Token: LP
📤 Elküldött mennyiség: ${transfer.amount}
📜 Tranzakció: https://solscan.io/tx/${tx.signature}
          `;

          await bot.sendMessage(CHANNEL_ID, message, { parse_mode: "Markdown" });
          console.log("✅ LP Burn értesítés elküldve!");
        }
      }
    }
  } catch (err) {
    console.error("❌ Hiba a WebSocket üzenet feldolgozása közben:", err);
  }
});

ws.on("error", (err) => {
  console.error("❌ Helius WebSocket hiba:", err);
});

ws.on("close", () => {
  console.log("⚠️ WebSocket kapcsolat lezárva. Újracsatlakozás 5 mp múlva...");
  setTimeout(() => ws.connect(HELIUS_WS), 5000);
});
