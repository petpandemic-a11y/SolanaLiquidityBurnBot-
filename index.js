import express from "express";
import fetch from "node-fetch";
import { Connection } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config();

// === CONFIG ===
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com"; // saját RPC / helius is mehet
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN; // Telegram bot token
const TG_CHAT_ID = process.env.TG_CHAT_ID;     // Csatorna/chat ID

// === INIT ===
const app = express();
const PORT = process.env.PORT || 10000;
const connection = new Connection(RPC_URL, "confirmed");

// === TELEGRAM SENDER ===
async function sendToTelegram(message) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log("❌ Telegram config hiányzik");
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: message,
        parse_mode: "Markdown"
      })
    });
  } catch (e) {
    console.error("❌ Telegram hiba:", e.message);
  }
}

// === LP BURN LISTENER ===
async function listenBurns() {
  console.log("🚀 LP Burn figyelő indul...");

  connection.onLogs("all", async (log) => {
    try {
      if (!log.logs) return;

      // Burn instruction keresése
      const isBurn = log.logs.some(l => l.includes("Instruction: Burn"));
      if (!isBurn) return;

      // Tranzakció részletek betöltése
      const txSig = log.signature;
      const txRes = await connection.getTransaction(txSig, { commitment: "confirmed" });
      if (!txRes) return;

      const { meta } = txRes;
      let mint = "Unknown";
      let tokenName = "Unknown";

      // Mint cím kinyerése
      if (meta && meta.preTokenBalances && meta.preTokenBalances.length > 0) {
        mint = meta.preTokenBalances[0].mint;
      }

      // Token nevet Dexscreener API-ból (ha kell)
      try {
        const ds = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
        const data = await ds.json();
        if (data.pairs && data.pairs.length > 0) {
          tokenName = data.pairs[0].baseToken.symbol || "Unknown";
        }
      } catch (e) {
        console.log("⚠️ Dexscreener hiba:", e.message);
      }

      // Üzenet
      const msg = `
🔥 *LP Burn detected!*
🪙 Token: ${tokenName}  
🧾 Mint: \`${mint}\`  
🔗 [Solscan](https://solscan.io/tx/${txSig})
      `;

      console.log(msg);
      await sendToTelegram(msg);

    } catch (err) {
      console.error("❌ Hiba burn feldolgozásnál:", err.message);
    }
  });
}

// === SERVER ===
app.get("/", (_, res) => res.send("🚀 LP Burn bot fut!"));

app.listen(PORT, () => {
  console.log(`🌍 Server listening on ${PORT}`);
  listenBurns();
});
