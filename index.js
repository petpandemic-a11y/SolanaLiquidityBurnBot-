const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
const cron = require('node-cron');

// Környezeti változók betöltése (lokális fejlesztéshez)
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// Környezeti változók ellenőrzése induláskor
function checkEnvironment() {
  const required = ['TELEGRAM_BOT_TOKEN', 'HELIUS_API_KEY'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Hiányzó környezeti változók:', missing.join(', '));
    console.log('💡 Állítsd be őket a Render Dashboard-on vagy .env fájlban');
    
    // Render környezetben nem állítjuk le, hogy a health check működjön
    if (!process.env.RENDER) {
      process.exit(1);
    }
  } else {
    console.log('✅ Környezeti változók rendben');
  }
}

// Ellenőrzés futtatása
checkEnvironment();

// Konfiguráció
const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN',
  heliusApiKey: process.env.HELIUS_API_KEY || 'YOUR_HELIUS_KEY',
  solanaRpc: process.env.SOLANA_RPC || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  port: process.env.PORT || 10000, // Render alapértelmezett port
  chatId: process.env.TELEGRAM_CHAT_ID || null,
  webhookUrl: process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/webhook` : 'https://your-domain.com/webhook',
  isProduction: process.env.NODE_ENV === 'production' || process.env.RENDER === 'true'
};

// Bot inicializálás - Render környezetben webhook módot preferálunk
const bot = config.isProduction && config.webhookUrl ? 
  new TelegramBot(config.telegramToken, { webHook: true }) :
  new TelegramBot(config.telegramToken, { polling: true });

const app = express();
app.use(express.json());

// Solana kapcsolat
const connection = new Connection(config.solanaRpc);

// Szűrési beállítások (memóriában tárolva)
let filterSettings = {
  enabled: true,
  minLiquidity: 1000, // USD értékben
  checkInterval: 5, // percekben
  trackOnlyNamed: true,
  dexFilters: ['raydium', 'orca', 'meteora'],
  minBurnPercentage: 99, // minimum burn százalék
  alertChatIds: new Set(),
  blacklistTokens: new Set(),
  whitelistTokens: new Set()
};

// LP burn események tárolása (duplikáció elkerülésére)
const recentBurns = new Map();

// Ismert DEX program ID-k
const DEX_PROGRAMS = {
  raydium: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  orca: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
  meteora: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'
};

// Token metaadat lekérése
async function getTokenMetadata(mintAddress) {
  try {
    const response = await axios.get(
      `https://api.helius.xyz/v0/token-metadata?api-key=${config.heliusApiKey}`,
      { params: { mint: mintAddress } }
    );
    return response.data;
  } catch (error) {
    console.error(`Error fetching metadata for ${mintAddress}:`, error.message);
    return null;
  }
}

// LP burn tranzakció ellenőrzése
async function checkForLPBurns() {
  if (!filterSettings.enabled) return;
  
  console.log('🔍 LP burn ellenőrzés indítása...');
  
  try {
    // Elmúlt 5 perc tranzakcióinak lekérése
    const endTime = Date.now();
    const startTime = endTime - (filterSettings.checkInterval * 60 * 1000);
    
    // Helius Enhanced Transactions API használata
    const response = await axios.post(
      `https://api.helius.xyz/v0/transactions?api-key=${config.heliusApiKey}`,
      {
        query: {
          type: 'BURN',
          startTime: Math.floor(startTime / 1000),
          endTime: Math.floor(endTime / 1000)
        }
      }
    );
    
    const transactions = response.data.result || [];
    
    for (const tx of transactions) {
      await analyzeBurnTransaction(tx);
    }
    
  } catch (error) {
    console.error('❌ Hiba a burn ellenőrzés során:', error.message);
  }
}

