import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

// === ENV változók ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

// === Telegram bot ===
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// === Bitquery GraphQL URL ===
const BITQUERY_URL = "https://graphql.bitquery.io/";

// === Lekérdezés ===
const query = `
query {
  solana(network: solana) {
    transfers(
      options: {desc: "block.timestamp.time", limit: 5}
      transferType: burn
    ) {
      amount
      currency {
        symbol
      }
      sender {
        address
      }
      block {
        timestamp {
          time(format: "%Y-%m-%d %H:%M:%S")
        }
      }
    }
  }
}
`;

// === LP Burn események lekérdezése ===
async function checkBurnEvents() {
  try {
    console.log("🔍 Ellenőrzés indul...");

    const response = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": BITQUERY_API_KEY
      },
      body: JSON.stringify({ query })
    });

    const data = await response.json();

    if (data.errors) {
      console.error("❌ Bitquery GraphQL hiba:", data.errors);
      return;
    }

    const transfers = data.data.solana.transfers;

    if (transfers.length === 0) {
      console.log("ℹ️ Nincs új LP burn esemény.");
      return;
    }

    for (const tx of transfers) {
      const message = `
🔥 *Új LP Burn esemény!*
💰 Token: ${tx.currency.symbol}
📉 Mennyiség: ${tx.amount}
📅 Időpont: ${tx.block.timestamp.time}
🔗 Cím: \`${tx.sender.address}\`
      `;

      await bot.sendMessage(CHANNEL_ID, message, { parse_mode: "Markdown" });
      console.log("✅ Üzenet elküldve Telegramra!");
    }
  } catch (error) {
    console.error("⚠️ Nem sikerült lekérdezni a Bitquery API-t:", error.message);
  }
}

// === Időzített lekérdezés ===
setInterval(checkBurnEvents, 15000);
