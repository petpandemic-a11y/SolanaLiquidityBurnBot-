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
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);

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
    maxRequestsPerMinute: 10, // Rate limiting
};

// Cache a már feldolgozott tokenekhez
const processedTokens = new Set();
const tokenCache = new Map(); // Token adatok cache
const requestQueue = [];
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 6000; // 6 másodperc között kérések (10 req/min)

// Rate limiter
const rateLimitedRequest = async (requestFn) => {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
    }
    
    lastRequestTime = Date.now();
    return await requestFn();
};

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
    const userIdStr = String(userId);
    const isAdminUser = ADMIN_IDS.includes(userIdStr);
    log('debug', 'Admin check', { 
        userId: userIdStr, 
        adminIds: ADMIN_IDS, 
        isAdmin: isAdminUser 
    });
    return isAdminUser;
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

        const response = await rateLimitedRequest(async () => {
            return await axios.post(
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
                    },
                    timeout: 30000
                }
            );
        });

        if (response.data && response.data.length > 0) {
            const metadata = response.data[0];
            tokenCache.set(mintAddress, metadata);
            
            // Cache tisztítás 1 óra után
            setTimeout(() => tokenCache.delete(mintAddress), 3600000);
            
            return metadata;
        }
        return null;
    } catch (error) {
        if (error.response?.status === 429) {
            log('warn', 'Rate limited on token metadata', { mintAddress });
            // Várunk egy kicsit és újrapróbáljuk
            await new Promise(resolve => setTimeout(resolve, 30000));
            return null;
        }
        log('error', 'Failed to get token metadata', { 
            mintAddress, 
            error: error.message,
            status: error.response?.status
        });
        return null;
    }
}

async function getRecentTransactions() {
    try {
        const response = await rateLimitedRequest(async () => {
            return await axios.post(
                `https://api.helius.xyz/v0/transactions`,
                {
                    query: {
                        type: ["SWAP", "BURN", "TOKEN_MINT"],
                        source: ["RAYDIUM", "ORCA", "JUPITER"]
                    },
                    options: {
                        limit: 20,
                        showRaw: false
                    }
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    params: {
                        'api-key': HELIUS_API_KEY
                    },
                    timeout: 30000
                }
            );
        });

        return response.data || [];
    } catch (error) {
        if (error.response?.status === 429) {
            log('warn', 'Rate limited on transactions');
            return [];
        }
        log('error', 'Failed to get recent transactions', { 
            error: error.message,
            status: error.response?.status
        });
        return [];
    }
}

async function checkLPBurnViaExplorer(tokenAddress) {
    try {
        // Solscan API használata (ingyenes, nem igényel API kulcsot)
        const response = await axios.get(
            `https://api.solscan.io/token/holders`,
            {
                params: {
                    token: tokenAddress,
                    offset: 0,
                    limit: 10
                },
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0'
                }
            }
        );

        if (response.data?.data) {
            // Ellenőrizzük, hogy van-e burn cím a holderek között
            const holders = response.data.data;
            const burnAddresses = [
                '1111111111111111111111111111111111111111111',
                'burnSoLBurnSoLBurnSoLBurnSoLBurnSoLBurnSoL',
                'DeadSoLBurnSoLBurnSoLBurnSoLBurnSoLBurnSoL'
            ];

            for (const holder of holders) {
                if (burnAddresses.includes(holder.owner)) {
                    const percentage = parseFloat(holder.percentage || 0);
                    if (percentage >= 99) {
                        return {
                            burned: true,
                            percentage: percentage,
                            burnAddress: holder.owner
                        };
                    }
                }
            }
        }

        return { burned: false, percentage: 0 };
    } catch (error) {
        // Ha a Solscan nem működik, próbáljuk a chain-en keresztül
        return await checkLPBurnOnChain(tokenAddress);
    }
}

