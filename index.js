// Solana Memecoin Audit Telegram Bot
// Átírva a Solana-MemeToken-Audit-Result alapján

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const { getMint, getAccount } = require('@solana/spl-token');
const axios = require('axios');

// Environment variables ellenőrzés
console.log('🔍 Environment variables ellenőrzése...');
console.log('BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN ? '✅ Beállítva' : '❌ Hiányzik');
console.log('CHANNEL_ID:', process.env.TELEGRAM_CHANNEL_ID ? '✅ Beállítva' : '❌ Hiányzik');
console.log('HELIUS_API_KEY:', process.env.HELIUS_API_KEY ? '✅ Beállítva' : '❌ Hiányzik');

// Konfigurációs változók - .env fájlból töltődnek
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID; // pl: @your_channel vagy -1001234567890
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// Ellenőrzés, hogy minden szükséges változó be van-e állítva
if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN nincs beállítva a .env fájlban!');
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error('❌ TELEGRAM_CHANNEL_ID nincs beállítva a .env fájlban!');
  process.exit(1);
}

if (!HELIUS_API_KEY) {
  console.error('❌ HELIUS_API_KEY nincs beállítva a .env fájlban!');
  process.exit(1);
}

const RPC_ENDPOINT = `https://rpc.helius.xyz/?api-key=${HELIUS_API_KEY}`;

// Bot és Solana connection inicializálása
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

// Memorizált tokenek tárolása (duplikáció elkerülésére)
const processedTokens = new Set();
const monitoredTokens = new Map();

class SolanaTokenAuditor {
  constructor() {
    this.connection = connection;
  }

  // Token információk lekérése
  async getTokenInfo(mintAddress) {
    try {
      const mintPubkey = new PublicKey(mintAddress);
      const mintInfo = await getMint(this.connection, mintPubkey);
      
      // Helius API-val kiegészítő adatok
      const tokenData = await this.getTokenMetadata(mintAddress);
      
      return {
        mintAddress,
        decimals: mintInfo.decimals,
        supply: mintInfo.supply.toString(),
        mintAuthority: mintInfo.mintAuthority?.toString(),
        freezeAuthority: mintInfo.freezeAuthority?.toString(),
        metadata: tokenData
      };
    } catch (error) {
      console.error('Token info hiba:', error);
      return null;
    }
  }

  // Token metadata Helius API-val
  async getTokenMetadata(mintAddress) {
    try {
      const response = await axios.post(RPC_ENDPOINT, {
        jsonrpc: '2.0',
        id: 'helius-test',
        method: 'getAsset',
        params: {
          id: mintAddress
        }
      });

      return response.data?.result || {};
    } catch (error) {
      console.error('Metadata hiba:', error);
      return {};
    }
  }

  // Top holderek elemzése
  async getTopHolders(mintAddress) {
    try {
      const response = await axios.post(RPC_ENDPOINT, {
        jsonrpc: '2.0',
        id: 'get-token-holders',
        method: 'getTokenLargestAccounts',
        params: [mintAddress]
      });

      const holders = response.data?.result?.value || [];
      const totalSupply = holders.reduce((sum, holder) => sum + parseFloat(holder.amount), 0);
      
      return holders.slice(0, 10).map((holder, index) => {
        const percentage = ((parseFloat(holder.amount) / totalSupply) * 100).toFixed(2);
        return {
          rank: index + 1,
          address: holder.address,
          amount: holder.amount,
          percentage: parseFloat(percentage)
        };
      });
    } catch (error) {
      console.error('Top holders hiba:', error);
      return [];
    }
  }

