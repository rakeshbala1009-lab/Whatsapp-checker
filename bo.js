const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const TELEGRAM_TOKEN = '8216427126:AAHF1CFTy-YG5lTJRaJpC_k0pyeWtZdSbiA';
const MASTER_ID = 6058266328;

let sock = null;
let expectingNumberForPair = false;
let isConnected = false;
let pairingChatId = null;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

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

// Strip everything except digits
function cleanNumber(raw) {
    return raw.replace(/\D/g, '');
}

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
        if (!isConnected) bot.sendMessage(chatId, '⚠️ WhatsApp not linked. Tap "Connect WhatsApp" first.');
        else bot.sendMessage(chatId, '📄 Send a .txt file with one number per line.');
        return;
    }

    if (expectingNumberForPair) {
        expectingNumberForPair = false;
        const phoneNumber = cleanNumber(text);
        if (phoneNumber.length < 10) {
            bot.sendMessage(chatId, '❌ Invalid number. Try again.');
            expectingNumberForPair = true;
            return;
        }

        pairingChatId = chatId;
        bot.sendMessage(chatId, '⏳ Requesting real pairing code from WhatsApp...');
        connectWhatsApp(chatId, phoneNumber);
    }
});

async function connectWhatsApp(chatId, phoneNumber) {
    if (sock) { try { sock.end(); } catch(e) {} sock = null; }

    const { state, saveCreds } = await useMultiFileAuthState('./session');
    sock = makeWASocket({
        auth: state,
        browser: ['TelegramBot', 'Chrome', '1.0.0'],
        printQRInTerminal: false,
        // pairingCode: true   // we'll request manually, no need
    });

    sock.ev.on('creds.update', saveCreds);

    // When the socket is ready (QR received), request a pairing code with the phone number
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        console.log('Connection state:', connection, qr ? 'QR ready' : '');

        if (qr && pairingChatId) {
            // Socket is ready for pairing code request
            try {
                console.log('Requesting pairing code for:', phoneNumber);
                const code = await sock.requestPairingCode(phoneNumber);
                console.log('Received real code:', code);
                const display = code.slice(0,4) + '-' + code.slice(4);
                bot.sendMessage(
                    pairingChatId,
                    `🔐 *Real linking code is ready*\n\n\`${display}\`\n\n(Type \`${code}\` without dash on that phone:\nWhatsApp → Linked Devices → Link a Device)`,
                    { parse_mode: 'Markdown' }
                );
            } catch (err) {
                console.error('requestPairingCode error:', err);
                bot.sendMessage(pairingChatId, '❌ Failed to get pairing code. Try again or check logs.');
                pairingChatId = null;
            }
            return;
        }

        if (connection === 'open') {
            isConnected = true;
            if (pairingChatId) {
                bot.sendMessage(pairingChatId, '✅ WhatsApp linked. You can now send a number list file.');
                pairingChatId = null;
            }
            return;
        }

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
            setTimeout(() => connectWhatsApp(chatId, phoneNumber), 5000);
        }
    });

    // Optional: dedicated event for pairing code (some versions)
    sock.ev.on('pairingCode', async ({ code }) => {
        console.log('Pairing code event:', code);
        if (!pairingChatId) return;
        const display = code.slice(0,4) + '-' + code.slice(4);
        await bot.sendMessage(
            pairingChatId,
            `🔐 *Real linking code ready*\n\n\`${display}\`\n\n(Type \`${code}\` on the target phone → Linked Devices → Link a Device)`,
            { parse_mode: 'Markdown' }
        );
    });
}

// --- file check (unchanged) ---
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
        const clean = cleanNumber(raw);
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

console.log('Bot started with explicit code request');
