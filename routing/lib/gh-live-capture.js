// routing/lib/gh-live-capture.js
//
// Ручной вход в GitHub внутри профиля тоже должен сохраниться.
//
// Как было: <provider>/open-session.js снимает копию GitHub-сессии ОДИН РАЗ — сразу
// после открытия окна — и уходит спать до закрытия (`new Promise(() => {})`). Всё, что
// человек делает дальше, в копию не попадало, а приходит он ровно за этим: жмёт
// «Continue with GitHub», логинится руками, GitHub выдаёт новый `user_session`. На диске
// при этом остаётся снимок ДО входа. Ссылаться на «оно и так в профиле» нельзя: Chromium
// пишет куки в SQLite лениво, и закрытие окна по Ctrl+C флаш не гарантирует — ровно так
// профиль `acct_ar_1786714708319_0` две недели жил на заселённой сессии от 20.08, хотя
// вход руками делали позже (замер 22.08: `user_session` в копии = seed от 20.08).
//
// Что делает модуль: пока окно открыто, каждые POLL_MS опрашивает банку кук КОНТЕКСТА
// (это память, флаш на диск не нужен) и, как только видит новый `user_session`,
//   1) перезаписывает <provider>/gh-sessions/<label>.json — источник, из которого чек-ин
//      возвращает сессию, если GitHub погасит её сам;
//   2) обновляет общий снимок github/sessions/<ghId>.json, если у записи пула есть
//      привязка `gh_…` — тот самый снимок, которым заселяют профили новых аккаунтов.
//
// Сырых запросов к github.com здесь нет и быть не должно: фейковый UA GitHub считает
// угоном и гасит сессию (см. routing/lib/github-session.js).

const fs = require('fs');
const path = require('path');

const POLL_MS = 5 * 1000;

function isGithubCookie(c) {
    const d = String((c && c.domain) || '').replace(/^\./, '');
    return d === 'github.com' || d.endsWith('.github.com');
}

function isGithubOrigin(o) {
    return /^https:\/\/([\w-]+\.)*github\.com$/i.test(String((o && o.origin) || ''));
}

function userSessionOf(cookies) {
    const c = (cookies || []).find(x => x.name === 'user_session' && x.value);
    return c ? c.value : null;
}

// Пул провайдера: массив записей либо {sessions:[…]}. Нужен ровно один факт — какой
// GitHub привязан к записи (поле ghId), чтобы обновить и общий снимок.
function ghIdForLabel(poolFile, label) {
    try {
        const id = String(label || '').replace(/^acct_/, '');
        const raw = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
        const arr = Array.isArray(raw) ? raw : (raw.sessions || raw.list || []);
        const rec = arr.find(s => String(s.id) === id);
        const ghId = rec && rec.ghId;
        return /^gh_/.test(String(ghId || '')) ? ghId : null;
    } catch { return null; }
}

function makeCapture({ label, moduleDir, poolFile }) {
    const backupDir = path.join(moduleDir, 'gh-sessions');
    const backupFile = path.join(backupDir, label + '.json');
    const sharedDir = path.join(moduleDir, '..', 'github', 'sessions');

    // Что уже лежит на диске. Сравниваем по значению user_session: сессия скользящая,
    // GitHub ротирует куку — новое значение и есть признак «вход был».
    function savedUserSession() {
        try {
            return userSessionOf(JSON.parse(fs.readFileSync(backupFile, 'utf8')).cookies);
        } catch { return null; }
    }

    // Сессионные куки (expires ≤ 0) не сохраняем: они умирают вместе с браузером,
    // восстанавливать их бессмысленно. Формат файла — тот же, что у saveGhBackup.
    function writeBackup(cookies) {
        const keep = cookies.filter(c => isGithubCookie(c) && c.expires > 0);
        if (!keep.length) return 0;
        fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(backupFile,
            JSON.stringify({ savedAt: new Date().toISOString(), cookies: keep }, null, 2) + '\n', 'utf8');
        return keep.length;
    }

    // Общий снимок для заселения новых профилей. Формат — как у github/harvest-session.js,
    // иначе open-session.js не примет его за seed:'github'.
    async function writeShared(context, ghId, cookies) {
        const state = await context.storageState().catch(() => null);
        if (!state) return false;
        const ghCookies = (state.cookies || []).filter(isGithubCookie);
        if (!userSessionOf(ghCookies)) return false;
        const origins = (state.origins || []).filter(isGithubOrigin);
        const login = ((cookies || []).find(c => c.name === 'dotcom_user') || {}).value || null;
        fs.mkdirSync(sharedDir, { recursive: true });
        fs.writeFileSync(path.join(sharedDir, ghId + '.json'), JSON.stringify({
            seed: 'github',
            ghLogin: login,
            harvestedAt: new Date().toISOString(),
            verifiedAt: new Date().toISOString(),
            source: path.join(moduleDir, 'profiles', label),
            cookies: ghCookies,
            origins,
        }, null, 2) + '\n', 'utf8');
        return true;
    }

    // Один замер. Возвращает true, если сессия оказалась новой и копия обновлена.
    async function captureOnce(context, { quiet = false } = {}) {
        const cookies = await context.cookies('https://github.com').catch(() => []);
        const live = userSessionOf(cookies);
        if (!live || live === savedUserSession()) return false;
        try {
            const n = writeBackup(cookies);
            if (!n) return false;
            if (!quiet) console.log(`🐙 ручной вход в GitHub сохранён (${n} кук) — чек-ин сможет его вернуть`);
            const ghId = poolFile ? ghIdForLabel(poolFile, label) : null;
            if (ghId && await writeShared(context, ghId, cookies)) {
                if (!quiet) console.log(`   общий снимок ${ghId} обновлён — новые профили заселятся этой сессией`);
            }
            return true;
        } catch (e) {
            console.log(`⚠️  копию GitHub-сессии сохранить не удалось: ${e.message}`);
            return false;
        }
    }

    // Замена `await new Promise(() => {})`: так же держит скрипт до закрытия окна,
    // но по дороге забирает ручной вход. Промис не резолвится — закрытие контекста
    // роняет процесс сам, как и раньше.
    function holdOpen(context) {
        return new Promise(() => {
            const timer = setInterval(() => { captureOnce(context).catch(() => {}); }, POLL_MS);
            context.on('close', () => clearInterval(timer));
        });
    }

    return { captureOnce, holdOpen, backupFile };
}

module.exports = { makeCapture, isGithubCookie, userSessionOf, POLL_MS };
