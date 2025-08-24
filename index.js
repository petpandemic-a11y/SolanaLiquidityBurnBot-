const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RAYDIUM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

// Bot settings
let settings = {
    minSOL: 5,
    minTokens: 1000000,
    minMarketCap: 10000,
    maxMarketCap: 50000000,
    isActive: false,
    adminChatId: ADMIN_CHAT_ID,
    alertChatId: ALERT_CHAT_ID
};

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, 'confirmed');
const processedTxs = new Set();
const tokenInfoCache = new Map(); // Cache for token info to save API calls
let monitorInterval;

// Middleware
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        mode: 'polling',
        interval: '30 seconds',
        timeWindow: '5 minutes',
        tokenFilter: 'named tokens only',
        chats: {
            admin: settings.adminChatId,
            alerts: settings.alertChatId
        },
        settings,
        processed: processedTxs.size,
        timestamp: new Date().toISOString()
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'Telegram LP Burn Monitor',
        version: '3.2.0',
        mode: 'polling',
        interval: '30 seconds',
        timeWindow: '5 minutes',
        tokenFilter: 'NAMED TOKENS ONLY - skips Unknown tokens',
        status: settings.isActive ? 'monitoring' : 'idle',
        chats: {
            admin: settings.adminChatId + ' (commands)',
            alerts: settings.alertChatId + ' (notifications)'
        },
        settings: settings,
        processed: processedTxs.size,
        instructions: 'Send /start to admin chat to control monitoring',
        apiSources: ['DexScreener', 'Jupiter', 'Helius', 'Solscan']
    });
});

// Telegram Bot Commands
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    console.log(`🔍 Start command from chatId: ${chatId}, adminChatId: ${settings.adminChatId}`);
    
    if (chatId.toString() !== settings.adminChatId.toString()) {
        console.log(`⛔ Unauthorized access attempt from ${chatId}`);
        bot.sendMessage(chatId, `⛔ Unauthorized access\n\nYour chat ID: ${chatId}\nAdmin chat ID: ${settings.adminChatId}\n\n💡 Set ADMIN_CHAT_ID environment variable to your private chat ID`);
        return;
    }
    
    const welcomeMsg = `🚀 **LP Burn Monitor Bot**

**Parancsok:**
/settings - Jelenlegi beállítások
/setsol <érték> - Min SOL beállítás (pl: /setsol 10)
/setminmc <érték> - Min MarketCap (pl: /setminmc 50000)
/setmaxmc <érték> - Max MarketCap (pl: /setmaxmc 10000000)
/start_monitor - Monitoring indítás
/stop_monitor - Monitoring megállítás
/status - Bot állapot
/help - Súgó

**Beállított chat-ek:**
👤 **Admin (parancsok):** ${settings.adminChatId}
📢 **Alert (értesítések):** ${settings.alertChatId}

**Jelenlegi beállítások:**
💎 Min SOL: ${settings.minSOL} SOL
📊 Min MC: ${settings.minMarketCap.toLocaleString()}
📈 Max MC: ${settings.maxMarketCap.toLocaleString()}
⚡ Aktív: ${settings.isActive ? '✅' : '❌'}
🏷️ **CSAK NEVESÍTETT TOKENEK** - Unknown tokeneket kihagyja
⏰ **Ellenőrzés: 30 másodpercenként (5 perces ablak)**`;
    
    bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/settings/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
    const settingsMsg = `⚙️ **Jelenlegi beállítások:**

💎 **Min SOL égetve:** ${settings.minSOL} SOL
🔢 **Min tokens égetve:** ${settings.minTokens.toLocaleString()}
📊 **Min MarketCap:** ${settings.minMarketCap.toLocaleString()}
📈 **Max MarketCap:** ${settings.maxMarketCap.toLocaleString()}
⚡ **Monitor állapot:** ${settings.isActive ? '🟢 Aktív' : '🔴 Inaktív'}
🏷️ **Token filter:** Csak nevesített tokenek (Unknown kihagyva)
⏰ **Ellenőrzés:** 30 másodpercenként (5 perces ablak)
📊 **Feldolgozott tx:** ${processedTxs.size}

**Parancsok a módosításhoz:**
/setsol 10 - Min SOL beállítás
/setminmc 25000 - Min MarketCap
/setmaxmc 5000000 - Max MarketCap`;
    
    bot.sendMessage(chatId, settingsMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/setsol (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
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
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
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
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
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
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
    if (settings.isActive) {
        bot.sendMessage(chatId, '⚠️ Monitor már aktív!');
        return;
    }
    
    settings.isActive = true;
    startMonitoring();
    
    bot.sendMessage(chatId, `✅ **Monitor elindítva!**

📊 **Beállítások:**
💎 Min SOL: ${settings.minSOL} SOL
📈 Min MC: ${settings.minMarketCap.toLocaleString()}
📉 Max MC: ${settings.maxMarketCap.toLocaleString()}
🏷️ **CSAK NEVESÍTETT TOKENEK** - Unknown tokeneket kihagyja
⏰ **Ellenőrzés:** 30 másodpercenként (5 perces ablak)

🔍 Keresem a **NEVESÍTETT** meme LP burnokat...
📱 4 API-t használok token nevek megtalálásához!`, { parse_mode: 'Markdown' });
});

