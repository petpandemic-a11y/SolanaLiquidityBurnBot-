// SRC/index.js — Solana Burn Bot (Bitquery v2 EAP) — FULL (debug-heavy) build
// Features:
// - Admin guard (only specific Telegram user IDs can control the bot).
// - Bitquery v2 EAP (TokenSupplyUpdates) polling with robust GraphQL error handling.
// - Amount normalization (abs, decimals → UI), USD estimation via Jupiter → DexScreener fallback.
// - Enrichment via DexScreener (price, liquidity, FDV, socials, pair URL).
// - RPC stats (total supply, top 10 holders, mint/freeze authority renounced checks).
// - Deduplication window for already posted txs.
// - Detailed logs: HEARTBEAT, POLL start/end, Bitquery counts, POSTED, SKIP, and errors.
// - Safe Telegram send (no markdown parsing) to avoid formatting crashes.
// - Commands: /ping, /ver, /post, /setmin, /status, /debug, /force, /forceburn.
//
// Usage (Render):
//  - Background Worker (not Web Service).
//  - Start command: npm start
//  - package.json: { "scripts": { "start": "node SRC/index.js" } }
//  - ENV required:
//      BOT_TOKEN           -> Telegram bot token from BotFather
//      CHANNEL_ID          -> Telegram channel numeric id (e.g. -1002778911061)
//      BITQUERY_API_KEY    -> Bitquery v2 EAP access token (starts with ory_at_...)
//    Optional:
//      MIN_USD             -> default "30"; set "0" for testing (post everything)
//      POLL_INTERVAL_SEC   -> default "10"
//      POLL_LOOKBACK_SEC   -> default "12"
//      DEDUP_MINUTES       -> default "10"
//      RPC_URL             -> optional custom Solana RPC (Helius/Triton/etc)
//
// Notes:
//  - Avoid running multiple instances with the same BOT_TOKEN (will cause 409 getUpdates conflicts).
//  - Ensure the bot is Admin on the target channel with "Post messages" permission.
//  - CHANNEL_ID should be numeric -100..., not @handle, for reliability.

import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

/* ==============================
   ENV
   ============================== */
const {
  BOT_TOKEN,
  CHANNEL_ID,
  BITQUERY_API_KEY,
  MIN_USD = '30',
  POLL_INTERVAL_SEC = '10',
  POLL_LOOKBACK_SEC = '12',
  DEDUP_MINUTES = '10',
  RPC_URL
} = process.env;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!CHANNEL_ID) throw new Error('Missing CHANNEL_ID');
if (!BITQUERY_API_KEY) throw new Error('Missing BITQUERY_API_KEY');

/* ==============================
   ADMIN GUARD
   ============================== */
// Only these Telegram user IDs may use control commands
const ADMIN_IDS = [1721507540]; // << állítsd a saját user ID-dra
const isAdmin = (ctx) => !!(ctx?.from && ADMIN_IDS.includes(ctx.from.id));

/* ==============================
   GLOBALS
   ============================== */
const BUILD_TAG = 'build-2025-08-23-full-debug-v2';

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL || clusterApiUrl('mainnet-beta'), 'confirmed');

let cfg = {
  minUsd: Number(MIN_USD) || 30,
  pollIntervalSec: Number(POLL_INTERVAL_SEC) || 10,
  lookbackSec: Number(POLL_LOOKBACK_SEC) || 12,
  dedupMinutes: Number(DEDUP_MINUTES) || 10,
};
let pollTimer = null;

const seen = new Map(); // key(sig::mint) -> ts

/* ==============================
   HEARTBEAT & GLOBAL ERROR LOGS
   ============================== */
setInterval(() => {
  console.log('[HEARTBEAT]', new Date().toISOString());
}, 15_000);

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

/* ==============================
   HELPERS
   ============================== */
const mask = s => (s ? s.slice(0,4)+'…'+s.slice(-4) : 'n/a');
const short = s => (s && s.length > 12 ? s.slice(0,4)+'…'+s.slice(-4) : s);
const fmtUsd = (x, frac=2) => (x==null ? 'n/a' : '$'+Number(x).toLocaleString(undefined,{maximumFractionDigits:frac}));
const fmtPct = x => (x==null ? 'n/a' : (Number(x)*100).toFixed(2)+'%');
const fmtNum = (x, frac=0) => (x==null ? 'n/a' : Number(x).toLocaleString(undefined,{maximumFractionDigits:frac}));
const nowMs = () => Date.now();
const keyFor = (sig, mint) => `${sig || 'no-sig'}::${mint || 'no-mint'}`;

