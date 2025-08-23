import fetch from "node-fetch";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

// --- ENV változók ---
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

// --- Telegram Bot inicializálás ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// --- Bitquery API endpoint ---
const BITQUERY_URL = "https://graphql.bitquery.io";

// --- GraphQL Query ---
const query = `
query MyQuery {
  solana {
    transfers(
      options: {limit: 5, desc: "block.timestamp.iso8601"},
      where: {
        transfer: {currency: {symbol: {is: "SOL"}}},
        transaction: {result: {eq: "SUCCESS"}}
      }
    ) {
      transfer {
        amount
        currency {
          symbol
        }
        sender
        receiver
      }
      transaction {
        signature
        block {
          timestamp {
            iso8601
          }
        }
      }
    }
  }
}
`;

// --- Bitquery Lekérdezés ---
async function fetchBurnEvents() {
  try {
    console.log("🔍 Bitquery lekérdezés indul...");

    const response = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": BITQUERY_API_KEY,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Bitquery API hiba: ${response.status}`);
    }

    const result = await response.json();

    if (result.errors) {
      console.error("❌ Bitquery GraphQL hiba:", result.errors);
      return [];
    }

    return result.data.solana.transfers || [];
  } catch (error) {
    console.error("🔥 Bitquery fetch hiba:", error.message);
    return [];
  }
}

// --- Események feldolgozása és Telegram értesítés ---
async function processEvents() {
  const events = await fetchBurnEvents();

  if (events.length === 0) {
    console.log("ℹ️ Nincs új LP burn esemény.");
    return;
  }

  for (const e of events) {
    const msg = `
🔥 **Új LP Burn esemény!** 🔥

💸 Mennyiség: ${e.transfer.amount} ${e.transfer.currency.symbol}
📤 Küldő: ${e.transfer.sender}
📥 Fogadó: ${e.transfer.receiver}
🕒 Időpont: ${e.transaction.block.timestamp.iso8601}
🔗 Tranzakció: https://solscan.io/tx/${e.transaction.signature}
    `;

    await bot.sendMessage(TELEGRAM_CHANNEL_ID, msg, { parse_mode: "Markdown" });
    console.log("✅ Új burn esemény elküldve Telegramra!");
  }
}

// --- Időzített figyelés ---
console.log("🚀 LP Burn Bot elindult, figyeli az eseményeket!");
setInterval(processEvents, 15000); // 15 mp-enként ellenőriz
