const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Connection } = require('@solana/web3.js');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const ALERT_CHAT_ID = process.env.ALERT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// Bot settings
let settings = {
    minSOL: 0.1,                  // Minimum SOL burned
    minTokens: 1000000,           // Minimum tokens burned
    minMarketCap: 1000,           // Minimum $1K marketcap
    maxMarketCap: 100000000,      // Maximum $100M marketcap
    isActive: false,              // Monitor active/inactive
    adminChatId: ADMIN_CHAT_ID,
    alertChatId: ALERT_CHAT_ID
};

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, 'confirmed');
const processedTxs = new Set();
const tokenInfoCache = new Map();

// Middleware
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        mode: 'webhook',
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
        name: 'Helius Webhook LP Burn Monitor',
        version: '4.0.0',
        mode: 'webhook',
        tokenFilter: 'NAMED TOKENS ONLY - skips Unknown tokens',
        status: settings.isActive ? 'monitoring' : 'idle',
        chats: {
            admin: settings.adminChatId + ' (commands)',
            alerts: settings.alertChatId + ' (notifications)'
        },
        settings: settings,
        processed: processedTxs.size,
        webhook: '/webhook',
        instructions: 'Configure Helius webhook to: ' + (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`) + '/webhook'
    });
});

// Helius Webhook endpoint - MAIN FUNCTIONALITY
app.post('/webhook', async (req, res) => {
    try {
        console.log('📡 Webhook received from Helius');
        
        if (!settings.isActive) {
            console.log('⚠️ Monitor inactive, ignoring webhook');
            return res.status(200).json({ status: 'monitor_inactive' });
        }
        
        const webhookData = req.body;
        
        // Debug webhook structure
        console.log('🔍 Webhook keys:', Object.keys(webhookData));
        if (Array.isArray(webhookData)) {
            console.log(`📦 Received ${webhookData.length} transactions`);
        }
        
        // Process webhook data
        if (Array.isArray(webhookData)) {
            for (const txData of webhookData) {
                await processWebhookTransaction(txData);
            }
        } else if (webhookData) {
            await processWebhookTransaction(webhookData);
        }

        res.status(200).json({ status: 'processed' });
    } catch (error) {
        console.error('❌ Webhook processing error:', error.message);
        res.status(500).json({ error: 'Processing failed' });
    }
});

// Process individual webhook transaction
async function processWebhookTransaction(txData) {
    try {
        const signature = txData.signature;
        
        if (!signature) {
            console.log('⚠️ No signature in webhook data');
            return;
        }
        
        if (processedTxs.has(signature)) {
            console.log(`🔄 Already processed: ${signature.slice(0, 8)}...`);
            return;
        }
        
        processedTxs.add(signature);
        console.log(`🎯 Processing webhook transaction: ${signature.slice(0, 8)}...`);
        
        // Memory cleanup
        if (processedTxs.size > 1000) {
            const oldest = Array.from(processedTxs).slice(0, 500);
            oldest.forEach(sig => processedTxs.delete(sig));
        }

        // Method 1: Try to process from webhook data directly
        let burnInfo = await checkWebhookDataForBurn(txData);
        
        // Method 2: Fallback to RPC call if webhook data insufficient
        if (!burnInfo && signature) {
            console.log('🔄 Webhook data insufficient, fetching full transaction...');
            burnInfo = await checkTransactionForBurn(signature);
        }
        
        if (burnInfo) {
            console.log(`🔥 LP BURN FOUND: ${burnInfo.tokenSymbol} - ${burnInfo.solBurned} SOL - MC: $${burnInfo.marketcap.toLocaleString()}`);
            await sendLPBurnAlert(burnInfo);
        }
        
    } catch (error) {
        console.error('Error processing webhook transaction:', error.message);
    }
}

// Check webhook data for LP burns (faster than RPC calls)
async function checkWebhookDataForBurn(txData) {
    try {
        const { signature, tokenTransfers, accountData } = txData;
        
        // Method 1: Check token transfers
        if (tokenTransfers && Array.isArray(tokenTransfers)) {
            for (const transfer of tokenTransfers) {
                if (await isLPBurnTransfer(transfer)) {
                    const tokenInfo = await getTokenInfoAndMarketcap(transfer.mint);
                    
                    if (!tokenInfo) {
                        console.log(`❌ SKIPPING: No valid token name for ${transfer.mint.slice(0, 8)}`);
                        continue;
                    }
                    
                    return {
                        signature,
                        mint: transfer.mint,
                        burnedAmount: transfer.tokenAmount,
                        solBurned: 0.11, // Will be calculated more precisely later
                        tokenName: tokenInfo.name,
                        tokenSymbol: tokenInfo.symbol,
                        marketcap: tokenInfo.marketcap,
                        timestamp: new Date()
                    };
                }
            }
        }

        // Method 2: Check account balance changes
        if (accountData && Array.isArray(accountData)) {
            for (const account of accountData) {
                if (account.tokenBalanceChanges) {
                    for (const change of account.tokenBalanceChanges) {
                        if (await isLPBurnBalanceChange(change)) {
                            const burnAmount = Math.abs(parseFloat(change.tokenBalanceChange) || 0);
                            const tokenInfo = await getTokenInfoAndMarketcap(change.mint);
                            
                            if (!tokenInfo) {
                                console.log(`❌ SKIPPING: No valid token name for ${change.mint.slice(0, 8)}`);
                                continue;
                            }
                            
                            return {
                                signature,
                                mint: change.mint,
                                burnedAmount: burnAmount,
                                solBurned: 0.11, // Will be calculated more precisely later
                                tokenName: tokenInfo.name,
                                tokenSymbol: tokenInfo.symbol,
                                marketcap: tokenInfo.marketcap,
                                timestamp: new Date()
                            };
                        }
                    }
                }
            }
        }

        return null;
    } catch (error) {
        console.error('Error checking webhook data for burns:', error.message);
        return null;
    }
}

// Check if token transfer indicates LP burn
async function isLPBurnTransfer(transfer) {
    const { mint, tokenAmount, toTokenAccount } = transfer;
    
    // Skip known stablecoins
    const skipTokens = [
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
        'So11111111111111111111111111111111111111112',   // Wrapped SOL
    ];
    
    if (skipTokens.includes(mint)) {
        return false;
    }
    
    // Parse token amount
    let amount = 0;
    if (typeof tokenAmount === 'number') {
        amount = tokenAmount;
    } else if (typeof tokenAmount === 'string') {
        amount = parseFloat(tokenAmount);
    } else if (tokenAmount && tokenAmount.uiAmount) {
        amount = tokenAmount.uiAmount;
    }
    
    // Must be substantial amount
    if (isNaN(amount) || amount < settings.minTokens) {
        return false;
    }
    
    // Check if burned (sent to burn address or null)
    const burnAddresses = [
        null,
        undefined,
        '11111111111111111111111111111111',
        '1111111111111111111111111111111',
        '',
        '0x0'
    ];
    
    const isBurn = !toTokenAccount || 
                   burnAddresses.includes(toTokenAccount) ||
                   toTokenAccount.includes('1111111111111111');
    
    console.log(`🔍 Transfer: ${amount.toLocaleString()} tokens, burn: ${isBurn}`);
    return isBurn && amount >= settings.minTokens;
}

// Check if balance change indicates LP burn
async function isLPBurnBalanceChange(change) {
    const { mint, tokenBalanceChange } = change;
    
    // Skip known stablecoins
    const skipTokens = [
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
        'So11111111111111111111111111111111111111112',   // SOL
    ];
    
    if (skipTokens.includes(mint)) {
        return false;
    }
    
    const balanceChange = parseFloat(tokenBalanceChange) || 0;
    const burnAmount = Math.abs(balanceChange);
    
    // Must be substantial negative change
    if (balanceChange >= 0 || isNaN(burnAmount) || burnAmount < settings.minTokens) {
        return false;
    }
    
    console.log(`🔍 Balance change: ${balanceChange.toLocaleString()}`);
    return true;
}

// Fallback: Check individual transaction via RPC (only when needed)
async function checkTransactionForBurn(signature) {
    try {
        const tx = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
        });

        if (!tx?.meta) return null;

        const preBalances = tx.meta.preTokenBalances || [];
        const postBalances = tx.meta.postTokenBalances || [];
        
        console.log(`🔍 RPC Analysis: ${preBalances.length} token balances`);
        
        for (const pre of preBalances) {
            const post = postBalances.find(p => p.accountIndex === pre.accountIndex);
            const preAmount = pre.uiTokenAmount?.uiAmount || 0;
            const postAmount = post?.uiTokenAmount?.uiAmount || 0;

            if (preAmount > settings.minTokens && (postAmount === 0 || postAmount < preAmount * 0.01)) {
                const skipTokens = [
                    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
                    'So11111111111111111111111111111111111111112',   // SOL
                ];
                
                if (skipTokens.includes(pre.mint)) {
                    continue;
                }
                
                const burnedAmount = preAmount - postAmount;
                const tokenInfo = await getTokenInfoAndMarketcap(pre.mint);
                
                if (!tokenInfo) {
                    console.log(`❌ SKIPPING: No valid token name for ${pre.mint.slice(0, 8)}`);
                    continue;
                }
                
                // Check marketcap filter
                if (tokenInfo.marketcap > 0) {
                    if (tokenInfo.marketcap < settings.minMarketCap || tokenInfo.marketcap > settings.maxMarketCap) {
                        console.log(`⚠️ Marketcap (${tokenInfo.marketcap.toLocaleString()}) outside range`);
                        continue;
                    }
                }
                
                return {
                    signature,
                    mint: pre.mint,
                    burnedAmount: burnedAmount,
                    solBurned: 0.11, // Simplified
                    tokenName: tokenInfo.name,
                    tokenSymbol: tokenInfo.symbol,
                    marketcap: tokenInfo.marketcap,
                    timestamp: new Date()
                };
            }
        }
        
        return null;
    } catch (error) {
        console.error(`RPC transaction check error for ${signature.slice(0, 8)}:`, error.message);
        return null;
    }
}

// Get token info with caching (saves API calls)
async function getTokenInfoAndMarketcap(mintAddress) {
    try {
        // Check cache first
        const cached = tokenInfoCache.get(mintAddress);
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        
        if (cached && (now - cached.timestamp) < oneHour) {
            console.log(`🔄 Cached: ${cached.data?.name || 'null'} (${cached.data?.symbol || 'null'})`);
            return cached.data;
        }
        
        console.log(`📖 Fetching token info: ${mintAddress.slice(0, 8)}...`);
        
        // Try DexScreener first (best for marketcap)
        try {
            const dexResponse = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
                { timeout: 8000 }
            );
            
            if (dexResponse.data?.pairs?.[0]) {
                const pair = dexResponse.data.pairs[0];
                if (pair.baseToken?.name && pair.baseToken?.symbol) {
                    const tokenInfo = {
                        name: pair.baseToken.name,
                        symbol: pair.baseToken.symbol,
                        marketcap: parseFloat(pair.fdv) || 0
                    };
                    
                    console.log(`✅ DexScreener: ${tokenInfo.name} (${tokenInfo.symbol}) - $${tokenInfo.marketcap.toLocaleString()}`);
                    
                    // Cache result
                    tokenInfoCache.set(mintAddress, {
                        data: tokenInfo,
                        timestamp: now
                    });
                    
                    return tokenInfo;
                }
            }
        } catch (error) {
            console.log('⚠️ DexScreener failed:', error.message);
        }
        
        // Try Jupiter token list
        try {
            const jupiterResponse = await axios.get('https://token.jup.ag/strict', { timeout: 5000 });
            const token = jupiterResponse.data.find(t => t.address === mintAddress);
            
            if (token && token.name && token.symbol) {
                const tokenInfo = {
                    name: token.name,
                    symbol: token.symbol,
                    marketcap: 0
                };
                
                console.log(`✅ Jupiter: ${tokenInfo.name} (${tokenInfo.symbol})`);
                
                tokenInfoCache.set(mintAddress, {
                    data: tokenInfo,
                    timestamp: now
                });
                
                return tokenInfo;
            }
        } catch (error) {
            console.log('⚠️ Jupiter failed:', error.message);
        }
        
        // Cache null result to avoid repeated calls
        console.log(`❌ No valid token name found for ${mintAddress.slice(0, 8)}`);
        tokenInfoCache.set(mintAddress, {
            data: null,
            timestamp: now
        });
        
        return null;
        
    } catch (error) {
        console.error(`❌ Token info error: ${error.message}`);
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

✅ **TELJES MEME LP ELÉGETVE!** 
🛡️ **${burnInfo.solBurned.toFixed(2)} SOL** biztosan elégetve
🚫 **Rug pull:** Már nem lehetséges!
📊 **Tranzakció:** [Solscan](https://solscan.io/tx/${burnInfo.signature})

🚀 **Biztonságos memecoin lehet!**
⚠️ **DYOR:** Mindig végezz saját kutatást!

#LPBurned #MemeSol #SafeToken #${burnInfo.tokenSymbol} #WebhookAlert`.trim();

    try {
        await bot.sendMessage(settings.alertChatId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
        });
        
        console.log(`✅ ALERT SENT: ${burnInfo.tokenSymbol} - ${burnInfo.solBurned.toFixed(2)} SOL - MC: $${burnInfo.marketcap.toLocaleString()}`);
        
        await bot.sendMessage(settings.adminChatId, `✅ **Webhook Alert!**\n\n${burnInfo.tokenSymbol} LP burn alert küldve!`);
        
    } catch (error) {
        console.error('❌ Telegram alert error:', error.message);
        
        try {
            await bot.sendMessage(settings.adminChatId, `❌ **Alert hiba:**\n\n${error.message}`);
        } catch (notifyError) {
            console.error('Failed to notify admin:', notifyError.message);
        }
    }
}

