// index.js - Teljes bot egyetlen fájlban
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// ============= KONFIGURÁCIÓ =============
const CONFIG = {
  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID: process.env.TELEGRAM_CHANNEL_ID,
  
  // Helius
  HELIUS_API_KEY: process.env.HELIUS_API_KEY,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || 'my-secret-key-12345',
  
  // Szűrők
  MIN_LP_SOL: parseFloat(process.env.MIN_LP_SOL || 5),
  MIN_MCAP: parseFloat(process.env.MIN_MCAP || 10000),
  MAX_MCAP: parseFloat(process.env.MAX_MCAP || 1000000),
  
  // Server
  PORT: process.env.PORT || 3000,
  SERVER_URL: process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'
};

// ============= EXPRESS SZERVER =============
const app = express();
app.use(express.json());

// Telegram bot inicializálás
const bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: false });

// Cache a feldolgozott burn tranzakciókhoz
const processedBurns = new Set();
const tokenCache = new Map();

// SOL ár cache
let solPrice = 100;

// ============= HELIUS WEBHOOK ENDPOINT =============
app.post('/webhook', async (req, res) => {
  try {
    // Webhook biztonság ellenőrzése
    if (req.headers['x-webhook-signature'] !== CONFIG.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const webhookData = req.body[0]; // Helius batch-ben küldi
    
    if (!webhookData) {
      return res.status(200).json({ status: 'no data' });
    }

    // LP burn detektálás
    const burnInfo = await detectLPBurn(webhookData);
    
    if (burnInfo && burnInfo.shouldNotify) {
      await sendTelegramAlert(burnInfo);
      processedBurns.add(webhookData.signature);
    }
    
    res.status(200).json({ status: 'processed' });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(200).json({ status: 'error', message: error.message });
  }
});

// ============= LP BURN DETEKTÁLÁS =============
async function detectLPBurn(txData) {
  try {
    const signature = txData.signature;
    
    // Ha már feldolgoztuk, skip
    if (processedBurns.has(signature)) {
      return null;
    }
    
    // Burn instruction keresése
    const instructions = txData.instructions || [];
    let burnData = null;
    
    for (const inst of instructions) {
      if (inst.programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
        const parsed = inst.parsed;
        if (parsed && (parsed.type === 'burn' || parsed.type === 'burnChecked')) {
          burnData = parsed.info;
          break;
        }
      }
    }
    
    if (!burnData) return null;
    
    // Token információk lekérése
    const tokenInfo = await getTokenInfo(burnData.mint || burnData.account);
    
    if (!tokenInfo) return null;
    
    // LP pool információk
    const poolInfo = await getPoolInfo(tokenInfo.address);
    
    if (!poolInfo || !poolInfo.isLPToken) return null;
    
    // Burn százalék számítás
    const burnPercentage = calculateBurnPercentage(burnData.amount, tokenInfo.supply);
    
    // Szűrők ellenőrzése
    if (burnPercentage < 99.9) return null;
    if (poolInfo.solValue < CONFIG.MIN_LP_SOL) return null;
    if (poolInfo.marketCap < CONFIG.MIN_MCAP) return null;
    if (poolInfo.marketCap > CONFIG.MAX_MCAP) return null;
    
    return {
      shouldNotify: true,
      signature,
      tokenName: tokenInfo.name || 'Unknown',
      tokenSymbol: tokenInfo.symbol || 'Unknown',
      tokenAddress: tokenInfo.address,
      burnPercentage,
      solBurned: poolInfo.solValue,
      marketCap: poolInfo.marketCap,
      dexName: poolInfo.dexName || 'Unknown DEX',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Detect LP burn error:', error);
    return null;
  }
}

// ============= TOKEN INFO LEKÉRÉS =============
async function getTokenInfo(mintAddress) {
  try {
    // Cache ellenőrzés
    if (tokenCache.has(mintAddress)) {
      return tokenCache.get(mintAddress);
    }
    
    // Helius API hívás
    const response = await axios.post(
      `https://api.helius.xyz/v0/token-metadata?api-key=${CONFIG.HELIUS_API_KEY}`,
      {
        mintAccounts: [mintAddress],
        includeOffChain: true,
        disableCache: false
      }
    );
    
    const data = response.data[0];
    if (!data) return null;
    
    const tokenInfo = {
      address: mintAddress,
      name: data.onChainMetadata?.metadata?.name || data.offChainMetadata?.name,
      symbol: data.onChainMetadata?.metadata?.symbol || data.offChainMetadata?.symbol,
      supply: data.onChainMetadata?.supply || 0,
      decimals: data.onChainMetadata?.decimals || 9
    };
    
    // Cache tárolás 5 percre
    tokenCache.set(mintAddress, tokenInfo);
    setTimeout(() => tokenCache.delete(mintAddress), 300000);
    
    return tokenInfo;
  } catch (error) {
    console.error('Get token info error:', error);
    return null;
  }
}

// ============= POOL INFO LEKÉRÉS =============
async function getPoolInfo(tokenAddress) {
  try {
    // Simplified pool detection - Helius DAS API
    const response = await axios.post(
      `https://api.helius.xyz/v0/addresses/${tokenAddress}/balances?api-key=${CONFIG.HELIUS_API_KEY}`
    );
    
    const data = response.data;
    
    // SOL balance keresése
    let solValue = 0;
    const nativeBalance = data.nativeBalance || 0;
    solValue = nativeBalance / 1e9; // Lamports to SOL
    
    // Market cap becslés
    const marketCap = solValue * 2 * solPrice;
    
    // LP token detektálás (egyszerűsített)
    const isLPToken = checkIfLPToken(tokenAddress, data);
    
    // DEX név meghatározása
    const dexName = detectDEX(tokenAddress);
    
    return {
      isLPToken,
      solValue,
      marketCap,
      dexName
    };
  } catch (error) {
    console.error('Get pool info error:', error);
    return null;
  }
}

// ============= SEGÉD FÜGGVÉNYEK =============
function calculateBurnPercentage(burnAmount, totalSupply) {
  if (!totalSupply || totalSupply === 0) return 0;
  return (burnAmount / totalSupply) * 100;
}

function checkIfLPToken(address, data) {
  // Egyszerűsített LP detektálás
  // Ha van SOL és más token is, valószínűleg LP
  const hasSOL = data.nativeBalance > 0;
  const hasTokens = data.tokens && data.tokens.length > 0;
  return hasSOL && hasTokens;
}

function detectDEX(address) {
  // Egyszerűsített DEX detektálás
  const addressStr = address.toLowerCase();
  if (addressStr.includes('ray')) return 'Raydium';
  if (addressStr.includes('orca')) return 'Orca';
  if (addressStr.includes('jet')) return 'Jupiter';
  return 'Unknown DEX';
}

async function updateSolPrice() {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
    );
    solPrice = response.data.solana.usd;
    console.log('SOL price updated:', solPrice);
  } catch (error) {
    console.error('Update SOL price error:', error);
  }
}

