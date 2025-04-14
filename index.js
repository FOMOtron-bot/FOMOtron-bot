import express from 'express';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import bs58 from 'bs58';

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

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

async function getTokenMetadata(mintAddress) {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const [metadataPDA] = await PublicKey.findProgramAddress(
      [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
      METADATA_PROGRAM_ID
    );

    const metadataAccount = await connection.getAccountInfo(metadataPDA);
    if (!metadataAccount) return null;

    const data = metadataAccount.data;
    const name = data.slice(1, 33).toString('utf8').replace(/\0/g, '').trim();
    const symbol = data.slice(33, 43).toString('utf8').replace(/\0/g, '').trim();
    return { name, symbol };
  } catch (e) {
    console.error('Metadata fetch failed:', e.message);
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

      let symbol = token.slice(0, 4) + '...' + token.slice(-4);
      let name = symbol;
      const metadata = await getTokenMetadata(token);
      if (metadata) {
        symbol = metadata.symbol || symbol;
        name = metadata.name || name;
      }

      const dexsRes = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${token}`);
      const dexsData = await dexsRes.json();
      const pair = dexsData?.pair || {};
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