console.log('[ENV] BITQUERY_API_KEY =', mask(BITQUERY_API_KEY));
console.log('[CFG]', cfg);

function minutesAgo(tsMs){
  if (!tsMs) return 'n/a';
  const m = Math.floor((Date.now()-tsMs)/60000);
  if (m < 1) return 'just now';
  if (m === 1) return '1 minute ago';
  return `${m} minutes ago`;
}
function pruneSeen(){
  const dedupMs = cfg.dedupMinutes * 60 * 1000;
  const t = nowMs();
  for (const [k,ts] of Array.from(seen.entries())) if (t - ts > dedupMs) seen.delete(k);
}

/* ==============================
   PRICES (Jupiter + DexScreener fallback, cache)
   ============================== */
const priceCache = new Map(); // mint -> { price, ts, source }
const PRICE_TTL_MS = 60_000;

// Ha zavar a Jupiter logja, állítsd false-ra:
const PRICE_USE_JUPITER = true;

async function priceFromJupiter(mint){
  try {
    const r = await fetch(`https://price.jup.ag/v6/price?ids=${encodeURIComponent(mint)}`);
    const j = await r.json();
    const p = j?.data?.[mint]?.price ?? null;
    return (p!=null && Number.isFinite(Number(p))) ? Number(p) : null;
  } catch (e) {
    console.error('[Jupiter price] error:', e?.message || e);
    return null;
  }
}
async function priceFromDexScreener(mint){
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`);
    const j = await r.json();
    const pairs = j?.pairs || [];
    const sols = pairs.filter(p => (p?.chainId||'').toLowerCase()==='solana');
    const best = (sols.length?sols:pairs).sort((a,b)=>(b?.liquidity?.usd||0)-(a?.liquidity?.usd||0))[0];
    const p = best?.priceUsd;
    return (p!=null && Number.isFinite(Number(p))) ? Number(p) : null;
  } catch (e) {
    console.error('[DexScreener price] error:', e?.message || e);
    return null;
  }
}
async function getUsdPriceByMint(mint){
  const t = Date.now();
  const cached = priceCache.get(mint);
  if (cached && (t - cached.ts) < PRICE_TTL_MS) return cached.price;
  let price = null;
  if (PRICE_USE_JUPITER) {
    price = await priceFromJupiter(mint);
  }
  if (price == null) price = await priceFromDexScreener(mint);
  if (price != null) priceCache.set(mint, { price, ts:t });
  return price;
}

/* ==============================
   BITQUERY v2 EAP
   ============================== */
const GQL = (sec) => `
query BurnsLastWindow {
  Solana(dataset: realtime, network: solana) {
    TokenSupplyUpdates(
      where: {
        Instruction: { Program: { Method: { in: ["Burn", "burn"] } } }
        Transaction: { Result: { Success: true } }
        Block: { Time: { since_relative: { seconds_ago: ${sec} } } }
      }
      orderBy: { descending: Block_Time }
      limit: { count: 500 }
    ) {
      Block { Time }
      Transaction { Signature }
      TokenSupplyUpdate {
        Amount
        AmountInUSD
        Currency { MintAddress Symbol Decimals }
      }
    }
  }
}`;
async function bitqueryFetch(query){
  const res = await fetch('https://streaming.bitquery.io/eap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BITQUERY_API_KEY}` },
    body: JSON.stringify({ query })
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {/*non-json*/}
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0,200)}`);
  if (!json) throw new Error('Invalid/empty JSON from Bitquery');
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json;
}

/* ==============================
   PARSE burns
   ============================== */
const numOrNull = v => { if (v==null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
function parseBurnNodes(nodes){
  const out = [];
  for (const n of nodes){
    const sig = n?.Transaction?.Signature || null;
    const timeIso = n?.Block?.Time || null;
    const tu = n?.TokenSupplyUpdate || null;
    const mint = tu?.Currency?.MintAddress || null;

    const decimals = numOrNull(tu?.Currency?.Decimals) ?? 0;
    const rawAmt = numOrNull(tu?.Amount);                // burns negative -> abs
    const absRawAmt = rawAmt!=null ? Math.abs(rawAmt) : null;
    const rawUsd = numOrNull(tu?.AmountInUSD);
    const absUsd = rawUsd!=null ? Math.abs(rawUsd) : null;

    // if huge integer & decimals>0 → assume base units and scale to UI
    let amountUi = absRawAmt;
    if (absRawAmt!=null && decimals>0) {
      const isInt = Number.isInteger(absRawAmt);
      if (isInt && absRawAmt > 10 ** Math.max(0, decimals - 2)) amountUi = absRawAmt / (10 ** decimals);
    }

    out.push({ sig, timeIso, mint, amount: amountUi, amountUsd: absUsd });
  }
  return out;
}

/* ==============================
   RPC STATS
   ============================== */
async function rpcStats(mintStr){
  const mintPk = new PublicKey(mintStr);
  let supplyUi=null, top10=[], top10Pct=null, mintRenounced=null, freezeRenounced=null;

  try{
    const s = await connection.getTokenSupply(mintPk);
    supplyUi = s?.value?.uiAmount ?? null;
  }catch(e){ console.error('getTokenSupply', e?.message); }

  try{
    const largest = await connection.getTokenLargestAccounts(mintPk);
    const arr = largest?.value || [];
    top10 = arr.slice(0,10).map(v => ({ address: v.address.toBase58(), amount: v.uiAmount }));
    if (supplyUi && supplyUi > 0){
      const sum = top10.reduce((a,c)=>a+(Number(c.amount)||0),0);
      top10Pct = sum / supplyUi;
    }
  }catch(e){ console.error('getTokenLargestAccounts', e?.message); }

  try{
    const mi = await getMint(connection, mintPk);
    mintRenounced = (mi?.mintAuthority === null);
    freezeRenounced = (mi?.freezeAuthority === null);
  }catch(e){ console.error('getMint', e?.message); }

  return { supplyUi, top10, top10Pct, mintRenounced, freezeRenounced };
}

/* ==============================
   DEXSCREENER enrich
   ============================== */
async function enrichDexScreener(mint){
  try{
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`);
    const j = await r.json();
    const pairs = j?.pairs || [];
    const sols = pairs.filter(p => (p?.chainId||'').toLowerCase()==='solana');
    const sorted = (sols.length?sols:pairs).sort((a,b)=>(b?.liquidity?.usd||0)-(a?.liquidity?.usd||0));
    const best = sorted[0];
    if (!best) return null;

    const toNum = (v)=> (v!=null && Number.isFinite(Number(v))) ? Number(v) : null;
    const priceUsd = toNum(best?.priceUsd);
    const liqUsd   = toNum(best?.liquidity?.usd);
    const fdv      = toNum(best?.fdv);
    const ratio    = (fdv && liqUsd) ? (fdv/liqUsd) : null;
    const createdMs = best?.pairCreatedAt ? Number(best.pairCreatedAt) : null;

    const info = best?.info || {};
    const websites = info?.websites || [];
    const socials  = info?.socials || [];
    const site = websites?.[0]?.url || null;
    const tg = socials.find(s => (s?.type||'').toLowerCase()==='telegram')?.url || null;
    const tw = socials.find(s => ['twitter','x'].includes((s?.type||'').toLowerCase()))?.url || null;

    const url = best?.url || null;
    return { priceUsd, liqUsd, fdv, ratio, createdMs, site, tg, tw, url };
  }catch(e){ console.error('DexScreener', e?.message); return null; }
}