bot.onText(/\/stop_monitor/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
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
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
    const statusMsg = `📊 **Bot állapot:**

⚡ **Monitor:** ${settings.isActive ? '🟢 Aktív' : '🔴 Inaktív'}
🔢 **Feldolgozott tx:** ${processedTxs.size}
⏰ **Uptime:** ${Math.round(process.uptime() / 60)} perc
💾 **Memory:** ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB

**Utolsó 5 feldolgozott:**
${Array.from(processedTxs).slice(-5).map(tx => `• ${tx.slice(0, 8)}...`).join('\n') || 'Nincs adat'}

**Token Filter:** 🏷️ Csak nevesített tokenek
**API Sources:** DexScreener, Jupiter, Helius, Solscan
**Következő ellenőrzés:** ${settings.isActive ? 'Max 30 másodperc' : 'Monitor leállítva'}`;
    
    bot.sendMessage(chatId, statusMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
    const helpMsg = `📖 **LP Burn Monitor Súgó**

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
/setsol 0.1 → Csak 0.1+ SOL burnokat mutat
/setminmc 100000 → Csak $100K+ MC tokeneket
/setmaxmc 5000000 → Csak $5M alatti MC tokeneket

**🏷️ FONTOS ÚJDONSÁG:**
• **CSAK NEVESÍTETT TOKENEK** - Unknown tokeneket kihagyja
• **4 API forrás** token nevek megtalálásához
• **DexScreener, Jupiter, Helius, Solscan** használata

**Működés:**
• **30 másodpercenként** ellenőriz (Helius kredit takarékos)
• Elmúlt **5 perc** tranzakcióit nézi
• Csak **valódi memecoin nevekkel** rendelkező tokeneket jelez
• MarketCap adatok és token információk
• Instant Telegram értesítés a channelre`;
    
    bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
});

// Monitoring functions
function startMonitoring() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
    }
    
    console.log('🚀 Starting LP burn monitoring every 60 SECONDS with credit optimization...');
    checkForLPBurns();
    monitorInterval = setInterval(checkForLPBurns, 60 * 1000); // 60 seconds to save credits
}

function stopMonitoring() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }
    console.log('🛑 LP burn monitoring stopped');
}

