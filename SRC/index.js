// SRC/index.js — Sol Burn Bot (CommonJS, SOL mode)
// - Bitquery v2 EAP: TokenSupplyUpdates -> burn-ek
// - Birdeye ár (SOL/USD + token USD), DexScreener enrich
// - LP filter strict / relaxed
// - Szűrők: MIN_SOL (burn SOL-ban), MAX_MCAP_SOL (FDV SOL-ban)
// - Watchdog, debug parancsok, dedup védelem

"use strict";

/* ===== Imports ===== */
const dotenv = require("dotenv");
dotenv.config();

const { fetch } = require("undici");
const { Telegraf } = require("telegraf");
const { Connection, PublicKey, clusterApiUrl } = require("@solana/web3.js");
const { getMint } = require("@solana/spl-token");

/* ===== ENV ===== */
const {
  BOT_TOKEN,
  CHANNEL_ID,
  BITQUERY_API_KEY,
  BIRDEYE_API_KEY,
  MIN_SOL = "0",
  MAX_MCAP_SOL = "0",
  POLL_INTERVAL_SEC = "20",
  POLL_LOOKBACK_SEC = "12",
  DEDUP_MINUTES = "10",
  RPC_URL
} = process.env;

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!CHANNEL_ID) throw new Error("Missing CHANNEL_ID");
if (!BITQUERY_API_KEY) throw new Error("Missing BITQUERY_API_KEY");
if (!BIRDEYE_API_KEY) console.warn("[WARN] Missing BIRDEYE_API_KEY (prices may fail)");

/* ===== Admin ===== */
const ADMIN_IDS = [1721507540]; // ide a te Telegram user ID-d
function isAdmin(ctx){ return !!(ctx && ctx.from && ADMIN_IDS.includes(ctx.from.id)); }

/* ===== Globals ===== */
console.log("[BOOT] build=2025-08-23_full");

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL || clusterApiUrl("mainnet-beta"), "confirmed");

let cfg = {
  minSol: Number(MIN_SOL) || 0,
  maxMcapSol: Number(MAX_MCAP_SOL) || 0,
  pollIntervalSec: Number(POLL_INTERVAL_SEC) || 20,
  lookbackSec: Number(POLL_LOOKBACK_SEC) || 12,
  dedupMinutes: Number(DEDUP_MINUTES) || 10
};

let lpStrict = true; // LP mód: strict = csak liqUsd==0, relaxed = n/a is átmegy

let pollTimer = null;
let lastPollAt = 0;
const seen = new Map();

const PRICE_TTL_MS = 180000;
const priceCache = new Map();
const solUsdCache = { price: null, ts: 0 };
const MAX_PRICE_LOOKUPS_PER_POLL = 2;

setInterval(()=>console.log("[HEARTBEAT]", new Date().toISOString()), 15000);

/* ===== Helpers ===== */
function short(s){ return (s && s.length > 12 ? s.slice(0,4)+"..."+s.slice(-4) : s); }
function fmtSol(x, frac=4){ return (x==null ? "n/a" : Number(x).toLocaleString(undefined,{maximumFractionDigits:frac})+" SOL"); }
function fmtNum(x, frac=0){ return (x==null ? "n/a" : Number(x).toLocaleString(undefined,{maximumFractionDigits:frac})); }
function fmtPct(x){ return (x==null ? "n/a" : (Number(x)*100).toFixed(2)+"%"); }
function nowMs(){ return Date.now(); }
function keyFor(sig, mint){ return (sig||"no-sig")+"::"+(mint||"no-mint"); }
function pruneSeen(){
  const limit = cfg.dedupMinutes*60*1000;
  const t=nowMs();
  for (const [k,ts] of seen) if (t-ts>limit) seen.delete(k);
}
function minutesAgo(tsMs){
  if (!tsMs) return "n/a";
  const m = Math.floor((Date.now()-tsMs)/60000);
  if (m<1) return "just now";
  if (m===1) return "1 minute ago";
  return m+" minutes ago";
}

