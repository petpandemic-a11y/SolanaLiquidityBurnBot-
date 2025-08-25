// index.js (ESM verzió)

import express from "express";
import fetch from "node-fetch";
import { Connection, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Solana kapcsolat ----
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://rpc.ankr.com/solana";
const HELIUS_ENDPOINT = process.env.HELIUS_ENDPOINT || null;

let connection = new Connection(RPC_ENDPOINT, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000,
});

// ---- Helper: biztosan string PublicKey ----
function toPubkeyString(address) {
  try {
    if (!address) return null;
    if (typeof address === "string") {
      return new PublicKey(address).toBase58();
    } else if (address && typeof address.toBase58 === "function") {
      return address.toBase58();
    }
  } catch (e) {
    console.error("❌ PublicKey konverzió hiba:", e.message);
  }
  return null;
}

// ---- Tranzakció feldolgozó ----
async function processBurn(sig) {
  try {
    const tx = await connection.getTransaction(sig, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      console.log("⚠️ Nem található tranzakció:", sig);
      return;
    }

    // Mint cím kiszedése
    let mintRaw = tx.transaction.message.accountKeys[0];
    let mint = toPubkeyString(mintRaw);

    if (mint) {
      console.log("🔥 LP Burn észlelve!");
      console.log("Mint:", mint);
      console.log("Tx:", `https://solscan.io/tx/${sig}`);

      // 🔔 Telegram küldés
      if (process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID) {
        await sendTelegramMessage(
          `🔥 Új LP Burn!\nMint: ${mint}\nTx: https://solscan.io/tx/${sig}`
        );
      }
    } else {
      console.log("⚠️ Nem sikerült mint címet konvertálni:", sig);
    }
  } catch (err) {
    console.error("🚨 Burn feldolgozási hiba:", err.message);

    if (HELIUS_ENDPOINT) {
      console.log("⚠️ Átváltás Helius RPC-re...");
      connection = new Connection(HELIUS_ENDPOINT, {
        commitment: "confirmed",
        confirmTransactionInitialTimeout: 60000,
      });
    }
  }
}

// ---- Telegram üzenetküldő ----
async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: process.env.TG_CHAT_ID,
    text,
    parse_mode: "HTML",
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("❌ Telegram hiba:", data);
    }
  } catch (e) {
    console.error("❌ Telegram API hiba:", e.message);
  }
}

// ---- Teszt endpoint ----
app.get("/", (req, res) => {
  res.send("🔥 LP Burn Watcher fut Renderen!");
});

// ---- Indítás ----
app.listen(PORT, () => {
  console.log(`🚀 Szerver fut a ${PORT} porton`);
});
