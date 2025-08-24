const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

// Konfiguráció
const TELEGRAM_BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID = 'YOUR_CHAT_ID'; // vagy channel ID
const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com'; // vagy használj Alchemy/QuickNode
const RAYDIUM_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

// Inicializálás
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

// Követett tokenek tárolása (memóriában, produkcióban használj adatbázist)
const monitoredTokens = new Set();
const processedTransactions = new Set();

// Token információk lekérése
async function getTokenInfo(mintAddress) {
    try {
        // Jupiter API használata token infókért
        const response = await axios.get(`https://token.jup.ag/strict`);
        const token = response.data.find(t => t.address === mintAddress);
        
        if (token) {
            return {
                name: token.name,
                symbol: token.symbol,
                decimals: token.decimals
            };
        }
        
        // Ha nem találjuk a Jupiter listában, próbáljuk a Solscan API-t
        const solscanResponse = await axios.get(`https://public-api.solscan.io/token/meta?tokenAddress=${mintAddress}`);
        return {
            name: solscanResponse.data.name || 'Unknown',
            symbol: solscanResponse.data.symbol || 'UNKNOWN',
            decimals: solscanResponse.data.decimals || 9
        };
    } catch (error) {
        console.error('Error fetching token info:', error);
        return {
            name: 'Unknown Token',
            symbol: 'UNKNOWN',
            decimals: 9
        };
    }
}

// LP burn esemény detektálása
async function checkLPBurn(signature) {
    try {
        const transaction = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
        });

        if (!transaction || !transaction.meta) {
            return null;
        }

        // Ellenőrizzük, hogy van-e LP token burn
        const preTokenBalances = transaction.meta.preTokenBalances || [];
        const postTokenBalances = transaction.meta.postTokenBalances || [];

        for (const preBalance of preTokenBalances) {
            const postBalance = postTokenBalances.find(
                p => p.accountIndex === preBalance.accountIndex
            );

            // Ha a balance 0-ra csökkent és jelentős összeg volt
            if (preBalance.uiTokenAmount.uiAmount > 1000 && 
                (!postBalance || postBalance.uiTokenAmount.uiAmount === 0)) {
                
                const tokenInfo = await getTokenInfo(preBalance.mint);
                
                // Ellenőrizzük, hogy ez LP token-e (általában nagy supply és liquidity pool part)
                if (await isLikelyLPToken(preBalance.mint, preBalance.uiTokenAmount.uiAmount)) {
                    return {
                        signature,
                        tokenInfo,
                        burnedAmount: preBalance.uiTokenAmount.uiAmount,
                        mint: preBalance.mint
                    };
                }
            }
        }

        return null;
    } catch (error) {
        console.error('Error checking LP burn:', error);
        return null;
    }
}

// Annak ellenőrzése, hogy LP token-e
async function isLikelyLPToken(mintAddress, burnedAmount) {
    try {
        // Raydium LP tokeneket keresünk
        const response = await axios.get(`https://api.raydium.io/v2/sdk/liquidity/mainnet.json`);
        const pools = response.data.official.concat(response.data.unOfficial || []);
        
        // Keressük meg, hogy van-e pool ezzel a token címmel
        const pool = pools.find(p => 
            p.lpMint === mintAddress || 
            p.baseMint === mintAddress || 
            p.quoteMint === mintAddress
        );

        return pool !== undefined;
    } catch (error) {
        console.error('Error checking LP token:', error);
        // Fallback: nagy mennyiség esetén valószínűleg LP
        return burnedAmount > 10000;
    }
}

// Telegram üzenet küldése
async function sendTelegramMessage(burnInfo) {
    const message = `
🔥 TELJES LP ÉGETÉS ÉSZLELVE! 🔥

💰 Token: ${burnInfo.tokenInfo.name} (${burnInfo.tokenInfo.symbol})
🏷️ Mint: \`${burnInfo.mint}\`
🔥 Égetett LP: ${burnInfo.burnedAmount.toLocaleString()}
📊 Tranzakció: [Solscan](https://solscan.io/tx/${burnInfo.signature})

⚠️ Ez azt jelentheti, hogy a token "rugged" vagy a fejlesztő elégetette a likviditást!
    `;

    try {
        await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
        console.log('Telegram message sent successfully');
    } catch (error) {
        console.error('Error sending Telegram message:', error);
    }
}

// Új tranzakciók figyelése
async function monitorTransactions() {
    console.log('Monitoring started...');
    
    try {
        // WebSocket kapcsolat a Solana hálózathoz
        const ws = new WebSocket('wss://api.mainnet-beta.solana.com');
        
        ws.on('open', () => {
            console.log('WebSocket connection opened');
            
            // Feliratkozás a Raydium program account változásaira
            const subscribeMessage = {
                jsonrpc: '2.0',
                id: 1,
                method: 'programSubscribe',
                params: [
                    RAYDIUM_PROGRAM_ID,
                    {
                        commitment: 'confirmed',
                        encoding: 'jsonParsed'
                    }
                ]
            };
            
            ws.send(JSON.stringify(subscribeMessage));
        });

        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data);
                
                if (message.method === 'programNotification') {
                    const signature = message.params.result.context.slot;
                    
                    // Elkerüljük a duplikált feldolgozást
                    if (processedTransactions.has(signature)) {
                        return;
                    }
                    processedTransactions.add(signature);

                    // Korlátozzuk a memória használatot
                    if (processedTransactions.size > 10000) {
                        const oldestSignatures = Array.from(processedTransactions).slice(0, 5000);
                        oldestSignatures.forEach(sig => processedTransactions.delete(sig));
                    }

                    // Ellenőrizzük az LP burn eseményeket
                    const burnInfo = await checkLPBurn(signature);
                    if (burnInfo) {
                        await sendTelegramMessage(burnInfo);
                    }
                }
            } catch (error) {
                console.error('Error processing message:', error);
            }
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });

        ws.on('close', () => {
            console.log('WebSocket connection closed, reconnecting...');
            setTimeout(monitorTransactions, 5000);
        });

    } catch (error) {
        console.error('Error in monitoring:', error);
        setTimeout(monitorTransactions, 5000);
    }
}

// Fallback: polling alapú megoldás
async function pollRecentTransactions() {
    console.log('Starting polling mode...');
    
    setInterval(async () => {
        try {
            // Legutóbbi blokk signatureök lekérése
            const recentSignatures = await connection.getSignaturesForAddress(
                new PublicKey(RAYDIUM_PROGRAM_ID),
                { limit: 100 }
            );

            for (const sigInfo of recentSignatures) {
                if (processedTransactions.has(sigInfo.signature)) {
                    continue;
                }
                
                processedTransactions.add(sigInfo.signature);
                
                const burnInfo = await checkLPBurn(sigInfo.signature);
                if (burnInfo) {
                    await sendTelegramMessage(burnInfo);
                }
                
                // Ratelimit elkerülése
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } catch (error) {
            console.error('Error in polling:', error);
        }
    }, 30000); // 30 másodpercenként
}

// Bot indítása
async function startBot() {
    console.log('Starting Solana LP Burn Monitor Bot...');
    
    // Teszteljük a Telegram kapcsolatot
    try {
        const me = await bot.getMe();
        console.log(`Bot started: ${me.username}`);
    } catch (error) {
        console.error('Telegram bot error:', error);
        return;
    }

    // Indítsuk a monitorozást
    try {
        await monitorTransactions();
    } catch (error) {
        console.error('WebSocket failed, falling back to polling');
        pollRecentTransactions();
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down bot...');
    process.exit(0);
});

// Bot indítása
startBot().catch(console.error);
