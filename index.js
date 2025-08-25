import express from "express";
import fetch from "node-fetch";
import { Connection, PublicKey } from "@solana/web3.js";

const RPC_URL = process.env.RPC_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 10000;

const connection = new Connection(RPC_URL, { commitment: "confirmed" });
const app = express();

// === Telegram üzenet küldő ===
async function sendTelegram(msg) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: "Markdown"
    })
  });
}

// === DexScreener token info ===
async function getTokenInfo(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.pairs && data.pairs.length > 0) {
      const pair = data.pairs[0];
      return {
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        priceUsd: parseFloat(pair.priceUsd),
        fdv: parseFloat(pair.fdv),
        liquidityUsd: parseFloat(pair.liquidity.usd),
        pairUrl: pair.url
      };
    }
  } catch (err) {
    console.error("Dexscreener error:", err);
  }
  return null;
}

// === LP Burn figyelő ===
async function handleBurn(signature) {
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0
    });
    if (!tx) return;

    // Csak akkor, ha Burn történt
    const logMsg = tx.meta?.logMessages?.join(" ") || "";
    if (!logMsg.toLowerCase().includes("burn")) return;

    // Megnézzük a Burn instructionokat
    const burnInst = tx.transaction.message.instructions.find(
      ix => ix.parsed?.type === "burn"
    );
    if (!burnInst) return;

    const mint = burnInst.parsed.info.mint;
    const amount = Number(burnInst.parsed.info.amount) / 1e9; // SPL token decimals feltételezve 9

    const tokenInfo = await getTokenInfo(mint);

    let msg = `🔥 *LP Burn észlelve!*\n[Solscan Tx](https://solscan.io/tx/${signature})`;

    if (tokenInfo) {
      // USD érték számítása
      const burnUsd = (amount * tokenInfo.priceUsd).toFixed(2);
      msg += `\n\n*Token:* ${tokenInfo.name} (${tokenInfo.symbol})`;
      msg += `\nÉgetett mennyiség: ${amount.toFixed(4)} ${tokenInfo.symbol}`;
      msg += `\nÉrték: ~${burnUsd} USD`;
      msg += `\nMCap: $${tokenInfo.fdv.toLocaleString()}`;
      msg += `\nLikviditás: $${tokenInfo.liquidityUsd.toLocaleString()}`;
      msg += `\n[DexScreener link](${tokenInfo.pairUrl})`;
    }

    await sendTelegram(msg);
    console.log("Kiküldve TG-re:", msg);
  } catch (err) {
    console.error("Burn feldolgozási hiba:", err);
  }
}

// === Példa: random signature figyelés (cron-szerű loop) ===
// TODO: majd LP pool accountok figyelése kell ide, most teszt dummy
setInterval(async () => {
  try {
    const sigs = await connection.getSignaturesForAddress(
      new PublicKey("11111111111111111111111111111111"), // dummy address
      { limit: 5 }
    );
    for (const s of sigs) {
      await handleBurn(s.signature);
    }
  } catch (e) {
    console.error("Signature lekérés hiba:", e);
  }
}, 30000);

// Render keepalive
app.get("/", (_, res) => res.send("LP Burn bot fut 🚀"));
app.listen(PORT, () => console.log(`Bot elindult a ${PORT} porton`));
