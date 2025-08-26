// index.js
import fs from 'fs';
import { Connection, clusterApiUrl, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

// === Config ===
const RPC = process.env.RPC || clusterApiUrl('mainnet-beta');
const connection = new Connection(RPC, 'confirmed');
const STATE_FILE = 'monitored-lps.json';
const RAYDIUM_API = 'https://api-v3.raydium.io';

// === State ===
let monitoredLPs = loadState();

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(monitoredLPs, null, 2));
}

// === Fetch new pools from Raydium API ===
async function discoverNewPools() {
  try {
    const url = `${RAYDIUM_API}/pools/info/list`;
    const res = await fetch(url);
    const data = await res.json();

    for (const pool of data.data || []) {
      if (!pool.lpMint?.address) continue;
      const lpMint = pool.lpMint.address;
      const tokenA = pool.mintA?.symbol || '';
      const tokenB = pool.mintB?.symbol || '';

      // MEME + SOL szűrés
      if (tokenA.toLowerCase().includes('sol') || tokenB.toLowerCase().includes('sol')) {
        if (
          tokenA.toLowerCase().includes('doge') ||
          tokenA.toLowerCase().includes('pepe') ||
          tokenA.toLowerCase().includes('inu') ||
          tokenB.toLowerCase().includes('doge') ||
          tokenB.toLowerCase().includes('pepe') ||
          tokenB.toLowerCase().includes('inu')
        ) {
          if (!monitoredLPs[lpMint]) {
            console.log('✨ New MEME pool found:', tokenA, '/', tokenB, 'LP:', lpMint);
            monitorLP(lpMint);
          }
        }
      }
    }
  } catch (e) {
    console.error('discoverNewPools error', e);
  }
}

// === Monitor LP for burn events ===
async function monitorLP(lpMint) {
  if (monitoredLPs[lpMint]) return;
  monitoredLPs[lpMint] = { since: Date.now() };
  saveState();

  const lpPubkey = new PublicKey(lpMint);
  console.log('👀 Monitoring LP:', lpMint);

  connection.onLogs(lpPubkey, (log) => {
    if (log.logs.some((l) => l.toLowerCase().includes('burn'))) {
      console.log('🔥 Burn detected for LP:', lpMint);
    }
    if (log.logs.some((l) => l.includes('11111111111111111111111111111111'))) {
      console.log('🔒 LP sent to null address (lock) for:', lpMint);
    }
  }, 'confirmed');
}

// === CLI commands ===
function handleCommand(cmd) {
  const [command, arg] = cmd.trim().split(/\\s+/);

  switch (command) {
    case '/monitor':
      if (!arg) return console.log('Usage: /monitor <lpMint>');
      monitorLP(arg);
      break;
    case '/stop':
      if (!arg) return console.log('Usage: /stop <lpMint>');
      delete monitoredLPs[arg];
      saveState();
      console.log('🛑 Stopped monitoring', arg);
      break;
    case '/status':
      console.log('📊 Active monitors:', Object.keys(monitoredLPs));
      break;
    default:
      console.log('Unknown command:', command);
  }
}

// === Main ===
(async () => {
  console.log('🚀 Raydium LP Burn Monitor started');

  // Reload existing
  for (const lpMint of Object.keys(monitoredLPs)) {
    monitorLP(lpMint);
  }

  // Discovery loop
  setInterval(discoverNewPools, 60_000); // every 60s

  // CLI input
  process.stdin.on('data', (d) => handleCommand(d.toString()));
})();
