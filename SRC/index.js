// SRC/index.js — Solana Burn Bot (Bitquery v2 EAP) — Clean ASCII version

import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

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

const ADMIN_IDS = [1721507540]; // change to your Telegram user id
const isAdmin = (ctx) => !!(ctx?.from && ADMIN_IDS.includes(ctx.from.id));

const BUILD_TAG = 'build-clean-ascii';

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

setInterval(() => {
  console.log('[HEARTBEAT]', new Date().toISOString());
}, 15000);

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

const short = s => (s && s.length > 12 ? s.slice(0,4)+'…'+s.slice(-4) : s);
const fmtUsd = (x, frac=2) => (x==null ? 'n/a' : '$'+Number(x).toLocaleString(undefined,{maximumFractionDigits:frac}));
const fmtPct = x => (x==null ? 'n/a' : (Number(x)*100).toFixed(2)+'%');
const fmtNum = (x, frac=0) => (x==null ? 'n/a' : Number(x).toLocaleString(undefined,{maximumFractionDigits:frac}));
const nowMs = () => Date.now();
const keyFor = (sig, mint) => `${sig || 'no-sig'}::${mint || 'no-mint'}`;

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

// --- Price helpers (only DexScreener to keep clean) ---
const priceCache = new Map();
const PRICE_TTL_MS = 60000;

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
  let price = await priceFromDexScreener(mint);
  if (price != null) priceCache.set(mint, { price, ts:t });
  return price;
}

// --- Bitquery ---
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
  let json = null; try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0,200)}`);
  if (!json) throw new Error('Invalid/empty JSON from Bitquery');
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json;
}

function parseBurnNodes(nodes){
  const out = [];
  for (const n of nodes){
    const sig = n?.Transaction?.Signature || null;
    const tu = n?.TokenSupplyUpdate || null;
    const mint = tu?.Currency?.MintAddress || null;
    const decimals = Number(tu?.Currency?.Decimals) || 0;
    const rawAmt = Number(tu?.Amount);
    const absRawAmt = rawAmt ? Math.abs(rawAmt) : null;
    const rawUsd = Number(tu?.AmountInUSD);
    const absUsd = rawUsd ? Math.abs(rawUsd) : null;

    let amountUi = absRawAmt;
    if (absRawAmt && decimals>0) {
      if (Number.isInteger(absRawAmt) && absRawAmt > 10 ** (decimals - 2)) {
        amountUi = absRawAmt / (10 ** decimals);
      }
    }
    out.push({ sig, mint, amount: amountUi, amountUsd: absUsd });
  }
  return out;
}

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

function renderTop(top10, pct){
  if (!top10?.length) return 'n/a';
  const lines = top10.map((h)=>`- ${short(h.address)} | ${fmtNum(h.amount,2)}`);
  return lines.join('\n') + (pct!=null?`\nTop10 share: ${fmtPct(pct)}`:'');
}

async function postReport(burn){
  let usd = (typeof burn.amountUsd==='number' && burn.amountUsd>0) ? burn.amountUsd : null;
  if ((usd==null || usd===0) && burn.mint && typeof burn.amount==='number' && burn.amount>0){
    const px = await getUsdPriceByMint(burn.mint);
    if (px) usd = burn.amount * px;
  }
  if (cfg.minUsd>0 && (usd==null || usd < cfg.minUsd)){
    console.log(`[SKIP<$${cfg.minUsd}] sig=${short(burn.sig)} mint=${short(burn.mint)} amount=${burn.amount} usd=${usd}`);
    return false;
  }
  const stats = burn.mint ? await rpcStats(burn.mint) : {};
  const lines=[];
  lines.push(`Burn event`);
  if (typeof burn.amount==='number'){
    lines.push(`Amount: ${fmtNum(burn.amount,4)} (~${usd!=null?fmtUsd(usd,0):'n/a'})`);
  }
  lines.push(`Total Supply: ${fmtNum(stats?.supplyUi,0)}`);
  lines.push(`Top Holders:\n${renderTop(stats?.top10, stats?.top10Pct)}`);
  if (burn.sig) lines.push(`Tx: https://solscan.io/tx/${burn.sig}`);
  if (burn.mint) lines.push(`Mint: ${burn.mint}`);
  const text = lines.join('\n');
  try {
    await bot.telegram.sendMessage(CHANNEL_ID, text, { disable_web_page_preview: true });
    console.log(`[POSTED] sig=${short(burn.sig)} usd~${usd!=null?usd.toFixed(2):'n/a'} mint=${short(burn.mint)} amount=${burn.amount}`);
    return true;
  } catch (e) {
    console.error('[sendMessage ERROR]', e?.description || e?.message || e);
    return false;
  }
}

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

// Commands
bot.command('ping', (ctx)=>ctx.reply('pong'));
bot.command('ver',  (ctx)=>ctx.reply(`OK ${BUILD_TAG}`));

bot.command('setmin', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('No permission.');
  const v = Number((ctx.message?.text || '').split(' ')[1]);
  if (!Number.isFinite(v) || v < 0) return ctx.reply('Usage: /setmin <usd>');
  cfg.minUsd = v;
  ctx.reply(`MIN_USD set to $${v}`);
});

bot.command('status', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('No permission.');
  const s = [
    'Settings:',
    `MIN_USD = $${cfg.minUsd}`,
    `POLL_INTERVAL_SEC = ${cfg.pollIntervalSec}`,
    `POLL_LOOKBACK_SEC = ${cfg.lookbackSec}`,
    `DEDUP_MINUTES = ${cfg.dedupMinutes}`
  ];
  return ctx.reply(s.join('\n'));
});

bot.command('forceburn', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('No permission.');
  try {
    const json = await bitqueryFetch(GQL(30));
    const nodes = json?.data?.Solana?.TokenSupplyUpdates || [];
    const burns = parseBurnNodes(nodes);
    if (!burns.length) return ctx.reply('No recent burns (last 30s).');
    const b = burns[0];
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
      `usd~${usd ?? 'n/a'}`
    ].join('\n');
    await bot.telegram.sendMessage(CHANNEL_ID, msg, { disable_web_page_preview: true });
    return ctx.reply('Forceburn sent to channel.');
  } catch (e) {
    return ctx.reply(`Forceburn error: ${e?.message || String(e)}`);
  }
});

// START block with 409 fallback
(async ()=>{
  let launched = false;
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  } catch(e) {}
  try {
    await bot.launch({ dropPendingUpdates: true });
    launched = true;
    console.log('Telegraf launched (polling).');
  } catch (e) {
    console.error('Telegraf launch failed:', e?.description || e?.message);
    console.warn('Fallback: running without Telegram updates, only channel posting.');
  }
  try{
    await bot.telegram.sendMessage(
      CHANNEL_ID,
      `BurnBot started
MIN_USD >= $${cfg.minUsd}
Poll=${cfg.pollIntervalSec}s Window=${cfg.lookbackSec}s Dedup=${cfg.dedupMinutes}m
${launched ? '(updates ON)' : '(updates OFF)'}
${BUILD_TAG}`
    );
  }catch(e){ console.error('[startup send] error:', e?.message); }
  console.log('[POLL] first run...');
  await pollOnce();
  restartPolling();
})();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
