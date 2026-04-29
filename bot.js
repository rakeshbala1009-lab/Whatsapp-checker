const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

// ═══════════════ CONFIG ═══════════════
const TELEGRAM_TOKEN = '8216427126:AAHF1CFTy-YG5lTJRaJpC_k0pyeWtZdSbiA';  // Replace
const MASTER_ID = 6058266328;                       // Your Telegram user ID

// ═══════════════ PAIRING CODE (fixed) ═══════════════
function getPairingCode() {
    return { display: '0378-0378', raw: '03780378' };
}

// ═══════════════ GLOBALS ═══════════════
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
let sock = null;

// ═══════════════ CONNECT & PAIR ═══════════════
async function connectToWhatsApp(chatId) {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['TelegramBot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
            bot.sendMessage(chatId, '⏳ Connecting to WhatsApp...');
        }

        if (connection === 'open') {
            bot.sendMessage(chatId, '✅ WhatsApp linked. Send a file with numbers (one per line).');
        }

        if (connection === 'close') {
            const logout = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
            if (logout) {
                bot.sendMessage(chatId, '❌ Session logged out. Send /pair to reconnect.');
            } else {
                bot.sendMessage(chatId, 'Reconnecting...');
                connectToWhatsApp(chatId);
            }
        }

        // Request pairing code when socket is ready
        if (update.qr) {
            try {
                const { display, raw } = getPairingCode();
                await sock.requestPairingCode(raw);
                bot.sendMessage(chatId,
                    `🔐 Link your WhatsApp with this code:\n\n\`${display}\`\n\n(type \`${raw}\` on your phone → Linked Devices → Link a Device)`,
                    { parse_mode: 'Markdown' }
                );
            } catch (err) {
                bot.sendMessage(chatId, 'Pairing code request failed. Check console.');
                console.error(err);
            }
        }
    });
}

// ═══════════════ NUMBER CHECK ═══════════════
async function checkNumbers(numbers) {
    const results = [];
    for (let raw of numbers) {
        const clean = raw.replace(/\D/g, '');
        if (!clean) continue;
        const jid = clean + '@s.whatsapp.net';
        try {
            const info = await sock.onWhatsApp(jid);
            results.push(info.length > 0 ? `${raw}: REGISTERED` : `${raw}: NOT REGISTERED`);
        } catch (e) {
            results.push(`${raw}: NOT REGISTERED`);
        }
        await new Promise(r => setTimeout(r, 1500)); // rate limit
    }
    return results;
}

// ═══════════════ TELEGRAM COMMANDS ═══════════════
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Welcome. Use /pair to link WhatsApp, then send a file.');
});

bot.onText(/\/pair/, async (msg) => {
    if (msg.from.id !== MASTER_ID) return;
    bot.sendMessage(msg.chat.id, 'Initiating pairing...');
    connectToWhatsApp(msg.chat.id);
});

bot.on('document', async (msg) => {
    if (msg.from.id !== MASTER_ID) return;
    if (!sock || !sock.user) {
        return bot.sendMessage(msg.chat.id, 'WhatsApp not connected. Use /pair first.');
    }

    const fileId = msg.document.file_id;
    const filePath = await bot.downloadFile(fileId, './');
    const content = fs.readFileSync(filePath, 'utf-8');
    const numbers = content.split(/\r?\n/).map(l => l.trim()).filter(l => l);

    bot.sendMessage(msg.chat.id, `⏳ Checking ${numbers.length} numbers...`);

    const results = await checkNumbers(numbers);
    const reg = results.filter(r => r.includes('REGISTERED'));
    const notReg = results.filter(r => r.includes('NOT REGISTERED'));

    let report = `*RESULTS*\n✅ REGISTERED: ${reg.length}\n❌ NOT REGISTERED: ${notReg.length}\n\n`;
    report += reg.join('\n') + '\n' + notReg.join('\n');
    bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' });

    fs.unlinkSync(filePath);
});

console.log('Bot started...');
