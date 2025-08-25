require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const express = require('express');

// ========================= CONFIG =========================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'secure_webhook_secret';
const PORT = process.env.PORT || 3000;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').filter(Boolean);

// Solana kapcsolat
const SOLANA_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const connection = new Connection(SOLANA_RPC, 'confirmed');

// Telegram bot inicializálás
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Express szerver webhook fogadáshoz
const app = express();
app.use(express.json());

// ========================= STATE MANAGEMENT =========================
const botConfig = {
    enabled: true,
    minLiquidity: 100, // USD
    maxLiquidity: 1000000, // USD
    checkInterval: 5 * 60 * 1000, // 5 perc
    filterNoName: true,
    alertOnlyFullBurn: true, // Csak 100% LP burn
};

// Cache a már feldolgozott tokenekhez
const processedTokens = new Set();
const tokenCache = new Map(); // Token adatok cache

// ========================= UTILITY FUNCTIONS =========================
function log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const logData = {
        timestamp,
        level,
        message,
        ...data
    };
    console.log(JSON.stringify(logData));
}

function isAdmin(userId) {
    return ADMIN_IDS.includes(String(userId));
}

function formatNumber(num) {
    if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(2)}K`;
    return num.toFixed(2);
}

// ========================= HELIUS API FUNCTIONS =========================
async function getTokenMetadata(mintAddress) {
    try {
        // Cache ellenőrzés
        if (tokenCache.has(mintAddress)) {
            return tokenCache.get(mintAddress);
        }

        const response = await axios.post(
            `https://api.helius.xyz/v0/token-metadata`,
            {
                mintAccounts: [mintAddress],
                includeOffChain: true,
                disableCache: false
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                },
                params: {
                    'api-key': HELIUS_API_KEY
                }
            }
        );

        if (response.data && response.data.length > 0) {
            const metadata = response.data[0];
            tokenCache.set(mintAddress, metadata);
            
            // Cache tisztítás 1 óra után
            setTimeout(() => tokenCache.delete(mintAddress), 3600000);
            
            return metadata;
        }
        return null;
    } catch (error) {
        log('error', 'Failed to get token metadata', { 
            mintAddress, 
            error: error.message 
        });
        return null;
    }
}

async function checkLPBurn(poolAddress) {
    try {
        // Raydium és Orca LP token címek lekérése
        const response = await axios.post(
            `https://api.helius.xyz/v0/addresses/${poolAddress}/transactions`,
            {
                limit: 100,
                type: ['BURN']
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                },
                params: {
                    'api-key': HELIUS_API_KEY
                }
            }
        );

        if (!response.data || response.data.length === 0) {
            return { burned: false, percentage: 0 };
        }

        // LP burn események elemzése
        let totalBurned = 0;
        let totalSupply = 0;

        for (const tx of response.data) {
            if (tx.type === 'BURN' && tx.tokenTransfers) {
                for (const transfer of tx.tokenTransfers) {
                    if (transfer.mint && transfer.tokenAmount) {
                        totalBurned += parseFloat(transfer.tokenAmount);
                    }
                }
            }
        }

        // Teljes supply lekérése
        try {
            const supplyInfo = await connection.getTokenSupply(new PublicKey(poolAddress));
            totalSupply = supplyInfo.value.uiAmount || 0;
        } catch (e) {
            log('warn', 'Could not get token supply', { poolAddress });
        }

        const burnPercentage = totalSupply > 0 ? (totalBurned / totalSupply) * 100 : 0;

        return {
            burned: burnPercentage >= 99.9, // ~100% burn
            percentage: burnPercentage,
            totalBurned,
            totalSupply
        };
    } catch (error) {
        log('error', 'Failed to check LP burn', { 
            poolAddress, 
            error: error.message 
        });
        return { burned: false, percentage: 0 };
    }
}

async function getNewTokens() {
    try {
        // Új tokenek lekérése az elmúlt 5 percből
        const fiveMinutesAgo = Date.now() - botConfig.checkInterval;
        
        const response = await axios.post(
            `https://api.helius.xyz/v0/token-metadata`,
            {
                limit: 100,
                showZeroBalance: false,
                displayOptions: {
                    showNativeBalance: true
                }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                },
                params: {
                    'api-key': HELIUS_API_KEY
                }
            }
        );

        if (!response.data) return [];

        const newTokens = [];
        
        for (const token of response.data) {
            // Szűrés: csak új, névvel rendelkező tokenek
            if (processedTokens.has(token.account)) continue;
            if (botConfig.filterNoName && (!token.onChainMetadata?.metadata?.data?.name || 
                token.onChainMetadata?.metadata?.data?.name === '')) continue;

            processedTokens.add(token.account);
            
            // LP burn ellenőrzés
            const burnStatus = await checkLPBurn(token.account);
            
            if (burnStatus.burned) {
                newTokens.push({
                    ...token,
                    burnStatus
                });
            }
        }

        return newTokens;
    } catch (error) {
        log('error', 'Failed to get new tokens', { error: error.message });
        return [];
    }
}

