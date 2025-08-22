import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';

const {
  BITQUERY_API_KEY,
  BOT_TOKEN,
  CHANNEL_ID,
  POLL_INTERVAL_SEC = '10',
  POLL_LOOKBACK_SEC = '12',
  MIN_USD = '30',
  DEDUP_MINUTES = '10'
} = process.env;

if (!BITQUERY_API_KEY) throw new Error('Missing BITQUERY_API_KEY');
if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!CHANNEL_ID) throw new Error('Missing CHANNEL_ID');

const bot = new Telegraf(BOT_TOKEN);

// dedup ugyanarra a tx-re
const seen = new Map(); // sig -> ts
const dedupMs = Number(DEDUP_MINUTES) * 60 * 1000;

// Jupiter ár cache
const priceCache = new Map(); // mint -> {price, ts}
const PRICE_TTL_MS = 60 * 1000;

function short(s){return s && s.length>12 ? s.slice(0,4)+'…'+s.slice(-4):s;}

async function getUsdPriceByMint(mint){
  const now = Date.now();
  const c = priceCache.get(mint);
  if (c && now - c.ts < PRICE_TTL_MS) return c.price;
  try{
    const r = await fetch(`https://price.jup.ag/v6/price?ids=${encodeURIComponent(mint)}`);
    const j = await r.json();
    const p = j?.data?.[mint]?.price ?? null;
    if (p){ priceCache.set(mint,{price:p,ts:now}); return p; }
  }catch{}
  return null;
}

// Bitquery GQL – utolsó ablak burn-jei
const GQL = (sec)=>`
query BurnsLastWindow {
  Solana {
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
      Instruction { Accounts { Account } }
      Call {
        Amount
        AmountInUI
        Currency { Address Decimals Symbol Name }
      }
    }
  }
}`;

function parse(nodes){
  const out=[];
  for(const n of nodes){
    const sig = n?.Transaction?.Signature;
    const timeIso = n?.Block?.Time;
    const call = n?.Call;
    const ins = n?.Instruction;
    let mint = call?.Currency?.Address || null;
    let decimals = call?.Currency?.Decimals ?? null;
    let amount = (typeof call?.AmountInUI==='number') ? call.AmountInUI : null;
    if(!mint){
      const accs = ins?.Accounts?.map(a=>a?.Account).filter(Boolean)||[];
      if(accs.length>=1) mint = accs[0];
    }
    if(!amount && typeof call?.Amount==='number' && typeof decimals==='number'){
      amount = call.Amount / Math.pow(10,decimals);
    }
    out.push({sig,timeIso,mint,amount});
  }
  return out;
}

async function post(b){
  const minUsd = Number(MIN_USD);
  let usd=null;
  if (b.mint && typeof b.amount==='number'){
    const px = await getUsdPriceByMint(b.mint);
    if(px) usd = b.amount*px;
  }
  if (minUsd>0 && (usd===null || usd<minUsd)) return false;

  const lines=[];
  lines.push('🔥 *Burn esemény (Bitquery)*');
  if(b.timeIso) lines.push(`• Idő: ${b.timeIso}`);
  if(b.sig) lines.push(`• Tx: \`${b.sig}\``);
  if(b.mint) lines.push(`• Mint: \`${b.mint}\``);
  if(typeof b.amount==='number') lines.push(`• Mennyiség: ${b.amount}`);
  if(usd!==null) lines.push(`• Becsült érték: ~$${usd.toFixed(2)}`);
  lines.push('');
  const links=[];
  if(b.sig) links.push(`[Solscan](https://solscan.io/tx/${b.sig})`);
  if(b.mint) links.push(`[Birdeye](https://birdeye.so/token/${b.mint}?chain=solana)`);
  if(b.mint) links.push(`[DexScreener](https://dexscreener.com/solana/${b.mint})`);
  lines.push(links.join(' | '));

  await bot.telegram.sendMessage(CHANNEL_ID, lines.join('\n'), { parse_mode:'Markdown', disable_web_page_preview:true });
  return true;
}

async function pollOnce(){
  // tisztítsuk a dedupot
  const now = Date.now();
  for(const [k,ts] of Array.from(seen.entries())) if (now-ts>dedupMs) seen.delete(k);

  const res = await fetch('https://streaming.bitquery.io/graphql',{
    method:'POST',
    headers:{'Content-Type':'application/json','X-API-KEY':BITQUERY_API_KEY},
    body: JSON.stringify({ query: GQL(Number(POLL_LOOKBACK_SEC)) })
  });
  const data = await res.json();
  const nodes = data?.data?.Solana?.Instructions || [];
  const burns = parse(nodes);
  for(const b of burns){
    if(!b.sig) continue;
    if(seen.has(b.sig)) continue;
    const ok = await post(b).catch(()=>false);
    if(ok) seen.set(b.sig, Date.now());
  }
}

bot.command('ping', (ctx)=>ctx.reply('pong'));

(async ()=>{
  await bot.launch();
  // induláskor jelzés
  try{ await bot.telegram.sendMessage(CHANNEL_ID, `✅ BurnBot elindult. /ping → pong • Szűrés: ≥$${MIN_USD} burn`);}catch(e){console.error(e?.message);}
  await pollOnce();
  setInterval(pollOnce, Number(POLL_INTERVAL_SEC)*1000);
})();