  // LP burn ellenőrzés
  async checkLPBurn(mintAddress) {
    try {
      // Raydium pool keresés
      const poolInfo = await this.findRaydiumPool(mintAddress);
      if (!poolInfo) return { burned: false, info: 'Pool nem található' };

      // LP token supply ellenőrzés
      const lpMintInfo = await getMint(this.connection, new PublicKey(poolInfo.lpMint));
      const isBurned = lpMintInfo.supply === BigInt(0) || !lpMintInfo.mintAuthority;

      return {
        burned: isBurned,
        lpMint: poolInfo.lpMint,
        supply: lpMintInfo.supply.toString(),
        info: isBurned ? 'LP égetett ✅' : 'LP NEM égetett ❌'
      };
    } catch (error) {
      console.error('LP burn ellenőrzés hiba:', error);
      return { burned: false, info: 'Ellenőrzési hiba' };
    }
  }

  // Raydium pool keresés
  async findRaydiumPool(mintAddress) {
    try {
      // Itt implementálhatod a Raydium API hívást vagy on-chain keresést
      // Egyszerűsített verzió - cseréld le valós implementációra
      const response = await axios.get(`https://api.raydium.io/v2/sdk/liquidity/mainnet.json`);
      const pools = response.data?.official || [];
      
      const pool = pools.find(p => 
        p.baseMint === mintAddress || p.quoteMint === mintAddress
      );
      
      return pool || null;
    } catch (error) {
      console.error('Pool keresés hiba:', error);
      return null;
    }
  }

  // Kockázati elemzés
  analyzeRisk(holders, tokenInfo, lpBurnInfo) {
    let riskScore = 0;
    let warnings = [];

    // Mint authority ellenőrzés
    if (tokenInfo.mintAuthority) {
      riskScore += 30;
      warnings.push('⚠️ Mint Authority aktív');
    }

    // Freeze authority ellenőrzés
    if (tokenInfo.freezeAuthority) {
      riskScore += 20;
      warnings.push('⚠️ Freeze Authority aktív');
    }

    // Holder koncentráció
    const top5Concentration = holders.slice(0, 5)
      .reduce((sum, h) => sum + h.percentage, 0);
    
    if (top5Concentration > 50) {
      riskScore += 25;
      warnings.push(`⚠️ Top 5 holder ${top5Concentration.toFixed(1)}% birtokol`);
    }

    // LP burn ellenőrzés
    if (!lpBurnInfo.burned) {
      riskScore += 25;
      warnings.push('⚠️ LP token nem égetett');
    }

    let riskLevel = 'ALACSONY ✅';
    if (riskScore > 25) riskLevel = 'KÖZEPES ⚠️';
    if (riskScore > 50) riskLevel = 'MAGAS ❌';
    if (riskScore > 75) riskLevel = 'EXTRÉM ☠️';

    return { riskScore, riskLevel, warnings };
  }

  // Teljes audit futtatása
  async auditToken(mintAddress) {
    try {
      console.log(`Token audit kezdése: ${mintAddress}`);
      
      const [tokenInfo, holders, lpBurnInfo] = await Promise.all([
        this.getTokenInfo(mintAddress),
        this.getTopHolders(mintAddress),
        this.checkLPBurn(mintAddress)
      ]);

      if (!tokenInfo) {
        throw new Error('Token információ nem érhető el');
      }

      const riskAnalysis = this.analyzeRisk(holders, tokenInfo, lpBurnInfo);

      return {
        tokenInfo,
        holders,
        lpBurnInfo,
        riskAnalysis,
        auditTime: new Date().toISOString()
      };
    } catch (error) {
      console.error('Audit hiba:', error);
      throw error;
    }
  }
}

