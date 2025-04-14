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

const trackedTokensFile = './data/added_tokens.txt';
const lastSignatureFile = './data/last_signatures.json';

let trackedTokens = fs.existsSync(trackedTokensFile)
  ? fs.readFileSync(trackedTokensFile, 'utf-8').split('\n').filter(Boolean).map(t => t.trim())
  : [];

let lastCheckedSignatures = fs.existsSync(lastSignatureFile)
  ? JSON.parse(fs.readFileSync(lastSignatureFile, 'utf-8'))
  : {};

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const connection = new Connection(RPC_URL);

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

function cleanString(buffer) {
  return buffer.toString('utf8').replace(/\0/g, '').trim();
}

function isGibberish(str) {
  return !str || /[^\x20-\x7E]/.test(str) || str.length < 1 || str.length > 32;
}

function looksLikeAddress(str) {
  return /^([A-HJ-NP-Za-km-z1-9]{32,44})$/.test(str);
}

async function getTokenInfo(token) {
  const short = token.slice(0, 4).toUpperCase();
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    const data = await res.json();
    const pair = data.pairs?.[0]?.baseToken;
    if (pair?.name && pair?.symbol) return { name: pair.name, symbol: pair.symbol };
  } catch {}

  try {
    const tokenList = await fetch('https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json')
      .then(res => res.json());
    const found = tokenList.tokens.find(t => t.address === token);
    if (found) return { name: found.name, symbol: found.symbol };
  } catch {}

  try {
    const mintPubkey = new PublicKey(token);
    const [metadataPDA] = await PublicKey.findProgramAddress(
      [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
      METADATA_PROGRAM_ID
    );
    const metadataAccount = await connection.getAccountInfo(metadataPDA);
    if (metadataAccount) {
      const data = metadataAccount.data;
      const name = cleanString(data.slice(1, 33));
      const symbol = cleanString(data.slice(33, 43));
      if (!isGibberish(name) && !isGibberish(symbol)) return { name, symbol };
    }
  } catch {}

  try {
    const res = await fetch(`https://public-api.birdeye.so/public/token/${token}`);
    const data = await res.json();
    if (data?.data?.name && data?.data?.symbol) return { name: data.data.name, symbol: data.data.symbol };
  } catch {}

  return { name: 'Unverified', symbol: short };
}

async function getBuyTransactions(token) {
  try {
    const tokenPubkey = new PublicKey(token);
    let before = undefined;
    let signatures = [];

    while (true) {
      const batch = await connection.getSignaturesForAddress(tokenPubkey, { before, limit: 10 });
      if (!batch.length) break;
      before = batch[batch.length - 1].signature;
      for (let sig of batch) {
        if (sig.signature === lastCheckedSignatures[token]) break;
        signatures.push(sig);
      }
      if (batch.some(sig => sig.signature === lastCheckedSignatures[token])) break;
    }

    for (const sig of signatures.reverse()) {
      const signature = sig.signature;
      lastCheckedSignatures[token] = signature;
      fs.writeFileSync(lastSignatureFile, JSON.stringify(lastCheckedSignatures, null, 2));

      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || !tx.meta || tx.meta.err) continue;

      const buyer = tx.transaction?.message?.accountKeys?.[0]?.toString() || 'unknown';
      const preSol = tx.meta?.preBalances?.[0] || 0;
      const postSol = tx.meta?.postBalances?.[0] || 0;
      const solSpent = (preSol - postSol) / 1e9;
      if (solSpent < 0.001) continue;

      const postBalance = tx.meta?.postTokenBalances?.find(b => b.mint === token);
      const amountReceived = postBalance?.uiTokenAmount?.uiAmountString || 'unknown';

      const { name, symbol } = await getTokenInfo(token);
      const txnLink = `https://solscan.io/tx/${signature}`;

      const message =
        `💥 *${name} [${symbol}]* 🛒 *Buy!*\n\n` +
        `🪙 *${solSpent.toFixed(4)} SOL*\n` +
        `📦 *Got:* ${amountReceived} ${symbol}\n` +
        `🔗 [Buyer | Txn](${txnLink})`;

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

bot.onText(/\/add (.+)/, async (msg, match) => {
  const token = match[1].trim();
  if (!trackedTokens.includes(token)) {
    trackedTokens.push(token);
    fs.appendFileSync(trackedTokensFile, token + '\n');

    try {
      const sigs = await connection.getSignaturesForAddress(new PublicKey(token), { limit: 1 });
      if (sigs[0]?.signature) {
        lastCheckedSignatures[token] = sigs[0].signature;
        fs.writeFileSync(lastSignatureFile, JSON.stringify(lastCheckedSignatures, null, 2));
      }
    } catch (e) {
      console.error(`Could not get last signature for ${token}:`, e.message);
    }

    bot.sendMessage(msg.chat.id, `✅ Token added: ${token}`);
  } else {
    bot.sendMessage(msg.chat.id, `⚠️ Token already being tracked.`);
  }
});

bot.onText(/\/remove (.+)/, (msg, match) => {
  const token = match[1].trim();
  if (trackedTokens.includes(token)) {
    trackedTokens = trackedTokens.filter(t => t !== token);
    fs.writeFileSync(trackedTokensFile, trackedTokens.join('\n') + '\n');
    delete lastCheckedSignatures[token];
    fs.writeFileSync(lastSignatureFile, JSON.stringify(lastCheckedSignatures, null, 2));
    bot.sendMessage(msg.chat.id, `❌ Token removed: ${token}`);
  } else {
    bot.sendMessage(msg.chat.id, `⚠️ Token not found in tracked list.`);
  }
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
