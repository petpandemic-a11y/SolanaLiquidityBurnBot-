// SRC/index.js — PRO bot (Bitquery v2) + /post + /debug
import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

/**
 * ENV:
 *  BOT_TOKEN              Telegram bot token
 *  CHANNEL_ID             Telegram csatorna/chat ID (pl. -1002778911061 VAGY @csatorna)
 *  BITQUERY_API_KEY       Bitquery API v2 Access Token (ory_at_…)
 *  MIN_USD                min. USD (pl. "30")
 *  POLL_INTERVAL_SEC      poll intervallum sec (default 10)
 *  POLL_LOOKBACK_SEC      időablak sec (default 12)
 *  DEDUP_MINUTES          dedup ablak percekben (default 10)
 *  RPC_URL                opcionális egyedi Solana RPC
 */

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

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL || clusterApiUrl('mainnet-beta'), 'confirmed');

// -------------------- helpers & caches --------------------
const seen = new Map(); // sig -> ts
const dedupMs = Number(DEDUP_MINUTES) * 60 * 1000;

const priceCache = new Map(); // mint -> { price, ts }
const PRICE_TTL_MS = 60_000;

const short = s => (s && s.length > 12 ? s.slice(0,4)+'…'+s.slice(-4) : s);
const fmtUsd = (x, frac=2) => (x==null ? 'n/a' : '$'+Number(x).toLocaleString(undefined,{maximumFractionDigits:frac}));
const fmtPct = x => (x==null ? 'n/a' : (Number(x)*100).toFixed(2)+'%');
const fmtNum = (x, frac=0) => (x==null ? 'n/a' : Number(x).toLocaleString(undefined,{maximumFractionDigits:frac}));
const nowMs = () => Date.now();

function minutesAgo(tsMs){
  if (!tsMs) return 'n/a';
  const m = Math.floor((Date.now()-tsMs)/60000);
  if (m < 1) return 'just now';
  if (m === 1) return '1 minute ago';
  return `${m} minutes ago`;
}

async function getUsdPriceByMint(mint){
  const t = nowMs();
  const cached = priceCache.get(mint);
  if (cached && t - cached.ts < PRICE_TTL_MS) return cached.price;
  try{
    const r = await fetch(`https://price.jup.ag/v6/price?ids=${encodeURIComponent(mint)}`);
    const j = await r.json();
    const p = j?.data?.[mint]?.price ?? null;
    if (p){ priceCache.set(mint,{price:p,ts:t}); return p; }
  }catch(e){ console.error('Jupiter price error:', e?.message); }
  return null;
}

// -------------------- Bitquery GQL (v2) --------------------
const GQL = (sec) => `
query BurnsLastWindow {
  Solana(dataset: realtime, network: solana) {
    Instructions(
      where: {
        Instruction: { Program: { Method: { is: "burn" } } }
        Transaction: { Result: { Success: true } }
        Block: { Time: { since: "${sec} seconds" } }
      }
      limit: 500
    ) {
      Transaction { Signature }
      Block { Time }
      Instruction { Accounts { Address } }
      Call {
        Amount
        AmountInUI
        Currency { Address Decimals Symbol Name }
      }
    }
  }
}`;

// robusztus fetch+parse Bitqueryhez (v2 Bearer auth)
async function bitqueryFetch(query){
  const res = await fetch('https://streaming.bitquery.io/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${BITQUERY_API_KEY}`, // v2
    },
    body: JSON.stringify({ query })
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {/* not JSON */}
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0,200)}`);
  }
  if (!json) throw new Error('Invalid/empty JSON from Bitquery');
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json;
}

function parseBurnNodes(nodes){
  const out = [];
  for(const n of nodes){
    const sig = n?.Transaction?.Signature;
    const timeIso = n?.Block?.Time;
    const call = n?.Call;
    const ins = n?.Instruction;

    let mint = call?.Currency?.Address || null;
    let decimals = call?.Currency?.Decimals ?? null;
    let amount = (typeof call?.AmountInUI==='number') ? call.AmountInUI : null;

    if (!mint){
      const accs = ins?.Accounts?.map(a=>a?.Address).filter(Boolean) || [];
      if (accs.length >= 1) mint = accs[0];
    }
    if (!amount && typeof call?.Amount==='number' && typeof decimals==='number'){
      amount = call.Amount / Math.pow(10, decimals);
    }
    out.push({ sig, timeIso, mint, amount });
  }
  return out;
}

// -------------------- DexScreener enrich --------------------
async function enrichDexScreener(mint){
  try{
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`);
    const j = await r.json();
    const pairs = j?.pairs || [];
    const sols = pairs.filter(p => (p?.chainId||'').toLowerCase()==='solana');
    const sorted = (sols.length?sols:pairs).sort((a,b)=>(b?.liquidity?.usd||0)-(a?.liquidity?.usd||0));
    const best = sorted[0];
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

    const url = best?.url || null; // DexScreener pair URL

    return { priceUsd, liqUsd, fdv, ratio, createdMs, site, tg, tw, url };
  }catch(e){
    console.error('DexScreener error:', e?.message);
    return null;
  }
}