// Telegram üzenet formázása
function formatAuditMessage(auditResult) {
  const { tokenInfo, holders, lpBurnInfo, riskAnalysis } = auditResult;
  const metadata = tokenInfo.metadata;
  
  let message = `🔍 **SOLANA TOKEN AUDIT**\n\n`;
  
  // Token alapadatok
  message += `**📊 TOKEN INFO:**\n`;
  message += `• Név: ${metadata.content?.metadata?.name || 'N/A'}\n`;
  message += `• Symbol: ${metadata.content?.metadata?.symbol || 'N/A'}\n`;
  message += `• Address: \`${tokenInfo.mintAddress}\`\n`;
  message += `• Decimals: ${tokenInfo.decimals}\n`;
  message += `• Supply: ${parseInt(tokenInfo.supply) / Math.pow(10, tokenInfo.decimals)}\n\n`;
  
  // Kockázati elemzés
  message += `**⚖️ KOCKÁZAT: ${riskAnalysis.riskLevel}**\n`;
  message += `Risk Score: ${riskAnalysis.riskScore}/100\n\n`;
  
  // Figyelmeztetések
  if (riskAnalysis.warnings.length > 0) {
    message += `**⚠️ FIGYELMEZTETÉSEK:**\n`;
    riskAnalysis.warnings.forEach(warning => {
      message += `${warning}\n`;
    });
    message += `\n`;
  }
  
  // Authority státusz
  message += `**🔐 AUTHORITY STATUS:**\n`;
  message += `• Mint: ${tokenInfo.mintAuthority ? '❌ Aktív' : '✅ Letiltott'}\n`;
  message += `• Freeze: ${tokenInfo.freezeAuthority ? '❌ Aktív' : '✅ Letiltott'}\n\n`;
  
  // LP burn info
  message += `**🔥 LP BURN:**\n${lpBurnInfo.info}\n\n`;
  
  // Top holderek
  if (holders.length > 0) {
    message += `**🏆 TOP 5 HOLDERS:**\n`;
    holders.slice(0, 5).forEach(holder => {
      const address = holder.address.slice(0, 4) + '...' + holder.address.slice(-4);
      message += `${holder.rank}. ${address} - ${holder.percentage}%\n`;
    });
  }
  
  message += `\n⏰ Audit idő: ${new Date().toLocaleString('hu-HU')}`;
  
  return message;
}

// Telegram bot inicializálása
const auditor = new SolanaTokenAuditor();

// Bot parancsok
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    '🤖 Solana Token Auditor Bot aktív!\n\n' +
    'Parancsok:\n' +
    '/audit [token_address] - Token audit futtatása\n' +
    '/monitor [token_address] - Token monitoring indítása\n' +
    '/stop [token_address] - Monitoring leállítása\n' +
    '/status - Aktív monitorok listája'
  );
});

// Token audit parancs
bot.onText(/\/audit (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tokenAddress = match[1].trim();
  
  try {
    bot.sendMessage(chatId, '🔍 Token audit folyamatban...');
    
    const auditResult = await auditor.auditToken(tokenAddress);
    const formattedMessage = formatAuditMessage(auditResult);
    
    // Csatornára posztolás
    await bot.sendMessage(CHANNEL_ID, formattedMessage, { parse_mode: 'Markdown' });
    
    // Válasz a parancs küldőjének
    bot.sendMessage(chatId, '✅ Audit kész és elküldve a csatornára!');
    
  } catch (error) {
    console.error('Audit hiba:', error);
    bot.sendMessage(chatId, `❌ Audit hiba: ${error.message}`);
  }
});

// Token monitoring
bot.onText(/\/monitor (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tokenAddress = match[1].trim();
  
  if (monitoredTokens.has(tokenAddress)) {
    return bot.sendMessage(chatId, '⚠️ Ez a token már monitorozva van!');
  }
  
  // Monitoring indítása
  const intervalId = setInterval(async () => {
    try {
      const auditResult = await auditor.auditToken(tokenAddress);
      
      // Csak jelentős változásokat posztol (pl. LP burn, authority változás)
      const shouldPost = checkSignificantChanges(tokenAddress, auditResult);
      
      if (shouldPost) {
        const message = formatAuditMessage(auditResult);
        await bot.sendMessage(CHANNEL_ID, 
          `🔔 **MONITORING UPDATE**\n\n${message}`, 
          { parse_mode: 'Markdown' }
        );
      }
      
    } catch (error) {
      console.error('Monitoring hiba:', error);
    }
  }, 300000); // 5 percenként ellenőriz
  
  monitoredTokens.set(tokenAddress, intervalId);
  bot.sendMessage(chatId, `✅ Monitoring elindítva: ${tokenAddress}`);
});

