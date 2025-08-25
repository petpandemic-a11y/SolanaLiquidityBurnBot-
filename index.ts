import express from "express";
import { Connection, clusterApiUrl, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";

// --- ENV változók (Render-en kell megadni) ---
const PORT = process.env.PORT || 3000;
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || clusterApiUrl("mainnet-beta");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const app = express();
const connection = new Connection(RPC_ENDPOINT, { commitment: "confirmed" });

// --- Token név lekérdezése on-chain metadata alapján ---
async function getTokenName(mint: string): Promise<string | null> {
  try {
    // Metaplex Metadata PDA kiszámítása
    const metadataProgramId = new PublicKey(
      "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s" // Metaplex Metadata Program
    );
    const [metadataPDA] = await PublicKey.findProgramAddress(
      [
        Buffer.from("metadata"),
        metadataProgramId.toBuffer(),
        new PublicKey(mint).toBuffer(),
      ],
      metadataProgramId
    );

    const accountInfo = await connection.getAccountInfo(metadataPDA);
    if (!accountInfo) return null;

    // Metadata parsing (egyszerű string keresés)
    const data = accountInfo.data.toString();
    const match = data.match(/[\x20-\x7E]{3,}/g); // olvasható stringek
    if (!match) return null;

    const possibleName = match.find((s) => s.length < 30);
    return possibleName || null;
  } catch (e) {
    console.error("getTokenName error:", e);
    return null;
  }
}

// --- Telegram üzenet küldés ---
async function sendTelegramMessage(text: string) {
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      }
    );
  } catch (e) {
    console.error("Telegram error:", e);
  }
}

// --- Burn figyelés ---
async function startBurnListener() {
  connection.onLogs("all", async (log) => {
    try {
      if (!log.logs.some((l) => l.includes("Instruction: Burn"))) return;

      // Mint cím kinyerése a logból
      const mintMatch = log.logs.find((l) => l.includes("mint:"));
      if (!mintMatch) return;

      const mint = mintMatch.split(" ").pop()?.trim();
      if (!mint) return;

      const tokenName = await getTokenName(mint);

      if (tokenName && tokenName.toUpperCase().includes("LP")) {
        const msg = `🔥 LP Burn detected!\nToken: ${tokenName}\nMint: ${mint}`;
        console.log(msg);
        await sendTelegramMessage(msg);
      }
    } catch (e) {
      console.error("Burn listener error:", e);
    }
  });
}

// --- Express keep-alive (Render miatt kell) ---
app.get("/", (_, res) => res.send("LP Burn Bot is running ✅"));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startBurnListener();
});
