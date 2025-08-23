import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Új Bitquery v1 endpoint
const BITQUERY_URL = "https://streaming.bitquery.io/graphql";

// GraphQL query a Solana LP burn eseményekhez
const query = `
query MyQuery {
  Solana {
    TokenBurns(
      limit: { count: 5 }
      orderBy: { descending: Block_Time }
    ) {
      Block {
        Time
      }
      Transaction {
        Signature
      }
      Token {
        Mint
        Name
        Symbol
      }
      Amount
    }
  }
}
`;

// Bitquery lekérés
async function fetchBurnEvents() {
  try {
    const response = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": BITQUERY_API_KEY
      },
      body: JSON.stringify({ query })
    });

    // Ha hibás státusz, dobjunk konkrét hibaüzenetet
    if (!response.ok) {
      throw new Error(`Bitquery API error! Status: ${response.status}`);
    }

    const data = await response.json();

    if (data.errors) {
      console.error("❌ Bitquery GraphQL hibák:", data.errors);
      return [];
    }

    return data.data?.Solana?.TokenBurns || [];
  } catch (error) {
    console.error("⚠️ Bitquery fetch hiba:", error.message);
    return [];
  }
}

// Telegram üzenet küldés
async function sendMessage(message) {
  try {
    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: "HTML" });
  } catch (err) {
    console.error("⚠️ Hiba a Telegram üzenetküldésnél:", err.message);
  }
}

// Időzített ellenőrzés
async function checkBurns() {
  console.log("🔍 Ellenőrzés indul...");

  const burns = await fetchBurnEvents();

  if (burns.length === 0) {
    console.log("ℹ️ Nincs új LP burn esemény.");
    return;
  }

  for (const burn of burns) {
    const message = `
🔥 <b>Új LP Burn esemény!</b>
💎 Token: ${burn.Token.Name} (${burn.Token.Symbol})
💰 Összeg: ${burn.Amount}
🕒 Idő: ${burn.Block.Time}
🔗 <a href="https://solscan.io/tx/${burn.Transaction.Signature}">Tranzakció</a>
    `;

    await sendMessage(message);
  }
}

// 1 percenként ellenőrizzük
setInterval(checkBurns, 60 * 1000);

// Első induláskor is ellenőriz
checkBurns();