/* ==============================
   FORMAT
   ============================== */
function links(sig, mint, dsUrl){
  const out=[];
  if (sig) out.push(`Solscan: https://solscan.io/tx/${sig}`);
  if (mint){
    out.push(`Birdeye: https://birdeye.so/token/${mint}?chain=solana`);
    out.push(`DexScreener: ${dsUrl || ('https://dexscreener.com/solana/'+mint)}`);
    out.push(`Photon: https://photon-sol.tinyastro.io/en/lp/${mint}`);
  }
  return out.join(' | ');
}
function renderTop(top10, pct){
  if (!top10?.length) return 'n/a';
  const lines = top10.map((h)=>`- ${short(h.address)} | ${fmtNum(h.amount,2)}`);
  return lines.join('\n') + (pct!=null?`\nTop10 share: ${fmtPct(pct)}`:'');
}
function renderSecurity(mintRenounced, freezeRenounced){
  const meta = '- Mutable Metadata: Unknown';
  const mint = `- Mint Authority: ${mintRenounced===true?'No (renounced)':'Yes/Unknown'}`;
  const frz  = `- Freeze Authority: ${freezeRenounced===true?'No (renounced)':'Yes/Unknown'}`;
  return `${meta}\n${mint}\n${frz}`;
}

/* ==============================
   POST REPORT (safe send, no markdown)
   ============================== */
