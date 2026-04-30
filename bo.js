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
let statusPollInterval = null;

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

// helper: strip non-digits
function cleanNumber(raw) {
    return raw.replace(/\D/g, '');
}

// helper: parse Maytapi URL → product_id, phone_id, token
function parseMaytapiUrl(url) {
    // matches /api/{product_id}/{phone_id}/(screen|status|qrCode)?...
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

// --- Maytapi API helpers ---
async function getQrCode() {
    const url = `https://api.maytapi.com/api/${maytapiProductId}/${maytapiPhoneId}/screen?token=${maytapiToken}`;
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    return resp.data;  // PNG buffer
}

async function getRawStatus() {
    const url = `https://api.maytapi.com/api/${maytapiProductId}/${maytapiPhoneId}/status?token=${maytapiToken}`;
    const resp = await axios.get(url);
    console.log('Maytapi status raw:', resp.data);
    return resp.data;
}

// Returns true if the status response indicates connected
function isStatusConnected(raw) {
    if (!raw) return false;
    // Direct string "connected"
    if (typeof raw === 'string' && raw.toLowerCase() === 'connected') return true;

    // Maytapi v2 format (your response): status.loggedIn, status.state.state='CONNECTED'
    if (raw.status) {
        if (raw.status.loggedIn === true) return true;
        if (raw.status.state && raw.status.state.state === 'CONNECTED') return true;
    }

    // Maytapi v1 / other formats
    if (raw.connected === true) return true;
    if (raw.status === 'connected') return true;
    if (raw.result && raw.result.status && raw.result.status.toString() === '200') return true;
    return false;
}

// Extract profile info: returns { name, phone } or null
function extractProfile(raw) {
    if (!raw) return null;
    let name = raw.name || raw.pushname || raw.senderName || '';
    let phone = raw.phone || raw.meUser || '';

    // Maytapi v2 (your response with status.number)
    if (raw.status) {
        if (!phone) phone = raw.status.number || raw.number || '';
        if (!name) name = raw.status.name || raw.status.pushname || raw.status.senderName || '';
    }

    // Fallback: result.user
    if (!name && raw.result && raw.result.user) {
        name = raw.result.user.name || raw.result.user.pushname || '';
        phone = phone || raw.result.user.phone || raw.result.user.number || '';
    }

    phone = phone.replace(/@c\.us$/, '').replace(/\D/g, '');
    if (name && phone) return { name, phone };
    if (phone) return { name: null, phone };   // only number available
    return null;
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

// --- Bot handlers ---
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

        // ---- Step 1: Check if already connected ----
        let alreadyConnected = false;
        try {
            const statusRaw = await getRawStatus();
            if (isStatusConnected(statusRaw)) {
                alreadyConnected = true;
                const profile = extractProfile(statusRaw);
                const confirmText = profile?.name
                    ? `✅ Already connected as *${profile.name}* (+${profile.phone})`
                    : profile?.phone
                        ? `✅ Already connected as +${profile.phone}`
                        : '✅ WhatsApp already connected.';
                bot.sendMessage(chatId, confirmText + '\nYou can now send a number list file.');
                isConnected = true;
                if (statusPollInterval) { clearInterval(statusPollInterval); statusPollInterval = null; }
            }
        } catch (e) {
            console.error('Initial status check error:', e.message);
            // continue to QR
        }

        if (alreadyConnected) return;

        // ---- Step 2: Not connected → fetch QR and poll ----
        bot.sendMessage(chatId, '⏳ Fetching QR code from Maytapi...');
        try {
            const qrBuffer = await getQrCode();
            const imgPath = `./qr_${Date.now()}.png`;
            fs.writeFileSync(imgPath, qrBuffer);

            await bot.sendPhoto(chatId, imgPath, {
                caption: '📷 Scan this QR code on the target phone:\n\nWhatsApp → Linked Devices → Link a Device\n\n*Bot will notify you once connected.*',
                parse_mode: 'Markdown'
            });
            fs.unlinkSync(imgPath);

            bot.sendMessage(chatId, '⏳ Waiting for you to scan the QR code...');

            // Clear any existing poll
            if (statusPollInterval) clearInterval(statusPollInterval);

            let attempts = 0;
            statusPollInterval = setInterval(async () => {
                attempts++;
                try {
                    const st = await getRawStatus();
                    if (isStatusConnected(st)) {
                        clearInterval(statusPollInterval);
                        statusPollInterval = null;
                        isConnected = true;
                        const profile = extractProfile(st);
                        const confirmText = profile?.name
                            ? `✅ WhatsApp linked as *${profile.name}* (+${profile.phone})`
                            : profile?.phone
                                ? `✅ WhatsApp linked as +${profile.phone}`
                                : '✅ WhatsApp linked.';
                        bot.sendMessage(chatId, confirmText + '\nYou can now send a number list file.');
                        return;
                    }
                } catch (err) {
                    // keep polling silently
                }

                if (attempts >= 120) {
                    clearInterval(statusPollInterval);
                    statusPollInterval = null;
                    bot.sendMessage(chatId, '❌ Linking timed out (10 min). Tap "Connect WhatsApp" to try again.');
                }
            }, 5000);

        } catch (err) {
            console.error('QR fetch error:', err.response?.data || err.message);
            bot.sendMessage(chatId, '❌ Failed to fetch QR code. Check your Maytapi URL and ensure the phone is active.');
            maytapiProductId = null;
            maytapiPhoneId = null;
            maytapiToken = null;
        }
    }
});

// ── File check (unchanged) ──
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
                // Maytapi returns: { success: true, result: { status: 200 } } when registered
                if (res.success && res.result && res.result.status === 200) {
                    results.push(`✅ ${raw}`);
                } else {
                    results.push(`❌ ${raw}`);
                }
            } catch (e) {
                results.push(`❌ ${raw} (error)`);
            }
            await new Promise(r => setTimeout(r, 500)); // rate limit
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

console.log('Bot running – Maytapi instant connect + profile verification');
