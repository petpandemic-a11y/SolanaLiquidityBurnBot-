import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RENDER_URL = process.env.RENDER_URL;

// ezt a címet figyeli → Raydium LP program ID (kötelező Helius miatt)
const RAYDIUM_LP_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

async function createWebhook() {
  try {
    const response = await axios.post(
      `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`,
      {
        accountAddresses: [RAYDIUM_LP_PROGRAM],
        webhookURL: `${RENDER_URL}/webhook`,
        transactionTypes: ["TRANSFER"],
        webhookType: "enhanced"
      }
    );

    console.log("✅ Webhook létrehozva:", response.data);
  } catch (err) {
    console.error("❌ Helius webhook létrehozási hiba:", err.response?.data || err.message);
  }
}

createWebhook();
