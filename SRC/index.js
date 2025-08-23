import axios from "axios";
import { Telegraf } from "telegraf";
import dotenv from "dotenv";

dotenv.config();

// --- ENV változók ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

const bot = new Telegraf(BOT_TOKEN);

// --- Bitquery API endpoint ---
const BITQUERY_URL = "https://graphql.bitquery.io";

// --- LP Burn esemény lekérdezés ---
const GET_LP_BURNS = `
query($limit: Int!) {
  solana {
    transfers(
      options: {desc: "block.timestamp.time", limit: $limit}
      transferType: burn
    ) {
      block {
        timestamp {
          time(format: "%Y-%m-%d %H:%M:%S")
        }
      }
      currency {
        symbol
        address
      }
      amount
      sender {
        address
      }
    }
  }
}
`;

let lastBurnSignature = null;

// --- Burn figyelő ciklus ---
async function checkBurns() {
  try {
    console.log("[Bot] 🔄 Ellenőrzés indul...");

    const response = await axios.post(
      BITQUERY_URL,
      {
        query: GET_LP_BURNS,
        variables: { limit: 5 },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": BITQUERY_API_KEY,
        },
      }
    );

    const burns = response.data.data.solana.transfers;

    if (!burns || burns.length === 0) {
      console.log("[Bot] ℹ️ Nincs új LP burn esemény.");
      return;
    }

    for (const burn of burns) {
      const signature = burn.sender.address + burn.block.timestamp.time;

      if (signature === lastBurnSignature) continue; // már láttuk

      lastBurnSignature = signature;

      const message = `
🔥 **Új LP Burn esemény!** 🔥

🔹 Token: **${burn.currency.symbol || "Ismeretlen"}**
🔹 Összeg: **${burn.amount} LP**
🔹 Cím: \`${burn.currency.address}\`
🕒 Időpont: ${burn.block.timestamp.time}
      `;

      await bot.telegram.sendMessage(CHANNEL_ID, message, {
        parse_mode: "Markdown",
      });

      console.log("[Bot] ✅ Új LP burn esemény elküldve Telegramra!");
    }
  } catch (error) {
    console.error("[Bot] ❌ Bitquery API hiba:", error.message);
    await bot.telegram.sendMessage(
      CHANNEL_ID,
      "⚠️ Nem sikerült lekérdezni a Bitquery API-t!"
    );
  }
}

// --- Indítás ---
bot.launch().then(() => {
  console.log("[Bot] 🚀 LP Burn Bot elindult és figyeli az LP burn eseményeket!");
  bot.telegram.sendMessage(
    CHANNEL_ID,
    "🚀 LP Burn Bot elindult és figyeli az LP burn eseményeket!"
  );
});

// --- 10 másodpercenként ellenőrzünk ---
setInterval(checkBurns, 10_000);
