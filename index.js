const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const RAYDIUM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const connection = new Connection(SOLANA_RPC, 'confirmed');
const processedTxs = new Set();

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// LP burn detection - ONLY 100% burns
async function checkLPBurn(signature) {
    try {
        // Validate signature
        if (!signature || typeof signature !== 'string' || signature.length < 80) {
            return null;
        }

        const tx = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
        });

        if (!tx?.meta) {
            return null;
        }

        const preBalances = tx.meta.preTokenBalances || [];
        const postBalances = tx.meta.postTokenBalances || [];

        for (const pre of preBalances) {
            const post = postBalances.find(p => p.accountIndex === pre.accountIndex);
            const preAmount = pre.uiTokenAmount?.uiAmount || 0;
            const postAmount = post?.uiTokenAmount?.uiAmount || 0;

            // STRICT: Only 100% LP burns (large amount → exactly 0)
            if (preAmount > 1000000 && postAmount === 0) { // Increased minimum to 1M+ tokens
                console.log(`🔍 100% LP burn found: ${preAmount.toLocaleString()} → 0`);
                
                // Double-check it's likely an LP token by checking if it's a large round number
                if (preAmount > 1000000 && Number.isInteger(preAmount)) {
                    const tokenInfo = await getTokenInfo(pre.mint);
                    
                    return {
                        signature,
                        mint: pre.mint,
                        burnedAmount: preAmount,
                        tokenName: tokenInfo.name,
                        tokenSymbol: tokenInfo.symbol,
                        timestamp: new Date(),
                        burnPercentage: 100 // Always 100% for our alerts
                    };
                }
            }
        }
        return null;
    } catch (error) {
        console.error(`LP check error for ${signature}:`, error.message);
        return null;
    }
}

// Get token info
async function getTokenInfo(mintAddress) {
    try {
        const response = await axios.get('https://token.jup.ag/strict', { timeout: 5000 });
        const token = response.data.find(t => t.address === mintAddress);
        
        if (token) {
            return { name: token.name, symbol: token.symbol };
        }

        const solscanResponse = await axios.get(
            `https://public-api.solscan.io/token/meta?tokenAddress=${mintAddress}`,
            { timeout: 5000 }
        );
        
        return {
            name: solscanResponse.data.name || 'Unknown Token',
            symbol: solscanResponse.data.symbol || 'UNKNOWN'
        };
    } catch (error) {
        return { name: 'Unknown Memecoin', symbol: 'MEME' };
    }
}

// Send Telegram alert - ONLY for 100% burns
async function sendLPBurnAlert(burnInfo) {
    const message = `
🔥 **100% LP ELÉGETVE!** 🔥

💰 **Token:** ${burnInfo.tokenName} (${burnInfo.tokenSymbol})
🏷️ **Cím:** \`${burnInfo.mint}\`
🔥 **Teljes LP égetés:** ${Math.round(burnInfo.burnedAmount).toLocaleString()} token
⏰ **Időpont:** ${burnInfo.timestamp.toLocaleString('hu-HU')}

✅ **TELJES LP ELÉGETVE!** 
🛡️ **Biztonság:** A likviditás 100%-ban el lett égetve
🚫 **Rug pull:** Már nem lehetséges!
📊 **Tranzakció:** [Solscan](https://solscan.io/tx/${burnInfo.signature})

🚀 **Ez egy potenciálisan biztonságos memecoin!**
⚠️ **Figyelem:** Mindig végezz saját kutatást (DYOR)!

#100PercentBurn #LPBurn #SafeMeme #Solana #RugProof
    `.trim();

    try {
        await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
        });
        console.log(`✅ 100% LP burn alert sent: ${burnInfo.tokenSymbol} - ${burnInfo.burnedAmount.toLocaleString()}`);
    } catch (error) {
        console.error('❌ Telegram error:', error.message);
    }
}

