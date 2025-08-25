import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== Beállítások =====
const PORT = process.env.PORT || 10000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const HELIUS_SECRET = process.env.HELIUS_WEBHOOK_SECRET || null;
const ENRICH = (process.env.ENRICH_WITH_DEXSCREENER || "true").toLowerCase() === "true";
const DS_MIN_INTERVAL = Number(process.env.DEXSCREENER_MIN_INTERVAL_MS || 1500);
const DS_TIMEOUT = Number(process.env.DEXSCREENER_TIMEOUT_MS || 4000);

// Fő DEX programok (LP only)
const PROGRAM_RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const PROGRAM_ORCA_WHIRLPOOLS = "9WFFm2i7TH4FzZ4PWzj1pYJKXxA9HBQ5fZVnK8hEJbbz";
// Ha van pontos Pump.fun pool program ID-d, tedd ide:
const PROGRAM_PUMPFUN = "Fg6PaFpoGXkYsidMpWxTWqkxhM8GdZ9XMBqMfmD9oeUo"; // példa – cseréld valódira, ha kell

const DEX_PROGRAMS = new Set([
  PROGRAM_RAYDIUM_AMM,
  PROGRAM_ORCA_WHIRLPOOLS,
  PROGRAM_PUMPFUN,
]);

// ===== Telegram helper =====
async function sendTG(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.warn("⚠️ Telegram adatok hiányoznak – nem posztolok.");
    return;
  }
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const body = { chat_id: TG_CHAT, text, parse_mode: "Markdown" };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) console.error("❌ Telegram hiba:", j);
    else console.log("📨 Üzenet elküldve Telegramra.");
  } catch (e) {
    console.error("❌ Telegram fetch hiba:", e.message);
  }
}

// ===== DexScreener helper (cache + rate-limit) =====
const pairCache = new Map(); // mint -> { data, ts }
let lastDexScreenerCall = 0;

async function safeDexScreenerByMint(mint) {
  if (!ENRICH) return null;
  const now = Date.now();

  // Cache 6 órára
  const cached = pairCache.get(mint);
  if (cached && now - cached.ts < 6 * 60 * 60 * 1000) return cached.data;

  // Rate-limit
  const wait = lastDexScreenerCall + DS_MIN_INTERVAL - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), DS_TIMEOUT);

  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: ctrl.signal });
    lastDexScreenerCall = Date.now();
    clearTimeout(to);
    if (!resp.ok) {
      console.warn("DexScreener nem OK:", resp.status);
      return null;
    }
    const data = await resp.json();
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
    // Csak akkor fogadjuk el, ha a mint valóban LP-hez tartozik valamely párban
    const relevant = pairs.find(p =>
      p?.lpToken?.address === mint || p?.baseToken?.address === mint || p?.quoteToken?.address === mint
    );
    pairCache.set(mint, { data: relevant || null, ts: Date.now() });
    return relevant || null;
  } catch (e) {
    clearTimeout(to);
    console.warn("DexScreener hiba:", e.message);
    return null;
  }
}

// ===== LP Burn detektálás a Helius payloadból =====
// Helius Enhanced webhook tipikusan: { type, timestamp, transactions: [ { signature, accountData, events, logMessages, ... } ] }
function isFromKnownDex(tx) {
  try {
    const keys = tx?.accountKeys || tx?.transaction?.message?.accountKeys || [];
    const keyStrings = keys.map(k => (typeof k === "string" ? k : k?.toString?.() || k?.pubkey || "")); // toleráns
    return keyStrings.some(k => DEX_PROGRAMS.has(k));
  } catch {
    return false;
  }
}

