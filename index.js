import express from "express";
import fetch from "node-fetch";
import { Connection } from "@solana/web3.js";
import TelegramBot from "node-telegram-bot-api";

const app = express();
const port = process.env.PORT || 3000;

// ENV változók (Render-en kell beállítani!)
const RPC_URL = process.env.RPC_URL || "https://rpc.ankr.com/solana"; // vagy Helius
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const connection = new Connection(RPC_URL, "confirmed");
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

async function getTokenMetadata(mint) {
  try {
    const resp = await fetch(`${RPC_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAsset",
        params: { id: mint }
      })
    });

    const data = await resp.json();
    if (data?.result?.content?.metadata) {
      return {
        name: data.result.content.metadata.name || "Unknown",
        symbol: data.result.content.metadata.symbol || "???"
      };
    }
    return { name: "Unknown", symbol: "???" };
  } catch (err) {
    console.error("Metadata fetch error:", err);
    return { name: "Unknown", symbol: "???" };
  }
}

async function listenBurns() {
  console.log("🚀 LP Burn figyelő indul...");

  connection.onLogs("all", async (log) => {
    const tx = log.signature;

    // egyszerű burn detektálás log alapján
    if (log.logs.some(l => l.includes("burn"))) {
      console.log("[BURN] Esemény tx:", tx);

      // Itt kéne az LP mint cím kinyerése a tranzakcióból -> most dummy
      const mint = "SoMeMintAddressHere"; 

      const meta = await getTokenMetadata(mint);

      const msg = `🔥 LP Burn detected!\nToken: ${meta.name} (${meta.symbol})\nMint: ${mint}\nTx: https://solscan.io/tx/${tx}`;
      console.log(msg);

      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        bot.sendMessage(TELEGRAM_CHAT_ID, msg);
      }
    }
  });
}

app.get("/", (req, res) => res.send("LP Burn listener running"));
app.listen(port, () => console.log(`🌍 Server listening on ${port}`));

listenBurns();
