import 'dotenv/config';
import fetch from 'node-fetch';
import { Telegraf } from 'telegraf';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

/**
 * PRO Solana Burn Bot
 * - Bitquery polling (last POLL_LOOKBACK_SEC) every POLL_INTERVAL_SEC sec
 * - Jupiter ár alapján USD becslés, MIN_USD szűrő
 * - DexScreener: priceUsd, liquidity.usd, fdv, socials, pairCreatedAt
 * - MCAP/LP arány
 * - RPC: supply, top10 holders, mint/freeze renounce
 * - Linkek: Solscan | Birdeye | DexScreener | Photon
 * - /ping → pong; startup üzenet; részletes logok
 */

const {
  BITQUERY_API_KEY,
  BOT_TOKEN,
  CHANNEL_ID,
  POLL_INTERVAL_SEC = '10',
  POLL_LOOKBACK_SEC = '12',
  MIN_USD = '30',
  DEDUP_MINUTES = '10',
  RPC_URL // optional
} = process.env;

if (!BITQUERY_API_KEY) throw new Error('Missing BITQUERY_API_KEY');
if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!CHANNEL_ID) throw new Error('Missing CHANNEL_ID');

const bot = new