/* ===== Backoff fetch ===== */
function isJsonLike(res){
  const ct = (res.headers.get("content-type")||"").toLowerCase();
  return ct.includes("application/json");
}
async function fetchJSONWithBackoff(url, opts={}, maxRetries=5, baseDelayMs=500){
  let delay=baseDelayMs;
  for (let i=0;i<=maxRetries;i++){
    try{
      const res = await fetch(url, opts);
      if (res.status===429||res.status===503){
        const ra=Number(res.headers.get("retry-after"))||0;
        const wait=Math.max(delay,ra*1000);
        console.warn("[backoff]",res.status,"retry in",wait,"ms");
        await new Promise(r=>setTimeout(r,wait));
        delay*=2; continue;
      }
      if (!isJsonLike(res)){
        await res.text().catch(()=>{});
        console.warn("[backoff] non-JSON retry in",delay,"ms");
        await new Promise(r=>setTimeout(r,delay));
        delay*=2; continue;
      }
      const j=await res.json();
      if (!res.ok) throw new Error("HTTP "+res.status+": "+JSON.stringify(j).slice(0,180));
      return j;
    }catch(e){
      if (i===maxRetries) throw e;
      console.warn("[backoff] err:",e.message||e,"retry in",delay,"ms");
      await new Promise(r=>setTimeout(r,delay));
      delay*=2;
    }
  }
  throw new Error("unreachable");
}

/* ===== Bitquery ===== */
function GQL(sec){
return `
query {
  Solana(dataset: realtime, network: solana) {
    TokenSupplyUpdates(
      where: {
        Instruction: { Program: { Method: { in: ["Burn","burn"] } } }
        Transaction: { Result: { Success: true } }
        Block: { Time: { since_relative: { seconds_ago: ${sec} } } }
      }
      orderBy: { descending: Block_Time }
      limit: { count: 200 }
    ) {
      Transaction { Signature }
      TokenSupplyUpdate { Amount AmountInUSD Currency { MintAddress Decimals } }
    }
  }
}`;
}
async function bitqueryFetch(query){
  const j=await fetchJSONWithBackoff("https://streaming.bitquery.io/eap",{
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+BITQUERY_API_KEY },
    body:JSON.stringify({query})
  },5,500);
  if (j.errors) throw new Error("GraphQL: "+JSON.stringify(j.errors));
  return j;
}
function parseBurnNodes(nodes){
  const out=[];
  for(const n of nodes){
    const sig=n?.Transaction?.Signature;
    const tu=n?.TokenSupplyUpdate;
    const mint=tu?.Currency?.MintAddress;
    const decimals=Number(tu?.Currency?.Decimals)||0;
    const rawAmt=Number(tu?.Amount);
    const absAmt=isFinite(rawAmt)?Math.abs(rawAmt):null;
    let amountUi=absAmt;
    if (absAmt && decimals>0 && absAmt>Math.pow(10,decimals-2)){
      amountUi=absAmt/Math.pow(10,decimals);
    }
    out.push({sig,mint,amount:amountUi});
  }
  return out;
}

/* ===== Birdeye prices ===== */
const SOL_MINT="So11111111111111111111111111111111111111112";
async function getUsdPriceByMint(mint){
  const now=Date.now();
  const c=priceCache.get(mint);
  if (c && now-c.ts<PRICE_TTL_MS) return c.usdPrice;
  try{
    const j=await fetchJSONWithBackoff(
      "https://public-api.birdeye.so/defi/price?chain=solana&address="+mint,
      {headers:{"X-API-KEY":BIRDEYE_API_KEY,"accept":"application/json"}},3,400);
    const p=j?.data?.value;
    if (p!=null){ const usd=Number(p); priceCache.set(mint,{usdPrice:usd,ts:now}); return usd; }
  }catch(e){ console.warn("[birdeye price] fail:",e.message); }
  return null;
}
async function getSolUsd(){
  const now=Date.now();
  if (solUsdCache.price && now-solUsdCache.ts<60000) return solUsdCache.price;
  try{
    const j=await fetchJSONWithBackoff(
      "https://public-api.birdeye.so/defi/price?chain=solana&address="+SOL_MINT,
      {headers:{"X-API-KEY":BIRDEYE_API_KEY,"accept":"application/json"}},3,400);
    const p=j?.data?.value; if (p!=null){ solUsdCache.price=Number(p); solUsdCache.ts=now; return solUsdCache.price; }
  }catch(e){ console.warn("[birdeye SOL price] fail:",e.message); }
  return null;
}

