import express from "express";
import fetch from "node-fetch";
import { Connection, PublicKey } from "@solana/web3.js";

const FREE_RPC = "https://rpc.ankr.com/solana"; // ingyenes public RPC
const HELIUS_RPC = process.env.HELIUS_RPC_URL;  // fallback RPC (pl. helius)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 10000;

let connection = new Connection(FREE_RPC, { commitment: "confirmed" });
let usingHelius = false;

const app = express();

// === DEX LP pool címlista ===
const LP_ADDRESSES = [
  // Raydium
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM authority
  // Orca
  "9WFFm2i7TH4FzZ4PWzj1pYJKXxA9HBQ5fZVnK8hEJbbz", // Orca Whirlpools program
  // Pump.fun
  "Fg6PaFpoGXkYsidMpWxTWqkxhM8GdZ9XMBqMfmD9oeUo", // Pump.fun (példa)
  // Ha van még több konkrét LP pool címed, ide tudod betenni
].map(a => new PublicKey(a));

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
    if (res.status === 429) {
      console.warn("DexScreener limit! Skipping...");
      return [];
    }
    const data = await res.json();
    if (data.pairs && data.pairs.length > 0) {
      return data.pairs;
    }
  } catch (err) {
    console.error("DexScreener error:", err);
  }
  return [];
}

// === RPC váltás, ha baj van ===
function switchToHelius() {
  if (!usingHelius && HELIUS_RPC) {
    console.warn("⚠️ Átváltás Helius RPC-re...");
    connection = new Connection(HELIUS_RPC, { commitment: "confirmed" });
    usingHelius = true;
  }
}

// === LP Burn feldolgozó ===
async function handleBurn(signature) {
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0
    });
    if (!tx) return;

    const logMsg = tx.meta?.logMessages?.join(" ") || "";
    if (!logMsg.toLowerCase().includes("burn")) return;

    const burnInst = tx.transaction.message.instructions.find(
      ix => ix.parsed?.type === "burn"
    );
    if (!burnInst) return;

    const mint = burnInst.parsed.info.mint;
    const amount = Number(burnInst.parsed.info.amount) / 1e9;

    const pairs = await getTokenInfo(mint);
    if (pairs.length === 0) return;

    // Csak LP tokenek szűrése
    const lpPair = pairs.find(
      p =>
        p.lpToken?.address === mint ||
        p.baseToken.address === mint ||
        p.quoteToken.address === mint
    );
    if (!lpPair) return;

    const burnUsd = (amount * parseFloat(lpPair.priceUsd || 0)).toFixed(2);
    let msg = `🔥 *Új LP Burn észlelve!*\n[Solscan Tx](https://solscan.io/tx/${signature})`;

    msg += `\n\n*Pool:* ${lpPair.baseToken.name} (${lpPair.baseToken.symbol}) / ${lpPair.quoteToken.symbol}`;
    msg += `\nÉgetett LP token: ${amount.toFixed(4)}`;
    if (burnUsd > 0) msg += `\nÉrték: ~${burnUsd} USD`;
    msg += `\nLikviditás: $${lpPair.liquidity.usd.toLocaleString()}`;
    msg += `\nMCap: $${lpPair.fdv.toLocaleString()}`;
    msg += `\n[DexScreener link](${lpPair.url})`;

    await sendTelegram(msg);
    console.log("✅ LP Burn kiküldve:", msg);
  } catch (err) {
    console.error("Burn feldolgozási hiba:", err.message);
    switchToHelius(); // ha hiba, akkor váltson Heliusra
  }
}

// === Poolok figyelése ===
setInterval(async () => {
  for (const lp of LP_ADDRESSES) {
    try {
      const sigs = await connection.getSignaturesForAddress(lp, { limit: 5 });
      for (const s of sigs) {
        await handleBurn(s.signature);
      }
    } catch (e) {
      console.error("Signature lekérés hiba:", e.message);
      switchToHelius();
    }
  }
}, 30000);

// Render keepalive
app.get("/", (_, res) => res.send("Csak LP Burn figyelés aktív 🚀"));
app.listen(PORT, () => console.log(`Bot elindult a ${PORT} porton`));
