import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY;

// Solscan API LP burn eseményekhez
const SOLSCAN_API = "https://public-api.solscan.io/account/tokens";
const BIRDEYE_API = "https://public-api.birdeye.so/public/token";

// Token infók lekérése Birdeye API-ról (price, mcap, holders)
async function fetchTokenInfo(tokenAddress) {
  try {
    const res = await axios.get(`${BIRDEYE_API}?address=${tokenAddress}`, {
      headers: { "X-API-KEY": BIRDEYE_API_KEY },
    });
    const data = res.data.data;
    return {
      price: data.price || null,
      mcap: data.mc || null,
      holders: data.holder || null,
    };
  } catch (e) {
    console.error("Token info lekérés hiba:", e.message);
    return { price: null, mcap: null, holders: null };
  }
}

// LP burn események ellenőrzése Solscan API-n keresztül
async function fetchBurnEvents() {
  try {
    // Lekérjük a legutóbbi tranzakciókat az LP poolokból
    const res = await axios.get(
      "https://public-api.solscan.io/transaction?limit=20"
    );
    const txs = res.data || [];

    for (const tx of txs) {
      if (!tx.tokenTransfers) continue;

      for (const transfer of tx.tokenTransfers) {
        // Csak burn tranzakciók
        if (
          transfer.destination &&
          transfer.destination === "11111111111111111111111111111111" // Solana burn address
        ) {
          const tokenAddress = transfer.mint;
          const burnedAmount = Number(transfer.amount);

          // Ellenőrizzük az LP teljes mennyiségét
          const tokenInfo = await fetchTokenInfo(tokenAddress);
          if (!tokenInfo || !tokenInfo.mcap || burnedAmount <= 0) continue;

          // Ha az LP teljesen elégett
          if (burnedAmount >= transfer.amount) {
            const msg = `
🔥 *100% LP Burn Detected!* 🔥

💎 *Token:* ${transfer.tokenSymbol || "Unknown"}
📜 *Contract:* \`${tokenAddress}\`
💰 *Price:* $${tokenInfo.price ? tokenInfo.price.toFixed(6) : "N/A"}
📈 *Market Cap:* $${tokenInfo.mcap ? tokenInfo.mcap.toLocaleString() : "N/A"}
👥 *Holders:* ${tokenInfo.holders || "N/A"}
🔥 *Amount Burned:* ${burnedAmount.toLocaleString()}
🔗 [View Transaction](https://solscan.io/tx/${tx.txHash})
            `;

            await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
          }
        }
      }
    }
  } catch (e) {
    console.error("LP burn lekérés hiba:", e.message);
  }
}

// 10 másodpercenként ellenőrizzük
setInterval(fetchBurnEvents, 10000);
