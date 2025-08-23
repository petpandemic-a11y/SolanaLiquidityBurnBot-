import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

/**
 * ENV változók:
 *  BOT_TOKEN          Telegram bot token
 *  CHANNEL_ID         Telegram csatorna ID (pl. -1001234567890)
 *  BITQUERY_API_KEY   Bitquery API kulcs (ory_at_...)
 *  BIRDEYE_API_KEY    Birdeye API kulcs
 *  MIN_SOL            minimum SOL érték (pl. 0.1)
 *  MAX_MCAP_SOL       maximum marketcap SOL-ban (opcionális)
 */

const {
  BOT_TOKEN,
  CHANNEL_ID,
  BITQUERY_API_KEY,
  BIRDEYE_API_KEY,
  MIN_SOL = '0.1',
  MAX_MCAP_SOL,
  RPC_URL
} = process.env;

if (!BOT_TOKEN) throw new Error('❌ BOT_TOKEN missing');
if (!CHANNEL_ID) throw new Error('❌ CHANNEL_ID missing');
if (!BITQUERY_API_KEY) throw new Error('❌ BITQUERY_API_KEY missing');
if (!BIRDEYE_API_KEY) throw new Error('❌ BIRDEYE_API_KEY missing');

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL || clusterApiUrl('mainnet-beta'), 'confirmed');

// ===== helpers =====
const seen = new Map();
const dedupMs = 10 * 60 * 1000; // 10 perc

const short = (s) => (s && s.length > 10 ? s.slice(0, 4) + '…' + s.slice(-4) : s);
const fmtNum = (x, d = 2) => (x == null ? 'n/a' : Number(x).toLocaleString(undefined, { maximumFractionDigits: d }));

// ===== ár lekérés =====
async function getSolUsd() {
  try {
    const r = await fetch('https://public-api.birdeye.so/public/price?address=So11111111111111111111111111111111111111112', {
      headers: { 'X-API-KEY': BIRDEYE_API_KEY }
    });
    const j = await r.json();
    return j?.data?.value || null;
  } catch (e) {
    console.error('[birdeye SOL price] error:', e.message);
    return null;
  }
}

async function getUsdPriceByMint(mint) {
  try {
    const r = await fetch(`https://public-api.birdeye.so/public/price?address=${mint}`, {
      headers: { 'X-API-KEY': BIRDEYE_API_KEY }
    });
    const j = await r.json();
    return j?.data?.value || null;
  } catch (e) {
    console.error('[birdeye token price] error:', e.message);
    return null;
  }
}

// ===== Bitquery lekérés =====
const GQL = (sec) => `
query MyQuery {
  solana(network: solana) {
    instructions(
      options: {limit: 50, desc: "block.time"}
      time: {since: "now-${sec}s"}
      where: {program: {method: {is: "burn"}}}
    ) {
      transaction { signature }
      block { time }
      instruction {
        accounts { address }
      }
    }
  }
}`;

async function bitqueryFetch(query) {
  const res = await fetch('https://graphql.bitquery.io/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': BITQUERY_API_KEY,
    },
    body: JSON.stringify({ query })
  });
  const j = await res.json();
  if (j.errors) throw new Error('Bitquery error: ' + JSON.stringify(j.errors));
  return j;
}

// ===== posztolás =====
async function postReport(burn) {
  const solUsdPrice = await getSolUsd();
  const tokenUsdPrice = burn.mint ? await getUsdPriceByMint(burn.mint) : null;

  let burnSol = null;
  if (burn.amount && tokenUsdPrice && solUsdPrice) {
    burnSol = (burn.amount * tokenUsdPrice) / solUsdPrice;
  }

  let mcapSol = null;
  if (burn.fdv && solUsdPrice) {
    mcapSol = burn.fdv / solUsdPrice;
  }

  if (Number(MIN_SOL) > 0 && (!burnSol || burnSol < Number(MIN_SOL))) {
    console.log(`[SKIP < MIN_SOL] sig=${burn.sig} mint=${short(burn.mint)} burnSol=${burnSol}`);
    return false;
  }
  if (MAX_MCAP_SOL && mcapSol && mcapSol > Number(MAX_MCAP_SOL)) {
    console.log(`[SKIP > MAX_MCAP_SOL] sig=${burn.sig} mcapSol=${mcapSol}`);
    return false;
  }

  const text = [
    `Burn event`,
    `Amount: ${fmtNum(burn.amount, 6)} (~${fmtNum(burnSol, 2)} SOL)`,
    `Total Supply: ${fmtNum(burn.supply, 0)}`,
    `Tx: https://solscan.io/tx/${burn.sig}`,
    `Mint: ${burn.mint}`
  ].join('\n');

  await bot.telegram.sendMessage(CHANNEL_ID, text, { disable_web_page_preview: true });
  console.log(`[POSTED] ${burn.sig}`);
  return true;
}

// ===== polling =====
async function pollOnce() {
  const json = await bitqueryFetch(GQL(30));
  const nodes = json?.data?.solana?.instructions || [];

  for (const n of nodes) {
    const sig = n?.transaction?.signature;
    const mint = n?.instruction?.accounts?.[0]?.address;
    if (!sig || !mint) continue;

    if (seen.has(sig) && Date.now() - seen.get(sig) < dedupMs) continue;
    seen.set(sig, Date.now());

    const burn = { sig, mint, amount: 0.0, supply: null, fdv: null };
    await postReport(burn);
  }
}

// ===== Telegram parancsok =====
bot.command('ping', (ctx) => ctx.reply('pong'));
bot.command('setmin', (ctx) => {
  const parts = ctx.message.text.split(' ');
  if (parts[1]) {
    process.env.MIN_SOL = parts[1];
    ctx.reply(`✅ MIN_SOL updated: ${parts[1]}`);
  } else {
    ctx.reply(`Current MIN_SOL = ${process.env.MIN_SOL}`);
  }
});

// ===== indulás =====
(async () => {
  await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
  await bot.launch();
  console.log('✅ Bot launched (polling)');

  setInterval(() => console.log('[HEARTBEAT]', new Date().toISOString()), 15000);
  setInterval(pollOnce, 15000);
})();
