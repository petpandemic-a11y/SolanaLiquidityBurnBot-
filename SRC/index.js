import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import WebSocket from "ws";
import fetch from "node-fetch";

dotenv.config();

// ---- Environment változók ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN || !CHANNEL_ID || !HELIUS_API_KEY) {
  console.error("❌ Hiányzik egy vagy több environment változó!");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ---- Solana burn címek ----
const BURN_ADDRESSES = [
  "11111111111111111111111111111111",
  "1nc1nerator11111111111111111111111111111",
  "BurnXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX11111"
];

// ---- Helius WebSocket URL ----
const HELIUS_WS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const ws = new WebSocket(HELIUS_WS);

// LP tokenek mint-jeinek lekérése Raydiumtól
let lpTokens = [];

async function fetchLPTokens() {
  try {
    const res = await fetch("https://api.raydium.io/v2/sdk/liquidity/mainnet.json");
    const pools = await res.json();

    lpTokens = Object.values(pools).map((pool) => pool.lpMint);
    console.log(`✅ ${lpTokens.length} LP token mint beállítva Raydiumról`);
  } catch (err) {
    console.error("❌ LP token lista letöltési hiba:", err);
  }
}

// Feliratkozás WebSocketre
ws.on("open", async () => {
  console.log("🔗 Kapcsolódva a Helius WebSockethez!");
  await fetchLPTokens();

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "lp-burn-tracker",
      method: "transactionSubscribe",
      params: [{ commitment: "confirmed" }]
    })
  );
});

// Tranzakciók figyelése
ws.on("message", async (msg) => {
  try {
    const data = JSON.parse(msg);
    const tx = data?.params?.result;
    if (!tx) return;

    const instructions = tx.transaction.message.instructions || [];
    for (const ix of instructions) {
      if (ix.program !== "spl-token") continue;

      const info = ix.parsed?.info;
      if (!info) continue;

      const { destination, amount, mint } = info;

      // Csak LP tokenek figyelése
      if (!lpTokens.includes(mint)) continue;

      // Csak burn címekre menő utalások
      if (BURN_ADDRESSES.includes(destination)) {
        // Lekérdezzük a jelenlegi LP token supply-t
        const supplyRes = await fetch(`https://api.mainnet-beta.solana.com`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTokenSupply",
            params: [mint]
          })
        });

        const supplyData = await supplyRes.json();
        const remainingSupply = Number(supplyData.result.value.amount);

        // Csak akkor küldünk értesítést, ha teljes burn történt
        if (remainingSupply === 0) {
          const message = `
🔥 **100% LP BURN ESEMÉNY** 🔥

🌐 LP Mint: \`${mint}\`
💧 Elégetett mennyiség: ${amount}
🪦 Burn cím: \`${destination}\`
🔗 [Tranzakció](https://solscan.io/tx/${tx.signature})
          `;

          await bot.sendMessage(CHANNEL_ID, message, { parse_mode: "Markdown" });
          console.log("✅ LP burn értesítés elküldve!");
        }
      }
    }
  } catch (err) {
    console.error("❌ Hiba a tranzakció feldolgozásakor:", err);
  }
});

ws.on("error", (err) => {
  console.error("❌ Helius WebSocket hiba:", err);
});

ws.on("close", () => {
  console.log("⚠️ WebSocket kapcsolat bontva. Újracsatlakozás 5 mp múlva...");
  setTimeout(() => ws.connect(HELIUS_WS), 5000);
});
