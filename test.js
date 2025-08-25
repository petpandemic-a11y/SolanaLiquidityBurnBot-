import fetch from "node-fetch";

const RENDER_URL = process.env.RENDER_URL || "http://localhost:3000";

async function sendTestPayload() {
  const fakeBurnPayload = {
    type: "transaction",
    transaction: {
      signatures: ["FAKE_SIGNATURE_123456"],
      message: {
        accountKeys: [
          { pubkey: "So11111111111111111111111111111111111111112" }, // SOL mint
          { pubkey: "FakeTokenMintAddress1111111111111111111111111" } // Fake meme token
        ],
        instructions: [
          {
            program: "spl-token",
            parsed: {
              type: "burn",
              info: {
                amount: "5000000000", // LP token burn mennyiség
                mint: "FakeLPTokenMint11111111111111111111111111",
                owner: "BurnWallet111111111111111111111111111111"
              }
            }
          }
        ]
      }
    },
    meta: {
      postBalances: [],
      preBalances: [],
      logMessages: ["Program log: Burn instruction detected"]
    }
  };

  try {
    const res = await fetch(`${RENDER_URL}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fakeBurnPayload)
    });

    console.log("➡️ Teszt payload elküldve, status:", res.status);
  } catch (err) {
    console.error("❌ Teszt payload küldési hiba:", err);
  }
}

sendTestPayload();
