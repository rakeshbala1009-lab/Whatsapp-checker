const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const TELEGRAM_TOKEN = '8216427126:AAHF1CFTy-YG5lTJRaJpC_k0pyeWtZdSbiA';
const MASTER_ID = 6058266328;

let sock = null;
let expectingNumberForPair = false;
let isConnected = false;
let pairingChatId = null;               // where to send the code when ready

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// keyboard
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

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Welcome. Use the keyboard.', mainKeyboard);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (msg.from.id !== MASTER_ID) return;

    if (text === '🔗 Connect WhatsApp') {
        expectingNumberForPair = true;
        bot.sendMessage(chatId, '📱 Send the WhatsApp number you want to link (country code, no +). e.g. 8801735009378');
        return;
    }

    if (text === '📂 Send number list') {
        if (!isConnected) {
            bot.sendMessage(chatId, '⚠️ WhatsApp not linked. Tap "Connect WhatsApp" first.');
        } else {
            bot.sendMessage(chatId, '📄 Send a .txt file with one number per line.');
        }
        return;
    }

    if (expectingNumberForPair) {
        expectingNumberForPair = false;
        const phoneNumber = text.trim().replace(/\D/g, '');
        if (phoneNumber.length < 10) {
            bot.sendMessage(chatId, '❌ Invalid number. Try again.');
            expectingNumberForPair = true;
            return;
        }

        pairingChatId = chatId;
        bot.sendMessage(chatId, '⏳ Requesting a real pairing code from WhatsApp...');
        connectWhatsApp(chatId);
    }
});

async function connectWhatsApp(chatId) {
    // Clean up any old session socket
    if (sock) { try { sock.end(); } catch(e) {} sock = null; }

    const { state, saveCreds } = await useMultiFileAuthState('./session');
    sock = makeWASocket({
        auth: state,
        browser: ['TelegramBot', 'Chrome', '1.0.0'],
        printQRInTerminal: false,
        pairingCode: true          // <--- native pairing code mode (v7+)
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        // ---- pairing code generated ----
        if (update.pairingCode) {
            const code = update.pairingCode;   // e.g. "X7KM3F2Q"
            const display = code.slice(0,4) + '-' + code.slice(4);
            bot.sendMessage(
                pairingChatId,
                `🔐 *Your real linking code is ready*\n\n\`${display}\`\n\n(Type \`${code}\` without dash on that phone:\nWhatsApp → Linked Devices → Link a Device)`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // ---- connection open ----
        if (connection === 'open') {
            isConnected = true;
            if (pairingChatId) {
                bot.sendMessage(pairingChatId, '✅ WhatsApp linked. You can now send a number list file.');
                pairingChatId = null;
            }
            return;
        }

        // ---- connection closed ----
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
                isConnected = false;
                sock = null;
                if (pairingChatId) {
                    bot.sendMessage(pairingChatId, '❌ Session logged out. Tap "Connect WhatsApp" again.');
                    pairingChatId = null;
                }
                return;
            }
            // Reconnect silently
            setTimeout(() => connectWhatsApp(chatId), 5000);
        }
    });
}

// ---- number check ----
bot.on('document', async (msg) => {
    if (msg.from.id !== MASTER_ID) return;
    if (!isConnected || !sock?.user) {
        return bot.sendMessage(msg.chat.id, '⚠️ WhatsApp not connected. Tap "Connect WhatsApp" first.');
    }

    const filePath = await bot.downloadFile(msg.document.file_id, './');
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
            results.push(res.length ? `✅ ${raw}` : `❌ ${raw}`);
        } catch (e) {
            results.push(`❌ ${raw}`);
        }
        await new Promise(r => setTimeout(r, 1500));
    }

    const reg = results.filter(r => r.startsWith('✅'));
    const notReg = results.filter(r => r.startsWith('❌'));
    let report = `*RESULTS*\n\nREGISTERED: ${reg.length}\nNOT REGISTERED: ${notReg.length}\n\n${reg.join('\n')}\n${notReg.join('\n')}`;
    bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' });
    fs.unlinkSync(filePath);
});

console.log('Bot running with native pairing code.');
