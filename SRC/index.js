// SRC/index.js — ULTRA bot (Bitquery v2 EAP) + DexScreener/Jupiter ár fallback + RPC + /post + /debug + /setmin + /status
import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

/**
 * ENV:
 *  BOT_TOKEN, CHANNEL_ID, BITQUERY_API_KEY (ory_at_…)
 *  MIN_USD ("30"), POLL_INTERVAL_SEC ("10"), POLL_LOOKBACK_SEC ("12"), DEDUP_MINUTES ("10")
 *  RPC_URL (opcionális)
 */
const {
  BOT_TOKEN, CHANNEL_ID, BITQUERY_API_KEY,
  MIN_USD = '30', POLL_INTERVAL_SEC = '10', POLL_LOOKBACK_SEC = '12', DEDUP_MINUTES = '10',
  RPC_URL
} = process.env;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!CHANNEL_ID) throw new Error('Missing CHANNEL_ID');
if (!BITQUERY_API_KEY) throw new Error('Missing BITQUERY_API_KEY');

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL || clusterApiUrl('mainnet-beta'), 'confirmed');

// ---- futás közbeni config ----
let cfg = {
  minUsd: Number(MIN_USD) || 30,
  pollIntervalSec: Number(POLL_INTERVAL_SEC) || 10,
  lookbackSec: Number(POLL_LOOKBACK_SEC) || 12,
  dedupMinutes: Number(DEDUP_MINUTES) || 10,
};
let pollTimer = null;

// ---- utils ----
const seen = new Map(); // key(sig+mint) -> ts
const mask = s => (s ? s.slice(0,4)+'…'+s.slice(-4) : 'n/a');
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
console.log('[ENV] BITQUERY_API_KEY =', mask(BITQUERY_API_KEY));
console.log('[CFG]', cfg);

// ---- árak (Jupiter + DexScreener fallback) ----
const priceCache = new Map(); // mint -> { price, ts, source }
const PRICE_TTL_MS = 60_000;

async function priceFromJupiter(mint){
  const r = await fetch(`https://price.jup.ag/v6/price?ids=${encodeURIComponent(mint)}`);
  const j = await r.json();
  const p = j?.data?.[mint]?.price ?? null;
  return (p!=null && Number.isFinite(Number(p))) ? Number(p) : null;
}
async function priceFromDexScreener(mint){
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`);
  const j = await r.json();
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

  let price = null; let src='none';
  try { price = await priceFromJupiter(mint); src='jup'; } catch {}
  if (price==null){
    try { price = await priceFromDexScreener(mint); src='ds'; } catch {}
  }
  if (price!=null) priceCache.set(mint, { price, ts:t, source:src });
  return price;
}

// ---- Bitquery (V2 EAP) ----
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

// ---- parse (abs, decimals→UI) ----
const numOrNull = v => { if (v==null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
function parseBurnNodes(nodes){
  const out = [];
  for (const n of nodes){
    const sig = n?.Transaction?.Signature || null;
    const timeIso = n?.Block?.Time || null;
    const tu = n?.TokenSupplyUpdate || null;
    const mint = tu?.Currency?.MintAddress || null;
    const decimals = numOrNull(tu?.Currency?.Decimals) ?? 0;

    const rawAmt = numOrNull(tu?.Amount);     // burn → negatív
    const absRawAmt = rawAmt!=null ? Math.abs(rawAmt) : null;
    const rawUsd = numOrNull(tu?.AmountInUSD);
    const absUsd = rawUsd!=null ? Math.abs(rawUsd) : null;

    // ha nagyon nagy egész és van decimals, skálázzuk UI-ra
    let amountUi = absRawAmt;
    if (absRawAmt!=null && decimals>0) {
      const isInt = Number.isInteger(absRawAmt);
      if (isInt && absRawAmt > 10 ** Math.max(0, decimals - 2)) amountUi = absRawAmt / (10 ** decimals);
    }

    out.push({ sig, timeIso, mint, amount: amountUi, amountUsd: absUsd });
  }
  return out;
}

// ---- RPC statok ----
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

// ---- DexScreener enrich (árat innen is használjuk USD-hez fallbackként) ----
async function enrichDexScreener(mint){
  try{
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`);
    const j = await r.json();
    const pairs = j?.pairs || [];
    const sols = pairs.filter(p => (p?.chainId||'').toLowerCase()==='solana');
    const sorted = (sols.length?sols:pairs).sort((a,b)=>(b?.liquidity?.usd||0)-(a?.liquidity?.usd||0));
    const best = sorted[0];
    if (!best) return null;

    const priceUsd = numOrNull(best?.priceUsd);
    const liqUsd   = numOrNull(best?.liquidity?.usd);
    const fdv      = numOrNull(best?.fdv);
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
  }catch(e){ return null; }
}

// ---- formatting ----
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
function renderTop(top10, pct){
  if (!top10?.length) return 'n/a';
  const lines = top10.map((h)=>`├ \`${short(h.address)}\` | ${fmtNum(h.amount,2)}`);
  return lines.join('\n') + (pct!=null?`\nTop10 share: ${fmtPct(pct)}`:'');
}
function renderSecurity(mintRenounced, freezeRenounced){
  const meta = '├ Mutable Metadata: Unknown';
  const mint = `├ Mint Authority: ${mintRenounced===true?'No ✅':mintRenounced===false?'Yes ❌':'Unknown'}`;
  const frz  = `└ Freeze Authority: ${freezeRenounced===true?'No ✅':freezeRenounced===false?'Yes ❌':'Unknown'}`;
  return `${meta}\n${mint}\n${frz}`;
}

