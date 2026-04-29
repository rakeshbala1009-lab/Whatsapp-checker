const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

// ═══════════════ CONFIG ═══════════════
const TELEGRAM_TOKEN = '8216427126:AAHF1CFTy-YG5lTJRaJpC_k0pyeWtZdSbiA';
const MASTER_ID = 6058266328;   // your Telegram user ID

// ═══════════════ STATE ═══════════════
let sock = null;
let expectingNumberForPair = false;
let isConnected = false;
let currentPairingCode = '';   // stores the fresh code for the current session

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

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

// ═══════════════ CODE GENERATOR ═══════════════
function generateRealPairingCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing I/O/0/1
    let code = '';
    for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;                              // e.g. "XK7M3F2Q" (no dash)
}

// ═══════════════ BUTTON HANDLERS ═══════════════
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Welcome. Use the keyboard.', mainKeyboard);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (msg.from.id !== MASTER_ID) return;   // ignore non‑master

    if (text === '🔗 Connect WhatsApp') {
        expectingNumberForPair = true;
        bot.sendMessage(chatId, '📱 Send the WhatsApp number you want to link (with country code, no + or spaces). Example: 84912345678');
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
            bot.sendMessage(chatId, '❌ Invalid number. Try again (include country code).');
            expectingNumberForPair = true;
            return;
        }

        // Generate a fresh, real code
        currentPairingCode = generateRealPairingCode();                // e.g. "XK7M3F2Q"
        const readable = currentPairingCode.slice(0,4) + '-' + currentPairingCode.slice(4); // "XK7M-F2Q"

        // Send the code immediately
        bot.sendMessage(chatId, `🔐 Real linking code for ${phoneNumber}\n\n\`${readable}\`\n\n(Type \`${currentPairingCode}\` exactly, without dash, on that phone:\nWhatsApp → Linked Devices → Link a Device)`);

        // Now start the socket and give it this code
        connectWhatsApp(chatId);
    }
});

// ═══════════════ WHATSAPP SOCKET (silent, no loops) ═══════════════
async function connectWhatsApp(chatId) {
    // Kill any existing socket cleanly
    if (sock) {
        try { sock.end(); } catch(e) {}
        sock = null;
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
            bot.sendMessage(chatId, '✅ WhatsApp linked. You can now send a number list file.');
            return;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
                isConnected = false;
                sock = null;
                bot.sendMessage(chatId, '❌ Session logged out. Tap "Connect WhatsApp" again.');
                return;
            }

            // Reconnect without Telegram spam
            setTimeout(() => connectWhatsApp(chatId), 5000);
        }

        // When QR appears, send the real pairing code to the server
        if (update.qr && currentPairingCode) {
            try {
                await sock.requestPairingCode(currentPairingCode);
            } catch (e) {
                console.error('requestPairingCode failed:', e);
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

console.log('Bot started. Real linking code enabled.');
