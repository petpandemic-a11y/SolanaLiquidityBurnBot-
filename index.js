import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

// ENV változók
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HELIUS_WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET;

// LP pool címek
const LP_ADDRESSES = new Set([
    // Raydium
    "4k3Dyjzvzp8eMZWUXbBCX8iMLV6jt9M2syCofQJGsC2A",
    "CmzA5i2tj7LQmch1oVvqASQSczDaHCL1zE1EXaJHk7Kx",
    "4rvD8MpjEALkSmmkKXZcXshxFXF5JhZYcw1AiJfXKc5Q",
    "5quBuwTUpTAtTXDN2edwvYfWw7N2gn1hBXD5z6HKz5xa",
    "66v6U9uWEs9rT5KwXGwvFdnLKwK5YkCk2XHj38vWVJkD",
    // Orca
    "6UeJwXQxUuTxmkpPGyK5u8iM2J1U9W2XZqdt24xjSg7M",
    "GZp8ivkYJ8ueKyt7hA9CFguLEp82bU9sZVrBEMcA4ZsF",
    "7RrwLUuMqRRm6RHs2CmDRvxRH7qAjRHBKYpsxf1xZDWV",
    "2xM8Y1X8vF2JbDg9D8ZbxYwDhzD5fYdtbUuN3kwHq1bK",
    // Jupiter
    "Hxh7E2Jcz75m2wAqD6u7skfoeHq5Vg8UMf9k7Y4Q1Rkh",
    "7bhRjMbb4jV9VZZtcso7WrRAAEv4dTiyFMcw6FFkFipN",
    "8CDeXynWTuR11PHQ1WbD3LEdGZzex4q7U8eVtMEzzRyd",
    "3L1kjj1EdV86iH7Kxf8PSYiqXQffVkL6Uxxm3tkVztgL"
]);

// Webhook endpoint
app.post("/webhook", async (req, res) => {
    const sig = req.headers["x-helius-signature"];
    const raw = JSON.stringify(req.body);

    // Ellenőrizzük a Helius aláírást
    const hash = crypto.createHmac("sha256", HELIUS_WEBHOOK_SECRET)
        .update(raw)
        .digest("hex");

    if (sig !== hash) {
        console.error("❌ Helius webhook signature mismatch");
        return res.status(403).send("Forbidden");
    }

    const events = req.body;

    for (const tx of events) {
        const signature = tx.signature || "Ismeretlen";
        const type = tx.type || "UNKNOWN";
        const accounts = tx.accounts || [];

        // Csak akkor dolgozunk, ha BURN tranzakció és LP poolból megy
        if (type === "BURN" && accounts.some(a => LP_ADDRESSES.has(a))) {
            const token = tx.token || "Ismeretlen token";
            const amount = tx.amount || "Ismeretlen összeg";

            const msg = `🔥 LP BURN 🔥\nToken: ${token}\nÖsszeg: ${amount}\nTx: https://solscan.io/tx/${signature}`;

            console.log("📤 Telegram küldés:", msg);

            await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg })
            });
        }
    }

    res.status(200).send("OK");
});

// Indítás
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