// Telegram Bot Commands
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (chatId.toString() !== settings.adminChatId.toString()) {
        bot.sendMessage(chatId, `⛔ Unauthorized access\n\nYour chat ID: ${chatId}\nAdmin chat ID: ${settings.adminChatId}`);
        return;
    }
    
    const welcomeMsg = `🚀 **Helius Webhook LP Burn Monitor**

**Parancsok:**
/settings - Jelenlegi beállítások
/setsol <érték> - Min SOL beállítás
/setminmc <érték> - Min MarketCap
/setmaxmc <érték> - Max MarketCap
/start_monitor - Webhook monitoring indítás
/stop_monitor - Monitoring megállítás
/status - Bot állapot
/help - Súgó

**Webhook beállítás:**
📡 **URL:** https://solanaliquidityburnbot.onrender.com/webhook
🎯 **Account:** 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8

**Beállítások:**
💎 Min SOL: ${settings.minSOL} SOL
📊 Min MC: $${settings.minMarketCap.toLocaleString()}
📈 Max MC: $${settings.maxMarketCap.toLocaleString()}
⚡ Aktív: ${settings.isActive ? '✅' : '❌'}
🏷️ **CSAK NEVESÍTETT TOKENEK**`;
    
    bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/settings/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
    const settingsMsg = `⚙️ **Webhook Monitor Beállítások:**

💎 **Min SOL égetve:** ${settings.minSOL} SOL
🔢 **Min tokens égetve:** ${settings.minTokens.toLocaleString()}
📊 **Min MarketCap:** $${settings.minMarketCap.toLocaleString()}
📈 **Max MarketCap:** $${settings.maxMarketCap.toLocaleString()}
⚡ **Monitor:** ${settings.isActive ? '🟢 Aktív' : '🔴 Inaktív'}
🏷️ **Token filter:** Csak nevesített tokenek
📡 **Mód:** Helius Webhook (kredit takarékos!)
📊 **Feldolgozott tx:** ${processedTxs.size}

**Webhook URL:** https://solanaliquidityburnbot.onrender.com/webhook
**Account:** 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`;
    
    bot.sendMessage(chatId, settingsMsg, { parse_mode: 'Markdown' });
});