// Burn tranzakció elemzése
async function analyzeBurnTransaction(tx) {
  try {
    // Ellenőrizzük, hogy LP token burn-e
    const burnInstructions = tx.instructions?.filter(inst => 
      inst.programId && Object.values(DEX_PROGRAMS).includes(inst.programId)
    ) || [];
    
    if (burnInstructions.length === 0) return;
    
    // Token információk kinyerése
    const tokenAccounts = tx.tokenTransfers || [];
    
    for (const transfer of tokenAccounts) {
      if (transfer.toUserAccount === '11111111111111111111111111111111' || // Burn cím
          transfer.toUserAccount === '1nc1nerator11111111111111111111111111111111') {
        
        const mintAddress = transfer.mint;
        
        // Duplikáció ellenőrzés
        const burnKey = `${tx.signature}_${mintAddress}`;
        if (recentBurns.has(burnKey)) continue;
        
        // Metadata lekérése
        const metadata = await getTokenMetadata(mintAddress);
        
        if (!metadata) continue;
        
        // Szűrők alkalmazása
        if (filterSettings.trackOnlyNamed && !metadata.name) continue;
        if (filterSettings.blacklistTokens.has(mintAddress)) continue;
        if (filterSettings.whitelistTokens.size > 0 && 
            !filterSettings.whitelistTokens.has(mintAddress)) continue;
        
        // Burn százalék számítása
        const burnPercentage = calculateBurnPercentage(transfer, metadata);
        
        if (burnPercentage >= filterSettings.minBurnPercentage) {
          // Értesítés küldése
          await sendBurnAlert({
            txSignature: tx.signature,
            tokenName: metadata.name || 'Unknown',
            tokenSymbol: metadata.symbol || 'N/A',
            mintAddress: mintAddress,
            burnAmount: transfer.tokenAmount,
            burnPercentage: burnPercentage,
            dex: identifyDex(tx.instructions),
            timestamp: new Date(tx.blockTime * 1000)
          });
          
          // Burn rögzítése
          recentBurns.set(burnKey, Date.now());
        }
      }
    }
  } catch (error) {
    console.error('❌ Hiba a tranzakció elemzése során:', error.message);
  }
}

// Burn százalék számítása
function calculateBurnPercentage(transfer, metadata) {
  try {
    const burnAmount = parseFloat(transfer.tokenAmount);
    const totalSupply = parseFloat(metadata.supply || 0);
    
    if (totalSupply === 0) return 0;
    
    return (burnAmount / totalSupply) * 100;
  } catch {
    return 0;
  }
}

// DEX azonosítása
function identifyDex(instructions) {
  for (const [dexName, programId] of Object.entries(DEX_PROGRAMS)) {
    if (instructions.some(inst => inst.programId === programId)) {
      return dexName.toUpperCase();
    }
  }
  return 'UNKNOWN';
}

// Telegram értesítés küldése
async function sendBurnAlert(burnData) {
  const message = `
🔥 <b>LP BURN ÉSZLELVE!</b> 🔥

📌 <b>Token:</b> ${burnData.tokenName} (${burnData.tokenSymbol})
🏦 <b>DEX:</b> ${burnData.dex}
💯 <b>Burn %:</b> ${burnData.burnPercentage.toFixed(2)}%
💰 <b>Burn mennyiség:</b> ${formatNumber(burnData.burnAmount)}
⏰ <b>Időpont:</b> ${burnData.timestamp.toLocaleString('hu-HU')}

🔗 <b>Mint:</b> <code>${burnData.mintAddress}</code>
📝 <b>TX:</b> <a href="https://solscan.io/tx/${burnData.txSignature}">Megtekintés</a>

#LPBurn #${burnData.dex} #${burnData.tokenSymbol}
`;
  
  // Értesítés küldése minden beállított chat-hez
  for (const chatId of filterSettings.alertChatIds) {
    try {
      await bot.sendMessage(chatId, message, { 
        parse_mode: 'HTML',
        disable_web_page_preview: false 
      });
    } catch (error) {
      console.error(`❌ Nem sikerült üzenetet küldeni ${chatId} számára:`, error.message);
    }
  }
}

