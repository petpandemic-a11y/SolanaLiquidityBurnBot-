// SRC/index.js — PRO bot (Bitquery v2 EAP) + /post + /debug
import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

/**
 * ENV:
 *  BOT_TOKEN              Telegram bot token
 *  CHANNEL_ID             Telegram csatorna/chat ID (pl. -1002778911061 vagy @csatorna)
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

// -------------------- helpers --------------------
const seen = new Map();
const dedupMs = Number(DEDUP_MINUTES) * 60 * 1000;

const short = s => (s && s.length > 12 ? s.slice(0,4)+'…'+s.slice(-4) : s);
const fmtUsd = (x, frac=2) => (x==null ? 'n/a' : '$'+Number(x).toLocaleString(undefined,{maximumFractionDigits:frac}));
const fmtNum = (x, frac=0) => (x==null ? 'n/a' : Number(x).toLocaleString(undefined,{maximumFractionDigits:frac}));
const nowMs = () => Date.now();

// -------------------- GQL query --------------------
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

// -------------------- Bitquery fetch --------------------
async function bitqueryFetch(query){
  const res = await fetch('https://streaming.bitquery.io/eap', { // fontos: /eap
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${BITQUERY_API_KEY}`,
    },
    body: JSON.stringify({ query })
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0,200)}`);
  if (!json) throw new Error('Invalid/empty JSON');
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json;
}

function parseBurnNodes(nodes){
  const out = [];
  for(const n of nodes){
    const sig = n?.Transaction?.Signature;
    const call = n?.Call;
    let mint = call?.Currency?.Address || null;
    let decimals = call?.Currency?.Decimals ?? null;
    let amount = (typeof call?.AmountInUI==='number') ? call.AmountInUI : null;
    if (!mint){
      const accs = n?.Instruction?.Accounts?.map(a=>a?.Address).filter(Boolean) || [];
      if (accs.length) mint = accs[0];
    }
    if (!amount && typeof call?.Amount==='number' && typeof decimals==='number'){
      amount = call.Amount / Math.pow(10, decimals);
    }
    out.push({ sig, mint, amount });
  }
  return out;
}

// -------------------- debug --------------------
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

// -------------------- bot parancsok --------------------
bot.command('ping', (ctx)=>ctx.reply('pong'));

bot.command('post', async (ctx) => {
  const text = ctx.message.text.split(' ').slice(1).join(' ') || 'Teszt üzenet';
  try {
    await bot.telegram.sendMessage(process.env.CHANNEL_ID, `🔔 TEST: ${text}`, { disable_web_page_preview: true });
    await ctx.reply('✅ Elküldve a csatornába.');
  } catch (e) {
    await ctx.reply(`❌ Hiba: ${e?.description || e?.message}`);
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
  try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); } catch {}
  await bot.launch({ dropPendingUpdates: true });
  console.log('✅ Bot launched');

  try{
    await bot.telegram.sendMessage(
      CHANNEL_ID,
      `✅ BurnBot elindult. /ping → pong • Szűrés: ≥$${MIN_USD}`
    );
  }catch(e){ console.error('[startup send] error:', e?.message); }
})();
