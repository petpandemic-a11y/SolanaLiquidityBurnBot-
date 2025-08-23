import fetch from "node-fetch";
import { Telegraf } from "telegraf";
import dotenv from "dotenv";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

const bot = new Telegraf(BOT_TOKEN);

// Bitquery V2 endpoint
const BITQUERY_URL = "https://streaming.bitquery.io/graphql";

// GraphQL query Solana LP burn eseményekhez (API v2)
const QUERY = `
query MyQuery {
  Solana {
    Transfers(
      where: {
        Transfer: { Currency: { Symbol: { is: "SOL" } } }
        Transaction: { Result: { Success: true } }
      }
      limit: { count: 5 }
    ) {
      Transfer {
        Amount
        Currency {
          Symbol
        }
        Receiver
        Sender
      }
      Transaction {
        Signature
        Block {
          Time
        }
      }
    }
  }
}`;

async function fetchBurnEvents() {
  try {
    const response = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${BITQUERY_API_KEY}`,
      },
      body: JSON.stringify({ query: QUERY }),
    });

    const data = await response.json();

    if (data.errors) {
      console.error("❌ Bitquery GraphQL hiba:", data.errors);
      return [];
    }

    return data.data?.Solana?.Transfers || [];
  } catch (error) {
    console.error("⚠️ Nem sikerült lekérdezni a Bitquery API-t:", error.message);
    return [];
  }
}

async function checkBurnEvents() {
  console.log("🔍 Ellenőrzés indul...");
  const events = await fetchBurnEvents();

  if (!events.length) {
    console.log("ℹ️ Nincs új LP burn esemény.");
    return;
  }

  for (const ev of events) {
    const msg = `
🔥 **Új Solana LP Burn esemény!** 🔥

💸 Mennyiség: ${ev.Transfer.Amount} ${ev.Transfer.Currency.Symbol}
📤 Küldő: ${ev.Transfer.Sender}
📥 Fogadó: ${ev.Transfer.Receiver}
⏳ Időpont: ${ev.Transaction.Block.Time}
🔗 Tx: https://solscan.io/tx/${ev.Transaction.Signature}
    `;

    await bot.telegram.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
    console.log("📩 Új esemény elküldve Telegramra!");
  }
}

bot.launch();
console.log("🚀 LP Burn Bot elindult, figyeli az eseményeket!");

// 30 másodpercenként ellenőrzünk
setInterval(checkBurnEvents, 30000);
