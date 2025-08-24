import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// --- ENV változók ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID;  // Csatorna vagy chat
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!TELEGRAM_BOT_TOKEN || !ALERT_CHAT_ID || !HELIUS_API_KEY) {
    console.error("❌ Hiányzó environment változók!");
    process.exit(1);
}

// --- Telegram bot ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// --- Express middleware ---
app.use(
    express.json({
        verify: (req, res, buf) => {
            req.rawBody = buf;
        },
    })
);

// --- Webhook végpont ---
app.post("/webhook", async (req, res) => {
    try {
        const heliusSig = req.headers["x-helius-signature"];
        if (!heliusSig) {
            console.warn("⚠️ Helius signature missing");
            return res.status(401).send("Missing signature");
        }

        // Ellenőrizzük az aláírást
        const computedSig = crypto
            .createHmac("sha256", HELIUS_API_KEY)
            .update(req.rawBody)
            .digest("base64");

        if (computedSig !== heliusSig) {
            console.error("❌ Helius webhook signature mismatch!");
            return res.status(401).send("Invalid signature");
        }

        const events = req.body;
        console.log(`📩 Webhook események száma: ${events.length}`);

        for (const event of events) {
            if (!event || !event.transaction) continue;

            const txSig = event.transaction.signatures?.[0];
            const instructions = event.transaction.message?.instructions || [];

            // Csak LP égetéseket keressük (Raydium, Orca, Jupiter pool)
            const isBurn = instructions.some(
                (ix) =>
                    ix.parsed?.type === "burn" ||
                    ix.parsed?.type === "burnChecked" ||
                    ix.program === "spl-token"
            );

            if (!isBurn) continue;

            // Token info lekérés
            const mint = instructions.find((ix) => ix.parsed?.info?.mint)?.parsed?.info?.mint;

            const tokenInfo = await getTokenInfo(mint);

            // Telegram értesítés
            await sendTelegramAlert({
                txSig,
                tokenName: tokenInfo.name,
                tokenSymbol: tokenInfo.symbol,
                mint,
                timestamp: new Date(event.blockTime * 1000),
            });
        }

        res.status(200).send("OK");
    } catch (error) {
        console.error("❌ Webhook feldolgozási hiba:", error.message);
        res.status(500).send("Internal server error");
    }
});

// --- Token infó lekérdezés (DexScreener + Jupiter fallback) ---
async function getTokenInfo(mint) {
    let info = { name: "Ismeretlen token", symbol: "UNKNOWN" };

    try {
        const dex = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
        if (dex.data?.pairs?.[0]?.baseToken) {
            info = {
                name: dex.data.pairs[0].baseToken.name,
                symbol: dex.data.pairs[0].baseToken.symbol,
            };
            return info;
        }
    } catch (e) {
        console.warn(`⚠️ DexScreener nem adott adatot: ${mint}`);
    }

    try {
        const jup = await axios.get("https://token.jup.ag/strict");
        const token = jup.data.find((t) => t.address === mint);
        if (token) {
            info = { name: token.name, symbol: token.symbol };
            return info;
        }
    } catch (e) {
        console.warn(`⚠️ Jupiter nem adott adatot: ${mint}`);
    }

    return info;
}

// --- Telegram értesítés ---
async function sendTelegramAlert(burnInfo) {
    const message = `
🔥 **LP BURN ÉSZLELVE** 🔥

💰 **Token:** ${burnInfo.tokenName} (${burnInfo.tokenSymbol})
🏷️ **Mint:** \`${burnInfo.mint}\`
📊 **Tranzakció:** [Solscan](https://solscan.io/tx/${burnInfo.txSig})
⏰ **Időpont:** ${burnInfo.timestamp.toLocaleString("hu-HU")}

#LPBurned #${burnInfo.tokenSymbol}
    `;

    await bot.sendMessage(ALERT_CHAT_ID, message.trim(), {
        parse_mode: "Markdown",
        disable_web_page_preview: false,
    });

    console.log(`✅ Telegram értesítés küldve: ${burnInfo.tokenSymbol}`);
}

// --- Indítás ---
app.listen(PORT, () => {
    console.log(`🚀 LP Burn Monitor fut a ${PORT} porton`);
});
