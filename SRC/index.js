import WebSocket from "ws";
import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const channelId = process.env.CHANNEL_ID;
const heliusApiKey = process.env.HELIUS_API_KEY;

// Solana burn címek
const BURN_ADDRESSES = [
  "11111111111111111111111111111111",
  "Burn111111111111111111111111111111111111111",
  "So11111111111111111111111111111111111111112"
];

// WebSocket kapcsolat a Helius RPC-vel
const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
const ws = new WebSocket(wsUrl);

ws.on("open", () => {
  console.log("🌐 Kapcsolódva a Helius WebSockethez!");

  // LP token transfer figyelés
  const message = {
    jsonrpc: "2.0",
    id: "1",
    method: "transactionSubscribe",
    params: [
      {
        accountInclude: [], // minden LP pool
        includeEvents: true,
        commitment: "confirmed"
      }
    ]
  };

  ws.send(JSON.stringify(message));
});

ws.on("message", async (data) => {
  try {
    const parsed = JSON.parse(data);
    const tx = parsed?.params?.result?.transaction;

    if (!tx || !tx.meta) return;

    const instructions = tx.transaction.message.instructions || [];
    for (const ix of instructions) {
      // SPL Token Transfer ellenőrzése
      if (ix.programId && ix.programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
        const destination = ix.parsed?.info?.destination;
        const amount = ix.parsed?.info?.amount;

        if (destination && BURN_ADDRESSES.includes(destination)) {
          // Telegram értesítés
          await bot.sendMessage(
            channelId,
            `🔥 **LP BURN ÉSZLELVE** 🔥\n\n` +
            `🔹 TX: https://solscan.io/tx/${parsed.params.result.signature}\n` +
            `💧 Elégetett mennyiség: ${amount}\n` +
            `📍 Cím: \`${destination}\``
          );

          console.log(`🔥 LP burn: ${amount} token -> ${destination}`);
        }
      }
    }
  } catch (err) {
    console.error("❌ Hiba a WebSocket üzenet feldolgozásakor:", err);
  }
});

ws.on("close", () => {
  console.log("⚠️ Helius WebSocket kapcsolat bontva. Újracsatlakozás 5s...");
  setTimeout(() => ws.connect(), 5000);
});

ws.on("error", (err) => {
  console.error("❌ WebSocket hiba:", err);
});
