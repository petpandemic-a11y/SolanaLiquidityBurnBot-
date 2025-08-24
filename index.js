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

// LP burn detection
async function checkLPBurn(signature) {
    try {
        // Validate signature
        if (!signature || typeof signature !== 'string' || signature.length < 80) {
            console.log('⚠️ Invalid signature format:', signature);
            return null;
        }

        const tx = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
        });

        if (!tx?.meta) {
            console.log('⚠️ No transaction metadata for:', signature);
            return null;
        }

        const preBalances = tx.meta.preTokenBalances || [];
        const postBalances = tx.meta.postTokenBalances || [];

        for (const pre of preBalances) {
            const post = postBalances.find(p => p.accountIndex === pre.accountIndex);
            const preAmount = pre.uiTokenAmount?.uiAmount || 0;
            const postAmount = post?.uiTokenAmount?.uiAmount || 0;

            // Full LP burn: large amount → 0
            if (preAmount > 100000 && postAmount === 0) {
                console.log(`🔍 Potential LP burn found: ${preAmount} → ${postAmount}`);
                
                const tokenInfo = await getTokenInfo(pre.mint);
                
                return {
                    signature,
                    mint: pre.mint,
                    burnedAmount: preAmount,
                    tokenName: tokenInfo.name,
                    tokenSymbol: tokenInfo.symbol,
                    timestamp: new Date()
                };
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

// Send Telegram alert
async function sendLPBurnAlert(burnInfo) {
    const message = `
🔥 **TELJES LP ELÉGETVE!** 🔥

💰 **Token:** ${burnInfo.tokenName} (${burnInfo.tokenSymbol})
🏷️ **Cím:** \`${burnInfo.mint}\`
🔥 **Égetett LP:** ${Math.round(burnInfo.burnedAmount).toLocaleString()}
⏰ **Időpont:** ${burnInfo.timestamp.toLocaleString('hu-HU')}

✅ **JÓ HÍR:** A fejlesztő elégette az LP-t!
🛡️ **Mit jelent:** Nem tudják már ellopni a likviditást
📊 **Tranzakció:** [Solscan](https://solscan.io/tx/${burnInfo.signature})

🚀 Ez lehet egy biztonságos memecoin! 
⚠️ De mindig DYOR (Do Your Own Research)!

#LPBurn #SafeMeme #Solana #RugProof
    `.trim();

    try {
        await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
        });
        console.log(`✅ Alert sent: ${burnInfo.tokenSymbol}`);
    } catch (error) {
        console.error('❌ Telegram error:', error.message);
    }
}

// WebSocket monitoring
function startWebSocketMonitoring() {
    const ws = new WebSocket('wss://api.mainnet-beta.solana.com');
    
    ws.on('open', () => {
        console.log('🔌 WebSocket connected');
        
        ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'logsSubscribe',
            params: [
                { mentions: [RAYDIUM_PROGRAM] },
                { commitment: 'confirmed' }
            ]
        }));
        
        console.log('📡 Subscribed to Raydium events');
    });

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            
            if (message.method === 'logsNotification') {
                const signature = message.params?.result?.signature;
                
                // Skip if signature is null/undefined
                if (!signature || typeof signature !== 'string') {
                    console.log('⚠️ Skipping invalid signature:', signature);
                    return;
                }
                
                if (processedTxs.has(signature)) return;
                processedTxs.add(signature);
                
                // Memory cleanup
                if (processedTxs.size > 5000) {
                    const oldest = Array.from(processedTxs).slice(0, 2500);
                    oldest.forEach(sig => processedTxs.delete(sig));
                }
                
                const burnInfo = await checkLPBurn(signature);
                if (burnInfo) {
                    console.log(`🔥 LP burn detected: ${burnInfo.tokenSymbol}`);
                    await sendLPBurnAlert(burnInfo);
                }
            }
        } catch (error) {
            console.error('WebSocket message error:', error.message);
        }
    });

    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error.message);
    });

    ws.on('close', () => {
        console.log('🔌 WebSocket closed, reconnecting...');
        setTimeout(startWebSocketMonitoring, 5000);
    });
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
            '🔥 Figyelek minden LP égetést a Solana hálózaton\n' +
            '✅ Értesíteni foglak, ha egy memecoin elégeti az LP-t!\n\n' +
            '#LPBurnMonitor #Online'
        );
        
        startWebSocketMonitoring();
        
        console.log('🚀 LP Burn Monitor started successfully!');
        
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