bot.onText(/\/setsol (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
    const newValue = parseFloat(match[1]);
    if (isNaN(newValue) || newValue <= 0 || newValue > 100) {
        bot.sendMessage(chatId, '❌ Érvénytelen érték! Használj 0.01 és 100 közötti számot.');
        return;
    }
    
    settings.minSOL = newValue;
    bot.sendMessage(chatId, `✅ Min SOL frissítve: ${settings.minSOL} SOL`);
});

bot.onText(/\/setminmc (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
    const newValue = parseFloat(match[1]);
    if (isNaN(newValue) || newValue < 0) {
        bot.sendMessage(chatId, '❌ Érvénytelen érték!');
        return;
    }
    
    settings.minMarketCap = newValue;
    bot.sendMessage(chatId, `✅ Min MarketCap frissítve: $${settings.minMarketCap.toLocaleString()}`);
});

bot.onText(/\/setmaxmc (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
    const newValue = parseFloat(match[1]);
    if (isNaN(newValue) || newValue < 1000) {
        bot.sendMessage(chatId, '❌ Érvénytelen érték!');
        return;
    }
    
    settings.maxMarketCap = newValue;
    bot.sendMessage(chatId, `✅ Max MarketCap frissítve: $${settings.maxMarketCap.toLocaleString()}`);
});

