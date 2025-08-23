import express from "express";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.use(express.json());

// Telegram bot inicializálás
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

// Burn címek listája
const BURN_ADDRESSES = [
  "11111111111111111111111111111111", // Solana null address
  "1nc1nerator11111111111111111111111111111", // hivatalos incinerator
  "Burn11111111111111111111111111111111111"
];

// Helius RPC endpoint
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

// Token meta lekérdezés Helius RPC-ből
async function getTokenInfo(mintAddress) {
  try {
    const response = await axios.post(HELIUS_RPC, {
      jsonrpc: "2.0",
      id: "burn-bot",
      method: "getAsset",
      params: { id: mintAddress }
    });

    const token = response.data?.result;
    if (!token) return { name: mintAddress, decimals: 0 };

    return {
      name: token.content?.metadata?.name || mintAddress,
      decimals: token.token_info?.decimals || 0
    };
  } catch (err) {
    console.error("❌ Token info lekérési hiba:", err.message);
    return { name: mintAddress, decimals: 0 };
  }
}

// Webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;

    if (!Array.isArray(data)) {
      console.log("⚠️ Üres webhook érkezett");
      return res.status(200).send("OK");
    }

    for (const tx of data) {
      const instructions = tx.instructions || [];

      for (const ix of instructions) {
        const destination = ix.parsed?.info?.destination;
        const mint = ix.parsed?.info?.mint || ix.parsed?.info?.tokenAddress;

        if (destination && BURN_ADDRESSES.includes(destination) && mint) {
          const tokenInfo = await getTokenInfo(mint);

          let rawAmount = ix.parsed?.info?.amount
            || ix.parsed?.info?.tokenAmount?.uiAmount
            || ix.parsed?.info?.tokenAmount?.amount
            || 0;

          const amount = tokenInfo.decimals > 0
            ? (rawAmount / Math.pow(10, tokenInfo.decimals)).toFixed(2)
            : rawAmount;

          const message = `
🔥 *LP BURN ÉSZLELVE* 🔥

Token: ${tokenInfo.name}
Összeg: ${amount}
Tx: https://solscan.io/tx/${tx.signature}
          `;

          await bot.sendMessage(process.env.CHANNEL_ID, message, {
            parse_mode: "Markdown"
          });

          console.log(`✅ LP Burn posztolva: ${tx.signature}`);
        }
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Webhook feldolgozási hiba:", error);
    res.status(500).send("Error");
  }
});

// Egyszerű státusz ellenőrző endpoint
app.get("/", (req, res) => {
  res.send("✅ Solana LP Burn Bot fut!");
});

// Szerver indítása
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook szerver fut a ${PORT}-es porton`);
});
