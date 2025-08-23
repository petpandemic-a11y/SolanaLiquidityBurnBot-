import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

const BITQUERY_URL = "https://graphql.bitquery.io";

const LP_POOLS = [
  "So11111111111111111111111111111111111111112", // Solana USDC LP pool
  "Ray111111111111111111111111111111111111111"  // Raydium LP pool
];

async function fetchLPBurns(poolAddress) {
  const query = `
    query {
      solana(network: solana) {
        transfers(
          options: {desc: "block.timestamp.time", limit: 20}
          transferType: burn
          sender: {is: "${poolAddress}"}
        ) {
          block {
            timestamp {
              time(format: "%Y-%m-%d %H:%M:%S")
            }
          }
          currency {
            address
            symbol
            name
          }
          amount
          receiver {
            address
          }
          transaction {
            signature
          }
        }
      }
    }
  `;

  try {
    const res = await axios.post(
      BITQUERY_URL,
      { query },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${BITQUERY_API_KEY}`
        },
      }
    );

    return res.data.data.solana.transfers || [];
  } catch (e) {
    console.error("Bitquery API hiba:", e.response?.status, e.response?.data || e.message);
    return [];
  }
}

async function checkBurnEvents() {
  console.log("🔄 Ellenőrzés indul...");

  for (const pool of LP_POOLS) {
    const burns = await fetchLPBurns(pool);

    for (const burn of burns) {
      const msg = `
🔥 *LP Token Burn Detected!* 🔥

💎 *Token:* ${burn.currency.name} (${burn.currency.symbol})
📜 *Contract:* \`${burn.currency.address}\`
📤 *Sender (Pool):* \`${pool}\`
📥 *Burn Address:* \`${burn.receiver.address}\`
💰 *Amount:* ${burn.amount}
⏰ *Time:* ${burn.block.timestamp.time}
🔗 [Tx on Solscan](https://solscan.io/tx/${burn.transaction.signature})
      `;

      await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
    }
  }
}

setInterval(checkBurnEvents, 10000);
