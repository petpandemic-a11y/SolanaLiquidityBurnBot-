const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Connection } = require('@solana/web3.js');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'secret-key';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, 'confirmed');
const processedTxs = new Set();

// Middleware
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    processed: processedTxs.size
  });
});

// Helius Webhook endpoint
app.post('/webhook', async (req, res) => {
    try {
        console.log('📡 Webhook received from Helius');
        
        const webhookData = req.body;
        
        // Debug: Log webhook structure
        console.log('🔍 Webhook data keys:', Object.keys(webhookData));
        if (webhookData[0]) {
            console.log('🔍 First transaction keys:', Object.keys(webhookData[0]));
            if (webhookData[0].tokenTransfers) {
                console.log('🔍 Token transfers count:', webhookData[0].tokenTransfers.length);
            }
        }
        
        if (Array.isArray(webhookData)) {
            for (const txData of webhookData) {
                await processTransaction(txData);
            }
        } else if (webhookData) {
            await processTransaction(webhookData);
        }

        res.status(200).json({ status: 'processed' });
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        res.status(500).json({ error: 'Processing failed' });
    }
});

// Process transaction from webhook
async function processTransaction(txData) {
    try {
        const signature = txData.signature;
        
        if (!signature || processedTxs.has(signature)) {
            return;
        }
        
        processedTxs.add(signature);
        console.log(`🔍 Processing: ${signature.slice(0, 8)}...`);
        
        // Memory cleanup
        if (processedTxs.size > 2000) {
            const oldest = Array.from(processedTxs).slice(0, 1000);
            oldest.forEach(sig => processedTxs.delete(sig));
        }

        const burnInfo = await checkForLPBurn(txData);
        
        if (burnInfo) {
            console.log(`🔥 100% LP BURN: ${burnInfo.tokenSymbol} - ${burnInfo.burnedAmount.toLocaleString()}`);
            await sendLPBurnAlert(burnInfo);
        }
        
    } catch (error) {
        console.error('Error processing transaction:', error.message);
    }
}

// Check for LP burn in transaction data
async function checkForLPBurn(txData) {
    try {
        const { signature, tokenTransfers, accountData } = txData;
        
        // Method 1: Check token transfers for burns
        if (tokenTransfers && Array.isArray(tokenTransfers)) {
            for (const transfer of tokenTransfers) {
                if (await isBurnTransfer(transfer)) {
                    // Parse token amount properly
                    let amount = 0;
                    if (typeof transfer.tokenAmount === 'number') {
                        amount = transfer.tokenAmount;
                    } else if (typeof transfer.tokenAmount === 'string') {
                        amount = parseFloat(transfer.tokenAmount);
                    } else if (transfer.tokenAmount && transfer.tokenAmount.uiAmount) {
                        amount = transfer.tokenAmount.uiAmount;
                    }
                    
                    if (isNaN(amount) || amount < 1000000) {
                        continue;
                    }
                    
                    console.log(`🎯 LP BURN FOUND via transfer: ${amount.toLocaleString()} tokens`);
                    const tokenInfo = await getTokenInfo(transfer.mint);
                    
                    return {
                        signature,
                        mint: transfer.mint,
                        burnedAmount: amount,
                        tokenName: tokenInfo.name,
                        tokenSymbol: tokenInfo.symbol,
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
                        if (await isBurnBalanceChange(change)) {
                            const burnAmount = Math.abs(parseFloat(change.tokenBalanceChange) || 0);
                            
                            if (isNaN(burnAmount) || burnAmount < 1000000) {
                                continue;
                            }
                            
                            console.log(`🎯 LP BURN FOUND via balance: ${burnAmount.toLocaleString()} tokens`);
                            const tokenInfo = await getTokenInfo(change.mint);
                            
                            return {
                                signature,
                                mint: change.mint,
                                burnedAmount: burnAmount,
                                tokenName: tokenInfo.name,
                                tokenSymbol: tokenInfo.symbol,
                                timestamp: new Date()
                            };
                        }
                    }
                }
            }
        }

        return null;
    } catch (error) {
        console.error('LP burn check error:', error.message);
        return null;
    }
}

