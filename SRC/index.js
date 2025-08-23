import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

console.log("🚀 LP Burn Bot elindult, figyeli az eseményeket!");

// Bitquery v2 API URL
const BITQUERY_URL = "https://streaming.bitquery.io/graphql";

// Új GraphQL lekérdezés Solana LP burn eseményekhez
const query = `
query LPBurnEvents {
  Solana {
    Transfers(
      where: {
        Transfer: {
          Amount: {gt: 0}
        },
        Burn: {is: true}
      },
      limit: {count: 5}
    ) {
      Transfer {
        Amount
        Currency {
          Symbol
        }
        Receiver
        Sender
        Block {
          Time
        }
      }
    }
  }
}`;

async function fetchLPBurnEvents() {
  try {
    const response = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${BITQUERY_API_KEY}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Bitquery API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.data?.Solana?.Transfers?.length) {
      console.log("ℹ️ Nincs új LP burn esemény.");
      return;
    }

    const events = data.data.Solana.Transfers;

    for (const event of events) {
      const msg = `
🔥 ÚJ LP BURN ESEMÉNY 🔥
Token: ${event.Transfer.Currency.Symbol}
Mennyiség: ${event.Transfer.Amount}
Égető cím: ${event.Transfer.Sender}
Idő: ${event.Transfer.Block.Time}
      `;
      console.log(msg);
      await bot.sendMessage(CHANNEL_ID, msg);
    }
  } catch (error) {
    console.error("⚠️ Bitquery fetch hiba:", error.message);
  }
}

// 30 másodpercenként ellenőriz
setInterval(fetchLPBurnEvents, 30000);
