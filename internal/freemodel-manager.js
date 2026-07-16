// internal/freemodel-manager.js
//
// Менеджер сессий FreeModel — отдельный, рядом с Devin-менеджером.
// Сканирует manual_sessions/ и берёт только те папки, чей session_info.txt
// содержит URL freemodel.dev. Открывает /dashboard/usage, парсит баланс
// и лимиты (5h / 7d).
//
// Экспортирует: freemodelSessionsMenu(helpers)
//   helpers = { clearScreen, setKeypressListener, rawList }

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SESSIONS_DIR = 'manual_sessions';
const V3_ACCOUNTS_DIR = path.join('freemodel', 'accounts');
const QUOTA_CACHE_FILE = 'logs/.freemodel_quota_cache.json';
const USAGE_URL = 'https://freemodel.dev/dashboard/usage';

// ─── Кэш квот ────────────────────────────────────────────────────
function loadQuotaCache() {
    try {
        if (fs.existsSync(QUOTA_CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(QUOTA_CACHE_FILE, 'utf-8')) || {};
        }
    } catch {}
    return {};
}
function saveQuotaCache(cache) {
    try {
        const dir = path.dirname(QUOTA_CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(QUOTA_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
    } catch {}
}

// ─── Сессии ──────────────────────────────────────────────────────
function readSessionInfo(itemPath) {
    const info = { url: '', email: '', org: '', status: '' };
    const f = path.join(itemPath, 'session_info.txt');
    if (!fs.existsSync(f)) return info;
    try {
        for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
            const c = line.indexOf(':');
            if (c < 0) continue;
            const k = line.slice(0, c).trim().toLowerCase();
            const v = line.slice(c + 1).trim();
            if (k === 'url') info.url = v;
            else if (k === 'email') info.email = v;
            else if (k === 'org') info.org = v;
            else if (k === 'статус' || k === 'status') info.status = v;
        }
    } catch {}
    return info;
}

function isFreemodelSession(itemPath) {
    const info = readSessionInfo(itemPath);
    return info.url.includes('freemodel.dev');
}

// v3-формат: freemodel/accounts/<idx>_<ts>_ok_<ident>/{session.json, cookies.json, account_info.txt}
function readV3AccountInfo(itemPath) {
    const info = { email: '', invite: '', status: '', apiKey: '' };
    const f = path.join(itemPath, 'account_info.txt');
    if (!fs.existsSync(f)) return info;
    try {
        for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
            const c = line.indexOf(':');
            if (c < 0) continue;
            const k = line.slice(0, c).trim().toLowerCase();
            const v = line.slice(c + 1).trim();
            if (k === 'email') info.email = v;
            else if (k.startsWith('invite code')) info.invite = v;
            else if (k === 'status') info.status = v;
            else if (k === 'api key') info.apiKey = v;
        }
    } catch {}
    return info;
}

function parseV3Account(item, itemPath) {
    const sessionFile = path.join(itemPath, 'session.json');
    if (!fs.existsSync(sessionFile)) return null;
    const info = readV3AccountInfo(itemPath);

    const dtFull = item.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    const okMark = /_ok_/.test(item) || /✅/.test(info.status);

    return {
        name: item,
        path: itemPath,
        orgName: '—',
        email: info.email || '—',
        date: dtFull ? `${dtFull[1]} ${dtFull[2]}:${dtFull[3]}` : '—',
        status: okMark ? '✅' : '❌',
        backend: 'v3',
    };
}

function parseSession(item, itemPath) {
    const sessionFile = path.join(itemPath, 'session.json');
    if (!fs.existsSync(sessionFile)) return null;
    const info = readSessionInfo(itemPath);

    const userMatch = item.match(/user-([a-z0-9]+)/);
    const dtFull = item.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);

    return {
        name: item,
        path: itemPath,
        orgName: info.org || (userMatch ? `user-${userMatch[1]}` : '—'),
        email: info.email || '—',
        date: dtFull ? `${dtFull[1]} ${dtFull[2]}:${dtFull[3]}` : '—',
        status: item.includes('error') ? '❌' : '✅',
    };
}

function getFreemodelSessions() {
    const list = [];

    // 1. Старый формат: manual_sessions/<name>/session_info.txt с "URL: freemodel.dev..."
    if (!fs.existsSync(SESSIONS_DIR)) {
        try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    }
    if (fs.existsSync(SESSIONS_DIR)) {
        for (const item of fs.readdirSync(SESSIONS_DIR)) {
            const p = path.join(SESSIONS_DIR, item);
            try {
                if (!fs.statSync(p).isDirectory()) continue;
            } catch { continue; }
            if (!isFreemodelSession(p)) continue;
            const s = parseSession(item, p);
            if (s) list.push(s);
        }
    }

    // 2. v3-формат: freemodel/accounts/<dir>/account_info.txt + session.json
    if (fs.existsSync(V3_ACCOUNTS_DIR)) {
        for (const item of fs.readdirSync(V3_ACCOUNTS_DIR)) {
            // Пропускаем служебные временные файлы автореги.
            if (item.startsWith('_tmp_') || item.startsWith('_error_')) continue;
            const p = path.join(V3_ACCOUNTS_DIR, item);
            try {
                if (!fs.statSync(p).isDirectory()) continue;
            } catch { continue; }
            const s = parseV3Account(item, p);
            if (s) list.push(s);
        }
    }

    return list.sort((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name));
}

