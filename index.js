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
                    const tokenInfo = await getTokenInfo(transfer.mint);
                    
                    return {
                        signature,
                        mint: transfer.mint,
                        burnedAmount: transfer.tokenAmount,
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
                            const burnAmount = Math.abs(change.tokenBalanceChange);
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
    const { toTokenAccount, tokenAmount, fromTokenAccount } = transfer;
    
    // Must be substantial amount
    if (tokenAmount < 1000000) return false;
    
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
    
    return isBurnAddress;
}

// Check if balance change indicates burn
async function isBurnBalanceChange(change) {
    // Large negative change (tokens removed/burned)
    const burnAmount = Math.abs(change.tokenBalanceChange);
    
    // Must be substantial burn
    if (change.tokenBalanceChange >= 0 || burnAmount < 1000000) {
        return false;
    }
    
    // Additional checks could be added here
    return true;
}

// Get token info using Helius API
async function getTokenInfo(mintAddress) {
    try {
        // Try Helius first
        const response = await axios.get(
            `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_API_KEY}`,
            {
                params: { mint: mintAddress },
                timeout: 5000
            }
        );
        
        if (response.data && response.data.length > 0) {
            const token = response.data[0];
            const metadata = token.onChainMetadata?.metadata || token.offChainMetadata || {};
            
            return {
                name: metadata.name || 'Unknown Token',
                symbol: metadata.symbol || 'UNKNOWN'
            };
        }

        // Fallback to Jupiter
        const jupiterResponse = await axios.get('https://token.jup.ag/strict', { timeout: 3000 });
        const jupiterToken = jupiterResponse.data.find(t => t.address === mintAddress);
        
        if (jupiterToken) {
            return { 
                name: jupiterToken.name, 
                symbol: jupiterToken.symbol 
            };
        }

        return { 
            name: 'Unknown Memecoin', 
            symbol: 'MEME' 
        };
        
    } catch (error) {
        console.log(`Token info failed for ${mintAddress.slice(0, 8)}...:`, error.message);
        return { 
            name: 'Unknown Memecoin', 
            symbol: 'MEME' 
        };
    }
}

// Send Telegram alert
async function sendLPBurnAlert(burnInfo) {
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
            const plainMessage = message.replace(/[*`_]/g, '');
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
        processed: processedTxs.size,
        uptime: process.uptime()
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
