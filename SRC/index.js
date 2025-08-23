// SRC/index.js — Minimal Sol Burn Bot (CommonJS, no emojis, SOL mode)
// Filters: MIN_SOL (burn value in SOL), MAX_MCAP_SOL (FDV in SOL), LP fully burned (liqUsd == 0)

"use strict";

/* ===== imports ===== */
const dotenv = require("dotenv");
dotenv.config();

const { fetch } = require("undici"); // garantáltan függvény CommonJS-ben
const { Telegraf } = require("telegraf");
const { Connection, PublicKey, clusterApiUrl } = require("@solana/web3.js");
const { getMint } = require("@solana/spl-token");

/* ===== ENV ===== */
const {
  BOT_TOKEN,
  CHANNEL_ID,
  BITQUERY_API_KEY,     // Bitquery v2 EAP Bearer token (ory_at_...)
  BIRDEYE_API_KEY,      // Birdeye API key
  MIN_SOL = "0",
  MAX_MCAP_SOL = "0",
  POLL_INTERVAL_SEC = "20",
  POLL_LOOKBACK_SEC = "25",
  DEDUP_MINUTES = "10",
  RPC_URL
} = process.env;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!CHANNEL_ID) throw new Error("Missing CHANNEL_ID");
if (!BITQUERY_API_KEY) throw new Error("Missing BITQUERY_API_KEY");
if (!BIRDEYE_API_KEY) console.warn("[WARN] Missing BIRDEYE_API_KEY (prices may fail)");

/* ===== admin ===== */
const ADMIN_IDS = [1721507540]; // <- a te Telegram user ID-d
function isAdmin(ctx){ return !!(ctx && ctx.from && ADMIN_IDS.includes(ctx.from.id)); }

/* ===== globals ===== */
const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL || clusterApiUrl("mainnet-beta"), "confirmed");

let cfg = {
  minSol: Number(MIN_SOL) || 0,
  maxMcapSol: Number(MAX_MCAP_SOL) || 0,
  pollIntervalSec: Number(POLL_INTERVAL_SEC) || 20,
  lookbackSec: Number(POLL_LOOKBACK_SEC) || 25,
  dedupMinutes: Number(DEDUP_MINUTES) || 10
};
let pollTimer = null;

const seen = new Map(); // key: sig::mint → ts

// caches
const PRICE_TTL_MS = 60 * 1000;
const priceCache = new Map(); // mint -> { usdPrice, ts }
const solUsdCache = { price: null, ts: 0 };
const MAX_PRICE_LOOKUPS_PER_POLL = 6;

setInterval(function(){ console.log("[HEARTBEAT]", new Date().toISOString()); }, 15000);

/* ===== helpers ===== */
function short(s){ return (s && s.length > 12 ? s.slice(0,4)+"..."+s.slice(-4) : s); }
function fmtSol(x, frac){ if (frac==null) frac=4; return (x==null ? "n/a" : Number(x).toLocaleString(undefined,{maximumFractionDigits:frac})+" SOL"); }
function fmtNum(x, frac){ if (frac==null) frac=0; return (x==null ? "n/a" : Number(x).toLocaleString(undefined,{maximumFractionDigits:frac})); }
function fmtPct(x){ return (x==null ? "n/a" : (Number(x)*100).toFixed(2)+"%"); }
function nowMs(){ return Date.now(); }
function keyFor(sig, mint){ return (sig||"no-sig")+"::"+(mint||"no-mint"); }

function minutesAgo(tsMs){
  if (!tsMs) return "n/a";
  var m = Math.floor((Date.now()-tsMs)/60000);
  if (m < 1) return "just now";
  if (m === 1) return "1 minute ago";
  return m + " minutes ago";
}
function pruneSeen(){
  var limit = cfg.dedupMinutes * 60 * 1000;
  var t = nowMs();
  Array.from(seen.entries()).forEach(function(ent){
    if (t - ent[1] > limit) seen.delete(ent[0]);
  });
}

