import express from "express";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import fetch from "node-fetch";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- RPC ENDPOINTS ---
const RPC_PUBLIC = "https://solana-rpc.publicnode.com"; // elsődleges (ingyenes)
const RPC_HELIUS = process.env.HELIUS_RPC_URL;          // fallback

let connection = new Connection(RPC_PUBLIC, {
  commitment: "confirmed",
  maxSupportedTransactionVersion: 0
});

// --- TELEGRAM ---
const bot = new TelegramBot(process.env.TG_BOT_TOKEN, { polling: false });
const CHAT_ID = process.env.TG_CHAT_ID;

// --- Segédfüggvény az RPC váltáshoz ---
async function withRPC(fn) {
  try {
    return await fn(connection);
  } catch (err) {
    console.error("❌ RPC error:", err.message || err);
    if (RPC_HELIUS) {
      console.warn("⚠️ Átváltás Helius RPC-re...");
      connection = new Connection(RPC_HELIUS, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });
      return await fn(connection);
    } else {
      throw err;
    }
  }
}

// --- Példa: LP Burn feldolgozás ---
async function checkBurns() {
  try {
    const sigs = await withRPC(conn =>
      conn.getSignaturesForAddress(
        // példaként Raydium pool program ID (testre kell szabni)
        "5quB4y8xJfNczWzG32KzB8MSmc5QwDFi1Cdm2At2Jx2z",
        { limit: 5 }
      )
    );

    for (const sig of sigs) {
      const tx = await withRPC(conn => conn.getTransaction(sig.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      }));

      if (!tx) continue;

      // LP Burn logika detektálás (egyszerűsítve)
      const burnInstr = tx.meta?.logMessages?.find(l => l.includes("Burn"));
      if (burnInstr) {
        console.log("🔥 LP Burn:", sig.signature);

        await bot.sendMessage(
          CHAT_ID,
          `🔥 Új LP Burn!\n\nTx: https://solscan.io/tx/${sig.signature}`
        );
      }
    }
  } catch (err) {
    console.error("Burn feldolgozási hiba:", err.message || err);
  }
}

// --- 60 másodpercenként fut ---
setInterval(checkBurns, 60_000);

// --- Render healthcheck ---
app.get("/", (_, res) => res.send("LP Burn bot fut 🚀"));
app.listen(PORT, () => console.log(`✅ Server fut a ${PORT} porton`));
