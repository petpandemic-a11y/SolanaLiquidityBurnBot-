// SRC/index.js — Solana Burn Bot (Bitquery v2 EAP)
// Design: Solana LP Burns-szerű poszt, USD + SOL érték, Socials + Security + Top Holders
// Árforrás: Birdeye (ha van key) -> Jupiter -> DexScreener (429/503 backoff + cache)

import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

/* ========= ENV ========= */
const {
  BOT_TOKEN,
  CHANNEL_ID,
  BITQUERY_API_KEY,
  BIRDEYE_API_KEY,
  PRICE_SOURCE = 'auto',   // 'birdeye' | 'jup' | 'ds' | 'auto'
  MIN_USD = '30',
  POLL_INTERVAL_SEC = '20',
  POLL_LOOKBACK_SEC = '25',
  DEDUP_MINUTES = '10',
  RPC_URL
} = process.env;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!CHANNEL_ID) throw new Error('Missing CHANNEL_ID');
if (!BITQUERY_API_KEY) throw new Error('Missing BITQUERY_API_KEY');

const ADMIN_IDS = [1721507540]; // <- a Te ID-d
const isAdmin = (ctx) => !!(ctx?.from && ADMIN_IDS.includes(ctx.from.id));

/* ========= Globals ========= */
const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL || clusterApiUrl('mainnet-beta'), 'confirmed');

let cfg = {
  minUsd: Number(MIN_USD) || 30,
  pollIntervalSec: Number(POLL_INTERVAL_SEC) || 20,
  lookbackSec: Number(POLL_LOOKBACK_SEC) || 25,
  dedupMinutes: Number(DEDUP_MINUTES) || 10,
};
let pollTimer = null;

const seen = new Map(); // sig::mint -> ts

// cachek
const PRICE_TTL_MS = 60_000;
const priceCache = new Map();   // mint -> { price, ts, src }
const solUsdCache = { price: null, ts: 0 };
const MAX_PRICE_LOOKUPS_PER_POLL = 6;

setInterval(()=>console.log('[HEARTBEAT]', new Date().toISOString()), 15000);

/* ========= Helpers ========= */
const short = s => (s && s.length > 12 ? s.slice(0,4)+'…'+s.slice(-4) : s);
const fmtUsd = (x, frac=2) => (x==null ? 'n/a' : '$'+Number(x).toLocaleString(undefined,{maximumFractionDigits:frac}));
const fmtSol = (x, frac=4) => (x==null ? 'n/a' : Number(x).toLocaleString(undefined,{maximumFractionDigits:frac})+' SOL');
const fmtPct = x => (x==null ? 'n/a' : (Number(x)*100).toFixed(2)+'%');
const fmtNum = (x, frac=0) => (x==null ? 'n/a' : Number(x).toLocaleString(undefined,{maximumFractionDigits:frac}));
const nowMs = () => Date.now();
const keyFor = (sig, mint) => `${sig||'no-sig'}::${mint||'no-mint'}`;

function minutesAgo(tsMs){
  if (!tsMs) return 'n/a';
  const m = Math.floor((Date.now()-tsMs)/60000);
  if (m < 1) return 'just now';
  if (m === 1) return '1 minute ago';
  return `${m} minutes ago`;
}
function pruneSeen(){
  const limit = cfg.dedupMinutes * 60 * 1000;
  const t = nowMs();
  for (const [k,ts] of Array.from(seen.entries())) if (t - ts > limit) seen.delete(k);
}