/* ===== DexScreener ===== */
async function enrichDexScreener(mint){
  try{
    const j=await fetchJSONWithBackoff(
      "https://api.dexscreener.com/latest/dex/tokens/"+mint,
      {headers:{"User-Agent":"BurnBot/1.0","Accept":"application/json"}},3,400);
    const pairs=j?.pairs||[];
    const sols=pairs.filter(p=>(p?.chainId||"").toLowerCase()==="solana");
    const arr=(sols.length?sols:pairs).sort((a,b)=>(b?.liquidity?.usd||0)-(a?.liquidity?.usd||0));
    const best=arr[0]; if (!best) return null;
    return {
      priceUsd:Number(best.priceUsd)||null,
      liqUsd:Number(best.liquidity?.usd)||null,
      fdv:Number(best.fdv)||null,
      ratio:(best.fdv && best.liquidity?.usd)?best.fdv/best.liquidity.usd:null,
      createdMs:best.pairCreatedAt?Number(best.pairCreatedAt):null,
      url:best.url||("https://dexscreener.com/solana/"+mint)
    };
  }catch(e){ console.warn("DexScreener fail:",e.message); return null; }
}

/* ===== RPC stats ===== */
async function rpcStats(mintStr){
  const mintPk=new PublicKey(mintStr);
  let supplyUi=null,top10=[],top10Pct=null,mintRenounced=null,freezeRenounced=null;
  try{ const s=await connection.getTokenSupply(mintPk); supplyUi=s?.value?.uiAmount; }catch{}
  try{
    const l=await connection.getTokenLargestAccounts(mintPk);
    const arr=l?.value||[];
    top10=arr.slice(0,10).map(v=>({address:v.address.toBase58(),amount:v.uiAmount}));
    if (supplyUi && supplyUi>0){ const sum=top10.reduce((a,c)=>a+(+c.amount||0),0); top10Pct=sum/supplyUi; }
  }catch{}
  try{ const mi=await getMint(connection,mintPk); mintRenounced=(mi?.mintAuthority===null); freezeRenounced=(mi?.freezeAuthority===null); }catch{}
  return {supplyUi,top10,top10Pct,mintRenounced,freezeRenounced};
}

/* ===== Formatting ===== */
function links(sig,mint,dsUrl){
  const out=[];
  if(sig) out.push("[Solscan](https://solscan.io/tx/"+sig+")");
  if(mint){
    out.push("[Birdeye](https://birdeye.so/token/"+mint+"?chain=solana)");
    out.push("[DexScreener]("+(dsUrl||("https://dexscreener.com/solana/"+mint))+")");
  }
  return out.join(" | ");
}
function renderSecurity(mintRenounced,freezeRenounced){
  return [
    "Mint Authority: "+(mintRenounced===true?"No":mintRenounced===false?"Yes":"Unknown"),
    "Freeze Authority: "+(freezeRenounced===true?"No":freezeRenounced===false?"Yes":"Unknown")
  ].join("\n");
}
function renderTop(top10,pct,supplyUi){
  if(!top10?.length) return "n/a";
  const lines=top10.map(h=>"- "+short(h.address)+" | "+fmtNum(h.amount,2));
  if(pct!=null) lines.push("Top10 share: "+fmtPct(pct));
  return lines.join("\n");
}