function isJsonLike(res){
  var ct = (res.headers.get("content-type") || "").toLowerCase();
  return ct.indexOf("application/json") !== -1;
}
async function fetchJSONWithBackoff(url, opts, maxRetries, baseDelayMs){
  if (!opts) opts = {};
  if (maxRetries==null) maxRetries = 5;
  if (baseDelayMs==null) baseDelayMs = 500;
  let delay = baseDelayMs;
  for (let i=0;i<=maxRetries;i++){
    try{
      const res = await fetch(url, opts);
      if (res.status===429 || res.status===503){
        const ra = Number(res.headers.get("retry-after")) || 0;
        const wait = Math.max(delay, ra*1000);
        console.warn("[backoff] "+res.status+" retry in "+wait+"ms");
        await new Promise(function(r){ setTimeout(r, wait); });
        delay *= 2; continue;
      }
      if (!isJsonLike(res)){
        await res.text().catch(function(){});
        console.warn("[backoff] non-JSON ("+res.status+") retry in "+delay+"ms");
        await new Promise(function(r){ setTimeout(r, delay); });
        delay *= 2; continue;
      }
      const json = await res.json();
      if (!res.ok) throw new Error("HTTP "+res.status+": "+JSON.stringify(json).slice(0,180));
      return json;
    }catch(e){
      if (i===maxRetries) throw e;
      console.warn("[backoff] err: "+(e && e.message ? e.message : String(e))+" retry in "+delay+"ms");
      await new Promise(function(r){ setTimeout(r, delay); });
      delay *= 2;
    }
  }
  throw new Error("unreachable");
}

/* ===== Bitquery (v2 EAP) ===== */
function GQL(sec){
  return [
    "query BurnsLastWindow {",
    "  Solana(dataset: realtime, network: solana) {",
    "    TokenSupplyUpdates(",
    "      where: {",
    "        Instruction: { Program: { Method: { in: [\"Burn\", \"burn\"] } } },",
    "        Transaction: { Result: { Success: true } },",
    "        Block: { Time: { since_relative: { seconds_ago: "+sec+" } } }",
    "      },",
    "      orderBy: { descending: Block_Time },",
    "      limit: { count: 200 }",
    "    ) {",
    "      Transaction { Signature }",
    "      TokenSupplyUpdate { Amount AmountInUSD Currency { MintAddress Decimals } }",
    "    }",
    "  }",
    "}"
  ].join("\n");
}

async function bitqueryFetch(query){
  const json = await fetchJSONWithBackoff(
    "https://streaming.bitquery.io/eap",
    {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":"Bearer "+BITQUERY_API_KEY
      },
      body: JSON.stringify({ query: query })
    },
    5, 500
  );
  if (json.errors) throw new Error("GraphQL: "+JSON.stringify(json.errors));
  return json;
}
function parseBurnNodes(nodes){
  const out = [];
  for (let i=0;i<nodes.length;i++){
    const n = nodes[i];
    const sig = n && n.Transaction ? n.Transaction.Signature : null;
    const tu = n ? n.TokenSupplyUpdate : null;
    const mint = tu && tu.Currency ? tu.Currency.MintAddress : null;
    const decimals = tu && tu.Currency && isFinite(Number(tu.Currency.Decimals)) ? Number(tu.Currency.Decimals) : 0;
    const rawAmt = Number(tu ? tu.Amount : NaN);
    const absAmt = isFinite(rawAmt) ? Math.abs(rawAmt) : null;
    let amountUi = absAmt;
    if (absAmt && decimals>0){
      if (Number.isInteger(absAmt) && absAmt > Math.pow(10, Math.max(0, decimals-2))){
        amountUi = absAmt / Math.pow(10, decimals);
      }
    }
    out.push({ sig: sig, mint: mint, amount: amountUi });
  }
  return out;
}

