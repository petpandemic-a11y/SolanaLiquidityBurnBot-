import express from "express";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const app = express();
app.use(express.json());

// Telegram bot inicializálás
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });
const CHANNEL_ID = process.env.CHANNEL_ID;

// Helius webhook endpoint
app.post("/webhook", async (req, res) => {
    try {
        const data = req.body;

        // Ellenőrizzük, hogy van-e tranzakció adat
        if (!data || !data[0] || !data[0].tokenTransfers || data[0].tokenTransfers.length === 0) {
            console.log("⚠️ Nincsenek token tranzakciók ebben a webhookban.");
            return res.status(200).send("OK");
        }

        // Végigmegyünk az összes token transferen
        for (const tx of data[0].tokenTransfers) {
            const { tokenAmount, mint, fromUserAccount, toUserAccount } = tx;

            // Csak akkor érdekel, ha a token "elégett" → célcím = burn address
            const burnAddresses = [
                "11111111111111111111111111111111",
                "1nc1nerator11111111111111111111111111111",
                "burn111111111111111111111111111111111111111"
            ];

            if (burnAddresses.includes(toUserAccount)) {
                const signature = data[0].signature || "Ismeretlen";

                const message = `
🔥 *LP BURN ÉSZLELVE!* 🔥

💧 Token: \`${mint}\`
📉 Összeg: ${tokenAmount} LP
📜 Tranzakció: [Nézd meg Solscan-en](https://solscan.io/tx/${signature})
`;

                // Üzenet küldése Telegram csatornára
                await bot.sendMessage(CHANNEL_ID, message, { parse_mode: "Markdown" });
                console.log("🚀 LP Burn észlelve, posztolva!");
            }
        }

        res.status(200).send("OK");
    } catch (error) {
        console.error("❌ Webhook feldolgozási hiba:", error);
        res.status(500).send("Hiba");
    }
});

// Szerver indítása Renderen
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Webhook szerver fut a ${PORT}-es porton`);
});