/* ===== Post ===== */
async function postReport(burn){
  const solUsd=await getSolUsd();
  const tokenUsd=burn.mint?await getUsdPriceByMint(burn.mint):null;
  let burnSol=null;
  if(burn.amount && tokenUsd && solUsd) burnSol=(burn.amount*tokenUsd)/solUsd;
  if(cfg.minSol>0){
    if(burnSol==null || burnSol<cfg.minSol){ console.log("[SKIP < MIN_SOL]",short(burn.sig)); return false; }
  }
  const ds=burn.mint?await enrichDexScreener(burn.mint):null;
  if(lpStrict){
    if(!(ds && ds.liqUsd===0)){ console.log("[SKIP LP not fully burned]",short(burn.sig)); return false; }
  }else{
    if(ds && typeof ds.liqUsd==="number" && ds.liqUsd>0){ console.log("[SKIP LP>0 relaxed]",short(burn.sig)); return false; }
  }
  let mcapSol=null;
  if(ds?.fdv && solUsd) mcapSol=ds.fdv/solUsd;
  if(cfg.maxMcapSol>0 && mcapSol>cfg.maxMcapSol){ console.log("[SKIP mcap]",short(burn.sig)); return false; }
  const stats=burn.mint?await rpcStats(burn.mint):{};
  const lines=[];
  lines.push("Token: "+(burn.mint||"n/a"));
  lines.push("Marketcap: "+(mcapSol!=null?fmtSol(mcapSol,2):"n/a"));
  lines.push("Liquidity: "+(ds?.liqUsd===0?"0 (LP burned)":"has LP"));
  lines.push("Price: "+(tokenUsd&&solUsd?fmtSol(tokenUsd/solUsd,6):"n/a"));
  lines.push("Burned Amount: "+fmtNum(burn.amount,4)+" (~"+(burnSol?fmtSol(burnSol,4):"n/a")+")");
  lines.push("Total Supply: "+fmtNum(stats.supplyUi,0));
  lines.push("Security:\n"+renderSecurity(stats.mintRenounced,stats.freezeRenounced));
  lines.push("Top Holders:\n"+renderTop(stats.top10,stats.top10Pct,stats.supplyUi));
  lines.push(links(burn.sig,burn.mint,ds?.url));
  const text=lines.join("\n");
  await bot.telegram.sendMessage(CHANNEL_ID,text,{disable_web_page_preview:true});
  console.log("[POSTED]",short(burn.sig));
  return true;
}

/* ===== Polling ===== */
async function pollOnce(){
  lastPollAt=Date.now();
  console.log("[POLL] start",new Date().toISOString());
  pruneSeen();
  try{
    const j=await bitqueryFetch(GQL(cfg.lookbackSec));
    const nodes=j?.data?.Solana?.TokenSupplyUpdates||[];
    const burns=parseBurnNodes(nodes);
    console.log("[Bitquery] parsed",burns.length);
    for(const b of burns){
      if(!b.sig||!b.mint) continue;
      const k=keyFor(b.sig,b.mint);
      if(seen.has(k)) continue;
      const ok=await postReport(b).catch(e=>{console.error("post error",e.message);return false;});
      if(ok) seen.set(k,nowMs());
    }
  }catch(e){ console.error("[Bitquery] fetch error:",e.message); }
  console.log("[POLL] end",new Date().toISOString());
}
function restartPolling(){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer=setInterval(pollOnce,cfg.pollIntervalSec*1000);
  console.log("[POLL] setInterval",cfg.pollIntervalSec,"sec");
}
setInterval(()=>{ const gap=Date.now()-lastPollAt; const maxGap=Math.max(60000,cfg.pollIntervalSec*3000);
  if(gap>maxGap){ console.warn("[WATCHDOG] restart"); restartPolling(); pollOnce().catch(()=>{});} },30000);

/* ===== Commands ===== */
bot.command("ping",ctx=>ctx.reply("pong"));
bot.command("status",ctx=>{
  ctx.reply([
    "MIN_SOL="+cfg.minSol,
    "MAX_MCAP_SOL="+(cfg.maxMcapSol>0?cfg.maxMcapSol:"off"),
    "POLL_INTERVAL_SEC="+cfg.pollIntervalSec,
    "LP mode="+(lpStrict?"strict":"relaxed")
  ].join("\n"));
});
bot.command("setminsol",ctx=>{
  if(!isAdmin(ctx)) return ctx.reply("No permission");
  const v=Number((ctx.message.text.split(" ")[1])||0);
  cfg.minSol=v; ctx.reply("MIN_SOL="+v);
});
bot.command("setmaxmcap",ctx=>{
  if(!isAdmin(ctx)) return ctx.reply("No permission");
  const v=Number((ctx.message.text.split(" ")[1])||
