import 'dotenv/config';
import { Telegraf } from 'telegraf';

const {
  BOT_TOKEN,
  CHANNEL_ID,
} = process.env;

const bot = new Telegraf(BOT_TOKEN);

// Teszt parancs
bot.command('ping', (ctx) => ctx.reply('pong'));

// Induláskor teszt üzenet a csatornába
(async () => {
  try {
    await bot.telegram.sendMessage(CHANNEL_ID, "✅ BurnBot sikeresen elindult és tud üzenetet küldeni!");
  } catch (e) {
    console.error("Nem sikerült üzenetet küldeni a csatornába:", e);
  }
})();

bot.launch();
