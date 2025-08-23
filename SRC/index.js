// SRC/index.js — DIAG build (ASCII only): bizonyítsuk be, hogy posztol, és Bitquery jön.

import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';

const {
  BOT_TOKEN,
  CHANNEL_ID,
  BITQUERY_API_KEY,
  MIN_USD = '30',
  POLL_INTERVAL_SEC = '10',
  POLL_LOOKBACK_SEC = '12'
} = process.env;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!CHANNEL_ID) throw new Error('Missing CHANNEL_ID');
if (!BITQUERY_API_KEY) throw new Error('Missing BITQUERY_API_KEY');

const bot = new Telegraf(BOT_TOKEN);
let pollTimer = null;

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
  const res = await fetch('https://streaming.bitquery.io/eap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BITQUERY_API_KEY}` },
    body: JSON.stringify({ query })
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0,200)}`);
  if (!json) throw new Error('Invalid JSON from Bitquery');
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json;
}

async function pollOnce(){
  const look = Number(POLL_LOOKBACK_SEC) || 12;
  console.log('[POLL] start', new Date().toISOString());
  try{
    const j = await bitqueryFetch(GQL(look));
    const nodes = j?.data?.Solana?.TokenSupplyUpdates || [];
    console.log(`[Bitquery] nodes=${nodes.length}`);
    // csak diagnosztikai poszt: mennyi burn jött a windowban
    const big = nodes.filter(n => {
      const usd = Number(n?.TokenSupplyUpdate?.AmountInUSD) || 0;
      return Math.abs(usd) >= Number(MIN_USD || '30');
    });
    if (big.length){
      const msg = `DIAG: last ${look}s burns=${nodes.length}, over $${MIN_USD}: ${big.length}`;
      try { await bot.telegram.sendMessage(CHANNEL_ID, msg, { disable_web_page_preview:true }); }
      catch(e){ console.error('[sendMessage error]', e?.description || e?.message); }
    }
  }catch(e){
    console.error('[Bitquery error]', e?.message || e);
  } finally {
    console.log('[POLL] end', new Date().toISOString());
  }
}

// parancsok (ha megy a polling)
bot.command('ping', (ctx)=>ctx.reply('pong'));
bot.command('status', (ctx)=>{
  ctx.reply([
    'Status:',
    `MIN_USD=$${MIN_USD}`,
    `POLL_INTERVAL_SEC=${POLL_INTERVAL_SEC}`,
    `POLL_LOOKBACK_SEC=${POLL_LOOKBACK_SEC}`
  ].join('\n'));
});

// START: 409-safe
(async ()=>{
  let launched = false;
  try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); } catch {}
  try {
    await bot.launch({ dropPendingUpdates: true });
    launched = true;
    console.log('Telegraf launched (polling ON).');
  } catch (e) {
    console.error('Telegraf launch failed:', e?.description || e?.message);
    console.warn('Fallback: running without updates.');
  }

  try {
    await bot.telegram.sendMessage(
      CHANNEL_ID,
      `DIAG bot started
MIN_USD >= $${MIN_USD}
Poll=${POLL_INTERVAL_SEC}s Window=${POLL_LOOKBACK_SEC}s
${launched ? '(updates ON)' : '(updates OFF)'}`
    );
  } catch(e){ console.error('[startup send error]', e?.message); }

  await pollOnce();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, (Number(POLL_INTERVAL_SEC)||10)*1000);
  console.log('[POLL] interval set:', POLL_INTERVAL_SEC, 'sec');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
