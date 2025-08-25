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
    if (!accountInfo) {
      console.log(`[INFO] Nincs metadata account a minthez: ${mint}`);
      return null;
    }

    const data = accountInfo.data.toString();
    const match = data.match(/[\x20-\x7E]{3,}/g); // olvasható stringek
    if (!match) return null;

    const possibleName = match.find((s) => s.length < 30);
    return possibleName || null;
  } catch (e) {
    console.error(`[ERROR] getTokenName hiba mint=${mint}:`, e);
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
    console.log(`[TG] Üzenet elküldve: ${text}`);
  } catch (e) {
    console.error("[ERROR] Telegram hiba:", e);
  }
}

// --- Burn figyelés ---
async function startBurnListener() {
  console.log(`[INIT] LP Burn figyelés indul RPC-n: ${RPC_ENDPOINT}`);

  connection.onLogs("all", async (log) => {
    try {
      if (!log.logs.some((l) => l.includes("Instruction: Burn"))) return;

      console.log("---------------------------------------------------");
      console.log(`[BURN] Burn esemény tx=${log.signature}`);

      // Mint cím kinyerése a logból (egyszerű keresés)
      const mintMatch = log.logs.find((l) => l.includes("mint:"));
      if (!mintMatch) {
        console.log("[WARN] Nem találtam mint címet a logban");
        return;
      }

      const mint = mintMatch.split(" ").pop()?.trim();
      if (!mint) {
        console.log("[WARN] Mint cím parsing sikertelen");
        return;
      }

      console.log(`[INFO] Burn mint=${mint}`);

      const tokenName = await getTokenName(mint);
      console.log(`[INFO] Token név=${tokenName || "ismeretlen"}`);

      if (tokenName && tokenName.toUpperCase().includes("LP")) {
        const msg = `🔥 <b>LP Burn detected!</b>\n\nToken: ${tokenName}\nMint: <code>${mint}</code>\nTx: https://solscan.io/tx/${log.signature}`;
        console.log("[MATCH] LP Burn megfelelt → küldés Telegramra");
        await sendTelegramMessage(msg);
      } else {
        console.log("[SKIP] Nem LP token, kihagyva");
      }
    } catch (e) {
      console.error("[ERROR] Burn listener hiba:", e);
    }
  });
}

// --- Express keep-alive (Render miatt kell) ---
app.get("/", (_, res) => res.send("LP Burn Bot is running ✅"));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startBurnListener();
});