/* ===== Prices (Birdeye) ===== */
const SOL_MINT = "So11111111111111111111111111111111111111112";
async function getUsdPriceByMint(mint){
  const now = Date.now();
  const cached = priceCache.get(mint);
  if (cached && (now - cached.ts) < PRICE_TTL_MS) return cached.usdPrice;
  try{
    const j = await fetchJSONWithBackoff(
      "https://public-api.birdeye.so/defi/price?chain=solana&address="+encodeURIComponent(mint),
      { headers:{ "X-API-KEY": BIRDEYE_API_KEY, "accept":"application/json" } },
      3, 400
    );
    const p = j && j.data ? j.data.value : null;
    if (p!=null && isFinite(Number(p))){
      const usdPrice = Number(p);
      priceCache.set(mint, { usdPrice: usdPrice, ts: now });
      return usdPrice;
    }
  }catch(e){
    console.warn("[birdeye price] fail:", e && e.message ? e.message : e);
  }
  return null;
}
async function getSolUsd(){
  const now = Date.now();
  if (solUsdCache.price && (now - solUsdCache.ts) < 60*1000) return solUsdCache.price;
  try{
    const j = await fetchJSONWithBackoff(
      "https://public-api.birdeye.so/defi/price?chain=solana&address="+SOL_MINT,
      { headers:{ "X-API-KEY": BIRDEYE_API_KEY, "accept":"application/json" } },
      3, 400
    );
    const p = j && j.data ? j.data.value : null;
    const price = (p!=null && isFinite(Number(p))) ? Number(p) : null;
    if (price!=null){ solUsdCache.price = price; solUsdCache.ts = now; }
    return price;
  }catch(e){
    console.warn("[birdeye SOL price] fail:", e && e.message ? e.message : e);
    return null;
  }
}
async function prefetchPrices(burns){
  const mints = Array.from(new Set(burns.map(function(b){ return b.mint; }).filter(Boolean)));
  let fetched=0;
  for (let i=0;i<mints.length;i++){
    if (fetched >= MAX_PRICE_LOOKUPS_PER_POLL) break;
    const m = mints[i];
    const cached = priceCache.get(m);
    const fresh = cached && (Date.now()-cached.ts)<PRICE_TTL_MS;
    if (!fresh){ await getUsdPriceByMint(m); fetched++; }
  }
}

/* ===== DexScreener enrich (liq, fdv, name, socials, url) ===== */
async function enrichDexScreener(mint){
  try{
    const j = await fetchJSONWithBackoff(
      "https://api.dexscreener.com/latest/dex/tokens/"+encodeURIComponent(mint),
      { headers:{ "User-Agent":"Mozilla/5.0 (BurnBot/1.0)", "Accept":"application/json" } },
      3, 400
    );
    const pairs = (j && j.pairs) ? j.pairs : [];
    const sols = pairs.filter(function(p){ return (p && (p.chainId||"").toLowerCase()==="solana"); });
    const arr = (sols.length?sols:pairs).slice().sort(function(a,b){
      const bu = (b && b.liquidity && b.liquidity.usd) ? b.liquidity.usd : 0;
      const au = (a && a.liquidity && a.liquidity.usd) ? a.liquidity.usd : 0;
      return bu - au;
    });
    const best = arr[0];
    if (!best) return null;

    const liqUsd = Number(best.liquidity && best.liquidity.usd ? best.liquidity.usd : null) || null;
    const fdv    = Number(best.fdv || null) || null;
    const name   = (best.baseToken && (best.baseToken.name || best.baseToken.symbol)) ? (best.baseToken.name || best.baseToken.symbol) : short(mint);
    const url    = best.url || ("https://dexscreener.com/solana/"+mint);

    const info = best.info || {};
    const websites = info.websites || [];
    const socials  = info.socials || [];
    const site = websites[0] && websites[0].url ? websites[0].url : null;
    let tg=null, tw=null;
    for (let i=0;i<socials.length;i++){
      const t = (socials[i].type||"").toLowerCase();
      if (t==="telegram" && socials[i].url) tg = socials[i].url;
      if ((t==="twitter" || t==="x") && socials[i].url) tw = socials[i].url;
    }

    return { liqUsd: liqUsd, fdv: fdv, name: name, url: url, site: site, tg: tg, tw: tw };
  }catch(e){
    console.warn("DexScreener enrich fail:", e && e.message ? e.message : e);
    return null;
  }
}