async function checkLPBurnOnChain(tokenAddress) {
    try {
        const mintPubkey = new PublicKey(tokenAddress);
        const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
        
        if (!largestAccounts.value || largestAccounts.value.length === 0) {
            return { burned: false, percentage: 0 };
        }

        const supply = await connection.getTokenSupply(mintPubkey);
        const totalSupply = supply.value.uiAmount || 0;

        if (totalSupply === 0) {
            return { burned: false, percentage: 0 };
        }

        // Burn címek
        const burnAddresses = [
            '1111111111111111111111111111111111111111111',
            'burnSoLBurnSoLBurnSoLBurnSoLBurnSoLBurnSoL',
            'DeadSoLBurnSoLBurnSoLBurnSoLBurnSoLBurnSoL'
        ];

        let burnedAmount = 0;

        for (const account of largestAccounts.value) {
            const accountInfo = await connection.getAccountInfo(account.address);
            if (accountInfo) {
                const owner = accountInfo.owner.toBase58();
                if (burnAddresses.some(burn => owner.includes(burn))) {
                    burnedAmount += account.uiAmount || 0;
                }
            }
        }

        const burnPercentage = (burnedAmount / totalSupply) * 100;

        return {
            burned: burnPercentage >= 99.9,
            percentage: burnPercentage,
            totalBurned: burnedAmount,
            totalSupply: totalSupply
        };
    } catch (error) {
        log('error', 'Failed to check LP burn on chain', { 
            tokenAddress, 
            error: error.message 
        });
        return { burned: false, percentage: 0 };
    }
}

async function getNewTokensAlternative() {
    try {
        // Alternatív megközelítés: Solana chain-ről közvetlenül
        const slot = await connection.getSlot();
        const blockTime = await connection.getBlockTime(slot);
        const currentTime = blockTime ? blockTime * 1000 : Date.now();
        const fiveMinutesAgo = currentTime - botConfig.checkInterval;

        // Recent programok lekérése
        const signatures = await connection.getSignaturesForAddress(
            new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // Token Program
            { limit: 50 },
            'confirmed'
        );

        const newTokens = [];

        for (const sig of signatures.slice(0, 10)) { // Csak az első 10-et nézzük
            try {
                const tx = await connection.getParsedTransaction(sig.signature, 'confirmed');
                
                if (!tx || !tx.meta || tx.meta.err) continue;
                
                // Token mint keresése
                for (const instruction of tx.transaction.message.instructions) {
                    if ('parsed' in instruction && 
                        instruction.parsed?.type === 'initializeMint') {
                        
                        const mintAddress = instruction.parsed.info?.mint;
                        
                        if (mintAddress && !processedTokens.has(mintAddress)) {
                            // Metadata lekérése
                            const metadata = await getTokenMetadata(mintAddress);
                            
                            if (metadata && metadata.onChainMetadata?.metadata?.data?.name) {
                                // LP burn ellenőrzés
                                const burnStatus = await checkLPBurnViaExplorer(mintAddress);
                                
                                if (burnStatus.burned) {
                                    newTokens.push({
                                        account: mintAddress,
                                        ...metadata,
                                        burnStatus
                                    });
                                    processedTokens.add(mintAddress);
                                }
                            }
                        }
                    }
                }
            } catch (error) {
                log('warn', 'Failed to process signature', { 
                    signature: sig.signature,
                    error: error.message 
                });
            }
        }

        return newTokens;
    } catch (error) {
        log('error', 'Failed to get new tokens alternative', { error: error.message });
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

        // Üzenet összeállítása
        const message = `
🔥 <b>100% LP BURN DETECTED!</b> 🔥

📌 <b>Token:</b> ${name} (${symbol})
🏷️ <b>Contract:</b> <code>${account}</code>
🔥 <b>LP Burn:</b> ${burnStatus.percentage.toFixed(1)}%
💰 <b>Burned Amount:</b> ${burnStatus.totalBurned ? formatNumber(burnStatus.totalBurned) : 'N/A'}

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

Your User ID: <code>${userId}</code>

${isAdmin(userId) ? `
✅ <b>You have admin access!</b>

<b>Admin Commands:</b>
/status - Bot status
/config - View configuration
/set_min_liq [amount] - Set minimum liquidity
/set_max_liq [amount] - Set maximum liquidity
/toggle - Enable/disable bot
/stats - View statistics
/test - Send test message
` : '❌ <b>You do not have admin access</b>'}

<b>Public Commands:</b>
/help - Show this message
/about - About this bot
/myid - Show your user ID

Channel: @${process.env.TELEGRAM_CHANNEL_USERNAME || 'your_channel'}
`;

    await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML' });
});