async function postReport(burn){
  // USD combine: Bitquery -> Jupiter -> DexScreener
  let usd = (typeof burn.amountUsd==='number' && burn.amountUsd>0) ? burn.amountUsd : null;
  if ((usd==null || usd===0) && burn.mint && typeof burn.amount==='number' && burn.amount>0){
    const px = await getUsdPriceByMint(burn.mint);
    if (px) usd = burn.amount * px;
  }

  if (cfg.minUsd>0 && (usd==null || usd < cfg.minUsd)){
    console.log(`[SKIP<$${cfg.minUsd}] sig=${short(burn.sig)} mint=${short(burn.mint)} amount=${burn.amount} usd=${usd}`);
    return false;
  }

  const ds = burn.mint ? await enrichDexScreener(burn.mint) : null;
  const stats = burn.mint ? await rpcStats(burn.mint) : {};

  const price = ds?.priceUsd ?? null;
  const liq   = ds?.liqUsd ?? null;
  const mcap  = ds?.fdv ?? null;
  const ratio = (mcap && liq) ? (mcap/liq) : null;
  const tradeStart = ds?.createdMs ? minutesAgo(ds.createdMs) : 'n/a';
  const socials = [ds?.site, ds?.tw, ds?.tg].filter(Boolean).join(' | ') || 'n/a';

  const lines=[];
  lines.push(`🔥 Burn Percentage: —`);
  lines.push(`🕒 Trading Start Time: ${tradeStart}`);
  lines.push('');
  lines.push(`📊 Marketcap: ${fmtUsd(mcap,0)}`);
  lines.push(`💧 Liquidity: ${fmtUsd(liq,0)}${ratio?` (${ratio?.toFixed(2)} MCAP/LP)`:''}`);
  lines.push(`💲 Price: ${price!=null?fmtUsd(price,6):'n/a'}`);
  if (typeof burn.amount==='number'){
    lines.push('');
    lines.push(`🔥 Burned Amount: ${fmtNum(burn.amount,4)} (~${usd!=null?fmtUsd(usd,0):'n/a'})`);
  }
  lines.push('');
  lines.push(`📦 Total Supply: ${fmtNum(stats?.supplyUi,0)}`);
  lines.push('');
  lines.push(`🌐 Socials: ${socials}`);
  lines.push('⚙️ Security:');
  lines.push(renderSecurity(stats?.mintRenounced, stats?.freezeRenounced));
  lines.push('');
  lines.push('💰 Top Holders:');
  lines.push(renderTop(stats?.top10, stats?.top10Pct));
  lines.push('');
  lines.push(links(burn.sig, burn.mint, ds?.url));
  if (burn.mint) lines.push(`\n${burn.mint}`);

  const text = lines.join('\n');

  try {
    await bot.telegram.sendMessage(CHANNEL_ID, text, { disable_web_page_preview: true });
    console.log(`[POSTED] sig=${short(burn.sig)} usd≈${usd!=null?usd.toFixed(2):'n/a'} mint=${short(burn.mint)} amount=${burn.amount}`);
    return true;
  } catch (e) {
    console.error('[sendMessage ERROR]', e?.description || e?.message || e);
    return false;
  }
}

/* ==============================
   POLLING
   ============================== */
async function pollOnce(){
  console.log('[POLL] start', new Date().toISOString());
  pruneSeen();
  try{
    const json = await bitqueryFetch(GQL(cfg.lookbackSec));
    const nodes = json?.data?.Solana?.TokenSupplyUpdates || [];
    const burns = parseBurnNodes(nodes);
    console.log(`[Bitquery] last ${cfg.lookbackSec}s -> nodes=${nodes.length}, parsed=${burns.length}`);

    for (const b of burns){
      if (!b.sig || !b.mint) continue;
      const k = keyFor(b.sig, b.mint);
      if (seen.has(k)) continue;
      const ok = await postReport(b).catch(e => { console.error('post error', e?.message); return false; });
      if (ok) seen.set(k, nowMs());
    }
  }catch(e){
    console.error('[Bitquery] fetch error:', e?.message || e);
  } finally {
    console.log('[POLL] end', new Date().toISOString());
  }
}
function restartPolling(){
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, cfg.pollIntervalSec*1000);
  console.log('[POLL] setInterval', cfg.pollIntervalSec, 'sec');
}

/* ==============================
   COMMANDS
   ============================== */