/* ===== RPC stats ===== */
async function rpcStats(mintStr){
  const mintPk = new PublicKey(mintStr);
  let supplyUi=null, top10=[], top10Pct=null, mintRenounced=null, freezeRenounced=null;
  try{
    const s = await connection.getTokenSupply(mintPk);
    supplyUi = s && s.value ? s.value.uiAmount : null;
  }catch(e){}
  try{
    const largest = await connection.getTokenLargestAccounts(mintPk);
    const arr = (largest && largest.value) ? largest.value : [];
    top10 = arr.slice(0,10).map(function(v){ return { address: v.address.toBase58(), amount: v.uiAmount }; });
    if (supplyUi && supplyUi > 0){
      const sum = top10.reduce(function(a,c){ return a + (Number(c.amount)||0); }, 0);
      top10Pct = sum / supplyUi;
    }
  }catch(e){}
  try{
    const mi = await getMint(connection, mintPk);
    mintRenounced = (mi && mi.mintAuthority === null);
    freezeRenounced = (mi && mi.freezeAuthority === null);
  }catch(e){}
  return { supplyUi: supplyUi, top10: top10, top10Pct: top10Pct, mintRenounced: mintRenounced, freezeRenounced: freezeRenounced };
}

/* ===== formatting ===== */
function links(sig, mint, dsUrl){
  const out=[];
  if (sig) out.push("[Solscan](https://solscan.io/tx/"+sig+")");
  if (mint){
    out.push("[Birdeye](https://birdeye.so/token/"+mint+"?chain=solana)");
    out.push("[DexScreener]("+(dsUrl || ("https://dexscreener.com/solana/"+mint))+")");
    out.push("[Photon](https://photon-sol.tinyastro.io/en/lp/"+mint+")");
  }
  return out.join(" | ");
}
function renderSecurity(mintRenounced, freezeRenounced){
  const lines = [];
  lines.push("Mutable Metadata: Unknown");
  lines.push("Mint Authority: " + (mintRenounced===true ? "No" : (mintRenounced===false ? "Yes" : "Unknown")));
  lines.push("Freeze Authority: " + (freezeRenounced===true ? "No" : (freezeRenounced===false ? "Yes" : "Unknown")));
  return lines.join("\n");
}
function renderTop(top10, pct, supplyUi){
  if (!top10 || !top10.length) return "n/a";
  const lines = top10.map(function(h){
    const base = "- " + short(h.address) + " | " + fmtNum(h.amount,2);
    if (supplyUi && h.amount!=null){
      const perc = (Number(h.amount)/supplyUi*100).toFixed(2) + "%";
      return base + " | " + perc;
    }
    return base;
  });
  if (pct!=null) lines.push("Top10 share: " + fmtPct(pct));
  return lines.join("\n");
}

