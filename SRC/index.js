import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

// ====== ENV változók ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ====== Bitquery GraphQL lekérdezés ======
const query = `
query {
  solana(network: solana) {
    transfers(
      options: {desc: "block.timestamp.time", limit: 5}
      currency: {is: "SOL"}
      amount: {gt: 0}
    ) {
      block {
        timestamp {
          time(format: "%Y-%m-%d %H:%M:%S")
        }
      }
      amount
      sender {
        address
      }
      receiver {
        address
      }
      currency {
        symbol
      }
    }
  }
}
`;

// ====== Adatok lekérdezése Bitquery API-tól ======
async function fetchBurnEvents() {
  try {
    const response = await fetch("https://graphql.bitquery.io", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${BITQUERY_API_KEY}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Bitquery API error! Status: ${response.status}`);
    }

    const result = await response.json();

    if (result.errors) {
      console.error("Bitquery GraphQL hiba:", result.errors);
      return [];
    }

    return result.data?.solana?.transfers || [];
  } catch (error) {
    console.error("⚠️ Bitquery fetch hiba:", error.message);
    return [];
  }
}

// ====== Új események figyelése ======
async function checkEvents() {
  console.log("🔍 Ellenőrzés indul...");
  const events = await fetchBurnEvents();

  if (!events.length) {
    console.log("ℹ️ Nincs új LP burn esemény.");
    return;
  }

  for (const e of events) {
    const msg = `
🔥 Új LP Burn esemény!

💰 Összeg: ${e.amount} ${e.currency.symbol}
📤 Küldő: ${e.sender.address}
📥 Fogadó: ${e.receiver.address}
🕒 Időpont: ${e.block.timestamp.time}
    `;
    await bot.sendMessage(CHANNEL_ID, msg.trim());
  }
}

// ====== Indítás ======
console.log("🚀 LP Burn Bot elindult, figyeli az eseményeket!");

// 30 másodpercenként ellenőriz
setInterval(checkEvents, 30000);