bot.command('ping', (ctx)=>ctx.reply('pong'));
bot.command('ver',  (ctx)=>ctx.reply(`OK • ${BUILD_TAG}`));

bot.command('post', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('❌ No permission.');
  const text = (ctx.message?.text || '').split(' ').slice(1).join(' ') || 'Test message';
  try {
    await bot.telegram.sendMessage(CHANNEL_ID, `🔔 TEST: ${text}`, { disable_web_page_preview: true });
    await ctx.reply('✅ Sent to channel.');
  } catch (e) {
    await ctx.reply(`❌ Error: ${e?.description || e?.message}`);
  }
});

bot.command('setmin', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('❌ No permission.');
  const v = Number((ctx.message?.text || '').split(' ')[1]);
  if (!Number.isFinite(v) || v < 0) return ctx.reply('Usage: /setmin <usd>');
  cfg.minUsd = v;
  ctx.reply(`✅ MIN_USD set to $${v}`);
});

bot.command('status', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('❌ No permission.');
  const s = [
    '⚙️ Settings:',
    `• MIN_USD = $${cfg.minUsd}`,
    `• POLL_INTERVAL_SEC = ${cfg.pollIntervalSec}s`,
    `• POLL_LOOKBACK_SEC = ${cfg.lookbackSec}s`,
    `• DEDUP_MINUTES = ${cfg.dedupMinutes}m`
  ];
  return ctx.reply(s.join('\n'));
});

bot.command('debug', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('❌ No permission.');
  try {
    const json = await bitqueryFetch(GQL(60));
    const nodes = json?.data?.Solana?.TokenSupplyUpdates || [];
    const burns = parseBurnNodes(nodes);

    const preview = [];
    for (const b of burns.slice(0,3)) {
      let usd = (typeof b.amountUsd === 'number' && b.amountUsd > 0) ? b.amountUsd : null;
      if ((usd == null || usd === 0) && b.mint && typeof b.amount === 'number' && b.amount > 0) {
        const px = await getUsdPriceByMint(b.mint);
        if (px) usd = b.amount * px;
      }
      preview.push(`- ${b.sig ? b.sig.slice(0,8)+'…' : 'no-sig'} | mint=${b.mint || 'n/a'} | amount=${b.amount ?? 'n/a'} | usd=${usd ?? b.amountUsd ?? 'n/a'}`);
    }

    let msg = `🧪 Debug: last 60s\n• Nodes: ${nodes.length}\n• Parsed burns: ${burns.length}`;
    if (preview.length) msg += `\n\nMinták:\n${preview.join('\n')}`;
    return ctx.reply(msg);
  } catch (e) {
    return ctx.reply(`❌ Bitquery error: ${e?.message || String(e)}`);
  }
});

// FORCE: simple test to channel, no Bitquery
bot.command('force', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('❌ No permission.');
  try {
    const msg = `FORCE TEST\nat=${new Date().toISOString()}`;
    await bot.telegram.sendMessage(CHANNEL_ID, msg, { disable_web_page_preview: true });
    return ctx.reply('✅ Force (simple) sent to channel.');
  } catch (e) {
    return ctx.reply(`❌ Force (simple) error: ${e?.description || e?.message || String(e)}`);
  }
});

// FORCEBURN: Bitquery-based forced post
bot.command('forceburn', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('❌ No permission.');
  try {
    const json = await bitqueryFetch(GQL(30));
    const nodes = json?.data?.Solana?.TokenSupplyUpdates || [];
    const burns = parseBurnNodes(nodes);
    if (!burns.length) return ctx.reply('ℹ️ No recent burns (last 30s).');

    const b = burns.find(x => x.mint && typeof x.amount === 'number' && x.amount > 0) || burns[0];

    let usd = (typeof b.amountUsd === 'number' && b.amountUsd > 0) ? b.amountUsd : null;
    if ((usd == null || usd === 0) && b.mint && typeof b.amount === 'number' && b.amount > 0) {
      const px = await getUsdPriceByMint(b.mint);
      if (px) usd = b.amount * px;
    }

    const msg = [
      'FORCE BURN TEST',
      `sig=${b.sig || 'n/a'}`,
      `mint=${b.mint || 'n/a'}`,
      `amount=${b.amount ?? 'n/a'}`,
      `usd≈${usd ?? 'n/a'}`
    ].join('\n');

    await bot.telegram.sendMessage(CHANNEL_ID, msg, { disable_web_page_preview: true });
    return ctx.reply('✅ Forceburn s
