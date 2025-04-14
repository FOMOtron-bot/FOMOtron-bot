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
  ? fs.readFileSync(trackedTokensFile, 'utf-8').split('\n').filter(Boolean).map(t => t.trim())
  : [];

let lastCheckedSignature = null;
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

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

  // 1. Solana Token List
  try {
    const tokenList = await fetch('https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json')
      .then(res => res.json());
    const found = tokenList.tokens.find(t => t.address === token);
    if (found) {
      let name = found.name;
      let symbol = found.symbol;
      if (looksLikeAddress(name)) name = 'Unverified';
      if (looksLikeAddress(symbol)) symbol = short;
      return { name, symbol };
    }
  } catch (e) {
    console.error('Token list failed:', e.message);
  }

  // 2. Metaplex Metadata
  try {
    const mintPubkey = new PublicKey(token);
    const [metadataPDA] = await PublicKey.findProgramAddress(
      [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
      METADATA_PROGRAM_ID
    );
    const metadataAccount = await connection.getAccountInfo(metadataPDA);
    if (metadataAccount) {
      const data = metadataAccount.data;
      const nameRaw = data.slice(1, 33);
      const symbolRaw = data.slice(33, 43);
      let name = cleanString(nameRaw);
      let symbol = cleanString(symbolRaw);
      if (!isGibberish(name) && !isGibberish(symbol)) {
        if (looksLikeAddress(name)) name = 'Unverified';
        if (looksLikeAddress(symbol)) symbol = short;
        return { name, symbol };
      }
    }
  } catch (e) {
    console.error('Metaplex metadata failed:', e.message);
  }

  // 3. DexScreener
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${token}`);
    const data = await res.json();
    const pair = data?.pair?.baseToken;
    if (pair?.name && pair?.symbol) {
      let name = pair.name;
      let symbol = pair.symbol;
      if (looksLikeAddress(name)) name = 'Unverified';
      if (looksLikeAddress(symbol)) symbol = short;
      return { name, symbol };
    }
  } catch (e) {
    console.error('DexScreener fallback failed:', e.message);
  }

  // 4. Birdeye
  try {
    const res = await fetch(`https://public-api.birdeye.so/public/token/${token}`);
    const data = await res.json();
    if (data?.data?.name && data?.data?.symbol) {
      let name = data.data.name;
      let symbol = data.data.symbol;
      if (looksLikeAddress(name)) name = 'Unverified';
      if (looksLikeAddress(symbol)) symbol = short;
      return { name, symbol };
    }
  } catch (e) {
    console.error('Birdeye fallback failed:', e.message);
  }

  // Final fallback
  return { name: 'Unverified', symbol: short };
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

      const { name, symbol } = await getTokenInfo(token);

      const dexsRes = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${token}`);
      const dexsData = await dexsRes.json();
      const pair = dexsData?.pair || {};
      const marketCap = pair.fdv ? `$${parseInt(pair.fdv).toLocaleString()}` : 'N/A';
      const position = pair.rank ? `#${pair.rank}` : 'N/A';
      const txnLink = `https://solscan.io/tx/${signature}`;

      const message =
        `💥 *${name} [${symbol}]* 🛒 *Buy!*\n\n` +
        `🪙 *${solSpent} SOL*\n` +
        `📦 *Got:* ${amountReceived} ${symbol}\n` +
        `🔗 [Buyer | Txn](${txnLink})\n` +
        `📊 *Position:* ${position}\n` +
        `💰 *Market Cap:* ${marketCap}`;

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
  const token = match[1].trim();
  if (!trackedTokens.includes(token)) {
    trackedTokens.push(token);
    fs.appendFileSync(trackedTokensFile, token + '\n');
    bot.sendMessage(msg.chat.id, `✅ Token added: ${token}`);
  } else {
    bot.sendMessage(msg.chat.id, `⚠️ Token already being tracked.`);
  }
});

bot.onText(/\/remove (.+)/, (msg, match) => {
  const tokenToRemove = match[1].trim();
  if (trackedTokens.includes(tokenToRemove)) {
    trackedTokens = trackedTokens.filter(t => t !== tokenToRemove);
    fs.writeFileSync(trackedTokensFile, trackedTokens.join('\n') + '\n');
    bot.sendMessage(msg.chat.id, `❌ Token removed: ${tokenToRemove}`);
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
