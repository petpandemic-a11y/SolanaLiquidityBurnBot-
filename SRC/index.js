import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

// ====== ENV változók ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY;

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

const BITQUERY_URL = "https://graphql.bitquery.io";
const BURN_ADDRESSES = [
  "11111111111111111111111111111111",
  "1nc1nerator11111111111111111111111111111"
];
const LP_BURN_THRESHOLD = 95; // százalékban

// ====== Bitquery GraphQL lekérdezés LP burn eseményekre ======
async function fetchLPBurns() {
  const query = `
    query LPBurns {
      solana(network: solana) {
        transfers(
          options: {desc: "block.timestamp.time", limit: 10}
          date: {since: "2025-08-23T00:00:00"}
          receiverAddress: {in: ${JSON.stringify(BURN_ADDRESSES)}}
        ) {
          block {
            timestamp {
              time(format: "%Y-%m-%d %H:%M:%S")
            }
          }
          amount
          currency {
            symbol
            address
          }
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
    const response = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${BITQUERY_API_KEY}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Bitquery API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (data.errors) {
      console.error("⚠️ Bitquery GraphQL hiba:", data.errors);
      return [];
    }

    return data.data?.solana?.transfers || [];
  } catch (error) {
    console.error("⚠️ Fetch hiba:", error.message);
    return [];
  }
}

// ====== Token total supply lekérdezése ======
async function fetchTotalSupply(tokenAddress) {
  const query = `
    query TokenSupply {
      solana(network: solana) {
        address(address: {is: "${tokenAddress}"}) {
          annotation {
            totalSupply
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(BITQUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${BITQUERY_API_KEY}`,
      },
      body: JSON.stringify({ query }),
    });

    const data = await response.json();
    return data.data?.solana?.address?.[0]?.annotation?.totalSupply || 0;
  } catch {
    return 0;
  }
}

// ====== LP burn események feldolgozása ======
async function checkLPBurns() {
  console.log("🔄 Ellenőrzés indul...");
  const burns = await fetchLPBurns();

  if (!burns.length) {
    console.log("ℹ️ Nincs új LP burn esemény.");
    return;
  }

  for (const burn of burns) {
    const totalSupply = await fetchTotalSupply(burn.currency.address);
    if (!totalSupply || totalSupply === 0) continue;

    const percentBurned = (burn.amount / totalSupply) * 100;

    if (percentBurned >= LP_BURN_THRESHOLD) {
      const msg = `
🔥 **ÚJ LP BURN** 🔥
Token: ${burn.currency.symbol}
Elégetett LP: ${percentBurned.toFixed(2)}%
Burn cím: ${burn.receiver.address}
Tx: https://solscan.io/tx/${burn.transaction.signature}
⏰ Idő: ${burn.block.timestamp.time}
      `;
      console.log(msg);
      await bot.sendMessage(CHANNEL_ID, msg, { parse_mode: "Markdown" });
    }
  }
}

// ====== Bot indítása ======
console.log("🚀 LP Burn Bot elindult! Csak Bitquery API-t használ.");
setInterval(checkLPBurns, 10000);
