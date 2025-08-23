import 'dotenv/config';
import fetch from 'node-fetch';
import TelegramBot from 'node-telegram-bot-api';

// --- ENV változók ---
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.CHANNEL_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// --- Telegram bot inicializálás ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// --- Burn address lista ---
const BURN_ADDRESSES = [
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111"
];

// --- Induláskor tesztüzenet ---
(async () => {
  try {
    await bot.sendMessage(TELEGRAM_CHANNEL_ID, "🔥 Bot elindult és figyeli az LP-burn eseményeket!");
    console.log("✅ Tesztüzenet elküldve Telegramra!");
  } catch (error) {
    console.error("❌ Nem sikerült Telegramra írni:", error.message);
  }
})();

// --- LP-burn figyelő ---
async function checkLPBurns() {
  try {
    console.log("🔄 Lekérdezés indul a Helius RPC-n...");

    const response = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "helius-test",
        method: "getSignaturesForAddress",
        params: [
          "TokenkProgram11111111111111111111111111111", // SPL Token program
          { limit: 10 }
        ]
      })
    });

    const data = await response.json();

    if (!data.result) {
      console.error("⚠️ Nincs adat a Helius RPC-től!");
      return;
    }

    for (const tx of data.result) {
      console.log("📌 Tranzakció:", tx.signature);

      // Ellenőrizzük, hogy van-e token burn
      const detailsResponse = await fetch(HELIUS_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "helius-tx",
          method: "getTransaction",
          params: [tx.signature, { encoding: "jsonParsed" }]
        })
      });

      const details = await detailsResponse.json();
      if (!details.result?.meta) continue;

      const postTokenBalances = details.result.meta.postTokenBalances || [];
      const preTokenBalances = details.result.meta.preTokenBalances || [];

      if (preTokenBalances.length > 0 && postTokenBalances.length === 0) {
        // Lehetséges LP-burn — ellenőrizzük, hova ment
        const accounts = details.result.transaction.message.accountKeys;
        const burnAccount = accounts.find(a => BURN_ADDRESSES.includes(a.pubkey));

        if (burnAccount) {
          console.log("🔥 LP token teljesen burnolva:", tx.signature);

          const message = `
🔥 **LP BURN ÉSZLELVE!**
🔗 [Tranzakció](https://solscan.io/tx/${tx.signature})
📍 Burn cím: \`${burnAccount.pubkey}\`
          `;

          await bot.sendMessage(TELEGRAM_CHANNEL_ID, message, { parse_mode: "Markdown" });
        }
      }
    }
  } catch (error) {
    console.error("❌ Hiba a lekérdezésben:", error.message);
  }
}

// --- Időzített lekérdezés 20 mp-enként ---
setInterval(checkLPBurns, 20000);