/* ===== post ===== */
async function postReport(burn){
  // prices
  const solUsd = await getSolUsd();
  let tokenUsd = null;
  if (burn.mint) tokenUsd = await getUsdPriceByMint(burn.mint);

  // burn value in SOL
  let burnSol = null;
  if (typeof burn.amount==="number" && burn.amount>0 && tokenUsd!=null && solUsd){
    burnSol = (burn.amount * tokenUsd) / solUsd;
  }

  // MIN_SOL
  const meetsMinSol = (cfg.minSol <= 0) ? true : (burnSol != null && burnSol >= cfg.minSol);
  if (!meetsMinSol){
    console.log("[SKIP < MIN_SOL] sig="+short(burn.sig)+" mint="+short(burn.mint)+" burnSol="+burnSol);
    return false;
  }

  // enrich
  const ds = burn.mint ? await enrichDexScreener(burn.mint) : null;

  // LP fully burned
  if (!(ds && ds.liqUsd === 0)){
    console.log("[SKIP LP not fully burned] sig="+short(burn.sig)+" mint="+short(burn.mint)+" liqUsd="+(ds ? ds.liqUsd : "n/a"));
    return false;
  }

  // MCAP in SOL
  let mcapSol = null;
  if (ds && ds.fdv && solUsd) mcapSol = ds.fdv / solUsd;
  if (cfg.maxMcapSol > 0 && mcapSol != null && mcapSol > cfg.maxMcapSol){
    console.log("[SKIP mcap > MAX_MCAP_SOL] sig="+short(burn.sig)+" mint="+short(burn.mint)+" mcapSol="+mcapSol.toFixed(2)+" > "+cfg.maxMcapSol);
    return false;
  }

  // rpc stats
  const stats = burn.mint ? await rpcStats(burn.mint) : {};

  // message
  const nameLine = ds && ds.name ? ds.name : short(burn.mint || "Token");
  const tradeStart = ds && ds.createdMs ? minutesAgo(ds.createdMs) : "n/a";
  const socials = (function(){
    const arr = [];
    if (ds && ds.site) arr.push(ds.site);
    if (ds && ds.tw) arr.push(ds.tw);
    if (ds && ds.tg) arr.push(ds.tg);
    return arr.length ? arr.join(" | ") : "n/a";
  })();

  const lines = [];
  lines.push("Token: " + nameLine);
  lines.push("Trading Start Time: " + tradeStart);
  lines.push("");
  lines.push("Marketcap: " + (mcapSol!=null ? fmtSol(mcapSol,2) : "n/a"));
  lines.push("Liquidity: 0 SOL (LP fully burned)");
  lines.push("Price: " + (tokenUsd!=null && solUsd ? fmtSol(tokenUsd/solUsd,6) : "n/a"));
  lines.push("");
  if (typeof burn.amount==="number"){
    lines.push("Burned Amount: " + fmtNum(burn.amount,4) + "  (~" + (burnSol!=null ? fmtSol(burnSol,4) : "n/a") + ")");
  }
  lines.push("");
  lines.push("Total Supply: " + fmtNum(stats && stats.supplyUi,0));
  lines.push("");
  lines.push("Socials: " + socials);
  lines.push("Security:");
  lines.push(renderSecurity(stats && stats.mintRenounced, stats && stats.freezeRenounced));
  lines.push("");
  lines.push("Top Holders:");
  lines.push(renderTop(stats && stats.top10, stats && stats.top10Pct, stats && stats.supplyUi));
  lines.push("");
  lines.push(links(burn.sig, burn.mint, ds ? ds.url : null));
  if (burn.mint) lines.push("\n" + burn.mint);

  const text = lines.join("\n");
  try{
    await bot.telegram.sendMessage(CHANNEL_ID, text, { disable_web_page_preview:true });
    console.log("[POSTED] sig="+short(burn.sig)+" burnSol="+(burnSol!=null ? burnSol.toFixed(4) : "n/a")+" SOL");
    return true;
  }catch(e){
    console.error("[sendMessage ERROR]", (e && (e.description || e.message)) ? (e.description || e.message) : e);
    return false;
  }
}