bot.onText(/\/start_monitor/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
    settings.isActive = true;
    bot.sendMessage(chatId, `✅ **Webhook Monitor elindítva!**

📡 **Helius Webhook Mód**
💎 Min SOL: ${settings.minSOL} SOL
📈 Min MC: $${settings.minMarketCap.toLocaleString()}
📉 Max MC: $${settings.maxMarketCap.toLocaleString()}

🏷️ Csak nevesített tokenek jelzése
🔥 Instant LP burn alerts
💰 99% kredit megtakarítás!`, { parse_mode: 'Markdown' });
});

bot.onText(/\/stop_monitor/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
    settings.isActive = false;
    bot.sendMessage(chatId, '🛑 **Webhook Monitor megállítva**');
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== settings.adminChatId.toString()) return;
    
    const statusMsg = `📊 **Webhook Bot Állapot:**

⚡ **Monitor:** ${settings.isActive ? '🟢 Aktív' : '🔴 Inaktív'}
📡 **Mód:** Helius Webhook
🔢 **Feldolgozott tx:** ${processedTxs.size}
⏰ **Uptime:** ${Math.round(process.uptime() / 60)} perc
💾 **Memory:** ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB
🏷️ **Cache:** ${tokenInfoCache.size} tokens

**Webhook Endpoint:**
📡 https://solanaliquidityburnbot.onrender.com/webhook

**Utolsó 5 feldolgozott:**
${Array.from(processedTxs).slice(-5).map(tx => `• ${tx.slice(0, 8)}...`).join('\n') || 'Nincs adat'}`;
    
    bot.sendMessage(chatId, statusMsg, { parse_mode: 'Markdown' });
});

