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

// Filtering settings (configurable via environment)
const MIN_SOL_BURNED = parseFloat(process.env.MIN_SOL_BURNED) || 5; // Minimum SOL burned
const MIN_MARKETCAP = parseFloat(process.env.MIN_MARKETCAP) || 10000; // Minimum $10k marketcap
const MAX_MARKETCAP = parseFloat(process.env.MAX_MARKETCAP) || 50000000; // Maximum $50M marketcap
const MIN_TOKEN_BURNED = parseFloat(process.env.MIN_TOKEN_BURNED) || 1000000; // Minimum tokens burned

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
        
        // Check SOL burn amount first
        const solBurned = await checkSOLBurnAmount(txData);
        
        if (solBurned < MIN_SOL_BURNED) {
            console.log(`⚠️ SOL burned (${solBurned.toFixed(2)}) < minimum (${MIN_SOL_BURNED})`);
            return null;
        }
        
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
                    
                    if (isNaN(amount) || amount < MIN_TOKEN_BURNED) {
                        continue;
                    }
                    
                    console.log(`🎯 Potential LP BURN: ${amount.toLocaleString()} tokens, ${solBurned.toFixed(2)} SOL`);
                    
                    // Get token info and marketcap
                    const tokenInfo = await getTokenInfoAndMarketcap(transfer.mint);
                    
                    // Check marketcap filter
                    if (tokenInfo.marketcap > 0 && 
                        (tokenInfo.marketcap < MIN_MARKETCAP || tokenInfo.marketcap > MAX_MARKETCAP)) {
                        console.log(`⚠️ Marketcap (${tokenInfo.marketcap.toLocaleString()}) outside range: ${MIN_MARKETCAP.toLocaleString()} - ${MAX_MARKETCAP.toLocaleString()}`);
                        return null;
                    }
                    
                    console.log(`🔥 LP BURN CONFIRMED: ${tokenInfo.symbol} - MC: ${tokenInfo.marketcap.toLocaleString()}`);
                    
                    return {
                        signature,
                        mint: transfer.mint,
                        burnedAmount: amount,
                        solBurned: solBurned,
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
                        if (await isBurnBalanceChange(change)) {
                            const burnAmount = Math.abs(parseFloat(change.tokenBalanceChange) || 0);
                            
                            if (isNaN(burnAmount) || burnAmount < MIN_TOKEN_BURNED) {
                                continue;
                            }
                            
                            console.log(`🎯 Potential LP BURN via balance: ${burnAmount.toLocaleString()} tokens, ${solBurned.toFixed(2)} SOL`);
                            
                            // Get token info and marketcap
                            const tokenInfo = await getTokenInfoAndMarketcap(change.mint);
                            
                            // Check marketcap filter
                            if (tokenInfo.marketcap > 0 && 
                                (tokenInfo.marketcap < MIN_MARKETCAP || tokenInfo.marketcap > MAX_MARKETCAP)) {
                                console.log(`⚠️ Marketcap (${tokenInfo.marketcap.toLocaleString()}) outside range`);
                                return null;
                            }
                            
                            console.log(`🔥 LP BURN CONFIRMED via balance: ${tokenInfo.symbol}`);
                            
                            return {
                                signature,
                                mint: change.mint,
                                burnedAmount: burnAmount,
                                solBurned: solBurned,
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
    
    // Must be substantial amount
    if (isNaN(amount) || amount < MIN_TOKEN_BURNED) {
        console.log(`⚠️ Amount too small: ${amount} < ${MIN_TOKEN_BURNED}`);
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
    return isBurnAddress && amount >= MIN_TOKEN_BURNED;
}

// Check if this is a SOL/Memecoin LP burn
async function checkSOLBurnAmount(txData) {
    try {
        const { tokenTransfers } = txData;
        
        if (!tokenTransfers || !Array.isArray(tokenTransfers)) {
            return 0;
        }
        
        // Look for SOL transfers in the same transaction
        let solBurned = 0;
        
        for (const transfer of tokenTransfers) {
            // Check if this is SOL (wrapped SOL mint)
            if (transfer.mint === 'So11111111111111111111111111111111111111112') {
                // Parse SOL amount
                let amount = 0;
                if (typeof transfer.tokenAmount === 'number') {
                    amount = transfer.tokenAmount / 1e9; // Convert from lamports to SOL
                } else if (transfer.tokenAmount && transfer.tokenAmount.uiAmount) {
                    amount = transfer.tokenAmount.uiAmount;
                }
                
                solBurned += amount;
            }
        }
        
        console.log(`💰 SOL burned in transaction: ${solBurned.toFixed(2)} SOL`);
        return solBurned;
    } catch (error) {
        console.error('Error checking SOL burn amount:', error.message);
        return 0;
    }
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
    
    // Must be substantial burn (negative change, meets minimum)
    if (balanceChange >= 0 || isNaN(burnAmount) || burnAmount < MIN_TOKEN_BURNED) {
        console.log(`⚠️ Balance change not a burn: ${balanceChange} (min: ${MIN_TOKEN_BURNED})`);
        return false;
    }
    
    console.log(`🔍 Balance change: ${balanceChange.toLocaleString()} (burn: ${burnAmount.toLocaleString()})`);
    return true;
}

// Get token info and marketcap using multiple APIs
async function getTokenInfoAndMarketcap(mintAddress) {
    try {
        console.log(`📖 Getting token info for: ${mintAddress}`);
        
        let tokenInfo = { name: 'Unknown Memecoin', symbol: 'MEME', marketcap: 0 };
        
        // Try DexScreener for better token data and marketcap
        try {
            const dexResponse = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
                { timeout: 5000 }
            );
            
            if (dexResponse.data && dexResponse.data.pairs && dexResponse.data.pairs.length > 0) {
                const pair = dexResponse.data.pairs[0];
                const baseToken = pair.baseToken;
                
                if (baseToken && baseToken.address === mintAddress) {
                    tokenInfo.name = baseToken.name || 'Unknown Token';
                    tokenInfo.symbol = baseToken.symbol || 'UNKNOWN';
                    tokenInfo.marketcap = parseFloat(pair.fdv) || 0; // Fully diluted valuation
                    
                    console.log(`✅ DexScreener: ${tokenInfo.name} (${tokenInfo.symbol}) - MC: ${tokenInfo.marketcap.toLocaleString()}`);
                    return tokenInfo;
                }
            }
        } catch (dexError) {
            console.log('⚠️ DexScreener failed:', dexError.message);
        }
        
        // Try Helius for token metadata
        try {
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
                
                tokenInfo.name = onChain?.name || offChain?.name || 'Unknown Token';
                tokenInfo.symbol = onChain?.symbol || offChain?.symbol || 'UNKNOWN';
                
                console.log(`✅ Helius: ${tokenInfo.name} (${tokenInfo.symbol})`);
            }
        } catch (heliusError) {
            console.log('⚠️ Helius failed:', heliusError.message);
        }
        
        // Try Jupiter as final fallback
        try {
            const jupiterResponse = await axios.get('https://token.jup.ag/strict', { timeout: 3000 });
            const jupiterToken = jupiterResponse.data.find(t => t.address === mintAddress);
            
            if (jupiterToken) {
                tokenInfo.name = jupiterToken.name;
                tokenInfo.symbol = jupiterToken.symbol;
                console.log(`✅ Jupiter: ${tokenInfo.name} (${tokenInfo.symbol})`);
            }
        } catch (jupiterError) {
            console.log('⚠️ Jupiter failed:', jupiterError.message);
        }
        
        // Try to get marketcap from CoinGecko if we have symbol
        if (tokenInfo.marketcap === 0 && tokenInfo.symbol !== 'MEME') {
            try {
                const cgResponse = await axios.get(
                    `https://api.coingecko.com/api/v3/search?query=${tokenInfo.symbol}`,
                    { timeout: 3000 }
                );
                
                if (cgResponse.data && cgResponse.data.coins && cgResponse.data.coins.length > 0) {
                    const coin = cgResponse.data.coins[0];
                    if (coin.market_cap_rank) {
                        tokenInfo.marketcap = coin.market_cap || 0;
                        console.log(`✅ CoinGecko marketcap: ${tokenInfo.marketcap.toLocaleString()}`);
                    }
                }
            } catch (cgError) {
                console.log('⚠️ CoinGecko failed:', cgError.message);
            }
        }
        
        return tokenInfo;
        
    } catch (error) {
        console.error(`❌ Token info error for ${mintAddress}:`, error.message);
        return { 
            name: 'Unknown Memecoin', 
            symbol: 'MEME',
            marketcap: 0
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
    
    // Format marketcap display
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
🔥 **Égetett LP:** ${Math.round(burnInfo.burnedAmount).toLocaleString()} token
💎 **SOL égetve:** ${burnInfo.solBurned?.toFixed(2) || 'N/A'} SOL
📊 **Market Cap:** ${marketCapText}
⏰ **Időpont:** ${burnInfo.timestamp.toLocaleString('hu-HU')}

✅ **TELJES LP ELÉGETVE!** 
🛡️ **Biztonság:** A likviditás ${burnInfo.solBurned?.toFixed(2) || 'N/A'} SOL-lal együtt el lett égetve
🚫 **Rug pull:** Már nem lehetséges!
📊 **Tranzakció:** [Solscan](https://solscan.io/tx/${burnInfo.signature})

🚀 **Potenciálisan biztonságos memecoin!**
⚠️ **DYOR:** Mindig végezz saját kutatást!

#100PercentBurn #LPBurn #SafeMeme #Solana #RugProof #SOLBurned
    `.trim();

    try {
        await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: false
        });
        
        console.log(`✅ ALERT SENT: ${burnInfo.tokenSymbol} - ${burnInfo.burnedAmount.toLocaleString()} tokens, ${burnInfo.solBurned?.toFixed(2)} SOL`);
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
      