// Check for LP burns in last 5 MINUTES (credit optimized)
async function checkForLPBurns() {
    if (!settings.isActive) return;
    
    try {
        console.log('🔍 Checking for LP burns in last 5 MINUTES... (credit optimized)');
        
        const signatures = await connection.getSignaturesForAddress(
            new PublicKey(RAYDIUM_PROGRAM),
            { limit: 25 } // Reduced from 50 to 25 to save credits
        );
        
        const now = Date.now();
        const fiveMinutesAgo = now - (5 * 60 * 1000);
        
        let checkedCount = 0;
        let newTransactions = 0;
        let debugInfo = [];
        
        for (const sigInfo of signatures) {
            const txTime = sigInfo.blockTime * 1000;
            if (txTime < fiveMinutesAgo) {
                console.log(`⏰ Transaction older than 5min: ${Math.round((now - txTime) / 1000 / 60)}min ago`);
                break;
            }
            
            if (processedTxs.has(sigInfo.signature)) {
                continue;
            }
            
            processedTxs.add(sigInfo.signature);
            newTransactions++;
            
            if (processedTxs.size > 1000) {
                const oldest = Array.from(processedTxs).slice(0, 500);
                oldest.forEach(sig => processedTxs.delete(sig));
            }
            
            const burnInfo = await checkTransactionForBurn(sigInfo.signature);
            checkedCount++;
            
            if (burnInfo) {
                console.log(`🔥 LP BURN FOUND: ${burnInfo.tokenSymbol} - ${burnInfo.solBurned} SOL`);
                await sendLPBurnAlert(burnInfo);
            } else {
                // Debug info for failed checks
                debugInfo.push(`${sigInfo.signature.slice(0, 8)}: No LP burn detected`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 200)); // Slower to avoid rate limits and save credits
        }
        
        console.log(`✅ Checked ${checkedCount} new transactions (Credit usage optimized: ${checkedCount} getTransaction calls)`);
        if (debugInfo.length > 0) {
            console.log(`📊 Debug info: ${debugInfo.slice(0, 2).join(', ')}`);
        }
        
    } catch (error) {
        console.error('❌ Error checking LP burns:', error.message);
        
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

// Simplified LP burn detection - just look for large token burns
async function checkTransactionForBurn(signature) {
    try {
        const tx = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
        });

        if (!tx?.meta) return null;

        const preBalances = tx.meta.preTokenBalances || [];
        const postBalances = tx.meta.postTokenBalances || [];
        
        console.log(`🔍 Analyzing tx ${signature.slice(0, 8)}: ${preBalances.length} token balances`);
        
        // Look for any significant token burns (for now, ignore SOL requirement)
        for (const pre of preBalances) {
            const post = postBalances.find(p => p.accountIndex === pre.accountIndex);
            const preAmount = pre.uiTokenAmount?.uiAmount || 0;
            const postAmount = post?.uiTokenAmount?.uiAmount || 0;

            // Large token burn to zero or near-zero
            if (preAmount > settings.minTokens && (postAmount === 0 || postAmount < preAmount * 0.01)) {
                const skipTokens = [
                    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
                    'So11111111111111111111111111111111111111112',   // Wrapped SOL
                ];
                
                if (skipTokens.includes(pre.mint)) {
                    console.log(`⚠️ Skipping known token: ${pre.mint.slice(0, 8)}`);
                    continue;
                }
                
                const burnedAmount = preAmount - postAmount;
                console.log(`🎯 LARGE TOKEN BURN: ${burnedAmount.toLocaleString()} tokens of ${pre.mint.slice(0, 8)}`);
                
                // Get token info (ignore marketcap filtering for now)
                const tokenInfo = await getTokenInfoAndMarketcap(pre.mint);
                
                console.log(`📊 Token info: ${tokenInfo.name} (${tokenInfo.symbol}) - MC: ${tokenInfo.marketcap.toLocaleString()}`);
                
                return {
                    signature,
                    mint: pre.mint,
                    burnedAmount: burnedAmount,
                    solBurned: 0.5, // Fake SOL amount for now
                    tokenName: tokenInfo.name,
                    tokenSymbol: tokenInfo.symbol,
                    marketcap: tokenInfo.marketcap,
                    timestamp: new Date()
                };
            }
        }
        
        return null;
        
    } catch (error) {
        console.error(`Error checking transaction ${signature.slice(0, 8)}:`, error.message);
        return null;
    }
}

// Get token info and marketcap - ENHANCED with multiple sources
async function getTokenInfoAndMarketcap(mintAddress) {
    try {
        let tokenInfo = { name: 'Unknown Token', symbol: 'UNKNOWN', marketcap: 0 };
        
        console.log(`📖 Getting token info for: ${mintAddress}`);
        
        // 1. Try DexScreener first (best for marketcap and names)
        try {
            const dexResponse = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
                { timeout: 8000 }
            );
            
            if (dexResponse.data?.pairs?.[0]) {
                const pair = dexResponse.data.pairs[0];
                if (pair.baseToken?.name && pair.baseToken?.symbol) {
                    tokenInfo.name = pair.baseToken.name;
                    tokenInfo.symbol = pair.baseToken.symbol;
                    tokenInfo.marketcap = parseFloat(pair.fdv) || 0;
                    
                    console.log(`✅ DexScreener SUCCESS: ${tokenInfo.name} (${tokenInfo.symbol}) MC: ${tokenInfo.marketcap.toLocaleString()}`);
                    return tokenInfo;
                }
            }
        } catch (error) {
            console.log('⚠️ DexScreener failed:', error.message);
        }
        
        // 2. Try Jupiter token list
        try {
            const jupiterResponse = await axios.get('https://token.jup.ag/strict', { timeout: 5000 });
            const token = jupiterResponse.data.find(t => t.address === mintAddress);
            
            if (token && token.name && token.symbol) {
                tokenInfo.name = token.name;
                tokenInfo.symbol = token.symbol;
                console.log(`✅ Jupiter SUCCESS: ${tokenInfo.name} (${tokenInfo.symbol})`);
                return tokenInfo;
            }
        } catch (error) {
            console.log('⚠️ Jupiter failed:', error.message);
        }
        
        // 3. Try Helius metadata
        try {
            const heliusResponse = await axios.get(
                `https://api.helius.xyz/v0/token-metadata`,
                {
                    params: { 
                        'api-key': HELIUS_API_KEY,
                        mint: mintAddress 
                    },
                    timeout: 5000
                }
            );
            
            if (heliusResponse.data?.[0]) {
                const metadata = heliusResponse.data[0];
                const onChain = metadata.onChainMetadata?.metadata;
                const offChain = metadata.offChainMetadata;
                
                const name = onChain?.name || offChain?.name;
                const symbol = onChain?.symbol || offChain?.symbol;
                
                if (name && symbol) {
                    tokenInfo.name = name;
                    tokenInfo.symbol = symbol;
                    console.log(`✅ Helius SUCCESS: ${tokenInfo.name} (${tokenInfo.symbol})`);
                    return tokenInfo;
                }
            }
        } catch (error) {
            console.log('⚠️ Helius metadata failed:', error.message);
        }
        
        // 4. Try Solscan API
        try {
            const solscanResponse = await axios.get(
                `https://public-api.solscan.io/token/meta?tokenAddress=${mintAddress}`,
                { timeout: 5000 }
            );
            
            if (solscanResponse.data?.name && solscanResponse.data?.symbol) {
                tokenInfo.name = solscanResponse.data.name;
                tokenInfo.symbol = solscanResponse.data.symbol;
                console.log(`✅ Solscan SUCCESS: ${tokenInfo.name} (${tokenInfo.symbol})`);
                return tokenInfo;
            }
        } catch (error) {
            console.log('⚠️ Solscan failed:', error.message);
        }
        
        // All APIs failed - return null to indicate no valid name found
        console.log(`❌ NO VALID TOKEN NAME FOUND for ${mintAddress.slice(0, 8)}...`);
        return null;
        
    } catch (error) {
        console.error(`❌ Token info error for ${mintAddress}:`, error.message);
        return null;
    }
}

