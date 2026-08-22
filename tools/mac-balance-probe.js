#!/usr/bin/env node
// Почему дашборд показывает «~ прикидку»: прогоняем ТОТ ЖЕ путь, что и он.
//
// Порядок источников баланса в transparent-proxy.js: self (куки профиля) →
// anchor (вписанный руками) → guess (прикидка). Если self не сработал, причина
// пишется в selfError, но в UI видна только подсказкой. Здесь она печатается
// целиком, вместе с промежуточными шагами: нашлась ли папка профиля, читаются
// ли куки, есть ли среди них сессионная, что ответил сервер.
//
// Секреты не печатаются: у куки только имя и длина.
// Запуск:  node tools/mac-balance-probe.js  [ar|go|tb|xp|jw]
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAP = {
    ar: { host: 'agentrouter.org', pool: 'routing/agentrouter-sessions.json', profiles: 'agentrouter/profiles' },
    go: { host: 'gorouter.app', pool: 'routing/gorouter-sessions.json', profiles: 'gorouter/profiles' },
    tb: { host: 'tabitoken.com', pool: 'routing/tabi-sessions.json', profiles: 'tabi/profiles' },
    xp: { host: 'xpeach.codes', pool: 'routing/xpeach-sessions.json', profiles: 'xpeach/profiles' },
    // 🪤 У JustWoker панель и API живут на ОДНОМ хосте с поддоменом: `api.justwoker.icu`.
    // Голый `justwoker.icu` не резолвится, поэтому здесь он обязателен — иначе куки
    // профиля не найдутся и точный баланс молча деградирует в «~ прикидку».
    // `token` — по какому куску имени искать куки в профиле. Для остальных четырёх это
    // первая метка хоста, но у этого она `api`: фильтр по ней притянул бы куки любого
    // домена со словом «api» и наврал бы в обе стороны.
    jw: { host: 'api.justwoker.icu', token: 'justwoker', pool: 'routing/justwoker-sessions.json', profiles: 'justwoker/profiles' },
};
const which = (process.argv[2] || 'ar').toLowerCase();
const cfg = MAP[which];
if (!cfg) { console.error(`не знаю «${which}», выбирай из: ${Object.keys(MAP).join(', ')}`); process.exit(1); }

const b = s => `\x1b[1m${s}\x1b[0m`;
const ok = s => console.log(`\x1b[32m  + ${s}\x1b[0m`);
const no = s => console.log(`\x1b[31m  - ${s}\x1b[0m`);
const dim = s => console.log(`\x1b[90m    ${s}\x1b[0m`);

console.log(b(`\n== mac-balance-probe · ${cfg.host} ==`));
console.log(`platform: ${process.platform} · node ${process.version}\n`);

let lib;
try { lib = require(path.join(ROOT, 'routing', 'lib', 'newapi-account')); ok('lib/newapi-account загрузился'); }
catch (e) { no(`lib/newapi-account не загрузился: ${e.message}`); process.exit(1); }

const ready = lib.cookieBackendReady();
console.log(ready.ok ? '' : `  ! бэкенд куки: ${ready.error}`);

// ── пул записей ──
let pool = [];
try {
    const raw = fs.readFileSync(path.join(ROOT, cfg.pool), 'utf8');
    const j = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    pool = Array.isArray(j) ? j : (j.accounts || j.list || j.sessions || []);
} catch (e) { no(`пул ${cfg.pool} не прочитался: ${e.message}`); process.exit(1); }
if (!pool.length) { no('в пуле нет записей — добавь аккаунт в дашборде'); process.exit(0); }
ok(`записей в пуле: ${pool.length}`);

// Как дашборд ищет профиль: сначала метка target.profile, потом acct_<id>.
function resolveProfile(target) {
    const base = path.join(ROOT, cfg.profiles);
    for (const label of [target.profile, target.id ? 'acct_' + target.id : null]) {
        if (!label) continue;
        const dir = path.join(base, String(label).replace(/[\\/]/g, ''));
        if (fs.existsSync(dir)) return { dir, label };
    }
    return { dir: null, label: null };
}

(async () => {
    let good = 0;
    for (const t of pool.slice(0, 6)) {
        const tag = t.name || t.email || t.id || '?';
        console.log(b(`\n${tag}`));
        dim(`id=${t.id || '—'} · profile-метка=${t.profile || 'нет'} · balanceSource=${t.balanceSource || '—'}`
            + (t.selfError ? ` · прошлая ошибка: ${t.selfError}` : ''));

        const prof = resolveProfile(t);
        if (!prof.dir) {
            no(`папки профиля нет (искал profile-метку и acct_${t.id})`);
            dim(`что лежит в ${cfg.profiles}: ${(fs.readdirSync(path.join(ROOT, cfg.profiles)) || []).slice(0, 8).join(', ')}`);
            continue;
        }
        ok(`профиль: ${prof.label}`);

        const key = lib.profileAesKey(prof.dir);
        if (!key) { no(`ключ куки не подобрался · ${lib.cookieFailReason(prof.dir, cfg.host)}`); continue; }
        ok(`ключ куки: ${key.length} байт`);

        const cookies = lib.readProfileCookies(prof.dir);
        const token = cfg.token || cfg.host.split('.')[0];
        const mine = cookies.filter(c => String(c.host || '').includes(token));
        if (!mine.length) { no(`куки для ${cfg.host} не прочитались (всего в профиле: ${cookies.length}) · ${lib.cookieFailReason(prof.dir, cfg.host)}`); continue; }
        ok(`куки: ${mine.map(c => `${c.name}(${String(c.value || '').length})`).join(', ')}`);

        // ── тот самый вызов, что делает дашборд ──
        const t0 = Date.now();
        let res;
        try { res = await lib.accountSelf({ host: cfg.host, profileDir: prof.dir, accessToken: t.accessToken || null, userId: t.newApiUserId || null }); }
        catch (e) { res = { ok: false, error: 'исключение: ' + e.message }; }
        const ms = Date.now() - t0;

        if (res && res.ok && res.balance != null) {
            good++;
            ok(`accountSelf: $${res.balance} (расход $${res.spent != null ? res.spent : '?'}, grant $${res.granted != null ? res.granted : '?'}) за ${ms}мс`);
        } else {
            no(`accountSelf не дал баланс за ${ms}мс: ${res && res.error ? res.error : JSON.stringify(res)}`);
        }
    }

    console.log(b('\n== вердикт =='));
    if (good) {
        ok(`точный баланс работает у ${good} записей — в дашборде жми «Проверить баланс»`);
        console.log('  Если там всё ещё «прикидка» — дашборд не перезапускался после git pull:');
        console.log('  bash routing/restart-dashboard.sh');
    } else {
        no('точный баланс не получился ни у одной записи — пришли вывод целиком');
    }
    console.log('');
})();