// ========================= TELEGRAM FUNCTIONS =========================
async function sendTokenAlert(tokenData) {
    try {
        const { 
            account, 
            onChainMetadata, 
            offChainMetadata,
            burnStatus 
        } = tokenData;

        const name = onChainMetadata?.metadata?.data?.name || offChainMetadata?.name || 'Unknown';
        const symbol = onChainMetadata?.metadata?.data?.symbol || offChainMetadata?.symbol || 'N/A';
        const decimals = onChainMetadata?.metadata?.data?.decimals || 9;

        // Üzenet összeállítása
        const message = `
🔥 <b>100% LP BURN DETECTED!</b> 🔥

📌 <b>Token:</b> ${name} (${symbol})
🏷️ <b>Contract:</b> <code>${account}</code>
🔥 <b>LP Burn:</b> ${burnStatus.percentage.toFixed(1)}%
💰 <b>Burned Amount:</b> ${formatNumber(burnStatus.totalBurned)}

🔗 <b>Links:</b>
• <a href="https://solscan.io/token/${account}">Solscan</a>
• <a href="https://dexscreener.com/solana/${account}">DexScreener</a>
• <a href="https://birdeye.so/token/${account}">Birdeye</a>
• <a href="https://rugcheck.xyz/tokens/${account}">RugCheck</a>

⚡ <i>New token with fully burned liquidity detected!</i>
⚠️ <i>DYOR - Always do your own research!</i>

#LPBurn #Solana #MemeToken`;

        await bot.sendMessage(CHANNEL_ID, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: false
        });

        log('info', 'Token alert sent', { 
            token: name, 
            symbol, 
            contract: account 
        });
    } catch (error) {
        log('error', 'Failed to send token alert', { 
            error: error.message,
            token: tokenData.account 
        });
    }
}

// ========================= TELEGRAM COMMANDS =========================
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const welcomeMessage = `
🤖 <b>Solana LP Burn Tracker Bot</b>

Welcome! This bot monitors new tokens on Solana and alerts when 100% of liquidity is burned.

${isAdmin(userId) ? `
<b>Admin Commands:</b>
/status - Bot status
/config - View configuration
/set_min_liq [amount] - Set minimum liquidity
/set_max_liq [amount] - Set maximum liquidity
/toggle - Enable/disable bot
/stats - View statistics
` : ''}

<b>Public Commands:</b>
/help - Show this message
/about - About this bot

Channel: @${process.env.TELEGRAM_CHANNEL_USERNAME || 'your_channel'}
`;

    await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML' });
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, '❌ Unauthorized');
    }

    const status = `
📊 <b>Bot Status</b>

✅ <b>Bot:</b> ${botConfig.enabled ? 'Enabled' : 'Disabled'}
⏰ <b>Check Interval:</b> ${botConfig.checkInterval / 60000} minutes
💰 <b>Min Liquidity:</b> $${formatNumber(botConfig.minLiquidity)}
💰 <b>Max Liquidity:</b> $${formatNumber(botConfig.maxLiquidity)}
🔍 <b>Filter No Name:</b> ${botConfig.filterNoName ? 'Yes' : 'No'}
🔥 <b>Only Full Burn:</b> ${botConfig.alertOnlyFullBurn ? 'Yes' : 'No'}

📝 <b>Processed Tokens:</b> ${processedTokens.size}
💾 <b>Cached Tokens:</b> ${tokenCache.size}
⏱️ <b>Uptime:</b> ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m
`;

    await bot.sendMessage(chatId, status, { parse_mode: 'HTML' });
});

bot.onText(/\/config/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, '❌ Unauthorized');
    }

    const config = JSON.stringify(botConfig, null, 2);
    await bot.sendMessage(chatId, `<pre>${config}</pre>`, { parse_mode: 'HTML' });
});

bot.onText(/\/toggle/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, '❌ Unauthorized');
    }

    botConfig.enabled = !botConfig.enabled;
    await bot.sendMessage(chatId, `✅ Bot ${botConfig.enabled ? 'enabled' : 'disabled'}`);
    log('info', 'Bot toggled', { enabled: botConfig.enabled, by: userId });
});

bot.onText(/\/set_min_liq (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, '❌ Unauthorized');
    }

    const amount = parseFloat(match[1]);
    if (isNaN(amount) || amount < 0) {
        return bot.sendMessage(chatId, '❌ Invalid amount');
    }

    botConfig.minLiquidity = amount;
    await bot.sendMessage(chatId, `✅ Min liquidity set to $${formatNumber(amount)}`);
    log('info', 'Min liquidity updated', { amount, by: userId });
});

