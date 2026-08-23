// routing/lib/ref-codes.js
//
// Реф-коды провайдеров в ОДНОМ месте: дефолт владельца репозитория + переопределение
// пользователя. До этого код рефки был захардкожен в ДЕСЯТИ точках — пять
// `<prov>/open-session.js`, `justwoker/auto-add.js` и четыре ссылки в разметке
// дашборда, — и любая забытая точка означала молча потерянный реф-кредит.
//
// Два файла, и разница между ними принципиальная:
//   ref-codes.default.json — В РЕПОЗИТОРИИ, коды владельца. Форк без настройки
//                            работает как раньше: регистрации идут по рефке владельца.
//   ref-codes.json         — в .gitignore, коды ПОЛЬЗОВАТЕЛЯ. Пишет дашборд (💩 в
//                            «Настройках»). Пустое значение = вернуться к дефолту.
//
// 🪤 Хост и путь — часть КОДА, а не настройки. Пользователь вписывает только сам код,
// поэтому подставить чужой хост через настройку нельзя. Формы у провайдеров разные:
// у AgentRouter `/register?aff=`, у остальных четырёх `/sign-up?aff=` — это не опечатка.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');
const DEFAULTS_FILE = path.join(DIR, 'ref-codes.default.json');
const USER_FILE = path.join(DIR, 'ref-codes.json');

const SHAPES = {
    agentrouter: { host: 'agentrouter.org',   path: '/register?aff=', label: 'AgentRouter' },
    gorouter:    { host: 'gorouter.app',      path: '/sign-up?aff=',  label: 'GoRouter' },
    justwoker:   { host: 'api.justwoker.icu', path: '/sign-up?aff=',  label: 'JustWoker' },
    tabi:        { host: 'tabitoken.com',     path: '/sign-up?aff=',  label: 'Tabi Token' },
    xpeach:      { host: 'xpeach.codes',      path: '/sign-up?aff=',  label: 'XPeach' },
};
const PROVIDERS = Object.keys(SHAPES);

function readJson(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
    } catch { return {}; }
}

// Код принимаем только распознаваемой формы. Мусор из файла не должен уехать в URL:
// «пусто» и «мусор» одинаково означают «взять дефолт», а не «сходить без рефки».
const CODE_RE = /^[A-Za-z0-9_-]{2,32}$/;
function clean(v) {
    const s = String(v == null ? '' : v).trim();
    return CODE_RE.test(s) ? s : null;
}

function defaults() {
    const d = readJson(DEFAULTS_FILE);
    const out = {};
    for (const p of PROVIDERS) out[p] = clean(d[p]);
    return out;
}

// Только реально заданные ключи — чтобы UI отличал «пользователь вписал» от «пусто».
function user() {
    const u = readJson(USER_FILE);
    const out = {};
    for (const p of PROVIDERS) { const c = clean(u[p]); if (c) out[p] = c; }
    return out;
}

function effective() {
    const d = defaults(), u = user(), out = {};
    for (const p of PROVIDERS) out[p] = u[p] || d[p] || null;
    return out;
}

function code(prov) { return effective()[prov] || null; }

// Ссылка на регистрацию. Без кода отдаём корень сайта, а не ссылку с пустым `aff=`:
// битый параметр панель может принять за код и потерять кредит вообще.
function url(prov) {
    const s = SHAPES[prov];
    if (!s) return null;
    const c = code(prov);
    return c ? `https://${s.host}${s.path}${encodeURIComponent(c)}` : `https://${s.host}/`;
}

// patch: { <prov>: '<код>' | '' }. Пустая строка удаляет переопределение (возврат к
// дефолту), неизвестные провайдеры игнорируются молча — фронт не должен уметь
// заводить новые ключи.
function save(patch) {
    const cur = readJson(USER_FILE);
    const next = {};
    for (const p of PROVIDERS) {
        if (Object.prototype.hasOwnProperty.call(patch || {}, p)) {
            const c = clean(patch[p]);
            if (c) next[p] = c;                       // задан — пишем
        } else if (clean(cur[p])) {
            next[p] = clean(cur[p]);                  // не трогали — сохраняем
        }
    }
    fs.writeFileSync(USER_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
}

module.exports = { PROVIDERS, SHAPES, defaults, user, effective, code, url, save, USER_FILE, DEFAULTS_FILE };
