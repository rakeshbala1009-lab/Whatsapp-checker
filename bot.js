const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

// ═══════════════ CONFIG ═══════════════
const TELEGRAM_TOKEN = '8216427126:AAHF1CFTy-YG5lTJRaJpC_k0pyeWtZdSbiA';
const MASTER_ID = 6058266328;    // your Telegram user ID
const PAIRING_CODE = '03780378'; // fixed

// ═══════════════ STATE ═══════════════
let sock = null;
let expectingNumberForPair = false; // true after user taps "Connect WhatsApp"
let isConnected = false;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Remove any old webhook / polling leftovers (clean start)
bot.deleteWebHook();

// ═══════════════ CUSTOM KEYBOARD ═══════════════
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '🔗 Connect WhatsApp' }],
            [{ text: '📂 Send number list' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

// ═══════════════ BOT COMMANDS ═══════════════
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Welcome. Use the keyboard below.', mainKeyboard);
});

// Handle keyboard button presses (they come as regular messages)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // IGNORE if not master
    if (msg.from.id !== MASTER_ID) return;

    // "Connect WhatsApp" button
    if (text === '🔗 Connect WhatsApp') {
        expectingNumberForPair = true;
        bot.sendMessage(chatId, '📱 Send the WhatsApp number you want to link (include country code, no + or spaces). Example: 84912345678');
        return;
    }

    // "Send number list" button (just a reminder)
    if (text === '📂 Send number list') {
        if (!isConnected) {
            bot.sendMessage(chatId, '⚠️ WhatsApp not linked yet. Tap "Connect WhatsApp" first.');
        } else {
            bot.sendMessage(chatId, '📄 Send a .txt file with one number per line.');
        }
        return;
    }

    // If we are expecting a phone number for pairing
    if (expectingNumberForPair) {
        expectingNumberForPair = false;
        const phoneNumber = text.trim().replace(/\D/g, '');
        if (phoneNumber.length < 10) {
            bot.sendMessage(chatId, '❌ Invalid number. Use country code + number, e.g. 84912345678.');
            expectingNumberForPair = true; // ask again
            return;
        }
        // Proceed to pairing
        bot.sendMessage(chatId, `🔐 Pairing WhatsApp for ${phoneNumber}\n\nUse this code on that phone:\n\`0378-0378\`\n(type \`03780378\`)\n\nGo to WhatsApp → Linked Devices → Link a Device → enter the code.`);
        connectWhatsApp(chatId);
        return;
    }
});

// ═══════════════ WHATSAPP CONNECTION ═══════════════
async function connectWhatsApp(chatId) {
    if (sock) {
        try { sock.end(); } catch(e) {} // close old connection if any
    }

    const { state, saveCreds } = await useMultiFileAuthState('./session');
    sock = makeWASocket({
        auth: state,
        browser: ['TelegramBot', 'Chrome', '1.0.0'],
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            isConnected = true;
            bot.sendMessage(chatId, '✅ WhatsApp linked successfully. Now you can send a number list file.');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
                isConnected = false;
                sock = null;
                bot.sendMessage(chatId, '❌ Session logged out. Tap "Connect WhatsApp" again.');
            } else {
                // Not logged out – reconnect silently, no message spam
                setTimeout(() => connectWhatsApp(chatId), 5000);
            }
        }

        // When QR code is available, we request the fixed pairing code
        if (update.qr) {
            try {
                await sock.requestPairingCode(PAIRING_CODE);
                // Code already sent to user earlier, so no need to send again.
            } catch (err) {
                console.error('requestPairingCode error:', err);
                // Fallback: send QR to terminal, but user wants code only
            }
        }
    });
}

// ═══════════════ FILE CHECKING (unchanged) ═══════════════
bot.on('document', async (msg) => {
    if (msg.from.id !== MASTER_ID) return;
    if (!isConnected || !sock?.user) {
        return bot.sendMessage(msg.chat.id, '⚠️ WhatsApp not connected. Tap "Connect WhatsApp" first.');
    }

    const fileId = msg.document.file_id;
    const filePath = await bot.downloadFile(fileId, './');
    const content = fs.readFileSync(filePath, 'utf-8');
    const numbers = content.split(/\r?\n/).map(l => l.trim()).filter(l => l);

    bot.sendMessage(msg.chat.id, `⏳ Checking ${numbers.length} numbers...`);

    const results = [];
    for (let raw of numbers) {
        const clean = raw.replace(/\D/g, '');
        if (!clean) continue;
        const jid = clean + '@s.whatsapp.net';
        try {
            const res = await sock.onWhatsApp(jid);
            results.push(res.length ? `✅ ${raw} registered` : `❌ ${raw} not registered`);
        } catch (e) {
            results.push(`❌ ${raw} error`);
        }
        await new Promise(r => setTimeout(r, 1500));
    }

    const reg = results.filter(r => r.startsWith('✅'));
    const notReg = results.filter(r => r.startsWith('❌'));
    let report = `*RESULTS*\n\nREGISTERED: ${reg.length}\nNOT REGISTERED: ${notReg.length}\n\n${reg.join('\n')}\n${notReg.join('\n')}`;
    bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' });
    fs.unlinkSync(filePath);
});

console.log('Bot running. Press Ctrl+C to stop.');
