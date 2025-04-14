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
const RPC_URL = process.env.SOLANA_RPC_URL;

let bot;

if (WEBHOOK_URL) {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
  bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`);
  app.post(`/bot${TELEGRAM_BOT_TOKEN}`, express.json(), (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  console.log(`🚀 Bot running in WEBHOOK mode at ${WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`);
} else {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  console.log(`🛠️ Bot running in POLLING mode`);
}

const connection = new Connection(RPC_URL);
const trackedTokensFile = './data/added_tokens.txt';

let trackedTokens = fs.existsSync(trackedTokensFile)
  ? fs.readFileSync(trackedTokensFile, 'utf-8').split('\n').filter(Boolean)
  : [];

let lastCheckedSignature = null;

async function getTokenInfoFromList(mint) {
  try {
    const res = await fetch('https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json');
    const data = await res.json();
    return data.tokens.find(t => t.address === mint) || null;
  } catch (err) {
    console.error('Token list lookup failed:', err.message);
    return null;
  }
}

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

      const buyer = tx.transaction?.message?.accountKeys?.[0]?.toString() || 'unknown';
      const preSol = tx.meta?.preBalances?.[0] || 0;
      const postSol = tx.meta?.postBalances?.[0] || 0;
      const solSpent = ((preSol - postSol) / 1e9).toFixed(4);

      const postBalance = tx.meta?.postTokenBalances?.find(b => b.mint === token);
      const amountReceived = postBalance?.uiTokenAmount?.uiAmountString || 'unknown';

      const tokenInfo = await getTokenInfoFromList(token);
      const symbol = tokenInfo?.symbol || token.slice(0, 4) + '...' + token.slice(-4);
      const name = tokenInfo?.name || symbol;

      const dexsRes = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${token}`);
      const dexsData = await dexsRes.json();
      const pair = dexsData?.pair || {};
      const priceUsd = pair.priceUsd ? `$${parseFloat(pair.priceUsd).toFixed(8)}` : 'N/A';
      const marketCap = pair.fdv ? `$${parseInt(pair.fdv).toLocaleString()}` : 'N/A';
      const position = pair.rank ? `#${pair.rank}` : 'N/A';
      const txnLink = `https://solscan.io/tx/${signature}`;

      const message =
        `💥 *${name} [${symbol}]* 🛒 *Buy!*
\n` +
        `🪙 *${solSpent} SOL*
` +
        `📦 *Got:* ${amountReceived} ${symbol}
` +
        `🔗 [Buyer | Txn](${txnLink})
` +
        `📊 *Position:* ${position}
` +
        `💰 *Market Cap:* ${marketCap}
`;

      await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error(`Error while processing token ${token}:`, err.message);
  }
}

setInterval(() => {
  trackedTokens.forEach(token => {
    getBuyTransactions(token).catch(console.error);
  });
}, 3000);

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

app.get('/', (_, res) => res.send('Solana Buy Bot is running.'));
app.get('/health', (req, res) => res.send('FOMOtron is alive!'));
app.listen(port, () => console.log(`🌐 Server listening on port ${port}`));

