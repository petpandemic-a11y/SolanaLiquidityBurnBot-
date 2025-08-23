import 'dotenv/config';
import WebSocket from 'ws';
import TelegramBot from 'node-telegram-bot-api';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const TELEGRAM_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHANNEL_ID;

// --- Burn címek listája ---
const BURN_ADDRESSES = [
  "11111111111111111111111111111111",
  "1nc1nerator11111111111111111111111111111",
  "BurnXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX11111"
];

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// --- Helius WebSocket kapcsolat ---
const ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`);

ws.on('open', () => {
  console.log('🌍 Kapcsolódva a Helius WebSockethez!');
  const subscribeMessage = {
    jsonrpc: "2.0",
    id: 1,
    method: "transactionSubscribe",
    params: [
      {
        accountInclude: [],
        encoding: "jsonParsed"
      }
    ]
  };
  ws.send(JSON.stringify(subscribeMessage));
});

ws.on('message', async (data) => {
  try {
    const msg = JSON.parse(data);

    // Csak akkor érdekel, ha van tranzakciós adat
    if (!msg?.params?.result?.transaction) return;

    const tx = msg.params.result.transaction;
    const meta = msg.params.result.meta;

    if (!meta || !meta.postTokenBalances || meta.postTokenBalances.length === 0) return;

    // Végigmegyünk az összes tokenen, és megnézzük, mi történt az LP-vel
    for (let balance of meta.postTokenBalances) {
      const pre = meta.preTokenBalances?.find(b => b.mint === balance.mint);
      const preAmount = pre ? Number(pre.uiTokenAmount.amount) : 0;
      const postAmount = Number(balance.uiTokenAmount.amount);

      // Ha az LP teljes mennyisége eltűnt, akkor tovább vizsgáljuk
      if (preAmount > 0 && postAmount === 0) {
        // Megnézzük, hogy a tranzakció egyik kimenete burn címre ment-e
        const burnOutput = tx.message.accountKeys.find(acc => BURN_ADDRESSES.includes(acc.pubkey));
        if (burnOutput) {
          const msgText = `
🔥 **ÚJ LP BURN ESEMÉNY** 🔥

🌐 Pool mint: ${balance.mint}
💧 Elégetett mennyiség: ${pre.uiTokenAmount.uiAmountString}
🪦 Burn cím: ${burnOutput}

🔗 https://solscan.io/tx/${msg.params.result.signature}
          `;
          await bot.sendMessage(TELEGRAM_CHAT_ID, msgText, { parse_mode: 'Markdown' });
          console.log("🚀 Jelentés elküldve Telegramra!");
        }
      }
    }
  } catch (error) {
    console.error("Hiba a feldolgozás közben:", error);
  }
});

ws.on('error', (err) => {
  console.error("❌ Helius WebSocket hiba:", err);
});

ws.on('close', () => {
  console.log("⚠️ Kapcsolat bontva a Helius-szal, újracsatlakozás...");
  setTimeout(() => process.exit(1), 3000);
});
