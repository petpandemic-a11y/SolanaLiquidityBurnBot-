import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const raydiumUrl = process.env.RAYDIUM_API;
const orcaUrl = process.env.ORCA_API;
const jupiterUrl = process.env.JUPITER_API;

const cachePath = "./SRC/lp-cache.json";

// LP-token mint címek lekérése
export async function fetchLPTokens() {
  let lpTokens = [];

  try {
    // RAYDIUM API
    const rayRes = await axios.get(raydiumUrl);
    if (rayRes.data) {
      for (const pool of rayRes.data) {
        if (pool.lpMint) lpTokens.push(pool.lpMint);
      }
    }
  } catch (e) {
    console.error("[Raydium API hiba]:", e.message);
  }

  try {
    // ORCA API
    const orcaRes = await axios.get(orcaUrl);
    if (orcaRes.data) {
      for (const key in orcaRes.data) {
        const pool = orcaRes.data[key];
        if (pool.poolTokenMint) lpTokens.push(pool.poolTokenMint);
      }
    }
  } catch (e) {
    console.error("[Orca API hiba]:", e.message);
  }

  try {
    // JUPITER API
    const jupRes = await axios.get(jupiterUrl);
    if (jupRes.data?.data) {
      for (const pool of jupRes.data.data) {
        if (pool.lpMint) lpTokens.push(pool.lpMint);
      }
    }
  } catch (e) {
    console.error("[Jupiter API hiba]:", e.message);
  }

  // Duplikátumok kiszűrése
  lpTokens = [...new Set(lpTokens)];

  // Mentés cache-be
  fs.writeFileSync(cachePath, JSON.stringify(lpTokens, null, 2));

  console.log(`[Bot] LP-token lista frissítve. Összesen: ${lpTokens.length}`);
  return lpTokens;
}