// Monitoring leállítása
bot.onText(/\/stop (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const tokenAddress = match[1].trim();
  
  if (monitoredTokens.has(tokenAddress)) {
    clearInterval(monitoredTokens.get(tokenAddress));
    monitoredTokens.delete(tokenAddress);
    bot.sendMessage(chatId, `✅ Monitoring leállítva: ${tokenAddress}`);
  } else {
    bot.sendMessage(chatId, '⚠️ Ez a token nem volt monitorozva!');
  }
});

// Monitoring státusz
bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const activeTokens = Array.from(monitoredTokens.keys());
  
  if (activeTokens.length === 0) {
    bot.sendMessage(chatId, 'ℹ️ Nincs aktív monitoring.');
  } else {
    const list = activeTokens.map((token, i) => `${i + 1}. ${token}`).join('\n');
    bot.sendMessage(chatId, `📊 **Aktív monitorok:**\n\`\`\`\n${list}\n\`\`\``, { parse_mode: 'Markdown' });
  }
});

// Jelentős változások ellenőrzése
function checkSignificantChanges(tokenAddress, currentData) {
  // Itt implementálhatod a logikát, hogy mikor posztoljon
  // Például: LP burn történt, authority változás, nagy holder változás
  return true; // Egyszerűsített - minden esetben posztol
}

// Hiba kezelés
bot.on('polling_error', (error) => {
  console.error('Telegram polling hiba:', error);
});

process.on('SIGINT', () => {
  console.log('Bot leállítása...');
  monitoredTokens.forEach(intervalId => clearInterval(intervalId));
  process.exit(0);
});

// HTTP szerver hozzáadása Render.com Web Service-hez
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: '🟢 Online',
    bot: 'Solana Token Auditor Bot',
    channel: CHANNEL_ID,
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime())} seconds`,
    memoryUsage: process.memoryUsage(),
    nodeVersion: process.version
  });
});

// Bot status endpoint  
app.get('/status', (req, res) => {
  res.json({
    monitoredTokens: monitoredTokens.size,
    processedTokens: processedTokens.size,
    activeMonitors: Array.from(monitoredTokens.keys()),
    botStatus: bot.isPolling() ? 'Polling' : 'Stopped'
  });
});

// Manual audit endpoint (webhook style)
app.post('/audit', express.json(), async (req, res) => {
  const { tokenAddress } = req.body;
  
  if (!tokenAddress) {
    return res.status(400).json({ error: 'Token address required' });
  }
  
  try {
    const auditResult = await auditor.auditToken(tokenAddress);
    const message = formatAuditMessage(auditResult);
    
    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
    
    res.json({ 
      success: true, 
      message: 'Audit posted to channel',
      tokenAddress 
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      tokenAddress 
    });
  }
});

// Webhook endpoint for external triggers
app.post('/webhook/new-token', express.json(), async (req, res) => {
  const { tokenAddress, source } = req.body;
  
  console.log(`🔔 Webhook trigger: ${tokenAddress} from ${source}`);
  
  try {
    const auditResult = await auditor.auditToken(tokenAddress);
    const message = `🔔 **NEW TOKEN DETECTED**\nSource: ${source}\n\n${formatAuditMessage(auditResult)}`;
    
    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
    
    res.json({ success: true, source, tokenAddress });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start HTTP server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 HTTP szerver fut: http://0.0.0.0:${PORT}`);
  console.log(`📊 Health check: http://0.0.0.0:${PORT}/`);
  console.log(`📈 Status: http://0.0.0.0:${PORT}/status`);
});

console.log('🤖 Solana Token Auditor Bot elindult!');
console.log(`📢 Csatorna: ${CHANNEL_ID}`);

module.exports = { auditor, bot, app };