// Webhook endpoint Helius számára
app.post('/webhook', async (req, res) => {
  try {
    console.log('📨 Webhook fogadva Helius-tól');
    
    // Helius webhook payload feldolgozása
    const webhookData = req.body;
    
    if (webhookData.type === 'BURN' || webhookData.type === 'TRANSFER') {
      await analyzeBurnTransaction(webhookData);
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Webhook hiba:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint (Render számára)
app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    bot: 'Solana LP Burn Monitor',
    monitoring: filterSettings.enabled,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    monitoring: filterSettings.enabled,
    activeChats: filterSettings.alertChatIds.size
  });
});

// Telegram parancsok
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  filterSettings.alertChatIds.add(chatId.toString());
  
  const welcomeMessage = `
🚀 <b>Solana LP Burn Monitor Bot</b>

Üdvözöllek! Ez a bot figyeli a Solana LP párok burn eseményeit.

📋 <b>Elérhető parancsok:</b>
/status - Bot státusz és beállítások
/enable - Monitoring bekapcsolása
/disable - Monitoring kikapcsolása
/setmin [összeg] - Min. likviditás beállítása (USD)
/setinterval [perc] - Ellenőrzési időköz
/setburn [%] - Min. burn százalék
/adddex [név] - DEX hozzáadása
/removedex [név] - DEX eltávolítása
/blacklist [mint] - Token blacklist-re tétele
/whitelist [mint] - Token whitelist-re tétele
/clearfilters - Szűrők törlése
/help - Súgó

✅ Értesítések bekapcsolva erre a chat-re!
`;
  
  await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML' });
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  
  const statusMessage = `
📊 <b>Bot Státusz</b>

${filterSettings.enabled ? '✅ Monitoring: AKTÍV' : '❌ Monitoring: INAKTÍV'}

⚙️ <b>Beállítások:</b>
• Min. likviditás: $${filterSettings.minLiquidity}
• Ellenőrzési időköz: ${filterSettings.checkInterval} perc
• Min. burn %: ${filterSettings.minBurnPercentage}%
• Csak nevesített tokenek: ${filterSettings.trackOnlyNamed ? 'IGEN' : 'NEM'}

🏦 <b>Aktív DEX-ek:</b>
${filterSettings.dexFilters.map(d => `• ${d.toUpperCase()}`).join('\n')}

📊 <b>Szűrők:</b>
• Blacklist tokenek: ${filterSettings.blacklistTokens.size} db
• Whitelist tokenek: ${filterSettings.whitelistTokens.size} db
• Aktív chat-ek: ${filterSettings.alertChatIds.size} db

⏰ <b>Utolsó ellenőrzés:</b> ${new Date().toLocaleString('hu-HU')}
`;
  
  await bot.sendMessage(chatId, statusMessage, { parse_mode: 'HTML' });
});

bot.onText(/\/enable/, async (msg) => {
  const chatId = msg.chat.id;
  filterSettings.enabled = true;
  await bot.sendMessage(chatId, '✅ Monitoring bekapcsolva!');
});

bot.onText(/\/disable/, async (msg) => {
  const chatId = msg.chat.id;
  filterSettings.enabled = false;
  await bot.sendMessage(chatId, '❌ Monitoring kikapcsolva!');
});

bot.onText(/\/setmin (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const amount = parseFloat(match[1]);
  
  if (isNaN(amount) || amount < 0) {
    await bot.sendMessage(chatId, '❌ Érvénytelen összeg!');
    return;
  }
  
  filterSettings.minLiquidity = amount;
  await bot.sendMessage(chatId, `✅ Min. likviditás beállítva: $${amount}`);
});

bot.onText(/\/setinterval (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const minutes = parseInt(match[1]);
  
  if (isNaN(minutes) || minutes < 1 || minutes > 60) {
    await bot.sendMessage(chatId, '❌ Érvénytelen időköz! (1-60 perc)');
    return;
  }
  
  filterSettings.checkInterval = minutes;
  
  // Cron job újraindítása
  cronJob.stop();
  cronJob = cron.schedule(`*/${minutes} * * * *`, checkForLPBurns);
  
  await bot.sendMessage(chatId, `✅ Ellenőrzési időköz beállítva: ${minutes} perc`);
});

