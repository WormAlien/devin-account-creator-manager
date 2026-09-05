// routing/lib/outlook-pool.js
//
// Пул Outlook-ящиков: хранилище + разбор пачки из магазина. Логика вынесена в модуль по
// образцу `freemodel/lib/tg-pool.js` (у GitHub-пула она размазана по трём файлам, и его
// собственные регрессы на это жалуются).
//
// 🔴 Почему у ящика есть профиль браузера, а не только пара логин-пароль: живая проба
// 31.08 — `outlook.office365.com:993` отвечает `AUTH=XOAUTH2 LOGINDISABLED`. Базовую
// авторизацию Microsoft выключил, значит IMAP по паролю невозможен, и письмо с кодом
// читается только из залогиненной сессии. Поэтому пароль здесь — не доступ к почте, а
// то, чем человек один раз входит в профиль; дальше живёт кука.
//
// Файлы: outlook/accounts.json (пул, в .gitignore), outlook/profiles/acct_<id>/ (профиль
// Chromium на ящик), outlook/sessions/<id>.json (снимок storageState).

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'outlook');
const FILE = path.join(DIR, 'accounts.json');
const PROFILES_DIR = path.join(DIR, 'profiles');
const SESSIONS_DIR = path.join(DIR, 'sessions');

const STATUSES = ['unknown', 'live', 'dead', 'locked'];
const KINDS = ['personal', 'student'];

function load() {
    try {
        const raw = fs.readFileSync(FILE, 'utf8');
        const arr = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

// Пишем через .tmp + rename: у tg-пула полная перезапись без этого, и два процесса
// одновременно теряют запись (зафиксировано как минус образца).
function save(arr) {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, FILE);
    return arr;
}

const isEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());
// Студенческий ящик отличается доменом, а не полем в файле магазина: домены вида
// `*.edu`, `*.edu.<cc>`, `*.ac.<cc>` — и он же даёт право на подписки для учащихся.
const isStudentDomain = s => /@[A-Za-z0-9.-]+\.(edu|edu\.[a-z]{2}|ac\.[a-z]{2})$/i.test(String(s || '').trim());
const profileLabel = id => 'acct_' + id;

// ── разбор пачки ──────────────────────────────────────────────────────────────
// Файлы магазина — это письма-чеки, а не голые списки: сверху «Заказ: …», реклама со
// ссылками и рамка `↓↓↓↓ Ваш заказ: ↓↓↓↓`, и только потом строки. Поэтому парсер не
// требует чистого ввода: строку берём, если в ней есть адрес почты, остальное — шум.
const NOISE_RE = /^(Заказ|Сайт|Ваш заказ|↓|🚨|🕺|https?:)/i;
const NO_EMAIL = 'адреса почты в строке нет';
// 🪤 В одном чеке бывают строки ДРУГОЙ покупки, где почта — просто логин. Формат
// `почта:пароль:2FA-секрет` — это GitHub-аккаунт, и его пароль к ящику не подходит:
// заведёшь такую строку почтой — получишь профиль, в который не войти, и поймёшь это
// только руками. Отличаем по хвосту: base32-секрет (A-Z2-7, от 10 символов) в пароль и
// в резервную почту не попадает никогда. Проверено на живых файлах: два чека по 10 и 3
// строки с outlook в конце отсекаются как «нет пароля», третий (10 строк
// `gmail:пароль:2FA`) — этой проверкой.
const B32_RE = /^[A-Z2-7]{10,}$/i;
const looksLike2fa = s => B32_RE.test(String(s || '').replace(/\s+/g, ''));

// Разделитель ищем по строке, а не задаём: магазины отдают `:`, `;`, `|` и табы.
function splitFields(line) {
    const sep = /\t/.test(line) ? /\t+/ : /;/.test(line) && !/:/.test(line) ? /;+/ : /\|/.test(line) ? /\|+/ : /:/;
    return String(line).split(sep).map(s => s.trim()).filter(s => s !== '');
}

// Одна строка → запись или { error }. Позиции полей не фиксируем: у восьми ящиков это
// `почта:пароль`, но в тех же чеках соседние строки бывают шестипольными, и «второе поле
// = пароль» на них врёт. Ищем адрес, дальше пароль — первое непустое поле после него.
function parseLine(line) {
    const parts = splitFields(line);
    if (!parts.length) return { error: 'пустая строка' };
    const at = parts.findIndex(isEmail);
    if (at < 0) return { error: NO_EMAIL };
    const email = parts[at].toLowerCase();
    const rest = parts.slice(at + 1);
    const password = rest.length ? rest[0] : '';
    if (!password) return { error: `у ${email} нет пароля` };
    // Хвост сохраняем как есть: там бывает резервная почта, дата и токены. Выбрасывать
    // нельзя — по этим полям потом отличают, что за ящик куплен.
    const tail = rest.slice(1).filter(Boolean);
    if (tail.some(looksLike2fa)) {
        return { error: `${email}: похоже на аккаунт с 2FA (base32-секрет в строке), а не на ящик` };
    }
    return {
        email,
        password,
        kind: isStudentDomain(email) ? 'student' : 'personal',
        note: tail.length ? tail.join(' · ') : '',
    };
}

// Пачка → { entries, errors, duplicates }. Дубли считаем и внутри пачки, и против пула:
// перезалив того же чека не должен плодить второй профиль на тот же ящик.
function parseBulk(text, existing) {
    const have = new Set((existing || []).map(a => String(a.email || '').toLowerCase()));
    const seen = new Set();
    const entries = [], errors = [], duplicates = [];
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (!line || NOISE_RE.test(line)) return;
        const r = parseLine(line);
        // Строку без адреса считаем шумом чека, а не ошибкой: в файле магазина таких
        // строк больше, чем полезных (реклама, рамки, ссылки), и в отчёте импорта они
        // забивали бы настоящие проблемы. Ошибка — это строка С адресом, но без пароля.
        if (r.error === NO_EMAIL) return;
        if (r.error) { errors.push({ line: i + 1, error: r.error }); return; }
        if (have.has(r.email) || seen.has(r.email)) { duplicates.push(r.email); return; }
        seen.add(r.email);
        entries.push(r);
    });
    return { entries, errors, duplicates };
}

module.exports = { DIR, FILE, PROFILES_DIR, SESSIONS_DIR, STATUSES, KINDS, load, save, isEmail, isStudentDomain, profileLabel, splitFields, parseLine, parseBulk };
