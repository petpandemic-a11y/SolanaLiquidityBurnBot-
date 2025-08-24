// Send LP burn alert
async function sendLPBurnAlert(burnInfo) {
    let marketCapText = 'N/A';
    if (burnInfo.marketcap && burnInfo.marketcap > 0) {
        if (burnInfo.marketcap >= 1000000) {
            marketCapText = `${(burnInfo.marketcap / 1000000).toFixed(1)}M`;
        } else if (burnInfo.marketcap >= 1000) {
            marketCapText = `${(burnInfo.marketcap / 1000).toFixed(0)}K`;
        } else {
            marketCapText = `${burnInfo.marketcap.toFixed(0)}`;
        }
    }
    
    const message = `
🔥 **100% LP ELÉGETVE!** 🔥

💰 **Token:** ${burnInfo.tokenName} (${burnInfo.tokenSymbol})
🏷️ **Mint:** \`${burnInfo.mint}\`
🔥 **Égetett tokens:** ${Math.round(burnInfo.burnedAmount).toLocaleString()}
💎 **SOL égetve:** ${burnInfo.solBurned.toFixed(2)} SOL
📊 **Market Cap:** ${marketCapText}
⏰ **Időpont:** ${burnInfo.timestamp.toLocaleString('hu-HU')}

✅ **TELJES MEME/SOL LP ELÉGETVE!**const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID; // Private chat for commands
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID || process.env.TELEGRAM_CHAT_ID; // Channel for alerts
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RAYDIUM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

// Bot settings (stored in memory, configurable via Telegram)
let settings = {
    minSOL: 5,                    // Minimum SOL burned
    minTokens: 1000000,           // Minimum tokens burned
    minMarketCap: 10000,          // Minimum $10K marketcap
    maxMarketCap: 50000000,       // Maximum $50M marketcap
    isActive: false,              // Monitor active/inactive
    adminChatId: ADMIN_CHAT_ID,   // Private chat for commands
    alertChatId: ALERT_CHAT_ID    // Channel for alerts
};

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, 'confirmed');
const processedTxs = new Set();
let monitorInterval;

// Middleware
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mode: 'polling',
    interval: '10 seconds',
    chats: {
      admin: settings.adminChatId,
      alerts: settings.alertChatId
    },
    settings,
    processed: processedTxs.size,
    timestamp: new Date().toISOString()
  });
});

// Telegram Bot Commands
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (chatId.toString() !== settings.adminChatId) {
        bot.sendMessage(chatId, '⛔ Unauthorized access');
        return;
    }
    
    const welcomeMsg = `
🚀 **LP Burn Monitor Bot**

**Parancsok:**
/settings - Jelenlegi beállítások
/setsol <érték> - Min SOL beállítás (pl: /setsol 10)
/setminmc <érték> - Min MarketCap (pl: /setminmc 50000)  
/setmaxmc <érték> - Max MarketCap (pl: /setmaxmc 10000000)
/start_monitor - Monitoring indítás
/stop_monitor - Monitoring megállítás
/status - Bot állapot
/help - Súgó

**Jelenlegi beállítások:**
💎 Min SOL: ${settings.minSOL} SOL
📊 Min MC: ${settings.minMarketCap.toLocaleString()}
📈 Max MC: ${settings.maxMarketCap.toLocaleString()}
⚡ Aktív: ${settings.isActive ? '✅' : '❌'}
⏰ **Ellenőrzés: 10 másodpercenként**
    `;
    
    bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/settings/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (chatId.toString() !== settings.adminChatId) return;
    
    const settingsMsg = `
⚙️ **Jelenlegi beállítások:**

💎 **Min SOL égetve:** ${settings.minSOL} SOL
🔢 **Min tokens égetve:** ${settings.minTokens.toLocaleString()}
📊 **Min MarketCap:** ${settings.minMarketCap.toLocaleString()}
📈 **Max MarketCap:** ${settings.maxMarketCap.toLocaleString()}
⚡ **Monitor állapot:** ${settings.isActive ? '🟢 Aktív' : '🔴 Inaktív'}
⏰ **Ellenőrzés:** 10 másodpercenként
📊 **Feldolgozott tx:** ${processedTxs.size}

**Parancsok a módosításhoz:**
/setsol 10 - Min SOL beállítás
/setminmc 25000 - Min MarketCap
/setmaxmc 5000000 - Max MarketCap
    `;
    
    bot.sendMessage(chatId, settingsMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/setsol (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (chatId.toString() !== settings.adminChatId) return;
    
    const newValue = parseFloat(match[1]);
    
    if (isNaN(newValue) || newValue <= 0 || newValue > 1000) {
        bot.sendMessage(chatId, '❌ Érvénytelen érték! Használj 0.1 és 1000 közötti számot.');
        return;
    }
    
    settings.minSOL = newValue;
    bot.sendMessage(chatId, `✅ Min SOL frissítve: ${settings.minSOL} SOL`);
});

bot.onText(/\/setminmc (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (chatId.toString() !== settings.adminChatId) return;
    
    const newValue = parseFloat(match[1]);
    
    if (isNaN(newValue) || newValue < 0 || newValue > 100000000) {
        bot.sendMessage(chatId, '❌ Érvénytelen érték! Használj 0 és 100M közötti számot.');
        return;
    }
    
    settings.minMarketCap = newValue;
    bot.sendMessage(chatId, `✅ Min MarketCap frissítve: $${settings.minMarketCap.toLocaleString()}`);
});

bot.onText(/\/setmaxmc (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (chatId.toString() !== settings.adminChatId) return;
    
    const newValue = parseFloat(match[1]);
    
    if (isNaN(newValue) || newValue < 1000 || newValue > 1000000000) {
        bot.sendMessage(chatId, '❌ Érvénytelen érték! Használj 1K és 1B közötti számot.');
        return;
    }
    
    settings.maxMarketCap = newValue;
    bot.sendMessage(chatId, `✅ Max MarketCap frissítve: $${settings.maxMarketCap.toLocaleString()}`);
});

bot.onText(/\/start_monitor/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (chatId.toString() !== settings.adminChatId) return;
    
    if (settings.isActive) {
        bot.sendMessage(chatId, '⚠️ Monitor már aktív!');
        return;
    }
    
    settings.isActive = true;
    startMonitoring();
    
    bot.sendMessage(chatId, `
✅ **Monitor elindítva!**

📊 **Beállítások:**
💎 Min SOL: ${settings.minSOL} SOL
📈 Min MC: ${settings.minMarketCap.toLocaleString()}
📉 Max MC: ${settings.maxMarketCap.toLocaleString()}
⏰ **Ellenőrzés:** 10 másodpercenként

🔍 Keresem a meme/SOL LP burnokat...
    `, { parse_mode: 'Markdown' });
});

bot.onText(/\/stop_monitor/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (chatId.toString() !== settings.adminChatId) return;
    
    if (!settings.isActive) {
        bot.sendMessage(chatId, '⚠️ Monitor már inaktív!');
        return;
    }
    
    settings.isActive = false;
    stopMonitoring();
    
    bot.sendMessage(chatId, '🛑 **Monitor megállítva**');
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (chatId.toString() !== settings.adminChatId) return;
    
    const statusMsg = `
📊 **Bot állapot:**

⚡ **Monitor:** ${settings.isActive ? '🟢 Aktív' : '🔴 Inaktív'}
🔢 **Feldolgozott tx:** ${processedTxs.size}
⏰ **Uptime:** ${Math.round(process.uptime() / 60)} perc
💾 **Memory:** ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB

**Utolsó 5 feldolgozott:**
${Array.from(processedTxs).slice(-5).map(tx => `• ${tx.slice(0, 8)}...`).join('\n') || 'Nincs adat'}

**Következő ellenőrzés:** ${settings.isActive ? 'Max 10 másodperc' : 'Monitor leállítva'}
    `;
    
    bot.sendMessage(chatId, statusMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (chatId.toString() !== settings.adminChatId) return;
    
    const helpMsg = `
📖 **LP Burn Monitor Súgó**

**Fő parancsok:**
/start - Indítás és alapparancsok
/settings - Jelenlegi beállítások megtekintése
/start_monitor - LP burn monitoring indítása
/stop_monitor - Monitoring megállítása
/status - Bot állapot és statisztikák

**Beállítás parancsok:**
/setsol <szám> - Min SOL mennyiség (pl: /setsol 2.5)
/setminmc <szám> - Min MarketCap dollárban (pl: /setminmc 50000)
/setmaxmc <szám> - Max MarketCap dollárban (pl: /setmaxmc 10000000)

**Példák:**
/setsol 10 → Csak 10+ SOL burnokat mutat
/setminmc 100000 → Csak $100K+ MC tokeneket
/setmaxmc 5000000 → Csak $5M alatti MC tokeneket

**Működés:**
• **10 másodpercenként** ellenőriz Helius API-n keresztül
• Csak elmúlt **10 másodperc** tranzakcióit nézi
• Csak meme/SOL LP burnokat keres
• MarketCap adatok DexScreener-ről
• Instant Telegram értesítés
• Helius kredit takarékos használat
    `;
    
    bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
});

// Monitoring functions
function startMonitoring() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
    }
    
    console.log('🚀 Starting LP burn monitoring every 10 SECONDS...');
    
    // Run immediately, then every 10 seconds
    checkForLPBurns();
    monitorInterval = setInterval(checkForLPBurns, 10 * 1000); // 10 seconds
}

function stopMonitoring() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }
    console.log('🛑 LP burn monitoring stopped');
}

// Check for LP burns in last 10 SECONDS
async function checkForLPBurns() {
    if (!settings.isActive) return;
    
    try {
        console.log('🔍 Checking for LP burns in last 10 seconds...');
        
        // Get recent signatures
        const signatures = await connection.getSignaturesForAddress(
            new PublicKey(RAYDIUM_PROGRAM),
            { limit: 20 } // Smaller limit for frequent checks
        );
        
        const now = Date.now();
        const tenSecondsAgo = now - (10 * 1000); // 10 seconds ago
        
        let checkedCount = 0;
        let newTransactions = 0;
        
        for (const sigInfo of signatures) {
            // Check if transaction is from last 10 seconds
            const txTime = sigInfo.blockTime * 1000;
            if (txTime < tenSecondsAgo) {
                console.log(`⏰ Transaction older than 10s: ${Math.round((now - txTime) / 1000)}s ago`);
                break;
            }
            
            if (processedTxs.has(sigInfo.signature)) {
                continue;
            }
            
            processedTxs.add(sigInfo.signature);
            newTransactions++;
            
            // Memory cleanup
            if (processedTxs.size > 1000) { // Smaller cache for frequent updates
                const oldest = Array.from(processedTxs).slice(0, 500);
                oldest.forEach(sig => processedTxs.delete(sig));
            }
            
            const burnInfo = await checkTransactionForBurn(sigInfo.signature);
            checkedCount++;
            
            if (burnInfo) {
                console.log(`🔥 LP BURN FOUND: ${burnInfo.tokenSymbol} - ${burnInfo.solBurned} SOL`);
                await sendLPBurnAlert(burnInfo);
            }
            
            // Shorter rate limiting for 10s cycles
            await new Promise(resolve => setTimeout(resolve, 50)); // 50ms delay
        }
        
        if (newTransactions > 0) {
            console.log(`✅ Checked ${checkedCount} new transactions in last 10 seconds`);
        }
        
    } catch (error) {
        console.error('❌ Error checking LP burns:', error.message);
        
        // Only notify admin of repeated errors to avoid spam
        if (!checkForLPBurns.lastError || Date.now() - checkForLPBurns.lastError > 60000) {
            try {
                await bot.sendMessage(settings.adminChatId, 
                    `❌ **Monitor hiba:**\n\n${error.message}\n\n⏰ ${new Date().toLocaleTimeString()}`
                );
                checkForLPBurns.lastError = Date.now();
            } catch (notifyError) {
                console.error('Failed to notify admin of error:', notifyError.message);
            }
        }
    }
}

// Check individual transaction for LP burn
async function checkTransactionForBurn(signature) {
    try {
        const tx = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
        });

        if (!tx?.meta) return null;

        const preBalances = tx.meta.preTokenBalances || [];
        const postBalances = tx.meta.postTokenBalances || [];
        
        // Look for token burns and SOL in same transaction
        let solBurned = 0;
        let tokenBurnInfo = null;
        
        // Check for SOL transfers
        if (tx.meta.preBalances && tx.meta.postBalances) {
            for (let i = 0; i < tx.meta.preBalances.length; i++) {
                const preBalance = tx.meta.preBalances[i];
                const postBalance = tx.meta.postBalances[i];
                const diff = (preBalance - postBalance) / 1e9; // Convert to SOL
                
                if (diff > 0.01) { // Meaningful SOL amount
                    solBurned += diff;
                }
            }
        }
        
        // Check for token burns
        for (const pre of preBalances) {
            const post = postBalances.find(p => p.accountIndex === pre.accountIndex);
            const preAmount = pre.uiTokenAmount?.uiAmount || 0;
            const postAmount = post?.uiTokenAmount?.uiAmount || 0;

            // Large burn to zero
            if (preAmount > settings.minTokens && postAmount === 0) {
                // Skip known stablecoins
                const skipTokens = [
                    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
                ];
                
                if (skipTokens.includes(pre.mint)) {
                    continue;
                }
                
                tokenBurnInfo = {
                    mint: pre.mint,
                    burnedAmount: preAmount
                };
                break;
            }
        }
        
        // Must have both token burn and SOL burn
        if (!tokenBurnInfo || solBurned < settings.minSOL) {
            return null;
        }
        
        console.log(`🎯 Potential LP burn: ${tokenBurnInfo.burnedAmount.toLocaleString()} tokens + ${solBurned.toFixed(2)} SOL`);
        
        // Get token info and marketcap
        const tokenInfo = await getTokenInfoAndMarketcap(tokenBurnInfo.mint);
        
        // Check marketcap filter
        if (tokenInfo.marketcap > 0) {
            if (tokenInfo.marketcap < settings.minMarketCap || tokenInfo.marketcap > settings.maxMarketCap) {
                console.log(`⚠️ Marketcap (${tokenInfo.marketcap.toLocaleString()}) outside range`);
                return null;
            }
        }
        
        return {
            signature,
            mint: tokenBurnInfo.mint,
            burnedAmount: tokenBurnInfo.burnedAmount,
            solBurned: solBurned,
            tokenName: tokenInfo.name,
            tokenSymbol: tokenInfo.symbol,
            marketcap: tokenInfo.marketcap,
            timestamp: new Date()
        };
        
    } catch (error) {
        console.error(`Error checking transaction ${signature}:`, error.message);
        return null;
    }
}

// Get token info and marketcap
async function getTokenInfoAndMarketcap(mintAddress) {
    try {
        let tokenInfo = { name: 'Unknown Token', symbol: 'UNKNOWN', marketcap: 0 };
        
        // Try DexScreener first for marketcap
        try {
            const dexResponse = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
                { timeout: 5000 }
            );
            
            if (dexResponse.data?.pairs?.[0]) {
                const pair = dexResponse.data.pairs[0];
                tokenInfo.name = pair.baseToken?.name || 'Unknown Token';
                tokenInfo.symbol = pair.baseToken?.symbol || 'UNKNOWN';
                tokenInfo.marketcap = parseFloat(pair.fdv) || 0;
                
                console.log(`✅ DexScreener: ${tokenInfo.name} (${tokenInfo.symbol}) MC: $${tokenInfo.marketcap.toLocaleString()}`);
                return tokenInfo;
            }
        } catch (error) {
            console.log('⚠️ DexScreener failed:', error.message);
        }
        
        // Fallback to Jupiter
        try {
            const jupiterResponse = await axios.get('https://token.jup.ag/strict', { timeout: 3000 });
            const token = jupiterResponse.data.find(t => t.address === mintAddress);
            
            if (token) {
                tokenInfo.name = token.name;
                tokenInfo.symbol = token.symbol;
                console.log(`✅ Jupiter fallback: ${tokenInfo.name} (${tokenInfo.symbol})`);
            }
        } catch (error) {
            console.log('⚠️ Jupiter failed:', error.message);
        }
        
        return tokenInfo;
        
    } catch (error) {
        console.error(`Token info error for ${mintAddress}:`, error.message);
        return { name: 'Unknown Token', symbol: 'UNKNOWN', marketcap: 0 };
    }
}

// Send LP burn alert
async function sendLPBurnAlert(burnInfo) {
    let marketCapText = 'N/A';
    if (burnInfo.marketcap && burnInfo.marketcap > 0) {
        if (burnInfo.marketcap >= 1000000) {
            marketCapText = `${(burnInfo.marketcap / 1000000).toFixed(1)}M`;
        } else if (burnInfo.marketcap >= 1000) {
            marketCapText = `${(burnInfo.marketcap / 1000).toFixed(0)}K`;
        } else {
            marketCapText = `${burnInfo.marketcap.toFixed(0)}`;
        }
    }
    
    const message = `
🔥 **100% LP ELÉGETVE!** 🔥

💰 **Token:** ${burnInfo.tokenName} (${burnInfo.tokenSymbol})
🏷️ **Mint:** \`${burnInfo.mint}\`
🔥 **Égetett tokens:** ${Math.round(burnInfo.burnedAmount).toLocaleString()}
💎 **SOL égetve:** ${burnInfo.solBurned.toFixed(2)} SOL
📊 **Market Cap:** ${marketCapText}
⏰ **Időpont:** ${burnInfo.timestamp.toLocaleString('hu-HU')}

✅ **TELJES MEME/SOL LP ELÉGETVE!** 
🛡️ **${burnInfo.solBurned.toFixed(2)} SOL** biztosan elégetve
🚫 **Rug pull:** Már nem lehetséges!
📊 **Tranzakció:** [Solscan](https://solscan.io/tx/${burnInfo.signature})

🚀 **Biztonságos memecoin lehet!**
⚠️ **DYOR:** Mindig végezz saját kutatást!

#LPBurned #MemeSol #SafeToken #${burnInfo.tokenSymbol}
    `.trim();

    try {
        // Send alert to channel/group (not to admin private chat)
        await bot.sendMessage(settings.alertChatId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
        });
        
        console.log(`✅ ALERT SENT to channel: ${burnInfo.tokenSymbol} - ${burnInfo.solBurned.toFixed(2)} SOL burned`);
        
        // Also notify admin privately about the alert
        await bot.sendMessage(settings.adminChatId, `✅ **Alert küldve!**\n\n${burnInfo.tokenSymbol} LP burn alert elküldve a channelre.`);
        
    } catch (error) {
        console.error('❌ Telegram alert error:', error.message);
        
        // Notify admin of the error
        try {
            await bot.sendMessage(settings.adminChatId, `❌ **Alert küldési hiba:**\n\n${error.message}`);
        } catch (notifyError) {
            console.error('Failed to notify admin of alert error:', notifyError.message);
        }
    }
} 
🛡️ **${burnInfo.solBurned.toFixed(2)} SOL** biztosan elégetve
🚫 **Rug pull:** Már nem lehetséges!
📊 **Tranzakció:** [Solscan](https://solscan.io/tx/${burnInfo.signature})

🚀 **Biztonságos memecoin lehet!**
⚠️ **DYOR:** Mindig végezz saját kutatást!

#LPBurned #MemeSol #SafeToken #${burnInfo.tokenSymbol}
    `.trim();

    try {
        await bot.sendMessage(settings.adminChatId, message, {
            parse_mode: 'Markdown',
            disable_web_
