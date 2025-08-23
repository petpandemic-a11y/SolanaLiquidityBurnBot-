import { Connection, PublicKey } from "@solana/web3.js";
import { Telegraf } from "telegraf";
import dotenv from "dotenv";

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const CHANNEL_ID = process.env.CHANNEL_ID;
const connection = new Connection(process.env.RPC_URL, "confirmed");

// Burn címek
const BURN_ADDRESSES = [
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111"
];

console.log("🚀 LP Burn Bot indul...");

const subscribeToBurns = async () => {
  connection.onLogs("all", async (log) => {
    try {
      const sig = log.signature;
      const tx = await connection.getParsedTransaction(sig, { commitment: "confirmed" });

      if (!tx?.transaction?.message?.instructions) return;

      for (const ix of tx.transaction.message.instructions) {
        const programId = ix.programId?.toString();
        if (!programId) continue;

        if (ix.parsed?.type === "transfer" || ix.parsed?.type === "burn") {
          const { source, destination, amount } = ix.parsed.info;

          // Csak LP burn érdekel
          if (BURN_ADDRESSES.includes(destination)) {
            const token = ix.parsed.info.mint || "Ismeretlen token";
            console.log(`🔥 LP Burn észlelve! Token: ${token}, Mennyiség: ${amount}`);

            await bot.telegram.sendMessage(
              CHANNEL_ID,
              `🔥 **LP Burn észlelve!**\n\n` +
              `💎 Token: \`${token}\`\n` +
              `💧 Mennyiség: ${amount}\n` +
              `📜 Tx: https://solscan.io/tx/${sig}`,
              { parse_mode: "Markdown" }
            );
          }
        }
      }
    } catch (err) {
      console.error("Hiba:", err.message);
    }
  });

  console.log("👂 Figyelem a tranzakciókat...");
};

subscribeToBurns();
