// SRC/index.js — Solana Burn Bot (Bitquery v2 EAP) — Backoff + Limit + ASCII clean

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
  POLL_INTERVAL_SEC = '20',
  POLL_LOOKBACK_SEC = '25',
  DEDUP_MINUTES = '10',
  RPC_URL
} = process.env;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!CHANNEL_ID) throw new Error('Missing CHANNEL_ID');
if (!BITQUERY_API_KEY) throw new Error('Missing BITQUERY_API_KEY');

const ADMIN_IDS = [1721507540]; // saját Telegram ID-d
const isAdmin = (ctx) => !!(ctx?.from && ADMIN_IDS.includes(ctx.from.id));

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL || clusterApiUrl('mainnet-beta'), 'confirmed');

let cfg = {
  minUsd: Number(MIN_USD) || 30,
  pollIntervalSec: Number(POLL_INTERVAL_SEC) || 20,
  lookbackSec: Number(POLL_LOOKBACK_SEC) || 25,
  dedupMinutes: Number(DEDUP_MINUTES) || 10,
};
let pollTimer = null;

const seen = new Map();
const priceCache = new Map();
const PRICE_TTL_MS = 60_000;
const MAX_PRICE_LOOKUPS_PER_POLL = 6;

setInterval(() => console.log('[HEARTBEAT]', new Date().toISOString()), 15000);

// ---------------- helpers ----------------
const short = s => (s && s.length > 12 ? s.slice(0,4)+'…'+s.slice(-4) : s);
const fmtUsd = (x, frac=2) => (x==null ? 'n/a' : '$'+Number(x).toLocaleString(undefined,{maximumFractionDigits:frac}));
const fmtPct = x => (x==null ? 'n/a' : (Number(x)*100).toFixed(2)+'%');
const fmtNum = (x, frac=0) => (x==null ? 'n/a' : Number(x).toLocaleString(undefined,{maximumFractionDigits:frac}));
const nowMs = () => Date.now();
const keyFor = (sig, mint) => `${sig || 'no-sig'}::${mint || 'no-mint'}`;

function pruneSeen(){
  const dedupMs = cfg.dedupMinutes * 60 * 1000;
  const t = nowMs();
  for (const [k,ts] of Array.from(seen.entries())) if (t - ts > dedupMs) seen.delete(k);
}

// ---------------- generic fetch with backoff ----------------
async function fetchJSONWithBackoff(url, {
  method = 'GET',
  headers = {},
  body = undefined,
} = {}, maxRetries = 5, baseDelayMs = 500) {
  let delay = baseDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { method, headers, body });
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get('retry-after')) || 0;
        const wait = Math.max(delay, ra * 1000);
        console.warn(`Server responded with ${res.status}. Retrying after ${wait}ms delay...`);
        await new Promise(r => setTimeout(r, wait));
        delay *= 2;
        continue;
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('application/json')) {
        const text = await res.text().catch(()=> '');
        console.warn(`Non-JSON content-type "${ct}". Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      const json = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0,200)}`);
      return json;
    } catch (e) {
      if (attempt === maxRetries) throw e;
      console.warn(`Fetch error: ${e?.message || e}. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
  throw new Error('Unreachable');
}

// ---------------- Bitquery ----------------
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
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BITQUERY_API_KEY}`
      },
      body: JSON.stringify({ query })
    },
    5,
    500
  );
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
    const rawUsd = Number(tu?.AmountInUSD);
    const absRawAmt = rawAmt ? Math.abs(rawAmt) : null;
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

// ---------------- DexScreener ----------------
const DS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; BurnBot/1.0)',
  'Accept': 'application/json',
};

async function priceFromDexScreener(mint){
  const j = await fetchJSONWithBackoff(
    `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
    { headers: DS_HEADERS },
    4,
    500
  );
  const pairs = j?.pairs || [];
  const sols = pairs.filter(p => (p?.chainId||'').toLowerCase()==='solana');
  const best = (sols.length?sols:pairs).sort((a,b)=>(b?.liquidity?.usd||0)-(a?.liquidity?.usd||0))[0];
  const p = best?.priceUsd;
  return (p!=null && Number.isFinite(Number(p))) ? Number(p) : null;
}

async function getUsdPriceByMint(mint){
  const t = Date.now();
  const cached = priceCache.get(mint);
  if (cached && (t - cached.ts) < PRICE_TTL_MS) return cached.price;
  const price = await priceFromDexScreener(mint);
  if (price != null) priceCache.set(mint, { price, ts:t });
  return price;
}

async function prefetchPrices(burns) {
  const distinctMints = Array.from(new Set(burns.map(b => b.mint).filter(Boolean)));
  let fetched = 0;
  for (const m of distinctMints) {
    if (fetched >= MAX_PRICE_LOOKUPS_PER_POLL) break;
    const cached = priceCache.get(m);
    const fresh = cached && (Date.now() - cached.ts) < PRICE_TTL_MS;
    if (!fresh) {
      const p = await priceFromDexScreener(m);
      if (p != null) priceCache.set(m, { price: p, ts: Date.now() });
      fetched++;
    }
  }
}

// ---------------- RPC stats ----------------
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

// ---------------- posting ----------------
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
  // Küszöb: ha MIN_USD <= 0 → mindig posztolunk
  const meetsThreshold = (cfg.minUsd <= 0) ? true : (usd != null && usd >= cfg.minUsd);
  if (!meetsThreshold) {
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

// ---------------- polling ----------------
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

// ---------------- commands ----------------
bot.command('ping', (ctx)=>ctx.reply('pong'));
bot.command('status', (ctx)=>{
  ctx.reply([
    'Status:',
    `MIN_USD=$${cfg.minUsd}`,
    `POLL_INTERVAL_SEC=${cfg.pollIntervalSec}`,
    `POLL_LOOKBACK_SEC=${cfg.lookbackSec}`,
    `DEDUP_MINUTES=${cfg.dedupMinutes}`
  ].join('\n'));
});
bot.command('setmin', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('No permission.');
  const v = Number((ctx.message?.text || '').split(' ')[1]);
  if (!Number.isFinite(v) || v < 0) return ctx.reply('Usage: /setmin <usd>');
  cfg.minUsd = v;
  ctx.reply(`MIN_USD set to $${v}`);
});

// ---------------- start ----------------
(async ()=>{
  try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); } catch {}
  try {
    await bot.launch({ dropPendingUpdates: true });
    console.log('Telegraf launched (polling ON).');
  } catch (e) {
    console.error('Telegraf launch failed:', e?.description || e?.message);
    console.warn('Fallback: running without updates.');
  }
  try {
    await bot.telegram.sendMessage(
      CHANNEL_ID,
      `BurnBot started
MIN_USD >= $${cfg.minUsd}
Poll=${cfg.pollIntervalSec}s Window=${cfg.lookbackSec}s Dedup=${cfg.dedupMinutes}m`
    );
  }catch(e){ console.error('[startup send error]', e?.message); }
  await pollOnce();
  restartPolling();
})();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
