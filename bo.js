const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

// ═══════════════ CONFIG ═══════════════
const TELEGRAM_TOKEN = '8216427126:AAHF1CFTy-YG5lTJRaJpC_k0pyeWtZdSbiA';

// ═══════════════ STATE ═══════════════
let expectingMaytapiUrl = false;
let isConnected = false;

// API pool & active instance
let apiPool = [];                     // { productId, phoneId, token, chatId }
let activeApi = null;                 // same type as above, but currently used
let activeStatusPollInterval = null;

// Number checking progress
let checkingChatId = null;
let checkingMessageId = null;
let checkingTotal = 0;
let checkingDone = 0;
let checkingResults = [];            // { number, registered }

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// keyboard
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '🔗 Connect WhatsApp' }, { text: '🔌 Disconnect' }],
            [{ text: '📂 Send number list' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

// helpers
function cleanNumber(raw) {
    return raw.replace(/\D/g, '');
}

function parseMaytapiUrl(url) {
    const regex = /\/api\/([^\/]+)\/([^\/]+)\/(?:screen|status|qrCode)(?:\?|$)/;
    const match = url.match(regex);
    if (!match) return null;
    const productId = match[1];
    const phoneId = match[2];
    const urlObj = new URL(url);
    const token = urlObj.searchParams.get('token');
    if (!token) return null;
    return { productId, phoneId, token };
}

// ─── Maytapi API helpers (uses an API entry) ───
async function getQrCode(api) {
    const url = `https://api.maytapi.com/api/${api.productId}/${api.phoneId}/screen?token=${api.token}`;
    const resp = await axios.get(url, { responseType: 'arraybuffer' });
    return resp.data;
}

async function getStatus(api) {
    const url = `https://api.maytapi.com/api/${api.productId}/${api.phoneId}/status?token=${api.token}`;
    const resp = await axios.get(url);
    return resp.data;
}

function isStatusConnected(raw) {
    if (!raw) return false;
    if (typeof raw === 'string' && raw.toLowerCase() === 'connected') return true;
    if (raw.status) {
        if (raw.status.loggedIn === true) return true;
        if (raw.status.state && raw.status.state.state === 'CONNECTED') return true;
    }
    if (raw.connected === true) return true;
    if (raw.status === 'connected') return true;
    if (raw.result && raw.result.status && raw.result.status.toString() === '200') return true;
    return false;
}

async function checkNumber(api, phoneNumber) {
    const url = `https://api.maytapi.com/api/${api.productId}/${api.phoneId}/checkNumberStatus`;
    const resp = await axios.get(url, {
        params: {
            token: api.token,
            number: `${phoneNumber}@c.us`
        }
    });
    return resp.data;
}

// ─── Pool management ───
function findApiIndex(api) {
    return apiPool.findIndex(a => a.productId === api.productId && a.phoneId === api.phoneId);
}

async function trySetActiveFromPool(chatId = null) {
    // Stop any existing polling
    if (activeStatusPollInterval) {
        clearInterval(activeStatusPollInterval);
        activeStatusPollInterval = null;
    }

    // If we already have an active API that is connected, keep it
    if (activeApi) {
        try {
            const st = await getStatus(activeApi);
            if (isStatusConnected(st)) {
                isConnected = true;
                return true; // still good
            }
        } catch (e) {}
        // Active is dead, remove it from pool
        const idx = findApiIndex(activeApi);
        if (idx !== -1) apiPool.splice(idx, 1);
        activeApi = null;
    }

    // Pick the first connected API from the pool
    for (let i = 0; i < apiPool.length; i++) {
        try {
            const st = await getStatus(apiPool[i]);
            if (isStatusConnected(st)) {
                activeApi = apiPool.splice(i, 1)[0]; // remove from pool, store as active
                isConnected = true;
                // Start polling for this active API
                activeStatusPollInterval = setInterval(async () => {
                    try {
                        const status = await getStatus(activeApi);
                        if (!isStatusConnected(status)) {
                            // Active died, switch
                            await trySetActiveFromPool(null);
                        }
                    } catch (e) {
                        // connection error, treat as dead
                        await trySetActiveFromPool(null);
                    }
                }, 10000);
                return true;
            }
        } catch (e) {}
    }
    // No connected API available
    isConnected = false;
    activeApi = null;
    return false;
}

// ─── Progress updating ───
async function updateProgress() {
    if (!checkingChatId || !checkingMessageId) return;
    try {
        await bot.editMessageText(
            `Number checking ${checkingDone}/${checkingTotal}`,
            { chat_id: checkingChatId, message_id: checkingMessageId }
        );
    } catch (e) {
        if (e.response && e.response.statusCode === 400) {
            // message deleted or not modified, ignore
        }
    }
}

// ─── Bot handlers ───
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Welcome. Use the keyboard.', mainKeyboard);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return;

    // ── Connect button ──
    if (text === '🔗 Connect WhatsApp') {
        expectingMaytapiUrl = true;
        bot.sendMessage(chatId,
            '🔗 Send your Maytapi screen URL.\n\n' +
            'Format: `https://api.maytapi.com/api/{product_id}/{phone_id}/screen?token=...`',
            { parse_mode: 'Markdown' }
        );
        return;
    }

    // ── Disconnect button ──
    if (text === '🔌 Disconnect') {
        if (!activeApi) {
            bot.sendMessage(chatId, '⚠️ No active WhatsApp instance to disconnect.');
            return;
        }

        // Stop polling, remove active, try next pool
        if (activeStatusPollInterval) {
            clearInterval(activeStatusPollInterval);
            activeStatusPollInterval = null;
        }
        // Actually we remove active API entirely; user requested disconnect.
        // We won't put it back into pool. Let it be gone.
        activeApi = null;
        isConnected = false;

        bot.sendMessage(chatId, '🔌 Disconnected. Looking for another connected instance...');
        const switched = await trySetActiveFromPool(chatId);
        if (switched) {
            bot.sendMessage(chatId, '✅ Switched to another WhatsApp instance.');
        } else {
            bot.sendMessage(chatId, '❌ No other WhatsApp instance available.');
        }
        return;
    }

    // ── Send number list button ──
    if (text === '📂 Send number list') {
        if (!isConnected) {
            bot.sendMessage(chatId, '⚠️ No active WhatsApp instance. Tap "Connect WhatsApp" first.');
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

        // Check if already in pool or active
        const existsActive = activeApi && activeApi.productId === parsed.productId && activeApi.phoneId === parsed.phoneId;
        const existsPool = apiPool.some(a => a.productId === parsed.productId && a.phoneId === parsed.phoneId);
        if (existsActive || existsPool) {
            bot.sendMessage(chatId, '⚠️ This API is already in the pool.');
            return;
        }

        // Add to pool (with chatId for reference, though not used much)
        apiPool.push({ ...parsed, chatId });

        // Check if we can use it immediately
        const connected = await trySetActiveFromPool(chatId);
        if (connected) {
            const st = await getStatus(activeApi);
            const number = st.status ? st.status.number || st.number : st.number;
            bot.sendMessage(chatId, `✅ WhatsApp connected (+${number}). The bot is now using this instance.`);
        } else {
            bot.sendMessage(chatId, '📌 API added to pool. It is either not connected or another instance is already active. The bot will use the first available connected instance.');
        }
        return;
    }
});

// ── File check ──
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    if (!isConnected || !activeApi) {
        return bot.sendMessage(chatId, '⚠️ No active WhatsApp instance. Tap "Connect WhatsApp" first.');
    }

    try {
        const filePath = await bot.downloadFile(msg.document.file_id, './');
        const content = fs.readFileSync(filePath, 'utf-8');
        const numbers = content.split(/\r?\n/).map(l => l.trim()).filter(l => l);
        fs.unlinkSync(filePath);

        // Initialize progress
        checkingChatId = chatId;
        checkingDone = 0;
        checkingTotal = numbers.length;
        checkingResults = [];

        const progressMsg = await bot.sendMessage(chatId, `Number checking 0/${checkingTotal}`);
        checkingMessageId = progressMsg.message_id;

        const registered = [];
        const fresh = [];

        for (let raw of numbers) {
            const clean = cleanNumber(raw);
            if (!clean) {
                checkingDone++;
                continue;
            }

            let reg = false;
            try {
                const res = await checkNumber(activeApi, clean);
                if (res.success && res.result && res.result.status === 200) {
                    reg = true;
                }
            } catch (e) {
                reg = false; // error treated as not registered
            }

            if (reg) registered.push(clean);
            else fresh.push(clean);

            checkingDone++;
            await updateProgress();

            // Rate limit: 50ms for ~20 checks/sec
            await new Promise(r => setTimeout(r, 50));
        }

        // Delete progress message
        try {
            await bot.deleteMessage(chatId, checkingMessageId);
        } catch (e) {}

        // Build final report
        let report = '';
        if (registered.length > 0) {
            report += '*Already Created Account Number ✅ :*\n';
            report += registered.join('\n') + '\n\n';
        }
        if (fresh.length > 0) {
            report += '*Fresh Number ❌*\n';
            report += fresh.map(n => `+${n}`).join('\n');
        }

        if (report) {
            await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
        } else {
            await bot.sendMessage(chatId, 'All numbers processed (no valid numbers).');
        }

    } catch (err) {
        console.error('File/check error:', err);
        bot.sendMessage(chatId, '❌ Error processing file.');
    }
});

console.log('Bot running – shared API pool, 20/s checks, live progress');
