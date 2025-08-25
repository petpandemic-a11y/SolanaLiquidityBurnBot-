import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { Connection, PublicKey } from "@solana/web3.js";

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;

// ==== CONFIG ====
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Raydium AMM (pool program)
const RAYDIUM_AMM = new PublicKey("675kPX9MHTjS2zt1c4uxszB5dLz7RQdq86UW2CeYcY8");

// Solana kapcsolat
const connection = new Connection(HELIUS_RPC, "confirmed");


// ===== Helper: token metadata =====
async function getTokenInfo(mint) {
  try {
    const url = `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_API_KEY}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mintAccounts: [mint] })
    });
    const data = await resp.json();
    if (data && data[0]) {
      return {
        name: data[0].onChainMetadata?.metadata?.data?.name || "Unknown",
        symbol: data[0].onChainMetadata?.metadata?.data?.symbol || "???",
        decimals: data[0].onChainMetadata?.metadata?.data?.decimals || 9,
        supply: data[0].onChainMetadata?.supply || 0
      };
    }
    return { name: "Unknown", symbol: "???", decimals: 9, supply: 0 };
  } catch (e) {
    console.error("Token info fetch error:", e);
    return { name: "Unknown", symbol: "???", decimals: 9, supply: 0 };
  }
}

// ===== Helper: Raydium pool adatlekérés (on-chain) =====
async function getPoolPrice(lpMint) {
  try {
    // Raydium pool account RPC query
    const acc = await connection.getParsedAccountInfo(new PublicKey(lpMint));
    if (!acc.value) return null;

    // Példa: innen kinyerjük a reserve-eket (tokenA, tokenB)
    const data = acc.value.data;
    if (!data?.parsed?.info) return null;

    const tokenA = parseFloat(data.parsed.info.tokenAmount.tokenAmount.amount);
    const tokenB = parseFloat(data.parsed.info.tokenAmount.uiAmount);

    // WSOL price fix (1 WSOL = 1 SOL)
    // Token ár: SOL/token
    const priceInSOL = tokenA > 0 && tokenB > 0 ? tokenA / tokenB : 0;

    return { priceInSOL };
  } catch (e) {
    console.error("Pool fetch error:", e);
    return null;
  }
}

// ===== Helper: SOL → USD ár (Coingecko) =====
async function getSOLPrice() {
  try {
    const resp = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const data = await resp.json();
    return data.solana.usd || 0;
  } catch (e) {
    console.error("SOL ár fetch error:", e);
    return 0;
  }
}

// ===== Telegram üzenet =====
async function sendTelegramMessage(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
    });
  } catch (e) {
    console.error("Telegram hiba:", e);
  }
}


// ===== Webhook feldolgozás =====
app.post("/webhook", async (req, res) => {
  try {
    const txs = req.body;
    for (const tx of txs) {
      if (!tx.meta) continue;

      const instructions = [
        ...(tx.transaction?.message?.instructions || []),
        ...(tx.meta?.innerInstructions?.flatMap(i => i.instructions) || [])
      ];

      for (const ix of instructions) {
        if (ix?.parsed?.type === "burn") {
          const mint = ix.parsed.info.mint;
          const amount = ix.parsed.info.amount;

          const tokenInfo = await getTokenInfo(mint);
          const amountNormalized = amount / (10 ** tokenInfo.decimals);

          // On-chain ár poolból
          const poolPrice = await getPoolPrice(mint);
          const solPrice = await getSOLPrice();

          let valueSOL = 0;
          let valueUSD = 0;
          let marketCapUsd = 0;

          if (poolPrice && poolPrice.priceInSOL > 0) {
            valueSOL = amountNormalized * poolPrice.priceInSOL;
            valueUSD = valueSOL * solPrice;

            if (tokenInfo.supply > 0) {
              const supply = tokenInfo.supply / (10 ** tokenInfo.decimals);
              marketCapUsd = supply * poolPrice.priceInSOL * solPrice;
            }
          }

          const msg = `🔥 LP Burn észlelve!\n\n` +
                      `Token: ${tokenInfo.name} (${tokenInfo.symbol})\n` +
                      `Égetett mennyiség: ${amountNormalized.toFixed(2)} ${tokenInfo.symbol}\n` +
                      (valueSOL > 0 ? `Érték: ${valueSOL.toFixed(2)} SOL ($${valueUSD.toFixed(2)})\n` : "") +
                      (marketCapUsd > 0 ? `MarketCap: $${marketCapUsd.toFixed(0)}\n` : "") +
                      `Tx: https://solscan.io/tx/${tx.transaction.signatures[0]}`;

          console.log(msg);
          await sendTelegramMessage(msg);
        }
      }
    }
    res.status(200).send("ok");
  } catch (e) {
    console.error("Webhook feldolgozási hiba:", e);
    res.status(500).send("error");
  }
});


// ===== Start =====
app.listen(PORT, () => {
  console.log(`🚀 LP Burn bot fut a ${PORT} porton (on-chain pricing)`);
});
