import express from "express";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "10mb" }));

// ====== WEBHOOK ======
app.post("/webhook", (req, res) => {
  console.log("🟢 ÚJ WEBHOOK HÍVÁS ÉRKEZETT");
  console.log("📅 Idő:", new Date().toISOString());
  console.log("📩 Headers:", JSON.stringify(req.headers, null, 2));

  try {
    const body = req.body;

    if (!body || body.length === 0) {
      console.warn("⚠️ Üres body érkezett!");
    } else {
      console.log("📦 Teljes Body JSON:", JSON.stringify(body, null, 2));

      // Ha enhanced webhook jön, signaturek logolása
      body.forEach((tx, i) => {
        console.log(`➡️ [${i}] Tx signature: ${tx.signature || "N/A"}`);

        if (tx.events?.amm) {
          console.log(`   🔄 AMM Event:`, JSON.stringify(tx.events.amm, null, 2));
        }

        if (tx.events?.token) {
          console.log(`   💰 Token Event:`, JSON.stringify(tx.events.token, null, 2));
        }
      });
    }

    res.status(200).send("✅ OK");
  } catch (err) {
    console.error("❌ Hiba feldolgozás közben:", err);
    res.status(500).send("❌ Hiba a webhook feldolgozásban");
  }
});

// ====== HEALTHCHECK ======
app.get("/", (req, res) => {
  res.send("🔥 Webhook szerver fut!");
});

app.listen(PORT, () => {
  console.log(`🚀 Szerver elindult a porton: ${PORT}`);
});
