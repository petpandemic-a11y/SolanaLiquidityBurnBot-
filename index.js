const { Connection, PublicKey } = require("@solana/web3.js");

// 🔧 Helper függvény, hogy biztosan legyen toBase58 string
function toPubkeyString(address) {
  try {
    if (!address) return null;
    if (typeof address === "string") {
      return new PublicKey(address).toBase58();
    } else if (address && typeof address.toBase58 === "function") {
      return address.toBase58();
    }
  } catch (e) {
    console.error("❌ PublicKey konverzió hiba:", e.message);
  }
  return null;
}

async function processBurn(sig, connection) {
  try {
    const tx = await connection.getTransaction(sig, {
      maxSupportedTransactionVersion: 0
    });

    if (!tx) {
      console.log("⚠️ Nem található tranzakció:", sig);
      return;
    }

    // Mint cím kiszedése
    let mintRaw = tx.transaction.message.accountKeys[0];
    let mint = toPubkeyString(mintRaw);

    // LP burn logika (csak akkor, ha biztosan van mint)
    if (mint) {
      console.log("🔥 LP Burn észlelve!");
      console.log("Mint:", mint);
      console.log("Tx:", `https://solscan.io/tx/${sig}`);
      
      // ide jön a Telegram poszt pl.
    } else {
      console.log("⚠️ Nem sikerült mint címet konvertálni:", sig);
    }

  } catch (err) {
    console.error("🚨 Burn feldolgozási hiba:", err.message);
  }
}
