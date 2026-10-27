// Loaded before every test file (npm test --import). Tests must never reach the
// real Telegram bot: a local .env carries a live token, and src/telegram/bot.js
// would start polling it and post test positions into the chat.
import { register } from 'node:module';

register('./offline-bot-loader.js', import.meta.url);

// Same for values a local .env would pin; dotenv never overrides keys already set.
process.env.PAPER_STARTING_BALANCE_SOL = '';
