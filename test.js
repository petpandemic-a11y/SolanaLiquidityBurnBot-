// test.js
import fetch from "node-fetch";

async function main() {
  const webhookUrl = process.env.RENDER_URL || "https://solanaliquidityburnbot.onrender.com/webhook";

  const testPayload = [
    {
      signature: "TEST_SIGNATURE_123",
      events: {
        token: [
          {
            mint: "So11111111111111111111111111111111111111112",
            tokenAmount: "123.45",
            tokenStandard: "Fungible"
          }
        ]
      }
    }
  ];

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testPayload),
    });

    console.log("➡️ Teszt payload elküldve:", JSON.stringify(testPayload, null, 2));
    console.log("✅ Webhook válasz státusz:", res.status);

    const text = await res.text();
    console.log("📩 Webhook válasz tartalom:", text);
  } catch (err) {
    console.error("❌ Hiba a teszt küldésnél:", err);
  }
}

main();