// -------------------- RPC: supply, top10, authorities --------------------
async function rpcStats(mintStr){
  const mintPk = new PublicKey(mintStr);
  let supplyUi=null, top10=[], top10Pct=null, mintRenounced=null, freezeRenounced=null;

  try{
    const s = await connection.getTokenSupply(mintPk);
    supplyUi = s?.value?.uiAmount ?? null;
  }catch(e){ console.error('getTokenSupply error:', e?.message); }

  try{
    const largest = await connection.getTokenLargestAccounts(mintPk);
    const arr = largest?.value || [];
    top10 = arr.slice(0,10).map(v => ({ address: v.address.toBase58(), amount: v.uiAmount }));
    if (supplyUi && supplyUi > 0){
      const sum = top10.reduce((a,c)=>a+(Number(c.amount)||0),0);
      top10Pct = sum / supplyUi;
    }
  }catch(e){ console.error('getTokenLargestAccounts error:', e?.message); }

  try{
    const mi = await getMint(connection, mintPk);
    mintRenounced = (mi?.mintAuthority === null);
    freezeRenounced = (mi?.freezeAuthority === null);
  }catch(e){ console.error('getMint error:', e?.message); }

  return { supplyUi, top10, top10Pct, mintRenounced, freezeRenounced };
}

// -------------------- formatting --------------------
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

// -------------------- Telegram posting --------------------
async function postReport(burn){
  const minUsd = Number(MIN_USD);
  let usd=null;
  if (burn.mint && typeof burn.amount==='number'){
    const px = await getUsdPriceByMint(burn.mint);
    if (px) usd = burn.amount * px;
  }
  if (minUsd>0 && (usd==null || usd < minUsd)){
    console.log(`[SKIP<$${minUsd}] ${burn.sig} mint=${short(burn.mint)} amount=${burn.amount} usd=${usd}`);
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
  lines.push(`🔥 Burn Percentage: —`); // pontos % nincs – helykitöltő
  lines.push(`🕒 Trading Start Time: ${tradeStart}`);
  lines.push('');
  lines.push(`📊 Marketcap: ${fmtUsd(mcap,0)}`);
  lines.push(`💧 Liquidity: ${fmtUsd(liq,0)}${ratio?` (${fmtNum(ratio,2)} MCAP/LP)`:''}`);
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

  const text = lines.join('\n');
  await bot.telegram.sendMessage(CHANNEL_ID, text, { parse_mode:'Markdown', disable_web_page_preview:true });
  console.log(`[POSTED] ${burn.sig} ~${fmtUsd(usd)} mint=${short(burn.mint)}`);
  return true;
}

// -------------------- polling loop --------------------
async function pollOnce(){
  const t = nowMs();
  for (const [k,ts] of Array.from(seen.entries())) if (t - ts > dedupMs) seen.delete(k);

  try{
    const json = await bitqueryFetch(GQL(Number(POLL_LOOKBACK_SEC)));
    const nodes = json?.data?.Solana?.Instructions || [];
    console.log(`[Bitquery] last ${POLL_LOOKBACK_SEC}s -> ${nodes.length} instructions`);
    const burns = parseBurnNodes(nodes);
    console.log(`[Bitquery] parsed burns: ${burns.length}`);

    for (const b of burns){
      if (!b.sig || !b.mint) continue;
      if (seen.has(b.sig)) continue;
      const ok = await postReport(b).catch(e => { console.error('post error', e?.message); return false; });
      if (ok) seen.set(b.sig, nowMs());
    }
  }catch(e){
    console.error('[Bitquery] fetch error:', e?.message);
  }
}

// -------------------- DEBUG helper + parancs --------------------
async function debugFetchBurns(seconds = 60) {
  try {
    const json = await bitqueryFetch(GQL(seconds));
    const nodes = json?.data?.Solana?.Instructions || [];
    const burns = parseBurnNodes(nodes);
    return { ok:true, nodes: nodes.length, burns: burns.length, preview: burns.slice(0,3) };
  } catch (e) {
    return { ok:false, err: e?.message || String(e) };
  }
}

// -------------------- commands --------------------
bot.command('ping', (ctx)=>ctx.reply('pong'));

bot.command('post', async (ctx) => {
  const text = ctx.message.text.split(' ').slice(1).join(' ') || 'Teszt üzenet';
  try {
    await bot.telegram.sendMessage(process.env.CHANNEL_ID, `🔔 TEST: ${text}`, { disable_web_page_preview: true });
    await ctx.reply('✅ Elküldve a csatornába.');
  } catch (e) {
    await ctx.reply(`❌ Nem sikerült: ${e?.description || e?.message}`);
    console.error('sendMessage error:', e);
  }
});

bot.command('debug', async (ctx) => {
  const r = await debugFetchBurns(60);
  if (!r.ok) return ctx.reply(`❌ Bitquery hiba: ${r.err}`);
  let msg = `🧪 Debug: last 60s\n• Instructions: ${r.nodes}\n• Parsed burns: ${r.burns}`;
  if (r.preview?.length) {
    msg += `\n\nMinták:\n` + r.preview.map(b => `- ${b.sig ? b.sig.slice(0,8)+'…' : 'no-sig'} | mint=${b.mint || 'n/a'} | amount=${b.amount ?? 'n/a'}`).join('\n');
  }
  return ctx.reply(msg);
});

// -------------------- start --------------------
(async ()=>{
  // Teljes nullázás induláskor a 409 ellen
  try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); }
  catch(e){ console.error('[deleteWebhook] warn:', e?.description || e?.message); }

  await bot.launch({ dropPendingUpdates: true });
  console.log('✅ Bot launched (polling).');

  try{
    await bot.telegram.sendMessage(
      CHANNEL_ID,
      `✅ BurnBot elindult. /ping → pong • Szűrés: ≥$${MIN_USD} • Poll: ${POLL_INTERVAL_SEC}s • Window: ${POLL_LOOKBACK_SEC}s`
    );
  }catch(e){ console.error('[startup send] error:', e?.message); }

  await pollOnce();
  setInterval(pollOnce, Number(POLL_INTERVAL_SEC)*1000);
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
