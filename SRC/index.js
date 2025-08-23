import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

// Bitquery GraphQL lekérdezés küldése
async function bitqueryRequest(query) {
  const res = await fetch("https://graphql.bitquery.io", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": BITQUERY_API_KEY,
    },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

// Lekérdezzük az LP burn eseményeket
async function fetchBurnEvents() {
  const query = `
  query {
    solana {
      transfers(
        options: {desc: "block.timestamp.time", limit: 10}
        where: {
          transfer_type: {is: burn}
          currency: {tokenType: {is: SPL}}
        }
      ) {
        block {
          timestamp {
            time(format: "%Y-%m-%d %H:%M:%S")
          }
        }
        currency {
          symbol
          name
          address
          decimals
        }
        amount
        transaction {
          signature
        }
      }
    }
  }`;

  try {
    const data = await bitqueryRequest(query);
    const transfers = data.data?.solana?.transfers || [];

    for (const tx of transfers) {
      const tokenAddress = tx.currency.address;
      const amountBurned = Number(tx.amount);

      // Lekérjük az LP teljes mennyiségét
      const totalSupply = await fetchTotalSupply(tokenAddress);
      if (!totalSupply || amountBurned < totalSupply) continue; // Csak 100%-os burn posztolódjon

      // Lekérjük token infókat (mcap, price, holders)
      const tokenInfo = await fetchTokenInfo(tokenAddress);

      const msg = `
🔥 *100% LP Burn Detected!* 🔥

💎 *Token:* ${tx.currency.name} (${tx.currency.symbol})
📜 *Contract:* \`${tokenAddress}\`
💰 *Price:* $${tokenInfo.price ? tokenInfo.price.toFixed(6) : "N/A"}
📈 *Market Cap:* $${tokenInfo.mcap ? tokenInfo.mcap.toLocaleString() : "N/A"}
👥 *Holders:* ${tokenInfo.holders || "N/A"}
🔥 *Amount Burned:* ${amountBurned.toLocaleString()}
⏱ *Time:* ${tx.block.timestamp.time}
🔗 [View Transaction](https://solscan.io/tx/${tx.transaction.signature})
      `;

      await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
    }
  } catch (e) {
    console.error("Hiba az események lekérésekor:", e.message);
  }
}

// Teljes kínálat (LP mennyiség) lekérdezése
async function fetchTotalSupply(tokenAddress) {
  const query = `
  query {
    solana {
      tokenSupply(
        where: { mintAddress: {is: "${tokenAddress}"} }
      ) {
        supply
      }
    }
  }`;

  try {
    const data = await bitqueryRequest(query);
    return Number(data.data?.solana?.tokenSupply?.[0]?.supply || 0);
  } catch (e) {
    console.error("TotalSupply hiba:", e.message);
    return null;
  }
}

// Token infók lekérdezése: mcap, price, holders
async function fetchTokenInfo(tokenAddress) {
  const query = `
  query {
    solana {
      tokenHolders(
        where: { mintAddress: {is: "${tokenAddress}"} }
      ) {
        tokenPriceUSD
        marketCapInUSD
      }
      tokenHoldersAggregate(
        where: { mintAddress: {is: "${tokenAddress}"} }
      ) {
        count
      }
    }
  }`;

  try {
    const data = await bitqueryRequest(query);
    return {
      price: data.data?.solana?.tokenHolders?.[0]?.tokenPriceUSD || null,
      mcap: data.data?.solana?.tokenHolders?.[0]?.marketCapInUSD || null,
      holders: data.data?.solana?.tokenHoldersAggregate?.count || null,
    };
  } catch (e) {
    console.error("TokenInfo hiba:", e.message);
    return {};
  }
}

// 10 másodpercenként figyelünk
setInterval(fetchBurnEvents, 10000);