bot.onText(/\/setburn (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const percentage = parseFloat(match[1]);
  
  if (isNaN(percentage) || percentage < 0 || percentage > 100) {
    await bot.sendMessage(chatId, '❌ Érvénytelen százalék! (0-100)');
    return;
  }
  
  filterSettings.minBurnPercentage = percentage;
  await bot.sendMessage(chatId, `✅ Min. burn százalék beállítva: ${percentage}%`);
});

bot.onText(/\/adddex (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const dexName = match[1].toLowerCase();
  
  if (!DEX_PROGRAMS[dexName]) {
    await bot.sendMessage(chatId, `❌ Ismeretlen DEX! Elérhető: ${Object.keys(DEX_PROGRAMS).join(', ')}`);
    return;
  }
  
  if (!filterSettings.dexFilters.includes(dexName)) {
    filterSettings.dexFilters.push(dexName);
  }
  
  await bot.sendMessage(chatId, `✅ ${dexName.toUpperCase()} hozzáadva a szűrőkhöz!`);
});

bot.onText(/\/removedex (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const dexName = match[1].toLowerCase();
  
  filterSettings.dexFilters = filterSettings.dexFilters.filter(d => d !== dexName);
  await bot.sendMessage(chatId, `✅ ${dexName.toUpperCase()} eltávolítva a szűrőkből!`);
});

bot.onText(/\/blacklist (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const mintAddress = match[1];
  
  filterSettings.blacklistTokens.add(mintAddress);
  await bot.sendMessage(chatId, `✅ Token hozzáadva a blacklist-hez:\n<code>${mintAddress}</code>`, 
    { parse_mode: 'HTML' });
});

bot.onText(/\/whitelist (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const mintAddress = match[1];
  
  filterSettings.whitelistTokens.add(mintAddress);
  await bot.sendMessage(chatId, `✅ Token hozzáadva a whitelist-hez:\n<code>${mintAddress}</code>`, 
    { parse_mode: 'HTML' });
});

bot.onText(/\/clearfilters/, async (msg) => {
  const chatId = msg.chat.id;
  
  filterSettings.blacklistTokens.clear();
  filterSettings.whitelistTokens.clear();
  
  await bot.sendMessage(chatId, '✅ Minden szűrő törölve!');
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  const helpMessage = `
📚 <b>Részletes Súgó</b>

<b>Alapvető parancsok:</b>
• /start - Bot indítása és értesítések bekapcsolása
• /status - Aktuális beállítások megtekintése
• /enable - Monitoring bekapcsolása
• /disable - Monitoring kikapcsolása

<b>Szűrési beállítások:</b>
• /setmin [USD] - Minimum likviditási küszöb
• /setinterval [perc] - Ellenőrzési gyakoriság (1-60)
• /setburn [%] - Minimum burn százalék (0-100)

<b>DEX kezelés:</b>
• /adddex [név] - DEX hozzáadása (raydium/orca/meteora)
• /removedex [név] - DEX eltávolítása

<b>Token szűrők:</b>
• /blacklist [mint] - Token kizárása
• /whitelist [mint] - Csak ezt a tokent figyelje
• /clearfilters - Összes szűrő törlése

<b>Működés:</b>
A bot ${filterSettings.checkInterval} percenként ellenőrzi az LP burn eseményeket a Solana hálózaton. 
Csak azokat az eseményeket jelzi, ahol a burn ${filterSettings.minBurnPercentage}% feletti.

💡 <b>Tipp:</b> Használj whitelist-et specifikus tokenek követéséhez!
`;
  
  await bot.sendMessage(chatId, helpMessage, { parse_mode: 'HTML' });
});

// Formázó függvény
function formatNumber(num) {
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(2);
}