// ============= TELEGRAM ÉRTESÍTÉS =============
async function sendTelegramAlert(burnInfo) {
  try {
    const message = `
🔥 <b>100% LP BURN DETECTED!</b> 🔥

💎 <b>Token:</b> ${burnInfo.tokenName} (${burnInfo.tokenSymbol})
📍 <b>Address:</b> <code>${burnInfo.tokenAddress}</code>

💰 <b>SOL Burned:</b> ${burnInfo.solBurned.toFixed(2)} SOL
📊 <b>Market Cap:</b> $${burnInfo.marketCap.toLocaleString()}
🔥 <b>Burn %:</b> ${burnInfo.burnPercentage.toFixed(1)}%
🏦 <b>DEX:</b> ${burnInfo.dexName}

🔗 <a href="https://solscan.io/tx/${burnInfo.signature}">View TX</a> | <a href="https://dexscreener.com/solana/${burnInfo.tokenAddress}">Chart</a>

⚠️ DYOR - Not financial advice!
`;

    await bot.sendMessage(CONFIG.TELEGRAM_CHANNEL_ID, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
    
    console.log('✅ Telegram alert sent:', burnInfo.tokenSymbol);
  } catch (error) {
    console.error('❌ Telegram send error:', error);
  }
}

// ============= WEBHOOK REGISZTRÁCIÓ =============
async function registerWebhook() {
  try {
    const webhookUrl = `${CONFIG.SERVER_URL}/webhook`;
    
    console.log('Registering webhook:', webhookUrl);
    
    const response = await axios.post(
      `https://api.helius.xyz/v0/webhooks?api-key=${CONFIG.HELIUS_API_KEY}`,
      {
        webhookURL: webhookUrl,
        transactionTypes: ['ENHANCED'],
        accountAddresses: [], // Minden LP figyelése
        webhookType: 'enhanced',
        authHeader: CONFIG.WEBHOOK_SECRET,
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        // Szűrők a költségcsökkentéshez
        filters: {
          programIds: [
            'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
            '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium
            '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP'  // Orca
          ]
        }
      }
    );
    
    console.log('✅ Webhook registered:', response.data.webhookID);
    return response.data.webhookID;
  } catch (error) {
    console.error('❌ Webhook registration error:', error.response?.data || error);
    
    // Ha már létezik webhook, listázzuk
    try {
      const listResponse = await axios.get(
        `https://api.helius.xyz/v0/webhooks?api-key=${CONFIG.HELIUS_API_KEY}`
      );
      console.log('Existing webhooks:', listResponse.data);
    } catch (listError) {
      console.error('List webhooks error:', listError);
    }
  }
}

// ============= API ENDPOINTS =============
app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    config: {
      MIN_LP_SOL: CONFIG.MIN_LP_SOL,
      MIN_MCAP: CONFIG.MIN_MCAP,
      MAX_MCAP: CONFIG.MAX_MCAP
    },
    processedBurns: processedBurns.size,
    solPrice: solPrice,
    uptime: process.uptime()
  });
});

