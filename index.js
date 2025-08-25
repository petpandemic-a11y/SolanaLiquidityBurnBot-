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
      return data.pairs; // tömb, több pár is lehet
    }
  } catch (err) {
    console.error("Dexscreener error:", err);
  }
  return [];
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

    // Burn instruction kiszedése
    const burnInst = tx.transaction.message.instructions.find(
      ix => ix.parsed?.type === "burn"
    );
    if (!burnInst) return;

    const mint = burnInst.parsed.info.mint;
    const amount = Number(burnInst.parsed.info.amount) / 1e9;

    // Token infók
    const pairs = await getTokenInfo(mint);
    if (pairs.length === 0) return; // nincs Dexscreener adat

    // Csak akkor, ha LP tokenről van szó
    const lpPair = pairs.find(
      p =>
        p.baseToken.address === mint ||
        p.quoteToken.address === mint ||
        p.lpToken?.address === mint
    );
    if (!lpPair) return; // nem LP burn, skip

    // Üzenet összerakás
    const burnUsd = (amount * parseFloat(lpPair.priceUsd || 0)).toFixed(2);
    let msg = `🔥 *Új LP Burn észlelve!*\n[Solscan Tx](https://solscan.io/tx/${signature})`;

    msg += `\n\n*Pool:* ${lpPair.baseToken.name} (${lpPair.baseToken.symbol}) / ${lpPair.quoteToken.symbol}`;
    msg += `\nÉgetett LP token: ${amount.toFixed(4)}`;
    if (burnUsd > 0) msg += `\nÉrték: ~${burnUsd} USD`;
    msg += `\nLikviditás: $${lpPair.liquidity.usd.toLocaleString()}`;
    msg += `\nMCap: $${lpPair.fdv.toLocaleString()}`;
    msg += `\n[DexScreener link](${lpPair.url})`;

    await sendTelegram(msg);
    console.log("LP Burn kiküldve TG-re:", msg);
  } catch (err) {
    console.error("Burn feldolgozási hiba:", err);
  }
}

// === Dummy polling (cseréld LP pool address figyelésre) ===
setInterval(async () => {
  try {
    const sigs = await connection.getSignaturesForAddress(
      new PublicKey("11111111111111111111111111111111"), // TODO: LP pool root címlista
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
app.get("/", (_, res) => res.send("Csak LP Burn figyelés aktív 🚀"));
app.listen(PORT, () => console.log(`Bot elindult a ${PORT} porton`));