// Régi burn események tisztítása (24 óra után)
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of recentBurns.entries()) {
    if (now - timestamp > 24 * 60 * 60 * 1000) {
      recentBurns.delete(key);
    }
  }
}, 60 * 60 * 1000); // Óránként

// Cron job az időzített ellenőrzésekhez
let cronJob = cron.schedule(`*/${filterSettings.checkInterval} * * * *`, checkForLPBurns);

// Helius webhook regisztráció
async function registerHeliusWebhook() {
  try {
    // Render környezetben automatikus URL használata
    const webhookUrl = config.webhookUrl || 
                       (process.env.RENDER_EXTERNAL_URL ? 
                        `${process.env.RENDER_EXTERNAL_URL}/webhook` : 
                        'https://your-domain.com/webhook');
    
    console.log(`🔗 Webhook URL: ${webhookUrl}`);
    
    const response = await axios.post(
      `https://api.helius.xyz/v0/webhooks?api-key=${config.heliusApiKey}`,
      {
        webhookURL: webhookUrl,
        transactionTypes: ['BURN', 'TRANSFER'],
        accountAddresses: Object.values(DEX_PROGRAMS),
        webhookType: 'enhanced'
      }
    );
    
    console.log('✅ Helius webhook regisztrálva:', response.data);
  } catch (error) {
    console.error('❌ Webhook regisztráció sikertelen:', error.message);
    // Production-ben ne álljon le a bot webhook hiba miatt
    if (!config.isProduction) {
      console.log('⚠️ Folytatás webhook nélkül (csak időzített ellenőrzés)');
    }
  }
}

// Alkalmazás indítása
async function start() {
  console.log('🚀 Solana LP Burn Monitor Bot indítása...');
  
  // Render környezet info
  if (process.env.RENDER) {
    console.log('📍 Környezet: Render.com');
    console.log(`🔗 Service URL: ${process.env.RENDER_EXTERNAL_URL || 'Nincs beállítva'}`);
  }
  
  // Express szerver indítása
  app.listen(config.port, () => {
    console.log(`📡 Webhook szerver fut: ${config.port} porton`);
    if (process.env.RENDER_EXTERNAL_URL) {
      console.log(`🌐 Publikus URL: ${process.env.RENDER_EXTERNAL_URL}`);
    }
  });
  
  // Helius webhook regisztráció
  await registerHeliusWebhook();
  
  // Első ellenőrzés
  await checkForLPBurns();
  
  // Keep-alive mechanizmus Render free tier-hez (14 percenként ping)
  if (process.env.RENDER && process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => {
      axios.get(`${process.env.RENDER_EXTERNAL_URL}/health`)
        .then(() => console.log('🏓 Keep-alive ping sikeres'))
        .catch(() => console.log('⚠️ Keep-alive ping sikertelen'));
    }, 14 * 60 * 1000); // 14 perc
  }
  
  console.log('✅ Bot sikeresen elindult!');
  console.log(`⏰ Ellenőrzés ${filterSettings.checkInterval} percenként`);
  console.log('💬 Használd a /start parancsot Telegramban a bot aktiválásához!');
}

// Bot indítása
start().catch(error => {
  console.error('❌ Kritikus hiba a bot indításakor:', error);
  // Render környezetben hagyjuk futni a szervert a health check miatt
  if (!process.env.RENDER) {
    process.exit(1);
  }
});

// Kezeletlen hibák kezelése
process.on('unhandledRejection', (error) => {
  console.error('❌ Kezeletlen Promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Kezeletlen kivétel:', error);
  // Kritikus hiba esetén újraindítás
  if (process.env.RENDER) {
    console.log('🔄 Újraindítás 5 másodperc múlva...');
    setTimeout(() => process.exit(1), 5000);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Bot leállítása...');
  bot.stopPolling();
  cronJob.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Bot leállítása (SIGTERM)...');
  bot.stopPolling();
  cronJob.stop();
  process.exit(0);
});
