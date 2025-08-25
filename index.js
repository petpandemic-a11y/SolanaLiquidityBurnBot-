import { Connection } from "@solana/web3.js";
import fetch from "node-fetch";
import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// RPC URL envből vagy fallback a Solana mainnet alap URL-re
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false
});

console.log(`🔗 RPC URL: ${RPC_URL}`);
console.log(`🌍 Server listening on ${PORT}`);

app.listen(PORT, () => {
  console.log("🚀 LP Burn figyelő indul...");
});

// Telegram config
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

async function sendToTelegram(message) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.warn("⚠️ Telegram adatok hiányoznak, nem tudok posztolni");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: message,
        parse_mode: "Markdown"
      })
    });
    console.log("📩 Üzenet elküldve Telegramra");
  } catch (err) {
    console.error("❌ Telegram hiba:", err);
  }
}

// Burn figyelő (polling példa)
async function checkBurn(txSig) {
  try {
    const txRes = await connection.getTransaction(txSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });

    if (!txRes || !txRes.meta) return;

    // Token mint kiszedése
    let mint = "Unknown";
    if (
      txRes.meta.preTokenBalances &&
      txRes.meta.preTokenBalances.length > 0
    ) {
      mint = txRes.meta.preTokenBalances[0].mint;
    }

    const message = `🔥 *LP Burn észlelve!*\nMint: \`${mint}\`\nTx: https://solscan.io/tx/${txSig}`;
    console.log(message);
    await sendToTelegram(message);
  } catch (err) {
    console.error("❌ Hiba burn feldolgozásnál:", err.message);
  }
}

// Teszt kedvéért itt meghívsz egy konkrét tx hash-t (pl. ismert LP burn tx)
(async () => {
  const testTx = "3uuhvpJz4w2Sg9ujTA7YtrmivBPeaQFLrTLprGhgLq4mmCGc6mtvvfdix8PJP42M42YEF1ECfkr5jKUSixU9Uqwz";
  console.log(`🔍 Teszt tranzakció ellenőrzés: ${testTx}`);
  await checkBurn(testTx);
})();
