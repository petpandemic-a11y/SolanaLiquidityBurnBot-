import fetch from "node-fetch";
import { Telegraf } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

if (!BOT_TOKEN || !CHANNEL_ID || !BITQUERY_API_KEY) {
  console.error("❌ Hiba: BOT_TOKEN, CHANNEL_ID vagy BITQUERY_API_KEY nincs beállítva!");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

console.log("🚀 LP Burn Bot indul...");

/**
 * Bitquery API lekérdezés
 */
async function fetchBitqueryData() {
  try {
    console.log("🔄 Bitquery lekérdezés indul...");

    const query = `
      query {
        Solana {
          Transfers(
            transferType: burn
            options: {desc: "block.timestamp.iso8601", limit: 5}
          ) {
            Block {
              Timestamp {
                iso8601
              }
            }
            Amount
            Currency {
              Symbol
              Address
            }
          }
        }
      }
    `;

    const response = await fetch("https://graphql.bitquery.io", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": BITQUERY_API_KEY
      },
      body: JSON.stringify({ query }),
    });

    console.log(`🌍 Bitquery státusz: ${response.status}`);

    const data = await response.json();
    console.log("📦 Bitquery teljes válasz:", JSON.stringify(data, null, 2));

    if (data.errors) {
      console.error("❌ Bitquery API hibák:", data.errors);
      return null;
    }

    return data.data?.Solana?.Transfers || [];
  } catch (error) {
    console.error("🔥 Bitquery fetch hiba:", error);
    return null;
  }
}

/**
 * LP burn események figyelése
 */
async function checkBurnEvents() {
  console.log("🔍 Ellenőrzés indul...");
  const burns = await fetchBitqueryData();

  if (!burns || burns.length === 0) {
    console.log("ℹ️ Nincs új LP burn esemény.");
    return;
  }

  for (const burn of burns) {
    const symbol = burn.Currency?.Symbol || "ISMERETLEN";
    const amount = burn.Amount || 0;
    const address = burn.Currency?.Address || "N/A";
    const timestamp = burn.Block?.Timestamp?.iso8601 || "N/A";

    const message = `
🔥 ÚJ LP BURN ESEMÉNY!
💰 Token: ${symbol}
📦 Mennyiség: ${amount}
📜 Cím: ${address}
⏰ Időpont: ${timestamp}
    `;

    console.log("📢 Telegram üzenet:", message);

    try {
      await bot.telegram.sendMessage(CHANNEL_ID, message);
    } catch (error) {
      console.error("⚠️ Hiba a Telegram üzenet küldésekor:", error);
    }
  }
}

/**
 * Indulás és időzített figyelés
 */
(async () => {
  await bot.telegram.sendMessage(CHANNEL_ID, "🚀 LP Burn Bot elindult és figyeli az LP burn eseményeket!");
  await checkBurnEvents();
  setInterval(checkBurnEvents, 60000);
})();
