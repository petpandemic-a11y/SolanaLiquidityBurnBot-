import 'dotenv/config';
import fetch from "node-fetch";
import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection(process.env.RPC_ENDPOINT, "confirmed");
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"); // Metaplex

async function getTokenMetadata(mint) {
  try {
    const [pda] = await PublicKey.findProgramAddress(
      [
        Buffer.from("metadata"),
        METADATA_PROGRAM_ID.toBuffer(),
        new PublicKey(mint).toBuffer(),
      ],
      METADATA_PROGRAM_ID
    );

    const accountInfo = await connection.getAccountInfo(pda);
    if (accountInfo?.data) {
      const name = accountInfo.data.toString().split("\u0000")[0]; 
      return name;
    }
  } catch (e) {
    console.log("Metadata fetch error:", e.message);
  }
  return null;
}

async function heliusLookup(mint) {
  try {
    const url = `https://api.helius.xyz/v0/token-metadata?api-key=${process.env.HELIUS_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mintAccounts: [mint] })
    });
    const data = await res.json();
    return data[0]?.onChainMetadata?.metadata?.name || "Ismeretlen token";
  } catch (e) {
    console.log("Helius lookup hiba:", e.message);
    return "Ismeretlen token";
  }
}

async function sendTelegram(msg) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: "Markdown"
    })
  });
}

console.log("🚀 LP Burn figyelő elindult...");

connection.onLogs("all", async (log) => {
  if (!log.logs) return;
  if (log.logs.some(l => l.includes("Burn"))) {
    const sig = log.signature;
    console.log(`[BURN] esemény tx=${sig}`);

    let tokenName = null;
    try {
      const tx = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
      const mint = tx?.transaction?.message?.instructions?.[0]?.parsed?.info?.mint;

      if (mint) {
        tokenName = await getTokenMetadata(mint);
        if (!tokenName) tokenName = await heliusLookup(mint);
      }

      const msg = `🔥 *LP Burn észlelve!*\n\nToken: ${tokenName || "Ismeretlen"}\nTx: https://solscan.io/tx/${sig}`;
      await sendTelegram(msg);
    } catch (e) {
      console.log("Hiba feldolgozás közben:", e.message);
    }
  }
});

// Render healthcheck
import http from "http";
http.createServer((_, res) => {
  res.writeHead(200);
  res.end("LP Burn watcher fut ✅");
}).listen(process.env.PORT || 10000);
