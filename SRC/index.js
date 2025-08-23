import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN);
const channelId = process.env.CHANNEL_ID;
const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

// Solana "burn" címek
const BURN_ADDRESSES = [
  "11111111111111111111111111111111",
  "Sysvar1111111111111111111111111111111111111"
];

// Debug funkció → utolsó 20 tranzakció SPL burn ellenőrzés
async function checkRecentBurns() {
  try {
    const response = await fetch(HELIUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "helius-debug",
        method: "getSignaturesForAddress",
        params: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", { limit: 20 }]
      })
    });

    const data = await response.json();

    if (!data.result || data.result.length === 0) {
      await bot.sendMessage(channelId, "⚠️ Nincs új tranzakció a Helius RPC-n keresztül.");
      return;
    }

    for (const tx of data.result) {
      const sig = tx.signature;

      // Lekérdezzük a részleteket
      const detailsResponse = await fetch(HELIUS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "helius-debug",
          method: "getTransaction",
          params: [sig, { encoding: "jsonParsed" }]
        })
      });

      const details = await detailsResponse.json();

      if (details.result?.transaction?.message?.instructions) {
        const instructions = details.result.transaction.message.instructions;

        for (const ix of instructions) {
          // Ellenőrizzük, hogy a cím burn-e
          if (BURN_ADDRESSES.includes(ix.parsed?.info?.destination)) {
            const amount = ix.parsed?.info?.amount || "N/A";
            const mint = ix.parsed?.info?.mint || "Unknown";

            await bot.sendMessage(
              channelId,
              `🔥 **LP Burn esemény** 🔥\n\n` +
              `Token: ${mint}\n` +
              `Mennyiség: ${amount}\n` +
              `Tx: https://solscan.io/tx/${sig}`
            );
          }
        }
      }
    }
  } catch (err) {
    console.error(err);
    await bot.sendMessage(channelId, "❌ Hiba a Helius lekérdezés során!");
  }
}

// 30 másodpercenként ellenőrizzük
setInterval(checkRecentBurns, 30000);

bot.sendMessage(channelId, "🤖 Bot elindult, debug mód bekapcsolva!");