/* ===== poll ===== */
async function pollOnce(){
  console.log("[POLL] start", new Date().toISOString());
  pruneSeen();
  try{
    const json = await bitqueryFetch(GQL(cfg.lookbackSec));
    const nodes = json && json.data && json.data.Solana && json.data.Solana.TokenSupplyUpdates ? json.data.Solana.TokenSupplyUpdates : [];
    const burns = parseBurnNodes(nodes);
    console.log("[Bitquery] last "+cfg.lookbackSec+"s -> nodes="+nodes.length+", parsed="+burns.length);

    await prefetchPrices(burns);

    for (let i=0;i<burns.length;i++){
      const b = burns[i];
      if (!b.sig || !b.mint) continue;
      const k = keyFor(b.sig, b.mint);
      if (seen.has(k)) continue;
      const ok = await postReport(b).catch(function(e){ console.error("post error", e && e.message ? e.message : e); return false; });
      if (ok) seen.set(k, nowMs());
    }
  }catch(e){
    console.error("[Bitquery] fetch error:", e && e.message ? e.message : e);
  }finally{
    console.log("[POLL] end", new Date().toISOString());
  }
}
function restartPolling(){
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, cfg.pollIntervalSec*1000);
  console.log("[POLL] setInterval "+cfg.pollIntervalSec+" sec");
}

/* ===== commands ===== */
bot.command("ping", function(ctx){ return ctx.reply("pong"); });
bot.command("status", function(ctx){
  const msg = [
    "Status:",
    "MIN_SOL="+cfg.minSol+" SOL",
    "MAX_MCAP_SOL="+(cfg.maxMcapSol>0 ? (cfg.maxMcapSol+" SOL") : "off"),
    "POLL_INTERVAL_SEC="+cfg.pollIntervalSec,
    "POLL_LOOKBACK_SEC="+cfg.lookbackSec,
    "DEDUP_MINUTES="+cfg.dedupMinutes,
    "LP filter: only post when liqUsd == 0"
  ].join("\n");
  return ctx.reply(msg);
});
bot.command("setminsol", function(ctx){
  if (!isAdmin(ctx)) return ctx.reply("No permission.");
  const parts = (ctx.message && ctx.message.text ? ctx.message.text : "").split(" ");
  const v = Number(parts[1]);
  if (!isFinite(v) || v < 0) return ctx.reply("Usage: /setminsol <sol>");
  cfg.minSol = v;
  return ctx.reply("MIN_SOL set to "+v+" SOL");
});
bot.command("setmaxmcap", function(ctx){
  if (!isAdmin(ctx)) return ctx.reply("No permission.");
  const parts = (ctx.message && ctx.message.text ? ctx.message.text : "").split(" ");
  const v = Number(parts[1]);
  if (!isFinite(v) || v < 0) return ctx.reply("Usage: /setmaxmcap <sol> (0 to disable)");
  cfg.maxMcapSol = v;
  return ctx.reply("MAX_MCAP_SOL set to "+(v>0 ? (v+" SOL") : "off"));
});

/* ===== start (409-safe) ===== */
(async function(){
  try{ await bot.telegram.deleteWebhook({ drop_pending_updates:true }); }catch(e){}
  try{
    await bot.launch({ dropPendingUpdates:true });
    console.log("Telegraf launched (polling ON).");
  }catch(e){
    console.error("Telegraf launch failed:", (e && (e.description || e.message)) ? (e.description || e.message) : e);
  }
  try{
    const boot = [
      "BurnBot started (SOL mode)",
      "MIN_SOL >= "+cfg.minSol+" SOL",
      "MAX_MCAP_SOL "+(cfg.maxMcapSol>0 ? ("<= "+cfg.maxMcapSol+" SOL") : "off"),
      "Poll="+cfg.pollIntervalSec+"s  Window="+cfg.lookbackSec+"s  Dedup="+cfg.dedupMinutes+"m",
      "LP filter: only when LP fully burned (liqUsd == 0)",
      "Price: Birdeye"
    ].join("\n");
    await bot.telegram.sendMessage(CHANNEL_ID, boot);
  }catch(e){
    console.error("[startup send error]", e && e.message ? e.message : e);
  }

  await pollOnce();
  restartPolling();
})();

process.once("SIGINT", function(){ bot.stop("SIGINT"); });
process.once("SIGTERM", function(){ bot.stop("SIGTERM"); });
