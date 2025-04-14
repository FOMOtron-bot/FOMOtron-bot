import express from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL;

// Create the Telegram bot (dynamic mode)
let bot;

if (WEBHOOK_URL) {
  // Webhook mode (Render)
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
  bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`);
  app.post(`/bot${TELEGRAM_BOT_TOKEN}`, express.json(), (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  console.log(`🚀 Bot running in WEBHOOK mode at ${WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`);
} else {
  // Polling mode (local dev)
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  console.log(`🛠️ Bot running in POLLING mode`);
}

const connection = new Connection('https://api.mainnet-beta.solana.com');
const trackedTokensFile = './data/added_tokens.txt';

let trackedTokens = fs.existsSync(trackedTokensFile)
  ? fs.readFileSync(trackedTokensFile, 'utf-8').split('\n').filter(Boolean)
  : [];

let lastCheckedSignature = null;

async function getBuyTransactions(token) {
  try {
    const tokenPubkey = new PublicKey(token);
    const signatures = await connection.getSignaturesForAddress(tokenPubkey, { limit: 10 });

    for (const signatureInfo of signatures.reverse()) {
      const { signature } = signatureInfo;
      if (lastCheckedSignature === signature) continue;
      lastCheckedSignature = signature;

      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || !tx.meta || tx.meta.err) continue;

      const isBuy = tx.meta?.postTokenBalances?.some(balance =>
        balance.mint === token && parseInt(balance.uiTokenAmount.amount) > 0
      );

      if (isBuy) {
        const amount = tx.meta.postTokenBalances.find(b => b.mint === token)?.uiTokenAmount.uiAmount;
        const buyer = tx.transaction?.message?.accountKeys?.[0]?.toString() || 'unknown';

        const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${token}`);
        const data = await res.json();
        const name = data?.pair?.baseToken?.symbol || 'Unknown';
        const link = `https://dexscreener.com/solana/${token}`;

        await bot.sendMessage(TELEGRAM_CHAT_ID,
          `🟢 *Buy Detected!*\nToken: *${name}*\nBuyer: \`${buyer}\`\nAmount: *${amount}*\n[View on DexScreener](${link})`,
          { parse_mode: 'Markdown' }
        );
      }
    }
  } catch (err) {
    console.error(`Error while processing token ${token}:`, err.message);
  }
}

setInterval(() => {
  trackedTokens.forEach(token => {
    getBuyTransactions(token).catch(console.error);
  });
}, 15000);

bot.onText(/\/add (.+)/, (msg, match) => {
  const token = match[1];
  if (!trackedTokens.includes(token)) {
    trackedTokens.push(token);
    fs.appendFileSync(trackedTokensFile, token + '\n');
    bot.sendMessage(msg.chat.id, `✅ Token added: ${token}`);
  } else {
    bot.sendMessage(msg.chat.id, `⚠️ Token already being tracked.`);
  }
});

bot.onText(/\/remove (.+)/, (msg, match) => {
  const token = match[1];
  trackedTokens = trackedTokens.filter(t => t !== token);
  fs.writeFileSync(trackedTokensFile, trackedTokens.join('\n'));
  bot.sendMessage(msg.chat.id, `❌ Token removed: ${token}`);
});

bot.onText(/\/list/, (msg) => {
  if (trackedTokens.length === 0) {
    bot.sendMessage(msg.chat.id, 'No tokens are currently being tracked.');
  } else {
    bot.sendMessage(msg.chat.id, `Currently tracking:\n${trackedTokens.join('\n')}`);
  }
});

// Web routes for Render health checks
app.get('/', (_, res) => res.send('Solana Buy Bot is running.'));
app.get('/health', (req, res) => res.send('FOMOtron is alive!'));

app.listen(port, () => console.log(`🌐 Server listening on port ${port}`));
