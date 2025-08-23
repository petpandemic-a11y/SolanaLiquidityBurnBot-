import axios from "axios";
import dotenv from "dotenv";
import { Telegraf } from "telegraf";

dotenv.config();

// Telegram bot init
const bot = new Telegraf(process.env.BOT_TOKEN);
const channelId = process.env.CHANNEL_ID;

// Bitquery GraphQL API endpoint
const BITQUERY_URL = "https://graphql.bitquery.io";

// LP burn események lekérdezése
async function getBurnEvents() {
  const query = `
    query GetSolanaBurns {
      solana(network: solana) {
        transfers(
          options: {desc: "block.timestamp.time", limit: 5}
          date: {since: "2025-08-01"}
          transferType: burn
        ) {
          block {
            timestamp {
              time(format: "%Y-%m-%d %H:%M:%S")
            }
          }
          amount
          currency {
            symbol
            address
          }
          sender {
            address
          }
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      BITQUERY_URL,
      { query },
      {
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": process.env.BITQUERY_API_KEY
        }
      }
    );

    const burns = response.data?.data?.solana?.transfers || [];
    return burns;
  } catch (error) {
    console.error("[Bot] ❌ Bitquery API hiba:", error.response?.status || error.message);
    return [];
  }
}

// Telegram értesítés küldése
async function sendTelegramMessage(message) {
  try {
    await bot.telegram.sendMessage(channelId, message, { parse_mode: "HTML" });
  } catch (error) {
    console.error("[Bot] ❌ Telegram küldési hiba:", error.message);
  }
}

// Folyamatos ellenőrzés
async function checkBurns() {
  console.log("[Bot] 🔄 Ellenőrzés indul...");
  const burns = await getBurnEvents();

  if (burns.length === 0) {
    console.log("[Bot] ℹ️ Nincs új LP burn esemény.");
    return;
  }

  for (const burn of burns) {
    const msg = `
🔥 <b>Új LP Burn esemény!</b>
💰 Token: <b>${burn.currency.symbol}</b>
💎 Összeg: <b>${burn.amount}</b>
🕒 Idő: ${burn.block.timestamp.time}
🔗 Cím: <code>${burn.currency.address}</code>
    `;
    await sendTelegramMessage(msg);
  }
}

// Bot indítása
async function startBot() {
  console.log("[Bot] 🚀 LP Burn Bot elindult, figyeli az eseményeket!");
  await sendTelegramMessage("🚀 LP Burn Bot elindult és figyeli az LP burn eseményeket!");

  // 1 percenként ellenőrzés
  setInterval(checkBurns, 60 * 1000);
}

startBot();
