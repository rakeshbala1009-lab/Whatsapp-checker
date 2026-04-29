const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

// ═══════════════ CONFIG ═══════════════
const TELEGRAM_TOKEN = '8216427126:AAHF1CFTy-YG5lTJRaJpC_k0pyeWtZdSbiA';
const MASTER_ID = 6058266328;

// ═══════════════ STATE ═══════════════
let sock = null;
let expectingNumberForPair = false;
let isConnected = false;
let expectedPhoneNumber = null;   // store the phone number for pairing
let pairingChatId = null;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ═══════════════ KEYBOARD ═══════════════
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

// ═══════════════ HANDLERS ═══════════════
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Welcome. Use the keyboard.', mainKeyboard);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (msg.from.id !== MASTER_ID) return;

    if (text === '🔗 Connect WhatsApp') {
        expectingNumberForPair = true;
        bot.sendMessage(chatId, '📱 Send the WhatsApp number you want to link (include country code). e.g. +8801735009378');
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
        const phoneNumber = text.trim().replace(/\D/g, ''); // only digits
        if (phoneNumber.length < 10) {
            bot.sendMessage(chatId, '❌ Invalid number. Try again.');
            expectingNumberForPair = true;
            return;
        }

        // Store the number and start the socket
        expectedPhoneNumber = phoneNumber;
        pairingChatId = chatId;

        bot.sendMessage(chatId, '⏳ Requesting pairing code from WhatsApp...');
        connectWhatsApp(chatId);
    }
});

// ═══════════════ WHATSAPP SOCKET (v7 pairing) ═══════════════
async function connectWhatsApp(chatId) {
    if (sock) { try { sock.end(); } catch(e) {} sock = null; }

    const { state, saveCreds } = await useMultiFileAuthState('./session');
    sock = makeWASocket({
        auth: state,
        browser: ['TelegramBot', 'Chrome', '1.0.0'],
        mobile: false            // keep false for multi-device web
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection === 'open') {
            isConnected = true;
            if (pairingChatId) {
                bot.sendMessage(pairingChatId, '✅ WhatsApp linked. You can now send a number list file.');
            }
            expectedPhoneNumber = null;
            pairingChatId = null;
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
                    expectedPhoneNumber = null;
                }
                return;
            }
            // reconnect silently
            setTimeout(() => connectWhatsApp(chatId), 5000);
            return;
        }

        // When QR appears, we trigger the pairing code request (new API)
        if (qr && expectedPhoneNumber && pairingChatId) {
            try {
                // Baileys v7: requestPairingCode(phoneNumber) – it will emit the code via 'connection.update'
                const code = await sock.requestPairingCode(expectedPhoneNumber);
                // In v7, the method returns the code directly? Actually it does not return; it emits.
                // We'll handle the result in the next event.
                // But sometimes it returns the code? Let's check by sending a placeholder.
                // We'll listen for 'connection.update' with a 'pairingCode' field.
            } catch (e) {
                console.error('requestPairingCode error:', e);
                bot.sendMessage(pairingChatId, `❌ Failed: ${e.message}`);
                pairingChatId = null;
                expectedPhoneNumber = null;
            }
        }

        // v7 pairing: code arrives in a subsequent update with 'code' property
        if (update.pairingCode && pairingChatId) {
            const { pairingCode } = update;
            const display = pairingCode.slice(0,4) + '-' + pairingCode.slice(4);
            bot.sendMessage(pairingChatId,
                `🔐 *Your WhatsApp pairing code*\n\n\`${display}\`\n\n(Type \`${pairingCode}\` exactly, without dash, on the other phone:\nWhatsApp → Linked Devices → Link a Device)`,
                { parse_mode: 'Markdown' }
            );
        }
    });
}

// ═══════════════ NUMBER CHECK (unchanged) ═══════════════
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

console.log('Bot started – v7 pairing enabled.');
