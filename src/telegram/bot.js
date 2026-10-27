import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from '../config.js';

// Telegram keeps the last allowed_updates a client sent; without an explicit list a stale
// ["message"] subscription silently drops every inline-button press (callback_query).
// The form-encoded getUpdates call needs the list JSON-serialized.
export const ALLOWED_UPDATES = ['message', 'callback_query'];
export const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: { params: { allowed_updates: JSON.stringify(ALLOWED_UPDATES) } } });
