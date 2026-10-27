// Test-only Telegram transport. Production orchestration and database are real.
// Every bot method resolves; calls are recorded on globalThis.__telegramCalls for assertions.
export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/telegram/bot.js')) return {
    format: 'module', shortCircuit: true,
    source: `
const calls = (globalThis.__telegramCalls ??= []);
const ids = { sendMessage: 1, sendPhoto: 2 };
export const bot = new Proxy({}, {
  get: (_, method) => (method === 'on' || method === 'onText')
    ? () => {}
    : async (...args) => { calls.push({ method: String(method), args }); return { message_id: ids[method] ?? 3 }; },
});`,
  };
  return nextLoad(url, context);
}
