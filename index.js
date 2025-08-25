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

// Admin IDs beállítása - debug logolással
const adminIdsEnv = process.env.ADMIN_IDS || '';
console.log('ADMIN_IDS environment variable:', adminIdsEnv);
const ADMIN_IDS = adminIdsEnv ? adminIdsEnv.split(',').map(id => id.trim()).filter(Boolean) : [];
console.log('Parsed ADMIN_IDS:', ADMIN_IDS);

// Solana kapcsolat
const SOLANA_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const connection = new Connection(SOLANA_RPC, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000
});

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
// Raydium AMM Program IDs
const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const ORCA_WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

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
        // Speciális tokenek kiszűrése
        const excludeTokens = [
            'So11111111111111111111111111111111111111112',
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
            'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
            'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'
        ];
        
        if (excludeTokens.includes(tokenAddress)) {
            return { burned: false, percentage: 0, reason: 'Major token excluded' };
        }

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
                            burnAddress: holder.owner,
                            source: 'Solscan'
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
        // Speciális esetek kezelése (SOL és USDC nagy tokenek)
        const specialTokens = [
            'So11111111111111111111111111111111111111112', // Wrapped SOL
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
            'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
            '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj' // stSOL
        ];

        // Ha ez egy nagy token, nem lehet LP burn
        if (specialTokens.includes(tokenAddress)) {
            return { burned: false, percentage: 0, reason: 'Major token' };
        }

        const mintPubkey = new PublicKey(tokenAddress);
        
        // Először próbáljuk meg a supply-t lekérni
        let totalSupply;
        try {
            const supply = await connection.getTokenSupply(mintPubkey);
            totalSupply = supply.value.uiAmount || 0;
        } catch (supplyError) {
            log('debug', 'Cannot get token supply', { tokenAddress });
            return { burned: false, percentage: 0 };
        }

        if (totalSupply === 0) {
            return { burned: false, percentage: 0 };
        }

        // Legnagyobb account lekérése - óvatosan
        try {
            const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
            
            if (!largestAccounts.value || largestAccounts.value.length === 0) {
                return { burned: false, percentage: 0 };
            }

            // Burn címek
            const burnAddresses = [
                '1111111111111111111111111111111111111111111',
                'burnSoLBurnSoLBurnSoLBurnSoLBurnSoLBurnSoL',
                'DeadSoLBurnSoLBurnSoLBurnSoLBurnSoLBurnSoL'
            ];

            let burnedAmount = 0;

            // Csak az első 3 legnagyobb accountot nézzük
            for (const account of largestAccounts.value.slice(0, 3)) {
                try {
                    const accountInfo = await connection.getAccountInfo(account.address);
                    if (accountInfo) {
                        const owner = accountInfo.owner.toBase58();
                        if (burnAddresses.some(burn => owner.includes(burn))) {
                            burnedAmount += account.uiAmount || 0;
                        }
                    }
                } catch (accountError) {
                    log('debug', 'Cannot check account', { address: account.address.toString() });
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
            log('debug', 'Cannot get largest accounts', { 
                tokenAddress,
                error: error.message 
            });
            return { burned: false, percentage: 0 };
        }
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
                // FONTOS: maxSupportedTransactionVersion: 0 hozzáadása
                const tx = await connection.getParsedTransaction(
                    sig.signature, 
                    {
                        commitment: 'confirmed',
                        maxSupportedTransactionVersion: 0
                    }
                );
                
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
            burnStatus,
            additionalInfo 
        } = tokenData;

        const name = onChainMetadata?.metadata?.data?.name || offChainMetadata?.name || 'Unknown';
        const symbol = onChainMetadata?.metadata?.data?.symbol || offChainMetadata?.symbol || 'N/A';

        // Üzenet összeállítása
        let message = `
🔥 <b>100% LP BURN DETECTED!</b> 🔥

📌 <b>Token:</b> ${name} (${symbol})
🏷️ <b>Contract:</b> <code>${account}</code>
🔥 <b>LP Burn:</b> ${burnStatus.percentage.toFixed(1)}%`;

        // Ha van további info
        if (additionalInfo) {
            if (additionalInfo.liquidity) {
                message += `\n💰 <b>Liquidity:</b> $${formatNumber(additionalInfo.liquidity)}`;
            }
            if (additionalInfo.fdv) {
                message += `\n📊 <b>FDV:</b> $${formatNumber(additionalInfo.fdv)}`;
            }
            if (additionalInfo.pairAge) {
                message += `\n⏰ <b>Age:</b> ${additionalInfo.pairAge.toFixed(1)} hours`;
            }
            if (additionalInfo.dexId) {
                message += `\n🏪 <b>DEX:</b> ${additionalInfo.dexId}`;
            }
        }

        if (burnStatus.totalBurned) {
            message += `\n🔥 <b>Burned Amount:</b> ${formatNumber(burnStatus.totalBurned)}`;
        }

        message += `

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
/debug - Debug information
/forcecheck - Force manual check
/clear - Clear cache
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

bot.onText(/\/setadmin (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Ez egy emergency admin beállítás - csak az első indításkor használható
    if (ADMIN_IDS.length === 0 && match[1] === String(userId)) {
        ADMIN_IDS.push(String(userId));
        await bot.sendMessage(chatId, `✅ Emergency admin set for user ID: ${userId}\n\n⚠️ Please set ADMIN_IDS environment variable on Render.com!`, { parse_mode: 'HTML' });
        log('warning', 'Emergency admin set', { userId });
    } else {
        await bot.sendMessage(chatId, '❌ Cannot set admin this way. Please configure ADMIN_IDS environment variable.');
    }
});

bot.onText(/\/envcheck/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const envInfo = `
🔍 <b>Environment Check</b>

<b>Your User ID:</b> <code>${userId}</code>

<b>Environment Variables Status:</b>
• BOT_TOKEN: ${BOT_TOKEN ? '✅ Set' : '❌ Missing'}
• HELIUS_API_KEY: ${HELIUS_API_KEY ? '✅ Set' : '❌ Missing'}
• CHANNEL_ID: ${CHANNEL_ID ? '✅ Set' : '❌ Missing'}
• ADMIN_IDS raw: "${process.env.ADMIN_IDS || 'NOT SET'}"
• ADMIN_IDS parsed: [${ADMIN_IDS.join(', ')}]
• PORT: ${PORT}

<b>Admin Check:</b>
• Your ID in admin list: ${ADMIN_IDS.includes(String(userId)) ? '✅ Yes' : '❌ No'}
• Admin list length: ${ADMIN_IDS.length}

${ADMIN_IDS.length === 0 ? '\n⚠️ <b>No admins configured!</b>\nUse /setadmin ' + userId + ' to set yourself as emergency admin' : ''}
`;

    await bot.sendMessage(chatId, envInfo, { parse_mode: 'HTML' });
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

bot.onText(/\/debug/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, `❌ Unauthorized. Your ID: ${userId}`);
    }

    const debugInfo = `
🔍 <b>Debug Information</b>

<b>Connection:</b>
• RPC: ${SOLANA_RPC.substring(0, 50)}...
• Status: ${connection ? '✅ Connected' : '❌ Disconnected'}

<b>Last Checks:</b>
• Processed Tokens: ${processedTokens.size}
• Cached Tokens: ${tokenCache.size}
• Last Request: ${new Date(lastRequestTime).toISOString()}

<b>Running manual check...</b>
`;

    await bot.sendMessage(chatId, debugInfo, { parse_mode: 'HTML' });

    // Manual check futtatása
    try {
        // DexScreener check
        const dexTokens = await getLatestMemeTokens();
        await bot.sendMessage(chatId, `Found ${dexTokens.length} tokens from DexScreener`, { parse_mode: 'HTML' });
        
        // Első token részletes ellenőrzése
        if (dexTokens.length > 0) {
            const firstToken = dexTokens[0];
            await bot.sendMessage(chatId, `
<b>First token:</b>
• Name: ${firstToken.name}
• Symbol: ${firstToken.symbol}
• Address: <code>${firstToken.address}</code>
• Liquidity: $${formatNumber(firstToken.liquidity)}
• Age: ${firstToken.pairAge.toFixed(1)}h

Checking LP burn status...`, { parse_mode: 'HTML' });
            
            const burnStatus = await checkRugCheckAPI(firstToken.address);
            await bot.sendMessage(chatId, `LP Burn: ${burnStatus.burned ? '✅ YES' : '❌ NO'} (${burnStatus.percentage}%)`, { parse_mode: 'HTML' });
        }
        
        // DEX pools check
        const testPools = await getNewPoolsFromDEX();
        await bot.sendMessage(chatId, `Found ${testPools.length} DEX pools`, { parse_mode: 'HTML' });
        
    } catch (error) {
        await bot.sendMessage(chatId, `❌ Debug error: ${error.message}`, { parse_mode: 'HTML' });
    }
});

bot.onText(/\/forcecheck/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, `❌ Unauthorized. Your ID: ${userId}`);
    }

    await bot.sendMessage(chatId, '🔄 Running forced check...', { parse_mode: 'HTML' });
    
    try {
        await periodicCheck();
        await bot.sendMessage(chatId, '✅ Forced check completed', { parse_mode: 'HTML' });
    } catch (error) {
        await bot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'HTML' });
    }
});

bot.onText(/\/clear/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, `❌ Unauthorized. Your ID: ${userId}`);
    }

    processedTokens.clear();
    tokenCache.clear();
    
    await bot.sendMessage(chatId, '✅ Cache cleared successfully', { parse_mode: 'HTML' });
    log('info', 'Cache manually cleared', { by: userId });
});

bot.onText(/\/testscan/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        return bot.sendMessage(chatId, `❌ Unauthorized. Your ID: ${userId}`);
    }

    await bot.sendMessage(chatId, '🔄 Running test scan for LP burns...', { parse_mode: 'HTML' });
    
    try {
        // Ismert LP burn token példa tesztelésre
        const testTokens = [
            'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // Bonk
            '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', // POPCAT
        ];
        
        for (const token of testTokens) {
            const burnStatus = await checkLPBurnViaExplorer(token);
            await bot.sendMessage(chatId, `
Token: <code>${token}</code>
Burn Status: ${burnStatus.burned ? '✅' : '❌'}
Percentage: ${burnStatus.percentage}%
Source: ${burnStatus.source || 'Chain'}`, { parse_mode: 'HTML' });
        }
        
        // Valódi scan
        await periodicCheck();
        await bot.sendMessage(chatId, '✅ Test scan completed', { parse_mode: 'HTML' });
    } catch (error) {
        await bot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'HTML' });
    }
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

async function getLatestMemeTokens() {
    try {
        log('info', 'Fetching latest meme tokens from DexScreener');
        
        // DexScreener API - ingyenes, nem kell kulcs
        const response = await axios.get(
            'https://api.dexscreener.com/latest/dex/tokens/solana',
            {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'application/json'
                }
            }
        );

        if (!response.data || !response.data.pairs) {
            log('warn', 'No data from DexScreener');
            return [];
        }

        const pairs = response.data.pairs;
        const newTokens = [];
        
        // Csak az új, kis market cap tokeneket nézzük
        for (const pair of pairs) {
            if (pair.chainId !== 'solana') continue;
            
            const tokenAddress = pair.baseToken?.address;
            const tokenName = pair.baseToken?.name;
            const tokenSymbol = pair.baseToken?.symbol;
            const liquidity = pair.liquidity?.usd || 0;
            const fdv = pair.fdv || 0;
            const pairAge = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3600000 : 999; // órákban
            
            // Szűrési feltételek
            if (tokenAddress && 
                tokenName && 
                tokenSymbol &&
                !processedTokens.has(tokenAddress) &&
                pairAge < 24 && // 24 óránál fiatalabb
                liquidity < 100000 && // 100k USD alatt
                fdv < 1000000) { // 1M FDV alatt
                
                newTokens.push({
                    address: tokenAddress,
                    name: tokenName,
                    symbol: tokenSymbol,
                    liquidity: liquidity,
                    fdv: fdv,
                    pairAge: pairAge,
                    dexId: pair.dexId,
                    pairAddress: pair.pairAddress
                });
                
                if (newTokens.length >= 10) break;
            }
        }
        
        log('info', `Found ${newTokens.length} new meme tokens from DexScreener`);
        return newTokens;
    } catch (error) {
        log('error', 'Failed to get tokens from DexScreener', { error: error.message });
        return [];
    }
}

async function checkRugCheckAPI(tokenAddress) {
    try {
        // RugCheck API - ingyenes
        const response = await axios.get(
            `https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report`,
            {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'application/json'
                }
            }
        );

        if (response.data) {
            const report = response.data;
            
            // Ellenőrizzük az LP burn státuszt
            if (report.risks) {
                for (const risk of report.risks) {
                    if (risk.name === 'LP_BURNED' && risk.value === 100) {
                        return {
                            burned: true,
                            percentage: 100,
                            source: 'RugCheck'
                        };
                    }
                }
            }
            
            // Vagy ha van LP lock info
            if (report.lpLocked && report.lpLockedPct >= 99) {
                return {
                    burned: false,
                    percentage: 0,
                    locked: true,
                    lockedPercentage: report.lpLockedPct
                };
            }
        }
        
        return { burned: false, percentage: 0 };
    } catch (error) {
        log('debug', 'RugCheck API not available', { tokenAddress });
        return { burned: false, percentage: 0 };
    }
}

async function getNewPoolsFromDEX() {
    try {
        const newPools = [];
        
        // Raydium pool-ok ellenőrzése
        const raydiumSigs = await connection.getSignaturesForAddress(
            new PublicKey(RAYDIUM_AMM_V4),
            { limit: 20 },
            'confirmed'
        );

        for (const sig of raydiumSigs.slice(0, 5)) {
            try {
                const tx = await connection.getParsedTransaction(
                    sig.signature,
                    {
                        commitment: 'confirmed',
                        maxSupportedTransactionVersion: 0
                    }
                );

                if (!tx || !tx.meta) continue;

                // Pool létrehozás keresése
                for (const log of (tx.meta.logMessages || [])) {
                    if (log.includes('initialize2') || log.includes('InitializeInstruction')) {
                        // Token címek kinyerése a tranzakcióból
                        const accounts = tx.transaction.message.accountKeys;
                        for (const account of accounts) {
                            const pubkey = account.pubkey?.toString() || account.toString();
                            if (!processedTokens.has(pubkey) && pubkey.length === 44) {
                                newPools.push(pubkey);
                                break;
                            }
                        }
                    }
                }
            } catch (error) {
                log('debug', 'Failed to process DEX signature', {
                    signature: sig.signature,
                    error: error.message
                });
            }
        }

        return newPools;
    } catch (error) {
        log('error', 'Failed to get new pools from DEX', { error: error.message });
        return [];
    }
}

async function getNewTokensFromJupiter() {
    try {
        // Jupiter token lista lekérése (ingyenes, nem kell API kulcs)
        const response = await axios.get(
            'https://token.jup.ag/all',
            {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0'
                }
            }
        );

        if (!response.data || !Array.isArray(response.data)) {
            return [];
        }

        const tokens = response.data;
        const newTokensToCheck = [];

        // Szűrjük ki a nagy/ismert tokeneket
        const excludeTokens = [
            'So11111111111111111111111111111111111111112', // Wrapped SOL
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
            'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
            '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj' // stSOL
        ];

        // Csak az új és kis tokeneket nézzük
        for (const token of tokens) {
            if (!processedTokens.has(token.address) && 
                !excludeTokens.includes(token.address) &&
                token.name && 
                token.symbol &&
                token.tags && 
                token.tags.includes('community')) { // Csak community tokenek
                
                newTokensToCheck.push({
                    address: token.address,
                    name: token.name,
                    symbol: token.symbol,
                    decimals: token.decimals
                });
                
                // Maximum 20 tokent vizsgálunk
                if (newTokensToCheck.length >= 20) break;
            }
        }

        log('info', `Found ${newTokensToCheck.length} new community tokens from Jupiter to check`);

        const burnedTokens = [];
        
        // LP burn ellenőrzés
        for (const token of newTokensToCheck.slice(0, 5)) { // Maximum 5 token részletes ellenőrzése
            const burnStatus = await checkLPBurnViaExplorer(token.address);
            
            if (burnStatus.burned) {
                burnedTokens.push({
                    account: token.address,
                    onChainMetadata: {
                        metadata: {
                            data: {
                                name: token.name,
                                symbol: token.symbol,
                                decimals: token.decimals
                            }
                        }
                    },
                    burnStatus
                });
                processedTokens.add(token.address);
            }
            
            // Kis késleltetés a rate limit miatt
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        return burnedTokens;
    } catch (error) {
        log('error', 'Failed to get tokens from Jupiter', { error: error.message });
        return [];
    }
}

// ========================= PERIODIC CHECK =========================
async function periodicCheck() {
    if (!botConfig.enabled) {
        log('info', 'Periodic check skipped - bot disabled');
        return;
    }

    try {
        log('info', 'Starting periodic check');
        
        // DexScreener-ről új tokenek lekérése (legmegbízhatóbb)
        const dexScreenerTokens = await getLatestMemeTokens();
        
        if (dexScreenerTokens.length > 0) {
            log('info', `Checking ${dexScreenerTokens.length} tokens for LP burn`);
            
            for (const token of dexScreenerTokens) {
                // Először RugCheck API
                let burnStatus = await checkRugCheckAPI(token.address);
                
                // Ha nem találtunk infót, próbáljuk a többi módszert
                if (!burnStatus.burned) {
                    burnStatus = await checkLPBurnViaExplorer(token.address);
                }
                
                if (burnStatus.burned) {
                    log('info', `LP BURN FOUND: ${token.name} (${token.symbol})`);
                    
                    // Token alert küldése
                    await sendTokenAlert({
                        account: token.address,
                        onChainMetadata: {
                            metadata: {
                                data: {
                                    name: token.name,
                                    symbol: token.symbol,
                                    decimals: 9
                                }
                            }
                        },
                        burnStatus,
                        additionalInfo: {
                            liquidity: token.liquidity,
                            fdv: token.fdv,
                            pairAge: token.pairAge,
                            dexId: token.dexId
                        }
                    });
                    
                    processedTokens.add(token.address);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
        
        // Alternatív források (backup)
        const [chainTokens, jupiterTokens] = await Promise.all([
            getNewTokensAlternative(),
            getNewTokensFromJupiter()
        ]);
        
        // Chain tokenek feldolgozása
        if (chainTokens.length > 0) {
            log('info', `Found ${chainTokens.length} LP burn tokens from chain`);
            for (const token of chainTokens) {
                await sendTokenAlert(token);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        // Jupiter tokenek feldolgozása
        if (jupiterTokens.length > 0) {
            log('info', `Found ${jupiterTokens.length} LP burn tokens from Jupiter`);
            for (const token of jupiterTokens) {
                await sendTokenAlert(token);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        if (dexScreenerTokens.length === 0 && chainTokens.length === 0 && jupiterTokens.length === 0) {
            log('info', 'No new LP burn tokens found in this check');
        }

        // Cache tisztítás
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