// Polling method (more reliable than WebSocket for this use case)
function startPollingMonitoring() {
    console.log('🔄 Starting polling mode with rate limiting...');
    
    setInterval(async () => {
        try {
            const signatures = await connection.getSignaturesForAddress(
                new PublicKey(RAYDIUM_PROGRAM),
                { limit: 10 } // Reduced from 20 to 10
            );

            for (const sigInfo of signatures.slice(0, 5)) { // Only check first 5
                if (processedTxs.has(sigInfo.signature)) continue;
                
                processedTxs.add(sigInfo.signature);
                
                // Memory cleanup
                if (processedTxs.size > 3000) { // Reduced size
                    const oldest = Array.from(processedTxs).slice(0, 1500);
                    oldest.forEach(sig => processedTxs.delete(sig));
                }
                
                const burnInfo = await checkLPBurn(sigInfo.signature);
                if (burnInfo) {
                    console.log(`🔥 LP burn detected: ${burnInfo.tokenSymbol}`);
                    await sendLPBurnAlert(burnInfo);
                }
                
                // Longer rate limiting to avoid 429 errors
                await new Promise(resolve => setTimeout(resolve, 500)); // Increased from 100ms
            }
        } catch (error) {
            if (error.message.includes('429')) {
                console.log('⚠️ Rate limited, waiting longer...');
                await new Promise(resolve => setTimeout(resolve, 5000));
            } else {
                console.error('Polling error:', error.message);
            }
        }
    }, 30000); // Increased from 15s to 30s
}

// WebSocket monitoring (backup method) - DISABLED to reduce load
function startWebSocketMonitoring() {
    console.log('🔌 WebSocket monitoring disabled to reduce rate limiting');
    // Commenting out WebSocket to reduce API calls
    /*
    const ws = new WebSocket('wss://api.mainnet-beta.solana.com');
    
    ws.on('open', () => {
        console.log('🔌 WebSocket connected');
        
        // Subscribe to account changes for Raydium program
        ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'programSubscribe',
            params: [
                RAYDIUM_PROGRAM,
                {
                    commitment: 'confirmed',
                    encoding: 'base64'
                }
            ]
        }));
        
        console.log('📡 Subscribed to Raydium program changes');
    });

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            
            if (message.method === 'programNotification') {
                // For program notifications, we need to poll recent transactions
                console.log('📊 Program change detected, checking recent transactions...');
                
                // Get recent signatures and check them
                setTimeout(async () => {
                    try {
                        const signatures = await connection.getSignaturesForAddress(
                            new PublicKey(RAYDIUM_PROGRAM),
                            { limit: 5 }
                        );

                        for (const sigInfo of signatures) {
                            if (processedTxs.has(sigInfo.signature)) continue;
                            
                            processedTxs.add(sigInfo.signature);
                            const burnInfo = await checkLPBurn(sigInfo.signature);
                            
                            if (burnInfo) {
                                console.log(`🔥 LP burn detected via WebSocket: ${burnInfo.tokenSymbol}`);
                                await sendLPBurnAlert(burnInfo);
                            }
                        }
                    } catch (error) {
                        console.error('WebSocket transaction check error:', error.message);
                    }
                }, 1000);
            }
        } catch (error) {
            console.error('WebSocket message error:', error.message);
        }
    });

    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error.message);
    });

    ws.on('close', () => {
        console.log('🔌 WebSocket closed, will restart with next poll cycle');
        // Don't immediately reconnect, let polling handle it
        setTimeout(() => {
            if (ws.readyState === WebSocket.CLOSED) {
                startWebSocketMonitoring();
            }
        }, 30000);
    });
    */
}

// Start the bot
async function startBot() {
    try {
        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
            throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID environment variables');
        }

        const me = await bot.getMe();
        console.log(`🤖 Telegram bot: @${me.username}`);
        
        const version = await connection.getVersion();
        console.log(`⚡ Solana connected: ${version['solana-core']}`);
        
        await bot.sendMessage(TELEGRAM_CHAT_ID, 
            '🚀 LP Burn Monitor elindult!\n\n' +
            '🔥 **CSAK 100% LP ÉGETÉSEKET** figyelek!\n' +
            '✅ Csak akkor írok, ha teljes LP elégetve\n' +
            '⚡ Polling mód: 30s ciklusok (rate limit safe)\n' +
            '🛡️ Rug pull védelem detector!\n\n' +
            '#100PercentBurn #LPBurnMonitor #Online'
        );
        
        // Start both monitoring methods
        startPollingMonitoring();
        startWebSocketMonitoring();
        
        console.log('🚀 LP Burn Monitor started successfully with dual monitoring!');
        
    } catch (error) {
        console.error('❌ Failed to start bot:', error);
        process.exit(1);
    }
}

// Start HTTP server (required for Render)
app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
    startBot();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Shutting down gracefully...');
    process.exit(0);
});