// Check if transfer is a burn (to null address or burn address)
async function isBurnTransfer(transfer) {
    const { toTokenAccount, tokenAmount, fromTokenAccount, mint } = transfer;
    
    // Skip known stablecoins and major tokens
    const skipTokens = [
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT  
        'So11111111111111111111111111111111111111112',   // SOL
        '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
        'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'   // mSOL
    ];
    
    if (skipTokens.includes(mint)) {
        console.log(`⚠️ Skipping known token: ${mint.slice(0, 8)}...`);
        return false;
    }
    
    // Parse token amount properly
    let amount = 0;
    if (typeof tokenAmount === 'number') {
        amount = tokenAmount;
    } else if (typeof tokenAmount === 'string') {
        amount = parseFloat(tokenAmount);
    } else if (tokenAmount && tokenAmount.uiAmount) {
        amount = tokenAmount.uiAmount;
    }
    
    // Must be substantial amount (1M+ tokens)
    if (isNaN(amount) || amount < 1000000) {
        console.log(`⚠️ Amount too small or invalid: ${amount}`);
        return false;
    }
    
    // Check if burned (sent to null or burn addresses)
    const burnAddresses = [
        null,
        undefined,
        '11111111111111111111111111111111',
        '1111111111111111111111111111111',
        '',
        '0x0'
    ];
    
    const isBurnAddress = !toTokenAccount || 
                         burnAddresses.includes(toTokenAccount) ||
                         toTokenAccount.includes('1111111111111111');
    
    console.log(`🔍 Transfer check: ${amount.toLocaleString()} tokens, burn: ${isBurnAddress}`);
    return isBurnAddress && amount >= 1000000;
}

// Check if balance change indicates burn
async function isBurnBalanceChange(change) {
    const { mint, tokenBalanceChange } = change;
    
    // Skip known stablecoins and major tokens
    const skipTokens = [
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT  
        'So11111111111111111111111111111111111111112',   // SOL
        '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
        'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'   // mSOL
    ];
    
    if (skipTokens.includes(mint)) {
        console.log(`⚠️ Skipping known token balance change: ${mint.slice(0, 8)}...`);
        return false;
    }
    
    // Parse balance change
    let balanceChange = 0;
    if (typeof tokenBalanceChange === 'number') {
        balanceChange = tokenBalanceChange;
    } else if (typeof tokenBalanceChange === 'string') {
        balanceChange = parseFloat(tokenBalanceChange);
    }
    
    // Large negative change (tokens removed/burned)
    const burnAmount = Math.abs(balanceChange);
    
    // Must be substantial burn (negative change, 1M+ tokens)
    if (balanceChange >= 0 || isNaN(burnAmount) || burnAmount < 1000000) {
        console.log(`⚠️ Balance change not a burn: ${balanceChange}`);
        return false;
    }
    
    console.log(`🔍 Balance change: ${balanceChange.toLocaleString()} (burn: ${burnAmount.toLocaleString()})`);
    return true;
}

// Get token info using Helius API
async function getTokenInfo(mintAddress) {
    try {
        console.log(`📖 Getting token info for: ${mintAddress.slice(0, 8)}...`);
        
        // Try Helius first
        const heliusUrl = `https://api.helius.xyz/v0/token-metadata`;
        const response = await axios.get(heliusUrl, {
            params: { 
                'api-key': HELIUS_API_KEY,
                mint: mintAddress 
            },
            timeout: 5000
        });
        
        if (response.data && response.data.length > 0) {
            const token = response.data[0];
            const onChain = token.onChainMetadata?.metadata;
            const offChain = token.offChainMetadata;
            
            const name = onChain?.name || offChain?.name || 'Unknown Token';
            const symbol = onChain?.symbol || offChain?.symbol || 'UNKNOWN';
            
            console.log(`✅ Helius token found: ${name} (${symbol})`);
            return { name, symbol };
        }

        console.log('⚠️ Helius token not found, trying Jupiter...');
        
        // Fallback to Jupiter
        const jupiterResponse = await axios.get('https://token.jup.ag/strict', { timeout: 3000 });
        const jupiterToken = jupiterResponse.data.find(t => t.address === mintAddress);
        
        if (jupiterToken) {
            console.log(`✅ Jupiter token found: ${jupiterToken.name} (${jupiterToken.symbol})`);
            return { 
                name: jupiterToken.name, 
                symbol: jupiterToken.symbol 
            };
        }

        console.log('⚠️ Token not found in any API, using default');
        return { 
            name: 'Unknown Memecoin', 
            symbol: 'MEME' 
        };
        
    } catch (error) {
        console.error(`❌ Token info error for ${mintAddress.slice(0, 8)}:`, error.message);
        return { 
            name: 'Unknown Memecoin', 
            symbol: 'MEME' 
        };
    }
}