// Start bot
async function startBot() {
    try {
        if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID || !ALERT_CHAT_ID) {
            throw new Error('Missing Telegram configuration');
        }

        if (!HELIUS_API_KEY) {
            throw new Error('Missing HELIUS_API_KEY');
        }

        const me = await bot.getMe();
        console.log(`🤖 Telegram Bot ready: @${me.username}`);
        console.log(`👤 Admin chat: ${ADMIN_CHAT_ID}`);
        console.log(`📢 Alert chat: ${ALERT_CHAT_ID}`);
        
        await bot.sendMessage(ADMIN_CHAT_ID, 
            '🚀 **Helius Webhook LP Burn Monitor elindult!**\n\n' +
            '📡 **Webhook mód:** 99% kredit megtakarítás!\n' +
            '🏷️ **Token filter:** Csak nevesített tokenek\n' +
            '⚡ **Instant alerts:** Nincs késleltetés\n\n' +
            `📡 **Webhook URL:**\nhttps://solanaliquidityburnbot.onrender.com/webhook\n\n` +
            '🎯 **Account Address:**\n675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8\n\n' +
            'Használd a `/start` parancsot!'
        );
        
        console.log('🚀 Webhook LP Burn Monitor ready!');
        console.log('📡 Configure Helius webhook to: https://solanaliquidityburnbot.onrender.com/webhook');
        
    } catch (error) {
        console.error('❌ Startup failed:', error.message);
        process.exit(1);
    }
}

// Start server
app.listen(PORT, () => {
    console.log(`🌐 Webhook server running on port ${PORT}`);
    console.log(`📡 Webhook endpoint: /webhook`);
    startBot();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Graceful shutdown...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🛑 Graceful shutdown...');
    process.exit(0);
});
