#!/usr/bin/env node
// Точная цифра шлюза для одного аккаунта — мимо дашборда, без рестарта `:8200`.
//
// Зачем: когда в таблице стоит анкер или прикидка, надо отличить «шлюз молчит» от
// «читать куки нечем». Скрипт печатает всё, что решает исход: заперта ли БД куки
// (открытое окно ЛК держит её монопольно — FILE_SHARE_NONE, копия невозможна),
// сколько куки нашлось, что ответил /api/user/self.
//
// Запуск:  node tools/probe-account-self.js <ar|go|jw|tb|xp> <id|подстрока имени> [--wait N]
//   --wait N — ждать до N секунд, пока окно ЛК закроют и замок снимется.
'use strict';
const fs = require('fs');
const path = require('path');

const lib = require('../routing/lib/newapi-account.js');

const POOLS = {
    ar: { file: 'routing/agentrouter-sessions.json', host: 'agentrouter.org', profiles: 'agentrouter/profiles' },
    go: { file: 'routing/gorouter-sessions.json', host: 'gorouter.app', profiles: 'gorouter/profiles' },
    jw: { file: 'routing/justwoker-sessions.json', host: 'api.justwoker.icu', profiles: 'justwoker/profiles' },
    tb: { file: 'routing/tabi-sessions.json', host: 'tabitoken.com', profiles: 'tabi/profiles' },
    xp: { file: 'routing/xpeach-sessions.json', host: 'xpeach.codes', profiles: 'xpeach/profiles' },
};

const [, , poolArg, needle] = process.argv;
const waitIdx = process.argv.indexOf('--wait');
const waitSec = waitIdx > 0 ? Number(process.argv[waitIdx + 1]) || 0 : 0;
const pool = POOLS[String(poolArg || '').toLowerCase()];
if (!pool || !needle) {
    console.error('использование: node tools/probe-account-self.js <ar|go|jw|tb|xp> <id|подстрока имени> [--wait сек]');
    process.exit(2);
}

const root = path.join(__dirname, '..');
const list = JSON.parse(fs.readFileSync(path.join(root, pool.file), 'utf8'));
const rows = Array.isArray(list) ? list : (list.sessions || []);
const t = rows.find(s => s.id === needle)
    || rows.find(s => `${s.name || ''} ${s.email || ''}`.toLowerCase().includes(String(needle).toLowerCase()));
if (!t) { console.error(`аккаунт «${needle}» в ${pool.file} не найден`); process.exit(1); }

const label = t.profile || ('acct_' + t.id);
const dir = path.join(root, pool.profiles, label);

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    console.log(`аккаунт : ${t.name || t.email || t.id}  (${pool.host})`);
    console.log(`профиль : ${label}${fs.existsSync(dir) ? '' : '  ← НА ДИСКЕ НЕТ'}`);
    console.log(`в пуле  : $${typeof t.balance === 'number' ? t.balance.toFixed(2) : '—'}`
        + ` (${t.balanceSource || 'нет источника'})`
        + `${t.balanceAnchor != null ? `, вписано вручную $${Number(t.balanceAnchor).toFixed(2)}` : ''}`
        + `${typeof t.selfBalance === 'number' ? `, последняя точная $${t.selfBalance.toFixed(2)}` : ''}`);

    const deadline = Date.now() + waitSec * 1000;
    let locked = lib.cookieDbLocked(dir);
    if (locked && waitSec > 0) console.log(`замок   : БД куки заперта — жду закрытия окна ЛК до ${waitSec} с…`);
    while (locked && Date.now() < deadline) {
        await sleep(2000);
        locked = lib.cookieDbLocked(dir);
    }
    console.log(`замок   : ${locked ? 'ЗАПЕРТА — окно ЛК этого аккаунта открыто' : 'снят'}`);
    if (locked) {
        console.log(`причина : ${lib.cookieFailReason(dir, pool.host)}`);
        process.exit(3);
    }

    const ck = lib.readProfileCookies(dir).filter(c => c.host === pool.host || c.host.endsWith('.' + pool.host));
    console.log(`куки    : ${ck.length} для ${pool.host}${ck.length ? ` (${ck.map(c => c.name).join(', ')})` : ''}`);

    const me = await lib.accountSelf({
        host: pool.host, profileDir: dir,
        accessToken: t.accessToken || null,
        userId: t.newApiUserId || null,
    }).catch(e => ({ ok: false, error: e.message }));

    if (!me.ok || me.balance == null) {
        console.log(`self    : не ответил — ${me.error || 'без причины'}`);
        process.exit(4);
    }
    console.log(`self    : остаток $${me.balance.toFixed(2)}`
        + `, потрачено $${me.spent != null ? me.spent.toFixed(2) : '—'}`
        + `, выдано $${me.granted != null ? me.granted.toFixed(2) : '—'}`
        + `${me.username ? ` · ${me.username}` : ''}`);
    const anchor = Number(t.balanceAnchor);
    if (isFinite(anchor) && anchor > 0) {
        const d = me.balance - anchor;
        console.log(`итог    : шлюз показывает ${d >= 0 ? 'на $' + d.toFixed(2) + ' БОЛЬШЕ' : 'на $' + Math.abs(d).toFixed(2) + ' меньше'},`
            + ' чем вписано вручную — после рестарта :8200 в таблице встанет цифра шлюза');
    }
})();