// Локаль: en-US отдаёт фейковый "Pro" всем, включая Free-акки. ru нельзя (гео).
// Ставим западноевропейскую — сайт должен вернуть либо en, либо локализованный,
// но без буга «всем Pro». По результатам probe можно уточнить (de/nl/fr/it).
const EN_CONTEXT_OPTS = {
    locale: 'de-DE',
    extraHTTPHeaders: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.5' },
};

// ─── Парсинг /dashboard/usage ────────────────────────────────────
async function checkFreemodelQuota(session) {
    let browser = null;
    try {
        const sessionFile = path.join(session.path, 'session.json');
        if (!fs.existsSync(sessionFile)) return null;
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ storageState: sessionFile, ...EN_CONTEXT_OPTS });
        const page = await context.newPage();

        // 1) Dashboard home: plan + renewal date (not present on /usage)
        let planInfo = { plan: '', renews: '' };
        try {
            await page.goto('https://freemodel.dev/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 });
            // Ждём пока React дорендерит хоть что-то узнаваемое.
            // Freemodel локализует UI (ru: "ТЕКУЩИЙ ТАРИФ / Улучшить"), поэтому
            // включаем и русские, и английские маркеры.
            await page.waitForFunction(
                () => {
                    const t = document.body?.innerText || '';
                    return /CURRENT\s+PLAN|ТЕКУЩИЙ\s+ТАРИФ|Upgrade to Pro|Улучшить|Manage subscription|Управлять подпиской|Billing|Биллинг|Subscription/i.test(t);
                },
                { timeout: 12000 }
            ).catch(() => {});
            await page.waitForTimeout(700);
        const homeText = await page.evaluate(() => (document.body?.innerText || '').replace(/\r/g, ''));
        const lines = homeText.split('\n').map(s => s.trim()).filter(Boolean);
        // Известные названия — всё остальное (плейсхолдер "—", "…", "Loading")
        // игнорируем, чтобы не залетало в кеш и не показывалось потом чипом-прочерком.
        const KNOWN_PLAN = /^(Free|Pro|Max|Team|Enterprise|Ultimate|Plus|Business|Trial|Beta)$/i;
        // САНITY: у Free-акков всегда есть блок "Complete these steps to unlock
        // VIP route access" / "Verify phone number" / "Make your first top-up".
        // У Pro-акков этого блока нет вообще. Freemodel периодически (race?) отдаёт
        // на /dashboard "CURRENT PLAN Pro" даже для Free-акков — не доверяем
        // заголовку, если ниже стоит VIP-unlock виджет.
        const HAS_VIP_UNLOCK =
            /Complete these steps to unlock VIP|unlock VIP route|Verify phone number.*Make your first top-up|Разблокируйте VIP|Подтвердите номер телефона.*Сделайте первое пополнение|VIP-Route freischalten/is.test(homeText);
        // Ищем строку-заголовок "CURRENT PLAN" / "ТЕКУЩИЙ ТАРИФ" — под ней стоит
        // название плана. Это самый надёжный сигнал, локализация не помеха.
        const planIdx = lines.findIndex(l => /^(CURRENT\s+PLAN|ТЕКУЩИЙ\s+ТАРИФ)$/i.test(l));
        if (planIdx >= 0 && lines[planIdx + 1] && KNOWN_PLAN.test(lines[planIdx + 1].trim())) {
            const headerPlan = lines[planIdx + 1].trim();
            // Если заголовок говорит Pro, но виден VIP-unlock — это Free (баг freemodel).
            if (HAS_VIP_UNLOCK && /^Pro$/i.test(headerPlan)) {
                planInfo.plan = 'Free';
            } else {
                planInfo.plan = headerPlan;
            }
        } else if (HAS_VIP_UNLOCK) {
            planInfo.plan = 'Free';
        }
        // Fallback: маркеры upgrade-CTA. Критично не путать «Pro plan» (это подпись
        // в CTA-блоке, показывается ВСЕМ включая Free-акки) с реальным индикатором.
        // Free-маркеры проверяем первыми — у Pro такого CTA нет.
        if (!planInfo.plan) {
            const freeMarkers = /Upgrade to Pro|Upgrade\s+plan|Get\s+Pro|You'?re on Free|Free plan\b|Улучшить\s+→|Улучшить тариф|Обновить до Pro/i;
            const proMarkers  = /Manage subscription|Cancel subscription|You'?re on Pro|Pro member|Управлять подпиской|Отменить подписку/i;
            if (freeMarkers.test(homeText)) planInfo.plan = 'Free';
            else if (proMarkers.test(homeText)) planInfo.plan = 'Pro';
        }
        // DOM-бэйдж fallback — тоже опасен: короткий текст "Pro" может быть где
        // угодно (в CTA-кнопке, sidebar-упоминании). Требуем чтобы это был именно
        // визуальный бэйдж: маленький, с фоном/бордером, и рядом НЕ было "Upgrade".
        if (!planInfo.plan) {
            try {
                const badgePlan = await page.evaluate(() => {
                    const nodes = Array.from(document.querySelectorAll('span,div,button,a'));
                    const CLEAN = /^(Free|Pro|Max|Team|Enterprise)$/;
                    for (const n of nodes) {
                        const t = (n.textContent || '').trim();
                        if (!CLEAN.test(t)) continue;
                        const r = n.getBoundingClientRect();
                        if (!(r.width > 0 && r.width < 120 && r.height > 0 && r.height < 44)) continue;
                        // Отсечь CTA-кнопки: рядом с ними обычно есть слово Upgrade/Get.
                        const parent = n.closest('button,a,[role="button"]');
                        const near = (parent?.textContent || '').toLowerCase();
                        if (/upgrade|get\s+pro|subscribe|buy/.test(near)) continue;
                        // Требуем визуальный признак бэйджа: фон или бордер.
                        const cs = getComputedStyle(n);
                        const hasChrome =
                            (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') ||
                            (cs.borderTopWidth && parseFloat(cs.borderTopWidth) > 0);
                        if (!hasChrome) continue;
                        return t;
                    }
                    return '';
                });
                if (badgePlan) planInfo.plan = badgePlan;
            } catch {}
        }
        // Последний fallback: /billing — там канонично.
        if (!planInfo.plan) {
            try {
                await page.goto('https://freemodel.dev/dashboard/billing', { waitUntil: 'domcontentloaded', timeout: 12000 });
                await page.waitForTimeout(1500);
                const bt = await page.evaluate(() => (document.body?.innerText || ''));
                // Free/Pro маркеры на обоих языках.
                if (/Upgrade to Pro|Upgrade\s+plan|Get\s+Pro|You'?re on Free|Free plan\b|Current plan.*Free|Улучшить\s+→|Улучшить тариф|Обновить до Pro|Текущий тариф.*Free/i.test(bt)) planInfo.plan = 'Free';
                else if (/Manage subscription|Cancel subscription|You'?re on Pro|Pro member|Current plan.*Pro|Управлять подпиской|Отменить подписку|Текущий тариф.*Pro/i.test(bt)) planInfo.plan = 'Pro';
                // Ещё один пас: ищем "CURRENT PLAN" / "ТЕКУЩИЙ ТАРИФ" + строку под ним.
                if (!planInfo.plan) {
                    const btLines = bt.split('\n').map(s => s.trim()).filter(Boolean);
                    const idx = btLines.findIndex(l => /^(CURRENT\s+PLAN|ТЕКУЩИЙ\s+ТАРИФ)$/i.test(l));
                    if (idx >= 0) {
                        for (let k = idx + 1; k < Math.min(btLines.length, idx + 5); k++) {
                            if (/^(Free|Pro|Max|Team|Enterprise|Ultimate|Plus|Business|Trial|Beta)$/i.test(btLines[k])) {
                                planInfo.plan = btLines[k];
                                break;
                            }
                        }
                    }
                }
                // DEBUG: если план так и не нашли — дампим кусочек текста в log-файл,
                // чтобы понять, чем эта страница отличается от «нормальных».
                if (!planInfo.plan) {
                    try {
                        const dbgDir = path.join(process.cwd(), 'logs');
                        if (!fs.existsSync(dbgDir)) fs.mkdirSync(dbgDir, { recursive: true });
                        const dumpFile = path.join(dbgDir, '.freemodel_plan_miss.log');
                        const snippet = bt.slice(0, 2000).replace(/\s+\n/g, '\n');
                        fs.appendFileSync(dumpFile,
                          `\n===== ${new Date().toISOString()} · ${session.name} · /billing =====\n${snippet}\n`);
                    } catch {}
                }
            } catch {}
        }
        const renewsMatch = homeText.match(/Renews(?:\s+on)?\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i);
        if (renewsMatch) planInfo.renews = new Date(renewsMatch[1]).toISOString();
        // Новая механика freemodel (июль 2026): "LIMITED-TIME TRIAL CREDIT $X.XX",
        // ниже "Claude Code CLI only", "Expires <Month> <day>, <year>", "N days left".
        // Даётся при бинде TG (реф-цепочка на 1 акк отключена, идёт только за пополнение).
        // Пишем в planInfo — потом попадёт в quota как trialCredit / trialExpires.
        const trialAmount = homeText.match(/LIMITED[-\s]TIME TRIAL CREDIT\s*\$([\d.,]+)/i);
        if (trialAmount) planInfo.trialCredit = `$${trialAmount[1]}`;
        const trialExpires = homeText.match(/Expires\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i);
        if (trialExpires) planInfo.trialExpires = new Date(trialExpires[1]).toISOString();
        const trialDaysLeft = homeText.match(/(\d+)\s+days?\s+left/i);
        if (trialDaysLeft) planInfo.trialDaysLeft = parseInt(trialDaysLeft[1], 10);
        // Detect Telegram binding: phone near "Telegram" or "connected" text.
        const tgPhoneMatch = homeText.match(/(?:telegram|tg)[\s\S]{0,60}?\+?(\d{6,15})/i) ||
                             homeText.match(/\+?(\d{6,15})[\s\S]{0,60}?(?:telegram|tg)/i) ||
                             homeText.match(/telegram\s*connected|telegram\s*verified|tg\s*connected/i);
        if (tgPhoneMatch) {
            planInfo.tgPhone = tgPhoneMatch[1] || 'connected';
            planInfo.tgBound = true;
        } else if (/Bind Telegram|Connect Telegram|Verify Telegram|Waiting for Telegram/i.test(homeText)) {
            planInfo.tgBound = false;
        }
    } catch {}

        await page.goto(USAGE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // Ждём пока появится "AVAILABLE NOW" — на Free-акках окон лимитов НЕТ
        // ("No active limits"), поэтому дальше ждать нечего, страница готова.
        // Сайт может отдать русскую локализацию несмотря на de-DE контекст (гео).
        await page.waitForFunction(
            () => /AVAILABLE NOW|ДОСТУПНО СЕЙЧАС|VERFÜGBAR/i.test(document.body?.innerText || ''),
            { timeout: 15000 }
        ).catch(() => {});
        // Ждём пока сумма подтянется (не $0.00 placeholder). Если реально 0 — не
        // ждём вечность: max 4с.
        await page.waitForFunction(() => {
            const t = document.body?.innerText || '';
            const m = t.match(/(?:AVAILABLE NOW|ДОСТУПНО СЕЙЧАС|VERFÜGBAR)[\s\S]{0,80}?\$([\d.,]+)/i);
            return m && parseFloat(m[1].replace(',', '')) > 0;
        }, { timeout: 4000 }).catch(() => {});
        // Блок окон 5h/7d рендерится ~2с ПОЗЖЕ, чем "AVAILABLE NOW" (отдельный
        // fetch). Причём сначала мелькает плейсхолдер "No active limits", который
        // потом ЗАМЕНЯЕТСЯ окнами — поэтому его нельзя принимать за терминальное
        // состояние. Ждём именно окна; на настоящем Free без окон отваливаемся
        // по таймауту 8с (цена — 8с на такой акк, зато кеш не портится пустыми h5/d7).
        await page.waitForFunction(() => {
            const t = document.body?.innerText || '';
            return /5-Hour window|Окно 5 часов/i.test(t);
        }, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(600);

        const data = await page.evaluate(() => {
            const text = (document.body?.innerText || '').replace(/\r/g, '');
            const lines = text.split('\n').map(s => s.trim()).filter(Boolean);

            const out = {
                available: '', plan: '', bonus: '', renews: '',
                // Referral bonus block (freemodel июль 2026):
                //   "Current balance", "From N referral · $Y each", "$USED / $CAP"
                referralBonus: '',        // $USED / $CAP как строка ("$3.49 / $10.00")
                referralBonusUsed: null,  // число
                referralBonusMax: null,   // число
                referralCount: null,      // "From N referral" → N
                // Старые окна лимитов оставлены для Pro-акков (если появятся).
                h5: '', h5max: '', h5resets: '', h5pct: null,
                d7: '', d7max: '', d7resets: '', d7pct: null,
            };

            // "Renews <Month> <day>, <year>" (Pro) / "Next billing ..." — не для Free.
            const renewsMatch = text.match(/Renews(?:\s+on)?\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i) ||
                                text.match(/Next\s+(?:billing|renewal|payment)[\s\S]{0,40}?([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i);
            if (renewsMatch) out.renews = new Date(renewsMatch[1]).toISOString();

            // "AVAILABLE NOW" / "ДОСТУПНО СЕЙЧАС" → следующая строка с $X.XX + "Bonus credits $Y.YY" рядом.
            const availIdx = lines.findIndex(l => /^(AVAILABLE NOW|ДОСТУПНО СЕЙЧАС)$/i.test(l));
            if (availIdx >= 0) {
                for (let i = availIdx + 1; i < Math.min(lines.length, availIdx + 6); i++) {
                    const m = lines[i].match(/^\$[\d.,]+$/);
                    if (m) { out.available = m[0]; break; }
                }
                // "Bonus credits $Y.YY" в 3-4 строках после AVAILABLE NOW.
                for (let i = availIdx + 1; i < Math.min(lines.length, availIdx + 6); i++) {
                    const mb = lines[i].match(/(?:Bonus credits|Бонусные кредиты)\s*\$([\d.,]+)/i);
                    if (mb) { out.bonus = `$${mb[1]}`; break; }
                }
            }

            // EXTRA USAGE → "Current balance" → "From N referral · $Y each" → "$USED / $CAP".
            const extraIdx = lines.findIndex(l => /EXTRA USAGE|ДОПОЛНИТЕЛЬНОЕ ИСПОЛЬЗОВАНИЕ/i.test(l));
            if (extraIdx >= 0) {
                for (let i = extraIdx; i < Math.min(lines.length, extraIdx + 10); i++) {
                    const mc = lines[i].match(/From\s+(\d+)\s+referral/i) ||
                               lines[i].match(/От\s+(\d+)\s+приглаш/i);
                    if (mc) out.referralCount = parseInt(mc[1], 10);
                    const mb = lines[i].match(/^\$([\d.,]+)\s*\/\s*\$([\d.,]+)$/);
                    if (mb) {
                        out.referralBonus = `$${mb[1]} / $${mb[2]}`;
                        out.referralBonusUsed = parseFloat(mb[1].replace(',', ''));
                        out.referralBonusMax = parseFloat(mb[2].replace(',', ''));
                        break;
                    }
                }
            }

            // Окна 5h/7d. Заголовок локализуется ("5-Hour window" / "Окно 5 часов"),
            // строки внутри: "Resets ..."/"Сброс ...", "$used / $max", "Использовано N%".
            const findWindow = (labels) => {
                let i = -1;
                for (let k = 0; k < lines.length; k++) {
                    const l = lines[k].toLowerCase();
                    if (labels.some(lb => l.startsWith(lb)) && !/\$/.test(l)) { i = k; break; }
                }
                if (i < 0) return null;
                let used = '', max = '', resets = '', pct = '';
                for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
                    const ln = lines[j];
                    if (/^(7-Day|AVAILABLE|Plan|API|Usage|Logs|Billing|EXTRA|Окно 7|ДОСТУПНО|ДОПОЛНИТЕЛЬНОЕ|ПОПОЛНЕНИЕ)/i.test(ln)) break;
                    let m = ln.match(/^(?:Resets|Сброс)\s+(?:через\s+)?(.+)$/i);
                    if (m) { resets = m[1].trim(); continue; }
                    m = ln.match(/^\$?([\d.,]+)\s*\/\s*\$?([\d.,]+)$/);
                    if (m) { used = `$${m[1]}`; max = `$${m[2]}`; continue; }
                    m = ln.match(/^(?:Использовано\s+)?([\d.]+)\s*%(?:\s*used)?$/i);
                    if (m) { pct = parseFloat(m[1]); }
                    if (used && pct !== '') break;
                }
                return { used, max, resets, pct };
            };
            const w5 = findWindow(['5-hour window', 'окно 5 час']);
            const w7 = findWindow(['7-day window', 'окно 7 дн']);
            if (w5) { out.h5 = w5.used; out.h5max = w5.max; out.h5resets = w5.resets; out.h5pct = w5.pct || null; }
            if (w7) { out.d7 = w7.used; out.d7max = w7.max; out.d7resets = w7.resets; out.d7pct = w7.pct || null; }
            return out;
        });

        await browser.close();
        browser = null;

        if (planInfo.plan) data.plan = planInfo.plan;
        if (planInfo.renews) data.renews = planInfo.renews;
        if (planInfo.tgPhone) data.tgPhone = planInfo.tgPhone;
        data.tgBound = planInfo.tgBound ?? null;
        // Trial credit блок (июль 2026): даётся при бинде TG, срок ~3 дня.
        if (planInfo.trialCredit)   data.trialCredit = planInfo.trialCredit;
        if (planInfo.trialExpires)  data.trialExpires = planInfo.trialExpires;
        if (typeof planInfo.trialDaysLeft === 'number') data.trialDaysLeft = planInfo.trialDaysLeft;

        // Возвращаем null только если ВООБЩЕ ничего не подтянулось. На Free есть
        // available но нет окон — это норма, данные валидные.
        if (!data.available && !data.h5 && !data.d7 && !data.trialCredit) return null;
        return data;
    } catch (e) {
        return null;
    } finally {
        if (browser) { try { await browser.close(); } catch {} }
    }
}

// ─── Извлечение API ключа ───────────────────────────────────────
// Открывает сессию, переходит на /dashboard/keys, создаёт новый ключ
// (маскирован в таблице), извлекает полный ключ из модалки успеха,
// сохраняет в account_info.txt и logs/.freemodel_meta.json.
const KEY_RE = /(?:fe[_-]|sk-)[A-Za-z0-9_-]{20,}/;
const KEY_PAGE_URL = 'https://freemodel.dev/dashboard/keys';

async function extractFreemodelApiKey(session) {
    let browser = null;
    try {
        const sessionFile = path.join(session.path, 'session.json');
        if (!fs.existsSync(sessionFile)) return { ok: false, error: 'session.json not found' };

        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ storageState: sessionFile, ...EN_CONTEXT_OPTS });
        const page = await context.newPage();

        await page.goto(KEY_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);

        // Проверяем лимит ключей (X / 5)
        const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        const limitMatch = bodyText.match(/(\d+)\s*\/\s*5/);
        if (limitMatch && parseInt(limitMatch[1], 10) >= 5) {
            await browser.close();
            return { ok: false, error: 'key limit reached (5/5)' };
        }

        // Ищем уже существующий ключ в account_info.txt (v3) или meta
        const infoFile = path.join(session.path, 'account_info.txt');
        if (fs.existsSync(infoFile)) {
            const infoText = fs.readFileSync(infoFile, 'utf-8');
            const m = infoText.match(KEY_RE);
            if (m) {
                await browser.close();
                return { ok: true, apiKey: m[0], source: 'account_info.txt' };
            }
        }

        // Dismiss any overlay that blocks clicks
        try {
            // Try clicking any visible button in the overlay
            const anyBtn = page.locator(".modal-backdrop button, .fixed.inset-0 button").first();
            if (await anyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await anyBtn.click({ timeout: 3000 });
                await page.waitForTimeout(800);
            }
        } catch {}
        try { await page.keyboard.press("Escape"); await page.waitForTimeout(400); } catch {}
        // Nuclear option: remove modal-backdrop via JS if still present
        try {
            await page.evaluate(() => {
                document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
            });
            await page.waitForTimeout(300);
        } catch {}

        // Click "Create key" — try JS click first, fallback to Playwright click
        let modalOpened = false;
        for (const method of ['js', 'playwright', 'force']) {
            try {
                if (method === 'js') {
                    await page.evaluate(() => {
                        const btns = document.querySelectorAll('button');
                        for (const b of btns) {
                            if (b.textContent.includes('Create key')) { b.click(); return; }
                        }
                    });
                } else if (method === 'playwright') {
                    await page.locator('button').filter({ hasText: 'Create key' }).first().click({ timeout: 5000 });
                } else if (method === 'force') {
                    await page.locator('button').filter({ hasText: 'Create key' }).first().click({ force: true, timeout: 5000 });
                }
                await page.waitForTimeout(1500);
                // Check if modal opened
                const modalInput = page.locator('#newKeyName, .modal-input');
                if (await modalInput.isVisible({ timeout: 2000 }).catch(() => false)) {
                    modalOpened = true;
                    break;
                }
            } catch { continue; }
        }

        if (!modalOpened) {
            // На неверифицированном аккаунте клик "Create key" открывает не поле
            // имени, а окно верификации (Bind phone / Bind Telegram / Buy API
            // credit). Ловим это и отдаём понятную ошибку вместо "could not open".
            const gateText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
            if (/complete account verification|bind a phone number|bind telegram|buy api credit|top up \$?\d|before creating an api key/i.test(gateText)) {
                await browser.close(); browser = null;
                return { ok: false, error: 'account not verified — bind Telegram/phone first', needsVerification: true };
            }
            throw new Error('could not open Create key modal');
        }

        // Заполняем имя ключа в модалке
        const nameInput = page.locator('#newKeyName, .modal-input');
        await nameInput.waitFor({ state: 'visible', timeout: 8000 });
        const keyName = `autoreg-${Date.now().toString(36)}`;
        await nameInput.fill(keyName);
        await page.waitForTimeout(400);

        // Submit — JS click for reliability
        await page.evaluate(() => {
            const modals = document.querySelectorAll('.modal, [role="dialog"]');
            for (const m of modals) {
                const btn = m.querySelector('button[type="submit"], button.dbtn-primary');
                if (btn) { btn.click(); return; }
            }
        });
        await page.waitForTimeout(2500);

        // Ждём успешную модалку с ключом
        const secretVal = page.locator('.secret-val');
        try {
            await secretVal.waitFor({ state: 'visible', timeout: 15000 });
        } catch {
            // Fallback: scan entire body for key text
            const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
            // FreeModel гейтит создание ключа за верификацией: если аккаунт не
            // привязал телефон/Telegram и не пополнил $10, сайт показывает это
            // вместо ключа. Возвращаем понятную ошибку, а не ".secret-val not found".
            if (/complete account verification|bind a phone number|top up \$?\d|before creating an api key/i.test(bodyText)) {
                await browser.close(); browser = null;
                return { ok: false, error: 'account not verified — bind Telegram/phone first', needsVerification: true };
            }
            const m = bodyText.match(KEY_RE);
            if (m) {
                const apiKey = m[0];
                try { await page.keyboard.press("Escape"); } catch {}
                await browser.close(); browser = null;
                // Сохраняем
                try {
                    let infoText = '';
                    if (fs.existsSync(infoFile)) { infoText = fs.readFileSync(infoFile, 'utf-8'); }
                    if (/^API Key:/m.test(infoText)) { infoText = infoText.replace(/^API Key:.*$/m, 'API Key: ' + apiKey); }
                    else { infoText = infoText.trimEnd() + '\nAPI Key: ' + apiKey + '\n'; }
                    fs.writeFileSync(infoFile, infoText, 'utf-8');
                } catch {}
                return { ok: true, apiKey, source: 'body_scan' };
            }
            throw new Error('.secret-val not found and no key in body');
        }
        const apiKey = (await secretVal.innerText()).trim();

        // Закрываем модалку
        try {
            const doneBtn = page.locator('.modal-backdrop .dbtn-primary').filter({ hasText: 'Done' });
            await doneBtn.click({ timeout: 3000 });
        } catch {}

        await page.waitForTimeout(500);
        await browser.close();
        browser = null;

        if (!KEY_RE.test(apiKey)) {
            return { ok: false, error: `unexpected key format: ${apiKey.substring(0, 16)}...` };
        }

        // Сохраняем в account_info.txt
        try {
            let infoText = '';
            if (fs.existsSync(infoFile)) {
                infoText = fs.readFileSync(infoFile, 'utf-8');
            }
            if (/^API Key:/m.test(infoText)) {
                infoText = infoText.replace(/^API Key:.*$/m, 'API Key: ' + apiKey);
            } else {
                infoText = infoText.trimEnd() + '\nAPI Key: ' + apiKey + '\n';
            }
            fs.writeFileSync(infoFile, infoText, 'utf-8');
        } catch {}

        // Сохраняем в logs/.freemodel_meta.json
        const META_FILE = path.join('logs', '.freemodel_meta.json');
        try {
            const meta = fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, 'utf-8')) : {};
            meta[session.name] = meta[session.name] || {};
            meta[session.name].apiKey = String(apiKey);
            fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
        } catch {}

        return { ok: true, apiKey, source: 'created' };
    } catch (e) {
        return { ok: false, error: e.message };
    } finally {
        if (browser) { try { await browser.close(); } catch {} }
    }
}

// ─── Рендер ──────────────────────────────────────────────────────
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const visW = s => [...stripAnsi(s)].reduce((n, ch) => n + (ch.codePointAt(0) >= 0x1F000 ? 2 : 1), 0);
const padTo = (s, w) => s + ' '.repeat(Math.max(0, w - visW(s)));

function renderList(sessions, row, quotaMap, loadingSet, focus, actionIdx, clearScreen) {
    const COL_EMAIL = 32;
    const COL_DATE = 16;

    const lines = [];
    lines.push(`  🆓 FreeModel — Менеджер сессий  \x1b[2m(${sessions.length} аккаунт${sessions.length === 1 ? '' : 'ов'})\x1b[0m`);
    lines.push('');
    const hint = focus === 'list'
        ? '\x1b[2m↑↓ сессия   → действия   Enter открыть /usage   Esc назад\x1b[0m'
        : '\x1b[2m↑↓ действие  ← список   Enter выполнить   Esc к списку\x1b[0m';
    lines.push(`  ${hint}`);
    lines.push('');
    lines.push(`  \x1b[2m  ${'#'.padStart(2)}  ${padTo('Email', COL_EMAIL)}  ${padTo('Дата', COL_DATE)}  Доступно   5h          7d\x1b[0m`);
    lines.push(`  \x1b[2m  ${'─'.repeat(COL_EMAIL + COL_DATE + 40)}\x1b[0m`);

    sessions.forEach((s, i) => {
        const isRow = i === row;
        const cursor = (isRow && focus === 'list') ? '\x1b[36m❯\x1b[0m' : (isRow ? '\x1b[2m›\x1b[0m' : ' ');
        const num = String(i + 1).padStart(2);
        const icon = s.status === '✅' ? '\x1b[32m✅\x1b[0m' : '\x1b[31m❌\x1b[0m';
        const emailWrap = isRow ? `\x1b[1m\x1b[36m${s.email}\x1b[0m` : s.email;
        const emailCol = padTo(emailWrap, COL_EMAIL);
        const dateCol = `\x1b[2m${padTo(s.date, COL_DATE)}\x1b[0m`;

        let extra = '';
        const q = quotaMap[s.name];
        if (loadingSet.has(s.name)) {
            extra = `\x1b[2m⏳ загрузка…\x1b[0m`;
        } else if (q) {
            const avail = q.available ? `\x1b[32m${q.available.padStart(7)}\x1b[0m` : '\x1b[2m   —   \x1b[0m';
            const h5 = q.h5 ? `${q.h5}/${q.h5max || '?'}` : '—';
            const d7 = q.d7 ? `${q.d7}/${q.d7max || '?'}` : '—';
            extra = `${avail}  \x1b[33m${padTo(h5, 10)}\x1b[0m  \x1b[36m${d7}\x1b[0m`;
        }

        lines.push(`  ${cursor} \x1b[2m${num}.\x1b[0m ${icon}  ${emailCol}${dateCol}  ${extra}`);
    });

    // Действия
    lines.push('');
    lines.push(`  \x1b[2m─────────────────────────────────────────────────────────\x1b[0m`);
    lines.push('');
    const actions = [
        { id: 'open',        label: '➜ Открыть /dashboard/usage в браузере' },
        { id: 'refresh',     label: '↻ Обновить квоту' },
        { id: 'refresh-all', label: '↻ Обновить все квоты' },
        { id: 'extract-key', label: '🔑 Извлечь API ключ' },
        { id: 'delete',      label: '✗ Удалить сессию' },
        { id: 'back',        label: '← Назад в меню' },
    ];
    actions.forEach((a, i) => {
        const isSel = focus === 'actions' && actionIdx === i;
        const cur = isSel ? '\x1b[36m❯\x1b[0m' : ' ';
        const text = isSel ? `\x1b[1m\x1b[36m${a.label}\x1b[0m` : (focus === 'actions' ? a.label : `\x1b[2m${a.label}\x1b[0m`);
        lines.push(`  ${cur} ${text}`);
    });

    // Детали выбранной сессии
    const s = sessions[row];
    if (s) {
        const q = quotaMap[s.name];
        lines.push('');
        lines.push(`  \x1b[2m─── Детали ───\x1b[0m`);
        lines.push(`  \x1b[2mEmail:\x1b[0m  ${s.email}`);
        lines.push(`  \x1b[2mПапка:\x1b[0m  ${s.path}`);
        if (q) {
            lines.push(`  \x1b[2mДоступно:\x1b[0m  ${q.available}   \x1b[2m(plan ${q.plan} · bonus ${q.bonus})\x1b[0m`);
            if (q.h5) lines.push(`  \x1b[2m5h окно:\x1b[0m   ${q.h5} / ${q.h5max}    \x1b[2m${q.h5resets}\x1b[0m`);
            if (q.d7) lines.push(`  \x1b[2m7d окно:\x1b[0m   ${q.d7} / ${q.d7max}    \x1b[2m${q.d7resets}\x1b[0m`);
        } else {
            lines.push(`  \x1b[2mКвота:\x1b[0m   не загружена  \x1b[2m(нажми "Обновить")\x1b[0m`);
        }
    }

    clearScreen();
    process.stdout.write(lines.join('\n'));
    return lines.length;
}

// ─── Главная функция ────────────────────────────────────────────
async function freemodelSessionsMenu({ clearScreen, setKeypressListener }) {
    let sessions = getFreemodelSessions();
    if (sessions.length === 0) {
        clearScreen();
        console.log('\n📭 Нет FreeModel-сессий в manual_sessions/');
        console.log('   Создай через: node freemodel/create_first_session.js\n');
        console.log('   Нажми любую клавишу для возврата...');
        await new Promise(r => {
            process.stdin.resume();
            if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(true); } catch {}
            process.stdin.once('keypress', () => {
                if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(false); } catch {}
                process.stdin.pause();
                r();
            });
        });
        return;
    }

    const quotaMap = loadQuotaCache();
    Object.keys(quotaMap).forEach(k => { if (!sessions.find(s => s.name === k)) delete quotaMap[k]; });
    saveQuotaCache(quotaMap);

    let row = 0, focus = 'list', actionIdx = 0;
    const loadingSet = new Set();

    let rerenderT = null;
    const doRender = () => renderList(sessions, row, quotaMap, loadingSet, focus, actionIdx, clearScreen);
    const rerender = (immediate = false) => {
        if (immediate) { if (rerenderT) clearTimeout(rerenderT); rerenderT = null; doRender(); }
        else if (!rerenderT) { rerenderT = setTimeout(() => { rerenderT = null; doRender(); }, 100); }
    };

    const setQuota = (name, q) => { quotaMap[name] = { ...q, updatedAt: Date.now() }; saveQuotaCache(quotaMap); };

    const loadOne = (s) => {
        if (s.status !== '✅') return;
        loadingSet.add(s.name); rerender(true);
        checkFreemodelQuota(s).then(q => {
            if (q) setQuota(s.name, q);
        }).catch(() => {}).finally(() => {
            loadingSet.delete(s.name);
            rerender();
        });
    };

    const loadAll = () => {
        const list = sessions.filter(s => s.status === '✅');
        if (list.length === 0) return;
        const MAX = 2;
        let idx = 0;
        const next = () => {
            while (loadingSet.size < MAX && idx < list.length) {
                const s = list[idx++];
                loadingSet.add(s.name);
                checkFreemodelQuota(s).then(q => {
                    if (q) setQuota(s.name, q);
                }).catch(() => {}).finally(() => {
                    loadingSet.delete(s.name);
                    rerender();
                    if (idx < list.length) next();
                });
            }
        };
        next();
    };

    const ACTIONS = ['open', 'refresh', 'refresh-all', 'extract-key', 'delete', 'back'];

    const openBrowser = async (s) => {
        setKeypressListener(null);
        if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(false); } catch {}
        try {
            const browser = await chromium.launch({ headless: false });
            const context = await browser.newContext({ storageState: path.join(s.path, 'session.json'), ...EN_CONTEXT_OPTS });
            const page = await context.newPage();
            await page.goto(USAGE_URL, { waitUntil: 'domcontentloaded' });
            // браузер оставляем открытым, юзер закроет
            loadOne(s);
        } catch {}
        process.stdin.resume();
        if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(true); } catch {}
        rerender(true);
        setKeypressListener(onKey);
    };

    let resolveOuter;
    const exitMenu = () => {
        setKeypressListener(null);
        if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(false); } catch {}
        process.stdin.pause();
        resolveOuter();
    };

    const execAction = async (id) => {
        const s = sessions[row];
        switch (id) {
            case 'open':        if (s) await openBrowser(s); break;
            case 'refresh':     if (s) loadOne(s); break;
            case 'refresh-all': loadAll(); break;
            case 'extract-key': {
                if (!s) return;
                clearScreen();
                process.stdout.write('\n  🔑 Извлекаю API ключ...\n');
                const result = await extractFreemodelApiKey(s);
                if (result.ok) {
                    process.stdout.write(`  ✅ Ключ: ${result.apiKey}\n  Источник: ${result.source}\n`);
                } else {
                    process.stdout.write(`  ❌ Ошибка: ${result.error}\n`);
                }
                process.stdout.write('\n  Нажми любую клавишу для продолжения...');
                await new Promise(r => {
                    process.stdin.once('keypress', () => r());
                });
                rerender(true);
                break;
            }
            case 'delete': {
                if (!s) return;
                try { fs.rmSync(s.path, { recursive: true, force: true }); } catch {}
                sessions = getFreemodelSessions();
                if (sessions.length === 0) { exitMenu(); return; }
                row = Math.min(row, sessions.length - 1);
                focus = 'list';
                rerender(true);
                break;
            }
            case 'back': exitMenu(); break;
        }
    };

    const onKey = async (str, key) => {
        if (!key) return;
        if (key.name === 'up') {
            if (focus === 'list') row = (row - 1 + sessions.length) % sessions.length;
            else actionIdx = (actionIdx - 1 + ACTIONS.length) % ACTIONS.length;
            rerender(true);
        } else if (key.name === 'down') {
            if (focus === 'list') row = (row + 1) % sessions.length;
            else actionIdx = (actionIdx + 1) % ACTIONS.length;
            rerender(true);
        } else if (key.name === 'right') {
            focus = 'actions'; rerender(true);
        } else if (key.name === 'left') {
            focus = 'list'; rerender(true);
        } else if (key.name === 'return') {
            if (focus === 'list') await openBrowser(sessions[row]);
            else await execAction(ACTIONS[actionIdx]);
        } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
            if (focus === 'actions') { focus = 'list'; rerender(true); }
            else exitMenu();
        }
    };

    process.stdin.resume();
    if (process.stdin.isTTY && process.stdin.setRawMode) try { process.stdin.setRawMode(true); } catch {}
    rerender(true);

    // Авто-загрузка квот при первом входе (только тех что без кэша)
    setTimeout(() => {
        const stale = sessions.filter(s => s.status === '✅' && !quotaMap[s.name]);
        if (stale.length) {
            stale.forEach(s => loadingSet.add(s.name));
            rerender();
            let i = 0;
            const next = () => {
                while (loadingSet.size <= 2 && i < stale.length) {
                    const s = stale[i++];
                    checkFreemodelQuota(s).then(q => { if (q) setQuota(s.name, q); })
                        .catch(() => {}).finally(() => { loadingSet.delete(s.name); rerender(); if (i < stale.length) next(); });
                }
            };
            next();
        }
    }, 200);

    return new Promise(res => { resolveOuter = res; setKeypressListener(onKey); });
}

module.exports = { freemodelSessionsMenu, getFreemodelSessions, checkFreemodelQuota, extractFreemodelApiKey };