bot.onText(/\/myid/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    await bot.sendMessage(chatId, `Your User ID: <code>${userId}</code>`, { parse_mode: 'HTML' });
});

bot.onText(/\/test/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, `❌ Unauthorized. Your ID: ${userId}`);
    }

    const testToken = {
        account: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
        onChainMetadata: {
            metadata: {
                data: {
                    name: 'Test Token',
                    symbol: 'TEST'
                }
            }
        },
        burnStatus: {
            burned: true,
            percentage: 100,
            totalBurned: 1000000
        }
    };

    await sendTokenAlert(testToken);
    await bot.sendMessage(chatId, '✅ Test message sent to channel');
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, `❌ Unauthorized. Your ID: ${userId}`);
    }

    const status = `
📊 <b>Bot Status</b>

✅ <b>Bot:</b> ${botConfig.enabled ? 'Enabled' : 'Disabled'}
⏰ <b>Check Interval:</b> ${botConfig.checkInterval / 60000} minutes
💰 <b>Min Liquidity:</b> $${formatNumber(botConfig.minLiquidity)}
💰 <b>Max Liquidity:</b> $${formatNumber(botConfig.maxLiquidity)}
🔍 <b>Filter No Name:</b> ${botConfig.filterNoName ? 'Yes' : 'No'}
🔥 <b>Only Full Burn:</b> ${botConfig.alertOnlyFullBurn ? 'Yes' : 'No'}
⚡ <b>Rate Limit:</b> ${botConfig.maxRequestsPerMinute} req/min

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
        return bot.sendMessage(chatId, `❌ Unauthorized. Your ID: ${userId}`);
    }

    const config = JSON.stringify(botConfig, null, 2);
    await bot.sendMessage(chatId, `<pre>${config}</pre>`, { parse_mode: 'HTML' });
});

bot.onText(/\/toggle/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, `❌ Unauthorized. Your ID: ${userId}`);
    }

    botConfig.enabled = !botConfig.enabled;
    await bot.sendMessage(chatId, `✅ Bot ${botConfig.enabled ? 'enabled' : 'disabled'}`);
    log('info', 'Bot toggled', { enabled: botConfig.enabled, by: userId });
});

bot.onText(/\/set_min_liq (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, `❌ Unauthorized. Your ID: ${userId}`);
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
        return bot.sendMessage(chatId, `❌ Unauthorized. Your ID: ${userId}`);
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
        return bot.sendMessage(chatId, `❌ Unauthorized. Your ID: ${userId}`);
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

💳 <b>Estimated Credits/Day:</b> ~${((24 * 60 / 5) * 2).toFixed(0)}
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
                    const burnStatus = await checkLPBurnViaExplorer(tokenAddress);
                    
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
        
        // Alternatív módszer használata a rate limit elkerülésére
        const newTokens = await getNewTokensAlternative();

        if (newTokens.length > 0) {
            log('info', `Found ${newTokens.length} new LP burn tokens`);
            
            for (const token of newTokens) {
                await sendTokenAlert(token);
                // Kis késleltetés a Telegram rate limit miatt
                await new Promise(resolve => setTimeout(resolve, 2000));
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
        log('info', 'Admin IDs configured', { adminIds: ADMIN_IDS });

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
        
        // Első futtatás 30 másodperc múlva
        setTimeout(periodicCheck, 30000);

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
        reason: reason?.message || reason 
    });
});

process.on('uncaughtException', (error) => {
    log('error', 'Uncaught exception', { error: error.message });
    // Ne állítsuk le a botot minden hiba miatt
    // process.exit(1);
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
