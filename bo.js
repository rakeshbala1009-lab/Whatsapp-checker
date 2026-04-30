const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ═══════════════ CONFIG ═══════════════
const TELEGRAM_TOKEN = '8752592084:AAFnnKL53CVHAgR-gWhvPgUDdhwDAO18L0k';

// ═══════════════ STATE ═══════════════
let expectingMaytapiUrl = false;
let isConnected = false;

let apiPool = [];
let activeApi = null;
let activeStatusPollInterval = null;

let checkingChatId = null;
let checkingMessageId = null;
let checkingTotal = 0;
let checkingDone = 0;
let checkingResults = [];

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

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

// Maytapi helpers
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

// Pool management
function findApiIndex(api) {
    return apiPool.findIndex(a => a.productId === api.productId && a.phoneId === api.phoneId);
}

async function trySetActiveFromPool(chatId = null) {
    if (activeStatusPollInterval) {
        clearInterval(activeStatusPollInterval);
        activeStatusPollInterval = null;
    }
    if (activeApi) {
        try {
            const st = await getStatus(activeApi);
            if (isStatusConnected(st)) {
                isConnected = true;
                return true;
            }
        } catch (e) {}
        const idx = findApiIndex(activeApi);
        if (idx !== -1) apiPool.splice(idx, 1);
        activeApi = null;
    }
    for (let i = 0; i < apiPool.length; i++) {
        try {
            const st = await getStatus(apiPool[i]);
            if (isStatusConnected(st)) {
                activeApi = apiPool.splice(i, 1)[0];
                isConnected = true;
                activeStatusPollInterval = setInterval(async () => {
                    try {
                        const status = await getStatus(activeApi);
                        if (!isStatusConnected(status)) {
                            await trySetActiveFromPool(null);
                        }
                    } catch (e) {
                        await trySetActiveFromPool(null);
                    }
                }, 10000);
                return true;
            }
        } catch (e) {}
    }
    isConnected = false;
    activeApi = null;
    return false;
}

// Progress update
async function updateProgress() {
    if (!checkingChatId || !checkingMessageId) return;
    try {
        await bot.editMessageText(
            `Number checking ${checkingDone}/${checkingTotal}`,
            { chat_id: checkingChatId, message_id: checkingMessageId }
        );
    } catch (e) {}
}

// Concurrency limiter
async function asyncPool(poolLimit, array, iteratorFn) {
    const ret = [];
    const executing = new Set();
    for (const item of array) {
        const p = Promise.resolve().then(() => iteratorFn(item));
        ret.push(p);
        executing.add(p);
        const clean = () => executing.delete(p);
        p.then(clean, clean);
        if (executing.size >= poolLimit) {
            await Promise.race(executing);
        }
    }
    return Promise.all(ret);
}

// ═══════════════ BOT HANDLERS ═══════════════
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Welcome. Use the keyboard.', mainKeyboard);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return;

    if (text === '🔗 Connect WhatsApp') {
        expectingMaytapiUrl = true;
        bot.sendMessage(chatId,
            '🔗 Send your Maytapi screen URL.\n\n' +
            'Format: `https://api.maytapi.com/api/{product_id}/{phone_id}/screen?token=...`',
            { parse_mode: 'Markdown' }
        );
        return;
    }

    if (text === '🔌 Disconnect') {
        if (!activeApi) {
            bot.sendMessage(chatId, '⚠️ No active WhatsApp instance to disconnect.');
            return;
        }
        if (activeStatusPollInterval) {
            clearInterval(activeStatusPollInterval);
            activeStatusPollInterval = null;
        }
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

    if (text === '📂 Send number list') {
        if (!isConnected) {
            bot.sendMessage(chatId, '⚠️ No active WhatsApp instance. Tap "Connect WhatsApp" first.');
        } else {
            bot.sendMessage(chatId, '📄 Send a .txt file with one number per line.');
        }
        return;
    }

    if (expectingMaytapiUrl) {
        expectingMaytapiUrl = false;
        const parsed = parseMaytapiUrl(text.trim());
        if (!parsed) {
            bot.sendMessage(chatId, '❌ Invalid URL format. Tap "Connect WhatsApp" and send a valid Maytapi screen URL.');
            return;
        }
        const existsActive = activeApi && activeApi.productId === parsed.productId && activeApi.phoneId === parsed.phoneId;
        const existsPool = apiPool.some(a => a.productId === parsed.productId && a.phoneId === parsed.phoneId);
        if (existsActive || existsPool) {
            bot.sendMessage(chatId, '⚠️ This API is already in the pool.');
            return;
        }
        apiPool.push({ ...parsed, chatId });
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

// ── File check (lightning fast, fresh‑only file) ──
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

        // Reset progress
        checkingChatId = chatId;
        checkingTotal = numbers.length;
        checkingDone = 0;
        checkingResults = [];

        const progressMsg = await bot.sendMessage(chatId, `Number checking 0/${checkingTotal}`);
        checkingMessageId = progressMsg.message_id;

        const registered = [];
        const fresh = [];

        // Concurrency limit – tune this number as per Maytapi limits (20–50 works fine)
        const CONCURRENCY = 100;

        await asyncPool(CONCURRENCY, numbers, async (raw) => {
            const clean = cleanNumber(raw);
            if (!clean) {
                checkingDone++;
                await updateProgress();
                return;
            }
            let reg = false;
            try {
                const res = await checkNumber(activeApi, clean);
                if (res.success && res.result && res.result.status === 200) {
                    reg = true;
                }
            } catch (e) {
                reg = false;
            }
            if (reg) registered.push(clean);
            else fresh.push(clean);

            checkingDone++;
            await updateProgress();
        });

        // Delete progress
        try { await bot.deleteMessage(chatId, checkingMessageId); } catch (e) {}

        // Build message report
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
        }

        // Send fresh numbers as a .txt file
        if (fresh.length > 0) {
            const freshContent = fresh.map(n => `+${n}`).join('\n');
            const filePathFresh = path.join(__dirname, 'Freash_Number.txt');
            fs.writeFileSync(filePathFresh, freshContent, 'utf-8');
            await bot.sendDocument(chatId, filePathFresh, { caption: `Fresh numbers (${fresh.length})` });
            fs.unlinkSync(filePathFresh);
        } else {
            await bot.sendMessage(chatId, 'No fresh numbers found.');
        }

    } catch (err) {
        console.error('File/check error:', err);
        bot.sendMessage(chatId, '❌ Error processing file.');
    }
});

console.log('Bot running – lightning speed checks, fresh‑only file');
