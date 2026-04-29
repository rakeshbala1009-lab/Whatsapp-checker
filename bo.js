const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

// ═══════════════ CONFIG ═══════════════
const TELEGRAM_TOKEN = '8216427126:AAHF1CFTy-YG5lTJRaJpC_k0pyeWtZdSbiA';
const MASTER_ID = 6058266328;

// ═══════════════ STATE ═══════════════
let expectingMaytapiUrl = false;
let isConnected = false;
let maytapiProductId = null;
let maytapiPhoneId = null;
let maytapiToken = null;
let statusPollInterval = null;   // stores polling timer

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

// helper: strip non‑digits
function cleanNumber(raw) {
    return raw.replace(/\D/g, '');
}

// helper: parse Maytapi URL → product_id, phone_id, token
function parseMaytapiUrl(url) {
    // matches /api/{product_id}/{phone_id}/...?token={token}
    const regex = /\/api\/([^\/]+)\/([^\/]+)\/(?:screen|status|qrCode)(?:\?|$)/;
    const match = url.match(regex);
    if (!match) return null;

    const productId = match[1];
    const phoneId = match[2];

    // extract token from query string
    const urlObj = new URL(url);
    const token = urlObj.searchParams.get('token');
    if (!token) return null;

    return { productId, phoneId, token };
}

// maytapi API calls
async function getQrCode() {
    const url = `https://api.maytapi.com/api/${maytapiProductId}/${maytapiPhoneId}/screen?token=${maytapiToken}`;
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    return resp.data;  // png buffer
}

async function getStatus() {
    const url = `https://api.maytapi.com/api/${maytapiProductId}/${maytapiPhoneId}/status?token=${maytapiToken}`;
    const resp = await axios.get(url);
    return resp.data;  // { connected: true/false, ... }
}

async function checkNumber(phoneNumber) {
    const url = `https://api.maytapi.com/api/${maytapiProductId}/${maytapiPhoneId}/checkNumberStatus`;
    const resp = await axios.get(url, {
        params: {
            token: maytapiToken,
            number: `${phoneNumber}@c.us`
        }
    });
    return resp.data;
}

// ═══════════════ BOT HANDLERS ═══════════════
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Welcome. Use keyboard.', mainKeyboard);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (msg.from.id !== MASTER_ID) return;

    // ── Connect button ──
    if (text === '🔗 Connect WhatsApp') {
        expectingMaytapiUrl = true;
        bot.sendMessage(chatId,
            '🔗 Send your Maytapi screen URL.\n\n' +
            'Format: `https://api.maytapi.com/api/{product_id}/{phone_id}/screen?token=...`\n\n' +
            'Example: `https://api.maytapi.com/api/d4eb8e07-ee12-4dfd-a601-6eb5642d85ed/141261/screen?token=0746191c-8978-4b44-b5f7-39d86b90f04a`',
            { parse_mode: 'Markdown' }
        );
        return;
    }

    // ── Send number list button ──
    if (text === '📂 Send number list') {
        if (!isConnected) {
            bot.sendMessage(chatId, '⚠️ WhatsApp not linked. Tap "Connect WhatsApp" first.');
        } else {
            bot.sendMessage(chatId, '📄 Send a .txt file with one number per line.');
        }
        return;
    }

    // ── User sent Maytapi URL ──
    if (expectingMaytapiUrl) {
        expectingMaytapiUrl = false;

        const parsed = parseMaytapiUrl(text.trim());
        if (!parsed) {
            bot.sendMessage(chatId, '❌ Invalid URL format. Tap "Connect WhatsApp" and send a valid Maytapi screen URL.');
            return;
        }

        maytapiProductId = parsed.productId;
        maytapiPhoneId = parsed.phoneId;
        maytapiToken = parsed.token;

        bot.sendMessage(chatId, '⏳ Fetching QR code from Maytapi...');

        try {
            // Fetch QR code image
            const qrBuffer = await getQrCode();
            const imgPath = `./qr_${Date.now()}.png`;
            fs.writeFileSync(imgPath, qrBuffer);

            await bot.sendPhoto(chatId, imgPath, {
                caption: '📷 Scan this QR code on the target phone:\n\nWhatsApp → Linked Devices → Link a Device\n\n*Bot will notify you once connected.*',
                parse_mode: 'Markdown'
            });
            fs.unlinkSync(imgPath);

            // Start polling status
            bot.sendMessage(chatId, '⏳ Waiting for you to scan the QR code...');

            // Clear any existing poll
            if (statusPollInterval) clearInterval(statusPollInterval);

            let attempts = 0;
            statusPollInterval = setInterval(async () => {
                attempts++;
                try {
                    const status = await getStatus();
                    console.log('Status check:', status);

                    // Maytapi returns { connected: true } when ready
                    if (status.connected === true || status.status === 'connected' || status === 'connected') {
                        clearInterval(statusPollInterval);
                        statusPollInterval = null;
                        isConnected = true;
                        bot.sendMessage(chatId, '✅ WhatsApp linked via Maytapi! You can now send a number list file.');
                    }
                } catch (err) {
                    console.error('Status poll error:', err.message);
                }

                // Timeout after 120 attempts (10 minutes)
                if (attempts >= 120) {
                    clearInterval(statusPollInterval);
                    statusPollInterval = null;
                    bot.sendMessage(chatId, '❌ Linking timed out (10 min). Tap "Connect WhatsApp" to try again.');
                }
            }, 5000);   // poll every 5 seconds

        } catch (err) {
            console.error('QR fetch error:', err.response?.data || err.message);
            bot.sendMessage(chatId, '❌ Failed to fetch QR code. Check your Maytapi URL and ensure the phone is active.');
            maytapiProductId = null;
            maytapiPhoneId = null;
            maytapiToken = null;
        }
    }
});

// ═══════════════ FILE CHECK ═══════════════
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    if (msg.from.id !== MASTER_ID) return;
    if (!isConnected) {
        return bot.sendMessage(chatId, '⚠️ No active WhatsApp instance. Tap "Connect WhatsApp" first.');
    }

    try {
        const filePath = await bot.downloadFile(msg.document.file_id, './');
        const content = fs.readFileSync(filePath, 'utf-8');
        const numbers = content.split(/\r?\n/).map(l => l.trim()).filter(l => l);
        fs.unlinkSync(filePath);

        bot.sendMessage(chatId, `⏳ Checking ${numbers.length} numbers via Maytapi...`);

        const results = [];
        for (let raw of numbers) {
            const clean = cleanNumber(raw);
            if (!clean) continue;
            try {
                const res = await checkNumber(clean);
                // res.result.status === 200 → registered
                if (res.success && res.result && res.result.status === 200) {
                    results.push(`✅ ${raw}`);
                } else {
                    results.push(`❌ ${raw}`);
                }
            } catch (e) {
                results.push(`❌ ${raw} (error)`);
            }
            await new Promise(r => setTimeout(r, 500)); // light rate‑limit
        }

        const reg = results.filter(r => r.startsWith('✅'));
        const notReg = results.filter(r => r.startsWith('❌'));
        let report = `*RESULTS*\n\nREGISTERED: ${reg.length}\nNOT REGISTERED: ${notReg.length}\n\n${reg.join('\n')}\n${notReg.join('\n')}`;
        bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });

    } catch (err) {
        console.error('File/check error:', err);
        bot.sendMessage(chatId, '❌ Error processing file.');
    }
});

console.log('Bot running – user provides Maytapi URL.');