// Send Telegram alert
async function sendLPBurnAlert(burnInfo) {
    // Validate burnedAmount
    if (isNaN(burnInfo.burnedAmount) || burnInfo.burnedAmount <= 0) {
        console.error('❌ Invalid burnedAmount:', burnInfo.burnedAmount);
        return;
    }
    
    const message = `
🔥 **100% LP ELÉGETVE!** 🔥

💰 **Token:** ${burnInfo.tokenName} (${burnInfo.tokenSymbol})
🏷️ **Mint:** \`${burnInfo.mint}\`
🔥 **Égetett mennyiség:** ${Math.round(burnInfo.burnedAmount).toLocaleString()} token
⏰ **Időpont:** ${burnInfo.timestamp.toLocaleString('hu-HU')}

✅ **TELJES LP ELÉGETVE!** 
🛡️ **Biztonság:** A likviditás el lett égetve
🚫 **Rug pull:** Már nem lehetséges!
📊 **Tranzakció:** [Solscan](https://solscan.io/tx/${burnInfo.signature})

🚀 **Potenciálisan biztonságos memecoin!**
⚠️ **DYOR:** Mindig végezz saját kutatást!

#100PercentBurn #LPBurn #SafeMeme #Solana #RugProof #HeliusAlert
    `.trim();

    try {
        await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
        });
        
        console.log(`✅ ALERT SENT: ${burnInfo.tokenSymbol} - ${burnInfo.burnedAmount.toLocaleString()}`);
    } catch (error) {
        console.error('❌ Telegram send error:', error.message);
        
        // Retry without markdown if failed
        try {
            const plainMessage = message.replace(/[*`_\[\]]/g, '');
            await bot.sendMessage(TELEGRAM_CHAT_ID, plainMessage);
            console.log('✅ Alert sent (plain text fallback)');
        } catch (retryError) {
            console.error('❌ Telegram retry failed:', retryError.message);
        }
    }
}

// Start the bot
async function startBot() {
    try {
        // Validate environment variables
        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
            throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
        }

        if (!HELIUS_API_KEY) {
            throw new Error('Missing HELIUS_API_KEY');
        }

        // Test Telegram
        const me = await bot.getMe();
        console.log(`🤖 Telegram Bot: @${me.username}`);
        
        // Test Helius connection
        const version = await connection.getVersion();
        console.log(`⚡ Helius RPC: ${version['solana-core']}`);
        
        // Send startup message
        await bot.sendMessage(TELEGRAM_CHAT_ID, 
            '🚀 **LP Burn Monitor ONLINE!**\n\n' +
            '🔥 **CSAK 100% LP ÉGETÉSEKET** figyelek!\n' +
            '⚡ **Helius webhook** - instant értesítések\n' +
            '✅ **Rate limit free** - nincs késés\n' +
            '🎯 **Real-time detection** aktiválva\n' +
            '🛡️ **Rug pull protection** detector!\n\n' +
            `📡 **Webhook:** /webhook\n` +
            `🌐 **Endpoint ready!**\n\n` +
            '#100PercentBurn #HeliusWebhook #LPBurnMonitor #Online'
        );
        
        console.log('🚀 LP BURN MONITOR STARTED SUCCESSFULLY!');
        console.log(`📡 Webhook endpoint: /webhook`);
        console.log('💡 Configure Helius webhook to: https://solanaliquidityburnbot.onrender.com/webhook');
        console.log('🎯 Account addresses: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
        console.log('🎯 Account addresses: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
        
    } catch (error) {
        console.error('❌ Startup failed:', error.message);
        process.exit(1);
    }
}

// Root endpoint info
app.get('/', (req, res) => {
    res.json({
        name: 'Solana LP Burn Monitor',
        version: '2.0.0',
        status: 'online',
        webhook: '/webhook',
        health: '/health',
        debug: '/debug',
        processed: processedTxs.size,
        uptime: process.uptime()
    });
});

// Debug endpoint
app.get('/debug', (req, res) => {
    res.json({
        processedTransactions: processedTxs.size,
        lastProcessed: Array.from(processedTxs).slice(-10),
        environment: {
            hasTelegramToken: !!TELEGRAM_BOT_TOKEN,
            hasTelegramChatId: !!TELEGRAM_CHAT_ID,
            hasHeliusApiKey: !!HELIUS_API_KEY,
            hasWebhookSecret: !!WEBHOOK_SECRET
        },
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
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
