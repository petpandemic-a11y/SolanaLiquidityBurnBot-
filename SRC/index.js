import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

const BITQUERY_URL = "https://graphql.bitquery.io";

async function fetchLPBurns(limit = 20) {
  const query = `
    query LPBurns($limit: Int!) {
      solana {
        transfers(
          options: {limit: $limit, desc: "block.timestamp.time"}
          transferType: burn
        ) {
          block {
            timestamp {
              time
            }
          }
          currency {
            address
            symbol
            name
          }
          amount
          sender {
            address
          }
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
      { query, variables: { limit } },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${BITQUERY_API_KEY}`,
        },
      }
    );

    return res.data.data?.solana?.transfers || [];
  } catch (e) {
    console.error("Bitquery API hiba:", e.response?.data || e.message);
    return [];
  }
}

async function checkBurnEvents() {
  console.log("🔄 Ellenőrzés indul...");

  const burns = await fetchLPBurns(20);

  for (const burn of burns) {
    const msg = `
🔥 *LP Token Burn Detected!* 🔥

💎 *Token:* ${burn.currency.name} (${burn.currency.symbol})
📜 *Contract:* \`${burn.currency.address}\`
📤 *Sender:* \`${burn.sender.address}\`
📥 *Burn Address:* \`${burn.receiver.address}\`
💰 *Amount:* ${burn.amount}
⏰ *Time:* ${burn.block.timestamp.time}
🔗 [Tx on Solscan](https://solscan.io/tx/${burn.transaction.signature})
    `;

    await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
  }
}

setInterval(checkBurnEvents, 10000);