bot.onText(/\/set_max_liq (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, '❌ Unauthorized');
    }

    const amount = parseFloat(match[1]);
    if (isNaN(amount) || amount < 0) {
        return bot.sendMessage(chatId, '❌ Invalid amount');
    }

    botConfig.maxLiquidity = amount;
    await bot.sendMessage(chatId, `✅ Max liquidity set to $${formatNumber(amount)}`);
    log('info', 'Max liquidity updated', { amount, by: userId });
});

bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, '❌ Unauthorized');
    }

    const memUsage = process.memoryUsage();
    const stats = `
📈 <b>Bot Statistics</b>

🔢 <b>Processed Tokens:</b> ${processedTokens.size}
💾 <b>Cache Size:</b> ${tokenCache.size}
🧠 <b>Memory Usage:</b>
  • RSS: ${(memUsage.rss / 1024 / 1024).toFixed(2)} MB
  • Heap: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB
⏱️ <b>Uptime:</b> ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m

💳 <b>Estimated Credits/Day:</b> ~${((24 * 60 / 5) * 10).toFixed(0)}
`;

    await bot.sendMessage(chatId, stats, { parse_mode: 'HTML' });
});

// ========================= WEBHOOK HANDLER =========================
app.post('/webhook', async (req, res) => {
    try {
        // Webhook titkos kulcs ellenőrzése
        const signature = req.headers['x-webhook-signature'];
        if (signature !== WEBHOOK_SECRET) {
            log('warn', 'Invalid webhook signature');
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { type, data } = req.body;

        // LP burn esemény feldolgozása
        if (type === 'BURN' || type === 'TOKEN_BURN') {
            log('info', 'Webhook received', { type, data: data?.signature });

            // Token metadata lekérése
            const tokenAddress = data?.tokenAddress || data?.mint;
            if (tokenAddress) {
                const metadata = await getTokenMetadata(tokenAddress);
                
                if (metadata && !processedTokens.has(tokenAddress)) {
                    const burnStatus = await checkLPBurn(tokenAddress);
                    
                    if (burnStatus.burned && botConfig.enabled) {
                        await sendTokenAlert({
                            account: tokenAddress,
                            ...metadata,
                            burnStatus
                        });
                        processedTokens.add(tokenAddress);
                    }
                }
            }
        }

        res.json({ success: true });
    } catch (error) {
        log('error', 'Webhook error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        enabled: botConfig.enabled,
        processed: processedTokens.size
    });
});

// ========================= PERIODIC CHECK =========================
async function periodicCheck() {
    if (!botConfig.enabled) {
        log('info', 'Periodic check skipped - bot disabled');
        return;
    }

    try {
        log('info', 'Starting periodic check');
        const newTokens = await getNewTokens();

        if (newTokens.length > 0) {
            log('info', `Found ${newTokens.length} new LP burn tokens`);
            
            for (const token of newTokens) {
                await sendTokenAlert(token);
                // Kis késleltetés a Telegram rate limit miatt
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } else {
            log('info', 'No new LP burn tokens found');
        }

        // Cache tisztítás ha túl nagy
        if (processedTokens.size > 10000) {
            const toKeep = Array.from(processedTokens).slice(-5000);
            processedTokens.clear();
            toKeep.forEach(t => processedTokens.add(t));
            log('info', 'Cleaned processed tokens cache');
        }
    } catch (error) {
        log('error', 'Periodic check failed', { error: error.message });
    }
}

// ========================= INITIALIZATION =========================
async function initialize() {
    try {
        log('info', 'Starting Solana LP Burn Bot...');

        // Telegram bot info
        const botInfo = await bot.getMe();
        log('info', 'Bot connected', { 
            username: botInfo.username,
            id: botInfo.id 
        });

        // Express szerver indítása
        app.listen(PORT, () => {
            log('info', 'Webhook server started', { port: PORT });
        });

        // Periodikus ellenőrzés indítása
        setInterval(periodicCheck, botConfig.checkInterval);
        
        // Első futtatás
        setTimeout(periodicCheck, 10000);

        log('info', 'Bot initialization complete');
    } catch (error) {
        log('error', 'Failed to initialize bot', { error: error.message });
        process.exit(1);
    }
}

// ========================= ERROR HANDLERS =========================
bot.on('polling_error', (error) => {
    log('error', 'Telegram polling error', { error: error.message });
});

bot.on('webhook_error', (error) => {
    log('error', 'Telegram webhook error', { error: error.message });
});

process.on('unhandledRejection', (reason, promise) => {
    log('error', 'Unhandled rejection', { 
        reason: reason?.message || reason,
        promise: promise.toString()
    });
});

process.on('uncaughtException', (error) => {
    log('error', 'Uncaught exception', { error: error.message });
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    log('info', 'Shutting down gracefully...');
    await bot.stopPolling();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log('info', 'SIGTERM received, shutting down...');
    await bot.stopPolling();
    process.exit(0);
});

// ========================= START BOT =========================
initialize();