// ---- posztolás ----
async function postReport(burn){
  // USD számítás: Bitquery (abs) → Jupiter → DexScreener
  let usd = (typeof burn.amountUsd==='number' && burn.amountUsd>0) ? burn.amountUsd : null;

  if ((usd==null || usd===0) && burn.mint && typeof burn.amount==='number' && burn.amount>0){
    const px = await getUsdPriceByMint(burn.mint); // jup→ds fallback
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
  const ratio = ds?.ratio ?? null;
  const tradeStart = ds?.createdMs ? minutesAgo(ds.createdMs) : 'n/a';
  const socials = [ds?.site, ds?.tw, ds?.tg].filter(Boolean).join(' | ') || 'n/a';

  const lines=[];
  lines.push(`🔥 Burn Percentage: —`);
  lines.push(`🕒 Trading Start Time: ${tradeStart}`);
  lines.push('');
  lines.push(`📊 Marketcap: ${fmtUsd(mcap,0)}`);
  lines.push(`💧 Liquidity: ${fmtUsd(liq,0)}${ratio?` (${(mcap&&liq)?(mcap/liq).toFixed(2):'n/a'} MCAP/LP)`:''}`);
  lines.push(`💲 Price: ${price!=null?fmtUsd(price,6):'n/a'}`);
  if (typeof burn.amount==='number' && usd!=null){
    lines.push('');
    lines.push(`🔥 Burned Amount: ${fmtNum(burn.amount,4)} (~${fmtUsd(usd,0)})`);
  }
  lines.push('');
  lines.push(`📦 Total Supply: ${fmtNum(stats?.supplyUi,0)}`);
  lines.push('');
  lines.push(`🌐 Socials: ${socials}    ⚙️ Security:`);
  lines.push(renderSecurity(stats?.mintRenounced, stats?.freezeRenounced));
  lines.push('');
  lines.push(`💰 Top Holders:`);
  lines.push(renderTop(stats?.top10, stats?.top10Pct));
  lines.push('');
  lines.push(links(burn.sig, burn.mint, ds?.url));
  if (burn.mint) lines.push(`\n${burn.mint}`);

  await bot.telegram.sendMessage(CHANNEL_ID, lines.join('\n'), { parse_mode:'Markdown', disable_web_page_preview:true });
  console.log(`[POSTED] sig=${short(burn.sig)} usd≈${usd?usd.toFixed(2):'n/a'} mint=${short(burn.mint)} amount=${burn.amount}`);
  return true;
}

// ---- polling ----
async function pollOnce(){
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
    console.error('[Bitquery] fetch error:', e?.message);
  }
}
function restartPolling(){ if (pollTimer) clearInterval(pollTimer); pollTimer = setInterval(pollOnce, cfg.pollIntervalSec*1000); }

// ---- debug + parancsok ----
async function debugFetchBurns(seconds = 60) {
  try {
    const json = await bitqueryFetch(GQL(seconds));
    const nodes = json?.data?.Solana?.TokenSupplyUpdates || [];
    const burns = parseBurnNodes(nodes);
    return { ok:true, nodes: nodes.length, burns: burns.length, preview: burns.slice(0,3) };
  } catch (e) { return { ok:false, err: e?.message || String(e) }; }
}

bot.command('ping', (ctx)=>ctx.reply('pong'));
bot.command('post', async (ctx) => {
  const text = ctx.message.text.split(' ').slice(1).join(' ') || 'Teszt üzenet';
  try { await bot.telegram.sendMessage(process.env.CHANNEL_ID, `🔔 TEST: ${text}`, { disable_web_page_preview: true }); await ctx.reply('✅ Elküldve a csatornába.'); }
  catch (e) { await ctx.reply(`❌ Nem sikerült: ${e?.description || e?.message}`); }
});
bot.command('debug', async (ctx) => {
  const r = await debugFetchBurns(60);
  if (!r.ok) return ctx.reply(`❌ Bitquery hiba: ${r.err}`);
  let msg = `🧪 Debug: last 60s\n• Nodes: ${r.nodes}\n• Parsed burns: ${r.burns}`;
  if (r.preview?.length) msg += `\n\nMinták:\n` + r.preview.map(b => `- ${b.sig ? b.sig.slice(0,8)+'…' : 'no-sig'} | mint=${b.mint || 'n/a'} | amount=${b.amount ?? 'n/a'} | usd=${b.amountUsd ?? 'n/a'}`).join('\n');
  return ctx.reply(msg);
});
bot.command('setmin', async (ctx) => {
  const v = Number(ctx.message.text.split(' ')[1]);
  if (!Number.isFinite(v) || v < 0) return ctx.reply('Használat: /setmin <usd>, pl. /setmin 100');
  cfg.minUsd = v; ctx.reply(`✅ MIN_USD beállítva: $${v}`);
});
bot.command('status', async (ctx) => {
  const s = [`⚙️ Beállítások:`,`• MIN_USD = $${cfg.minUsd}`,`• POLL_INTERVAL_SEC = ${cfg.pollIntervalSec}s`,`• POLL_LOOKBACK_SEC = ${cfg.lookbackSec}s`,`• DEDUP_MINUTES = ${cfg.dedupMinutes}m`];
  return ctx.reply(s.join('\n'));
});

// ---- start ----
(async ()=>{
  try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); } catch {}
  await bot.launch({ dropPendingUpdates: true });
  console.log('✅ Bot launched (polling).');

  try{
    await bot.telegram.sendMessage(
      CHANNEL_ID,
      `✅ BurnBot elindult.
• Küszöb: ≥$${cfg.minUsd}
• Poll: ${cfg.pollIntervalSec}s
• Window: ${cfg.lookbackSec}s
• Dedup: ${cfg.dedupMinutes} perc`
    );
  }catch(e){ console.error('[startup send] error:', e?.message); }

  await pollOnce();
  restartPolling();
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
