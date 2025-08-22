import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

/**
 * PRO Solana Burn Bot (Bitquery polling, enriched output)
 * - Polls Bitquery every POLL_INTERVAL_SEC seconds for the last POLL_LOOKBACK_SEC
 * - Filters to burns with estimated USD value >= MIN_USD (Jupiter price)
 * - Enrichment:
 *    • DexScreener: priceUsd, liquidity.usd, fdv (MCAP), socials, pairCreatedAt
 *    • MCAP / LP ratio
 *    • Supply + Top 10 holders (RPC)
 *    • Mint/Freeze authority (renounce check)
 *    • Links: Solscan, Birdeye, DexScreener, Photon
 * - /ping -> pong; startup test message
 */

const {
  BITQUERY_API_KEY,
  BOT_TOKEN,
  CHANNEL_ID,
  POLL_INTERVAL_SEC = '10',
  POLL_LOOKBACK_SEC = '12',
  MIN_USD = '1000',
  DEDUP_MINUTES = '10',
  RPC_URL // optional
} = process.env;

if (!BITQUERY_API_KEY) throw new Error('Missing BITQUERY_API_KEY');
if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!CHANNEL_ID) throw new Error('Missing CHANNEL_ID');

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(RPC_URL || clusterApiUrl('mainnet-beta'), 'confirmed');

// Caches & helpers
const seen = new Map(); // sig -> ts
const dedupMs = Number(DEDUP_MINUTES) * 60 * 1000;
const PRICE_TTL_MS = 60 * 1000;
const priceCache = new Map(); // mint -> { price, ts }

function short(s) { return s && s.length > 12 ? s.slice(0,4) + '…' + s.slice(-4) : s; }
function fmtUsd(x, frac=2) { return x == null ? 'n/a' : '$' + Number(x).toLocaleString(undefined, { maximumFractionDigits: frac }); }
function fmtPct(x) { return x == null ? 'n/a' : `${(Number(x)*100).toFixed(2)}%`; }
function fmtNumber(x, frac=0) { return x == null ? 'n/a' : Number(x).toLocaleString(undefined, { maximumFractionDigits: frac }); }
function minutesAgo(tsMs) {
  if (!tsMs) return 'n/a';
  const mins = Math.floor((Date.now() - tsMs) / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  return `${mins} minutes ago`;
}

async function getUsdPriceByMint(mint) {
  const now = Date.now();
  const c = priceCache.get(mint);
  if (c && now - c.ts < PRICE_TTL_MS) return c.price;
  try {
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${encodeURIComponent(mint)}`);
    const data = await res.json();
    const p = data?.data?.[mint]?.price ?? null;
    if (p) {
      priceCache.set(mint, { price: p, ts: now });
      return p;
    }
  } catch {}
  return null;
}

// Bitquery GraphQL query
const GQL = (winSec) => `
query BurnsLastWindow {
  Solana {
    Instructions(
      where: {
        Instruction: { Program: { Method: { is: "burn" } } }
        Transaction: { Result: { Success: true } }
        Block: { Time: { since: "${winSec} seconds" } }
      }
      limit: 500
    ) {
      Transaction { Signature }
      Block { Time }
      Instruction {
        Program { Name Method }
        Accounts { Account }
      }
      Call {
        Amount
        AmountInUI
        Currency { Address Symbol Name Decimals }
      }
    }
  }
}`;

function parseBurnNodes(nodes) {
  const out = [];
  for (const n of nodes) {
    const sig = n?.Transaction?.Signature;
    const timeIso = n?.Block?.Time;
    const call = n?.Call;
    const ins = n?.Instruction;
    let mint = call?.Currency?.Address || null;
    let decimals = call?.Currency?.Decimals ?? null;
    let amount = (typeof call?.AmountInUI === 'number') ? call.AmountInUI : null;
    if (!mint) {
      const accs = ins?.Accounts?.map(a => a?.Account).filter(Boolean) || [];
      if (accs.length >= 1) mint = accs[0];
    }
    if (!amount && typeof call?.Amount === 'number' && typeof decimals === 'number') {
      amount = call.Amount / Math.pow(10, decimals);
    }
    out.push({ sig, timeIso, mint, amount });
  }
  return out;
}

async function enrichWithDexScreener(mint) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`);
    const j = await r.json();
    const pairs = j?.pairs || [];
    // prefer Solana pairs, pick the one with highest liquidity
    const solPairs = pairs.filter(p => (p?.chainId || p?.chainId === 0) ? (p.chainId?.toLowerCase?.() === 'solana') : (p.chainId === 'solana'));
    const byLiq = (a,b) => (b?.liquidity?.usd||0) - (a?.liquidity?.usd||0);
    const best = (solPairs.length ? solPairs : pairs).sort(byLiq)[0];

    if (!best) return null;
    const priceUsd = Number(best?.priceUsd ?? null) || null;
    const liqUsd = Number(best?.liquidity?.usd ?? null) || null;
    const fdv = Number(best?.fdv ?? null) || null; // MCAP (FDV)
    const lpUrl = best?.url || null;
    const pairCreatedAt = best?.pairCreatedAt || null;
    const createdMs = pairCreatedAt ? Number(pairCreatedAt) : null;

    // socials & websites
    const info = best?.info || {};
    const websites = info?.websites || [];
    const social = info?.socials || [];
    const site = websites?.[0]?.url || null;
    const tg = (social || []).find(s => (s?.type||'').toLowerCase()==='telegram')?.url || null;
    const tw = (social || []).find(s => ['twitter','x'].includes((s?.type||'').toLowerCase()))?.url || null;

    return {
      priceUsd, liqUsd, fdv, mcOverLp: (fdv && liqUsd) ? (fdv/liqUsd) : null,
      site, tg, tw, lpUrl, createdMs
    };
  } catch {
    return null;
  }
}

async function getTokenStats(mintStr) {
  const mintPk = new PublicKey(mintStr);
  // supply
  let supplyUi = null;
  try {
    const s = await connection.getTokenSupply(mintPk);
    supplyUi = s?.value?.uiAmount ?? null;
  } catch {}
  // holders
  let topHolders = [];