function isJsonLike(res){
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  return ct.includes('application/json');
}
async function fetchJSONWithBackoff(url, opts={}, maxRetries=5, baseDelayMs=500){
  let delay = baseDelayMs;
  for(let i=0;i<=maxRetries;i++){
    try{
      const res = await fetch(url, opts);
      if (res.status===429 || res.status===503){
        const ra = Number(res.headers.get('retry-after'))||0;
        const wait = Math.max(delay, ra*1000);
        console.warn(`[backoff] ${res.status} retry in ${wait}ms`);
        await new Promise(r=>setTimeout(r, wait)); delay*=2; continue;
      }
      if (!isJsonLike(res)){
        const _ = await res.text().catch(()=> '');
        console.warn(`[backoff] non-JSON (${res.status}) retry in ${delay}ms`);
        await new Promise(r=>setTimeout(r, delay)); delay*=2; continue;
      }
      const json = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0,180)}`);
      return json;
    }catch(e){
      if (i===maxRetries) throw e;
      console.warn(`[backoff] err: ${e?.message||e}. retry in ${delay}ms`);
      await new Promise(r=>setTimeout(r, delay)); delay*=2;
    }
  }
  throw new Error('unreachable');
}

/* ========= Bitquery (v2 EAP) ========= */
const GQL = (sec)=>`
query BurnsLastWindow {
  Solana(dataset: realtime, network: solana) {
    TokenSupplyUpdates(
      where: {
        Instruction: { Program: { Method: { in: ["Burn", "burn"] } } }
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

async function bitqueryFetch(query){
  const json = await fetchJSONWithBackoff(
    'https://streaming.bitquery.io/eap',
    {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':`Bearer ${BITQUERY_API_KEY}`
      },
      body: JSON.stringify({ query })
    },
    5, 500
  );
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json;
}
function parseBurnNodes(nodes){
  const out=[];
  for(const n of nodes){
    const sig = n?.Transaction?.Signature || null;
    const tu = n?.TokenSupplyUpdate || null;
    const mint = tu?.Currency?.MintAddress || null;
    const decimals = Number(tu?.Currency?.Decimals)||0;
    const rawAmt = Number(tu?.Amount);
    const rawUsd = Number(tu?.AmountInUSD);
    const absAmt = Number.isFinite(rawAmt)?Math.abs(rawAmt):null;
    const absUsd = Number.isFinite(rawUsd)?Math.abs(rawUsd):null;
    let amountUi = absAmt;
    if (absAmt && decimals>0){
      if (Number.isInteger(absAmt) && absAmt > 10 ** Math.max(0, decimals-2)){
        amountUi = absAmt / (10 ** decimals);
      }
    }
    out.push({ sig, mint, amount: amountUi, amountUsd: absUsd });
  }
  return out;
}

/* ========= Price sources ========= */
// Birdeye
async function priceFromBirdeye(mint){
  if (!BIRDEYE_API_KEY) return null;
  try{
    const j = await fetchJSONWithBackoff(
      `https://public-api.birdeye.so/defi/price?chain=solana&address=${encodeURIComponent(mint)}`,
      { headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'accept':'application/json' } },
      3, 400
    );
    const p = j?.data?.value;
    if (p!=null && Number.isFinite(Number(p))) return Number(p);
  }catch(e){ console.warn('[birdeye] fail:', e?.message||e); }
  return null;
}
// Jupiter
async function priceFromJupiter(mint){
  const urls = [
    `https://price.jup.ag/v6/price?ids=${encodeURIComponent(mint)}`,
    `https://price.jup.ag/v4/price?ids=${encodeURIComponent(mint)}`
  ];
  for (const u of urls){
    try{
      const j = await fetchJSONWithBackoff(u, {}, 3, 400);
      const p = j?.data?.[mint]?.price;
      if (p!=null && Number.isFinite(Number(p))) return Number(p);
    }catch(e){ console.warn('[jup] fail:', e?.message||e); }
  }
  return null;
}
// DexScreener
async function priceFromDexScreener(mint){
  try{
    const j = await fetchJSONWithBackoff(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      { headers: { 'User-Agent':'Mozilla/5.0 (compatible; BurnBot/1.0)', 'Accept':'application/json' } },
      3, 400
    );
    const pairs = j?.pairs || [];
    const sols = pairs.filter(p => (p?.chainId||'').toLowerCase()==='solana');
    const best = (sols.length?sols:pairs).sort((a,b)=>(b?.liquidity?.usd||0)-(a?.liquidity?.usd||0))[0];
    const p = best?.priceUsd;
    if (p!=null && Number.isFinite(Number(p))) return Number(p);
  }catch(e){ console.warn('[ds] fail:', e?.message||e); }
  return null;
}
async function getUsdPriceByMint(mint){
  const now = Date.now();
  const cached = priceCache.get(mint);
  if (cached && (now - cached.ts) < PRICE_TTL_MS) return cached.price;

  const pref = (PRICE_SOURCE||'auto').toLowerCase();
  let order;
  if (pref==='birdeye') order=[priceFromBirdeye, priceFromJupiter, priceFromDexScreener];
  else if (pref==='jup') order=[priceFromJupiter, priceFromBirdeye, priceFromDexScreener];
  else if (pref==='ds') order=[priceFromDexScreener, priceFromJupiter, priceFromBirdeye];
  else order = BIRDEYE_API_KEY
    ? [priceFromBirdeye, priceFromJupiter, priceFromDexScreener]
    : [priceFromJupiter, priceFromDexScreener];

  let price=null, src=null;
  for (const fn of order){
    price = await fn(mint);
    if (price!=null){ src = fn.name; break; }
  }
  if (price!=null) priceCache.set(mint, { price, ts: now, src });
  return price;
}

// SOL/USD (Jupiter)
const SOL_MINT = 'So11111111111111111111111111111111111111112';
async function getSolUsd(){
  const now = Date.now();
  if (solUsdCache.price && (now - solUsdCache.ts) < 60_000) return solUsdCache.price;
  const j = await fetchJSONWithBackoff(`https://price.jup.ag/v6/price?ids=${SOL_MINT}`, {}, 3, 400);
  const p = j?.data?.[SOL_MINT]?.price;
  const price = (p!=null && Number.isFinite(Number(p))) ? Number(p) : null;
  if (price!=null){ solUsdCache.price = price; solUsdCache.ts = now; }
  return price;
}

async function prefetchPrices(burns){
  const mints = Array.from(new Set(burns.map(b=>b.mint).filter(Boolean)));
  let fetched=0;
  for (const m of mints){
    if (fetched >= MAX_PRICE_LOOKUPS_PER_POLL) break;
    const cached = priceCache.get(m);
    const fresh = cached && (Date.now()-cached.ts)<PRICE_TTL_MS;
    if (!fresh){ await getUsdPriceByMint(m); fetched++; }
  }
}

/* ========= DexScreener extra info (name/liquidity/etc) ========= */
async function enrichDexScreener(mint){
  try{
    const j = await fetchJSONWithBackoff(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      { headers: { 'User-Agent':'Mozilla/5.0 (compatible; BurnBot/1.0)', 'Accept':'application/json' } },
      3, 400
    );
    const pairs = j?.pairs || [];
    const sols  = pairs.filter(p => (p?.chainId||'').toLowerCase()==='solana');
    const best  = (sols.length?sols:pairs).sort((a,b)=>(b?.liquidity?.usd||0)-(a?.liquidity?.usd||0))[0];
    if (!best) return null;

    const priceUsd = Number(best?.priceUsd ?? null) || null;
    const liqUsd   = Number(best?.liquidity?.usd ?? null) || null;
    const fdv      = Number(best?.fdv ?? null) || null;
    const ratio    = (fdv && liqUsd) ? (fdv/liqUsd) : null;
    const createdMs = best?.pairCreatedAt ? Number(best.pairCreatedAt) : null;

    const info = best?.info || {};
    const websites = info?.websites || [];
    const socials  = info?.socials || [];
    const site = websites?.[0]?.url || null;
    const tg = socials.find(s => (s?.type||'').toLowerCase()==='telegram')?.url || null;
    const tw = socials.find(s => ['twitter','x'].includes((s?.type||'').toLowerCase()))?.url || null;

    const name = best?.baseToken?.name || best?.baseToken?.symbol || short(mint);
    const url  = best?.url || (`https://dexscreener.com/solana/${mint}`);

    return { priceUsd, liqUsd, fdv, ratio, createdMs, site, tg, tw, url, name };
  }catch(e){
    console.warn('DexScreener enrich fail:', e?.message||e);
    return null;
  }
}

/* ========= RPC stats ========= */
async function rpcStats(mintStr){
  const mintPk = new PublicKey(mintStr);
  let supplyUi=null, top10=[], top10Pct=null, mintRenounced=null, freezeRenounced=null;
  try{
    const s = await connection.getTokenSupply(mintPk);
    supplyUi = s?.value?.uiAmount ?? null;
  }catch(e){}
  try{
    const largest = await connection.getTokenLargestAccounts(mintPk);
    const arr = largest?.value || [];
    top10 = arr.slice(0,10).map(v => ({ address: v.address.toBase58(), amount: v.uiAmount }));
    if (supplyUi && supplyUi > 0){
      const sum = top10.reduce((a,c)=>a+(Number(c.amount)||0),0);
      top10Pct = sum / supplyUi;
    }
  }catch(e){}
  try{
    const mi = await getMint(connection, mintPk);
    mintRenounced = (mi?.mintAuthority === null);
    freezeRenounced = (mi?.freezeAuthority === null);
  }catch(e){}
  return { supplyUi, top10, top10Pct, mintRenounced, freezeRenounced };
}

/* ========= Formatting ========= */
function links(sig, mint, dsUrl){
  const out=[];
  if (sig) out.push(`[Solscan](https://solscan.io/tx/${sig})`);
  if (mint){
    out.push(`[Birdeye](https://birdeye.so/token/${mint}?chain=solana)`);
    out.push(`[DexScreener](${dsUrl || ('https://dexscreener.com/solana/'+mint)})`);
    out.push(`[Photon](https://photon-sol.tinyastro.io/en/lp/${mint})`);
  }
  return out.join(' | ');
}
function renderSecurity(mintRenounced, freezeRenounced){
  const meta = '├ Mutable Metadata: Unknown';
  const mint = `├ Mint Authority: ${mintRenounced===true?'No ✅':mintRenounced===false?'Yes ❌':'Unknown'}`;
  const frz  = `└ Freeze Authority: ${freezeRenounced===true?'No ✅':freezeRenounced===false?'Yes ❌':'Unknown'}`;
  return `${meta}\n${mint}\n${frz}`;
}
function renderTop(top10, pct, supplyUi){
  if (!top10?.length) return 'n/a';
  const lines = top10.map((h)=>{
    const perc = (supplyUi && h.amount!=null) ? ` | ${(Number(h.amount)/supplyUi*100).toFixed(2)}%` : '';
    return `├ \`${short(h.address)}\` | ${fmtNum(h.amount,2)}${perc}`;
  });
  return lines.join('\n') + (pct!=null?`\n└ Top10 share: ${fmtPct(pct)}`:'');
}

/* ========= Post report (USD + SOL) ========= */
async function postReport(burn){
  let usd = (typeof burn.amountUsd==='number' && burn.amountUsd>0) ? burn.amountUsd : null;
  let tokenPriceUsd = null, solUsd = null, sol = null;

  if ((usd==null || usd===0) && burn.mint && typeof burn.amount==='number' && burn.amount>0){
    tokenPriceUsd = await getUsdPriceByMint(burn.mint);
    if (tokenPriceUsd) usd = burn.amount * tokenPriceUsd;
  }
  if (usd!=null){
    solUsd = await getSolUsd();
    if (solUsd) sol = usd / solUsd;
  }

  // küszöb: ha MIN_USD <= 0, mindig posztolunk
  const meets = (cfg.minUsd <= 0) ? true : ((usd ?? 0) >= cfg.minUsd);
  if (!meets){
    console.log(`[SKIP<$${cfg.minUsd}] ${short(burn.sig)} mint=${short(burn.mint)} amount=${burn.amount} usd=${usd}`);
    return false;
  }

  const ds = burn.mint ? await enrichDexScreener(burn.mint) : null;
  const stats = burn.mint ? await rpcStats(burn.mint) : {};

  const priceUsd = ds?.priceUsd ?? tokenPriceUsd ?? null;
  const liqUsd   = ds?.liqUsd ?? null;
  const mcap     = ds?.fdv ?? null;
  const ratio    = ds?.ratio ?? null;
  const tradeStart = ds?.createdMs ? minutesAgo(ds.createdMs) : 'n/a';
  const socials = [ds?.site, ds?.tw, ds?.tg].filter(Boolean).join(' | ') || 'n/a';
  const nameLine = ds?.name ? `${ds.name}` : short(burn.mint||'Token');

  const lines = [];

  // CÍM (token név)
  lines.push(`${nameLine}`);
  lines.push('');

  // FŐ META blokk a példád mintájára
  lines.push(`🔥 Burn Percentage: —`);
  lines.push(`🕒 Trading Start Time: ${tradeStart}`);
  lines.push('');
  lines.push(`📊 Marketcap: ${fmtUsd(mcap,0)}`);
  lines.push(`💧 Liquidity: ${fmtUsd(liqUsd,0)}${ratio?` (${fmtNum(ratio,2)} MCAP/LP)`:''}`);
  lines.push(`💲 Price: ${priceUsd!=null?fmtUsd(priceUsd,6):'n/a'}`);
  lines.push('');

  // ÉGETETT MENNYISÉG (USD + SOL)
  if (typeof burn.amount==='number'){
    const usdTxt = (usd!=null) ? fmtUsd(usd,0) : 'n/a';
    const solTxt = (sol!=null) ? fmtSol(sol,4) : 'n/a';
    lines.push(`🔥 Burned Amount: ${fmtNum(burn.amount,4)}  (~${usdTxt} | ${solTxt})`);
  }
  lines.push('');

  // SUPPLY
  lines.push(`📦 Total Supply: ${fmtNum(stats?.supplyUi,0)}`);
  lines.push('');

  // SOCIALS + SECURITY blokk
  lines.push(`🌐 Socials: ${socials}    ⚙️ Security:`);
  lines.push(renderSecurity(stats?.mintRenounced, stats?.freezeRenounced));
  lines.push('');

  // TOP HOLDERS
  lines.push(`👑 Top Holders:`);
  lines.push(renderTop(stats?.top10, stats?.top10Pct, stats?.supplyUi));
  lines.push('');

  // Linkek
  lines.push(links(burn.sig, burn.mint, ds?.url));
  if (burn.mint) lines.push(`\n${burn.mint}`);

  const text = lines.join('\n');

  try{
    await bot.telegram.sendMessage(CHANNEL_ID, text, { parse_mode:'Markdown', disable_web_page_preview:true });
    console.log(`[POSTED] ${short(burn.sig)} ~${usd!=null?usd.toFixed(0):'n/a'}$ ${sol!=null?`(${sol.toFixed(4)} SOL)`:''}`);
    return true;
  }catch(e){
    console.error('[sendMessage ERROR]', e?.description || e?.message || e);
    return false;
  }
}

/* ========= Polling ========= */
async function pollOnce(){
  console.log('[POLL] start', new Date().toISOString());
  pruneSeen();
  try{
    const json = await bitqueryFetch(GQL(cfg.lookbackSec));
    const nodes = json?.data?.Solana?.TokenSupplyUpdates || [];
    const burns = parseBurnNodes(nodes);
    console.log(`[Bitquery] last ${cfg.lookbackSec}s -> nodes=${nodes.length}, parsed=${burns.length}`);

    await prefetchPrices(burns);

    for (const b of burns){
      if (!b.sig || !b.mint) continue;
      const k = keyFor(b.sig, b.mint);
      if (seen.has(k)) continue;
      const ok = await postReport(b).catch(e=>{ console.error('post error', e?.message); return false; });
      if (ok) seen.set(k, nowMs());
    }
  }catch(e){
    console.error('[Bitquery] fetch error:', e?.message || e);
  }finally{
    console.log('[POLL] end', new Date().toISOString());
  }
}
function restartPolling(){
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, cfg.pollIntervalSec*1000);
  console.log('[POLL] setInterval', cfg.pollIntervalSec, 'sec');
}

/* ========= Commands ========= */
bot.command('ping', (ctx)=>ctx.reply('pong'));
bot.command('status', (ctx)=>{
  ctx.reply([
    'Status:',
    `MIN_USD=$${cfg.minUsd}`,
    `POLL_INTERVAL_SEC=${cfg.pollIntervalSec}`,
    `POLL_LOOKBACK_SEC=${cfg.lookbackSec}`,
    `DEDUP_MINUTES=${cfg.dedupMinutes}`,
    `PRICE_SOURCE=${(PRICE_SOURCE||'auto')}${BIRDEYE_API_KEY?' (birdeye key set)':''}`
  ].join('\n'));
});
bot.command('setmin', async (ctx)=>{
  if (!isAdmin(ctx)) return ctx.reply('No permission.');
  const v = Number((ctx.message?.text||'').split(' ')[1]);
  if (!Number.isFinite(v) || v < 0) return ctx.reply('Usage: /setmin <usd>');
  cfg.minUsd = v;
  ctx.reply(`MIN_USD set to $${v}`);
});

/* ========= Start (409-safe) ========= */
(async ()=>{
  try{ await bot.telegram.deleteWebhook({ drop_pending_updates:true }); }catch{}
  try{
    await bot.launch({ dropPendingUpdates:true });
    console.log('Telegraf launched (polling ON).');
  }catch(e){
    console.error('Telegraf launch failed:', e?.description || e?.message);
  }
  try{
    await bot.telegram.sendMessage(
      CHANNEL_ID,
      `✅ BurnBot started
MIN_USD ≥ $${cfg.minUsd}
Poll=${cfg.pollIntervalSec}s  Window=${cfg.lookbackSec}s  Dedup=${cfg.dedupMinutes}m
Price source=${PRICE_SOURCE}${BIRDEYE_API_KEY?' (birdeye key set)':''}`
    );
  }catch(e){ console.error('[startup send error]', e?.message); }

  await pollOnce();
  restartPolling();
})();

process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM', ()=>bot.stop('SIGTERM'));