function extractBurnsFromTx(tx) {
  // Kikeressük az olyan parsed/inner instruction-öket, ahol type = 'burn'
  const burns = [];

  const allIxs = [
    ...(tx?.transaction?.message?.instructions || []),
    ...((tx?.meta?.innerInstructions || []).flatMap(ii => ii.instructions) || []),
    ...(tx?.instructions || []), // Helius formátum
  ];

  for (const ix of allIxs) {
    const parsed = ix?.parsed || ix?.data?.parsed || null;
    const progId = ix?.programId || ix?.programIdIndex || ix?.program || null;

    // Csak SPL Token burn (Token Program) – Helius parsed: parsed.type === 'burn'
    const isBurn = parsed?.type?.toLowerCase?.() === "burn";
    if (!isBurn) continue;

    const info = parsed?.info || {};
    const mint = info?.mint || info?.mintAccount || null;
    const rawAmount = info?.amount || info?.tokenAmount || null;

    burns.push({
      mint,
      amount: Number(rawAmount) || 0,
      programRef: progId,
    });
  }
  return burns;
}

// ===== Webhook endpoint =====
app.post("/webhook", async (req, res) => {
  // Gyors ACK, hogy ne legyen retry
  res.status(200).send("ok");

  try {
    // Opcionális Secret ellenőrzés
    if (HELIUS_SECRET) {
      const inc = req.headers["x-hel-secrettoken"] || req.headers["x-hel-secret"] || "";
      if (inc && inc !== HELIUS_SECRET) {
        console.warn("⚠️ Secret mismatch – esemény eldobva.");
        return;
      }
    }

    const body = req.body;
    if (!body) { console.warn("⚠️ Üres webhook body"); return; }

    const txs = Array.isArray(body) ? body : (body?.transactions || body?.events || []);
    if (!Array.isArray(txs) || txs.length === 0) { 
      console.log("ℹ️ Nincs feldolgozható tranzakció ebben a batch-ben.");
      return; 
    }

    for (const tx of txs) {
      const sig = tx?.signature || tx?.transaction?.signatures?.[0] || "(ismeretlen)";
      const fromDex = isFromKnownDex(tx);
      if (!fromDex) {
        // Kreditspórolás: csak DEX-es tx-eket nézünk tovább
        continue;
      }

      const burns = extractBurnsFromTx(tx);
      if (!burns.length) continue;

      for (const b of burns) {
        const mint = typeof b.mint === "string" ? b.mint : (b.mint?.toString?.() || null);
        if (!mint) {
          console.warn("[WARN] Burn talált, de nincs mint cím. Sig:", sig);
          continue;
        }

        // Enrichment (cache-elt)
        const pair = await safeDexScreenerByMint(mint);

        // Üzenet összeállítás
        let lines = [];
        lines.push("🔥 *LP Burn észlelve!*");
        lines.push(`Tx: https://solscan.io/tx/${sig}`);
        lines.push(`Mint: \`${mint}\``);

        if (pair) {
          const base = `${pair.baseToken?.name || ""} (${pair.baseToken?.symbol || "?"})`;
          const quote = pair.quoteToken?.symbol || "?";
          lines.push(`Pool: *${base} / ${quote}*`);
          if (b.amount) {
            // LP token mennyiség – USD érték csak becslés, ha van priceUsd
            const usd = pair.priceUsd ? (b.amount * Number(pair.priceUsd)).toFixed(2) : null;
            lines.push(`Égetett LP: ${b.amount.toLocaleString()}${usd ? ` (~$${usd})` : ""}`);
          }
          if (pair?.liquidity?.usd) lines.push(`Likviditás: $${Number(pair.liquidity.usd).toLocaleString()}`);
          if (pair?.fdv) lines.push(`FDV: $${Number(pair.fdv).toLocaleString()}`);
          if (pair?.url) lines.push(`DexScreener: ${pair.url}`);
        } else {
          lines.push("_(Nincs DexScreener adat – cache/limit miatt vagy nem LP pár)_");
        }

        const msg = lines.join("\n");
        console.log(`[BURN] ${sig} – ${mint}`);
        await sendTG(msg);
      }
    }
  } catch (e) {
    console.error("🚨 Webhook feldolgozási hiba:", e.message);
  }
});

// Healthcheck
app.get("/", (_req, res) => res.send("LP burn webhook él ✅"));

// Indítás
app.listen(PORT, () => {
  console.log(`✅ Server fut a ${PORT} porton`);
  console.log("🌍 Webhook endpoint: POST /webhook");
  console.log("🔒 Helius secret ellenőrzés:", HELIUS_SECRET ? "bekapcsolva" : "kikapcsolva");
});
