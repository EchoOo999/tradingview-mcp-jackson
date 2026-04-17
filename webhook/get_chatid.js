// One-time script: prints your Telegram chat ID from recent bot messages.
// Usage: TELEGRAM_BOT_TOKEN=<token> node webhook/get_chatid.js

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error('ERROR: set TELEGRAM_BOT_TOKEN env var first.');
  console.error('  Windows CMD:  set TELEGRAM_BOT_TOKEN=7123...:AAF...');
  console.error('  PowerShell:   $env:TELEGRAM_BOT_TOKEN="7123...:AAF..."');
  console.error('  bash/WSL:     TELEGRAM_BOT_TOKEN=7123...:AAF... node webhook/get_chatid.js');
  process.exit(1);
}

const url = `https://api.telegram.org/bot${TOKEN}/getUpdates`;

const res = await fetch(url);
const data = await res.json();

if (!data.ok) {
  console.error('Telegram API error:', data.description);
  process.exit(1);
}

if (!data.result.length) {
  console.log('No updates found. Make sure you sent a message to @cta_sfp_bot first, then re-run.');
  process.exit(0);
}

console.log('\n── Chats found in recent updates ──────────────────────\n');

const seen = new Set();
for (const update of data.result) {
  const msg = update.message || update.channel_post || update.my_chat_member?.chat;
  if (!msg) continue;
  const chat = msg.chat || msg;
  const key = String(chat.id);
  if (seen.has(key)) continue;
  seen.add(key);

  const type  = chat.type  || 'unknown';
  const title = chat.title || chat.username || `${chat.first_name ?? ''} ${chat.last_name ?? ''}`.trim();
  console.log(`Chat ID : ${chat.id}`);
  console.log(`Type    : ${type}`);
  console.log(`Name    : ${title || '(no name)'}`);
  console.log('────────────────────────────────────────────────────\n');
}

console.log('Copy the Chat ID above and set it as TELEGRAM_CHAT_ID in Railway.');
