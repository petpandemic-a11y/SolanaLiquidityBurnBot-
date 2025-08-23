import fetch from "node-fetch";
import { Telegraf } from "telegraf";
import dotenv from "dotenv";
dotenv.config();

// --- ENV változók betöltése ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

if (!BOT_TOKEN || !CHANNEL_ID || !BITQUERY_API_KEY) {
  console.error("❌ Hiányzik valamelyik ENV változó!");
  process.exit(1);
}

// --- Telegram Bot inicializálás ---
const bot = new Telegraf(BOT_TOKEN);

// --- Bitquery API V2 végpont ---
const BITQUERY_URL = "https://streaming.bitquery.io/graphql";

// --- GraphQL lekérdezés ---
const query = `
  query MyQuery {
    solana {
      burns(
        limit: { count: 5 }
        order_by: { burn_time: desc }
      ) {
        amount
        mint
        owner
        transaction {
          signature
        }
        burn_time
      }
    }
  }
`;

// --- Bitquery lekérés ---
async function fetchBitquery() {
  try {
    console.log("🔍 Ellenőrzés indul…");

    const response = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${BITQUERY_API_KEY}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      console.error(`❌ Bitquery API hiba: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();

    if (data.errors) {
      console.error("❌ Bitquery GraphQL hiba:", data.errors);
      return null;
    }

    return data.data.solana.burns || [];
  } catch (error) {
    console.error("🔥 Bitquery fetch hiba:", error.message);
    return null;
  }
}

// --- Burn események ellenőrzése ---
async function checkBurns() {
  const burns = await fetchBitquery();
  if (!burns || burns.length === 0) {
    console.log("ℹ️ Nincs új LP burn esemény.");
    return;
  }

  for (const burn of burns) {
    const msg = `
🔥 ÚJ LP BURN ÉSZLELVE! 🔥

💰 Mennyiség: ${burn.amount}
🪙 Token: ${burn.mint}
👤 Tulaj: ${burn.owner}
🔗 Tranzakció: https://solscan.io/tx/${burn.transaction.signature}
⏰ Időpont: ${burn.burn_time}
    `;

    await bot.telegram.sendMessage(CHANNEL_ID, msg.trim(), { parse_mode: "Markdown" });
    console.log("✅ Üzenet elküldve a Telegramra!");
  }
}

// --- Időzített ellenőrzés ---
setInterval(checkBurns, 60_000); // minden 1 percben ellenőrizzük

// --- Bot indítása ---
bot.launch().then(() => {
  console.log("🚀 LP Burn Bot elindult és figyeli az eseményeket!");
});