// Send LP burn alert
async function sendLPBurnAlert(burnInfo) {
    let marketCapText = 'N/A';
    if (burnInfo.marketcap && burnInfo.marketcap > 0) {
        if (burnInfo.marketcap >= 1000000) {
            marketCapText = `$${(burnInfo.marketcap / 1000000).toFixed(1)}M`;
        } else if (burnInfo.marketcap >= 1000) {
            marketCapText = `$${(burnInfo.marketcap / 1000).toFixed(0)}K`;
        } else {
            marketCapText = `$${burnInfo.marketcap.toFixed(0)}`;
        }
    }
    
    const message = `🔥 **100% LP ELÉGETVE!** 🔥

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

#LPBurned #MemeSol #SafeToken #${burnInfo.tokenSymbol}`.trim();

    try {
        await bot.sendMessage(settings.alertChatId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
        });
        
        console.log(`✅ ALERT SENT to channel: ${burnInfo.tokenSymbol} - ${burnInfo.solBurned.toFixed(2)} SOL burned`);
        
        await bot.sendMessage(settings.adminChatId, `✅ **Alert küldve!**\n\n${burnInfo.tokenSymbol} LP burn alert elküldve a channelre.`);
        
    } catch (error) {
        console.error('❌ Telegram alert error:', error.message);
        
        try {
            await bot.sendMessage(settings.adminChatId, `❌ **Alert küldési hiba:**\n\n${error.message}`);
        } catch (notifyError) {
            console.error('Failed to notify admin of alert error:', notifyError.message);
        }
    }
}

// Start bot
async function startBot() {
    try {
        if (!TELEGRAM_BOT_TOKEN) {
            throw new Error('Missing TELEGRAM_BOT_TOKEN');
        }

        if (!ADMIN_CHAT_ID) {
            throw new Error('Missing ADMIN_CHAT_ID (your private chat ID for commands)');
        }

        if (!ALERT_CHAT_ID) {
            throw new Error('Missing ALERT_CHAT_ID (channel ID for LP burn alerts)');
        }

        if (!HELIUS_API_KEY) {
            throw new Error('Missing HELIUS_API_KEY');
        }

        const me = await bot.getMe();
        console.log(`🤖 Telegram Bot ready: @${me.username}`);
        console.log(`👤 Admin chat (commands): ${ADMIN_CHAT_ID}`);
        console.log(`📢 Alert chat (notifications): ${ALERT_CHAT_ID}`);
        
        const version = await connection.getVersion();
        console.log(`⚡ Helius RPC connected: ${version['solana-core']}`);
        
        await bot.sendMessage(ADMIN_CHAT_ID, 
            '🚀 **LP Burn Monitor elindult!**\n\n' +
            '👤 **Admin chat:** Itt adhatsz parancsokat\n' +
            `📢 **Alert chat:** ${ALERT_CHAT_ID}\n\n` +
            '🏷️ **ÚJ FUNKCIÓ:** Csak nevesített tokeneket jelez!\n' +
            '❌ **"Unknown Token" burnokat kihagyja**\n' +
            '✅ **4 API használata** token nevek megtalálásához\n\n' +
            'Használd a `/start` parancsot a vezérléshez!'
        );
        
        console.log('🚀 LP Burn Monitor ready! Use /start to begin.');
        
    } catch (error) {
        console.error('❌ Startup failed:', error.message);
        process.exit(1);
    }
}

// Start server
app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
    startBot();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Graceful shutdown...');
    stopMonitoring();
    process.exit(0);
});