app.get('/config', (req, res) => {
  res.json({
    MIN_LP_SOL: CONFIG.MIN_LP_SOL,
    MIN_MCAP: CONFIG.MIN_MCAP,
    MAX_MCAP: CONFIG.MAX_MCAP
  });
});

app.post('/config', (req, res) => {
  const { minSol, minMcap, maxMcap } = req.body;
  
  if (minSol !== undefined) CONFIG.MIN_LP_SOL = parseFloat(minSol);
  if (minMcap !== undefined) CONFIG.MIN_MCAP = parseFloat(minMcap);
  if (maxMcap !== undefined) CONFIG.MAX_MCAP = parseFloat(maxMcap);
  
  res.json({
    success: true,
    config: {
      MIN_LP_SOL: CONFIG.MIN_LP_SOL,
      MIN_MCAP: CONFIG.MIN_MCAP,
      MAX_MCAP: CONFIG.MAX_MCAP
    }
  });
});

// ============= SZERVER INDÍTÁS =============
app.listen(CONFIG.PORT, async () => {
  console.log('================================');
  console.log('🚀 Solana LP Burn Tracker Bot');
  console.log('================================');
  console.log(`📡 Server: http://localhost:${CONFIG.PORT}`);
  console.log(`📊 Min SOL: ${CONFIG.MIN_LP_SOL}`);
  console.log(`💰 MCap: $${CONFIG.MIN_MCAP} - $${CONFIG.MAX_MCAP}`);
  console.log('================================');
  
  // Webhook regisztráció
  await registerWebhook();
  
  // SOL ár frissítése
  await updateSolPrice();
  setInterval(updateSolPrice, 60000); // Percenként frissít
  
  // Cache tisztítás naponta
  setInterval(() => {
    processedBurns.clear();
    tokenCache.clear();
    console.log('🧹 Cache cleared');
  }, 86400000);
  
  console.log('✅ Bot is ready and listening for LP burns!');
});

// ============= GRACEFUL SHUTDOWN =============
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});
