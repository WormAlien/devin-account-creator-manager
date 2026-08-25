#!/usr/bin/env node
// Пруф Aliyun WAF: браузер добывает, бэкенд пользуется (25.08).
//
// Разбор: `/api/user/self` у agentrouter отдаёт нашему node-клиенту JS-челлендж, а не
// JSON. Браузер челлендж решает и получает куку `acw_sc__v2` — СЕССИОННУЮ, то есть в
// SQLite профиля она не попадает вообще. Поэтому чтение профиля пруф не находит никогда,
// и «WAF-заглушка (слишком часто)» была неверным диагнозом: замер показал челлендж на
// одиночном запросе через минуты после прогона.
//
// Запуск: node tools/check-waf-proof.js
'use strict';
const fs = require('fs');
const path = require('path');

const lf = (s) => s.replace(/\r\n/g, '\n');
const LIB_PATH = path.join(__dirname, '..', 'routing', 'lib', 'newapi-account.js');
const LIB = lf(fs.readFileSync(LIB_PATH, 'utf8'));
const SESS = lf(fs.readFileSync(path.join(__dirname, '..', 'agentrouter', 'open-session.js'), 'utf8'));
const lib = require(LIB_PATH);

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};
const cutFn = (src, head) => {
    const i = src.indexOf(head);
    if (i < 0) return '';
    const j = src.indexOf('\n}', i);
    return src.slice(i, j < 0 ? undefined : j + 2);
};

// ── 1. дверь в jar для браузерных кук ──
check(typeof lib.putJarCookies === 'function', 'putJarCookies экспортирован');
const put = cutFn(LIB, 'function putJarCookies(');
check(/fromBrowserAt/.test(put), 'запись помечается как пришедшая из браузера');
check(/cookiesAt/.test(put) && /updatedAt/.test(put),
    'штампы ротации обновляются — иначе effectiveCookieHeader сочтёт jar старее профиля');
check(!/console\.log/.test(put), 'значения кук в лог не печатаются');

// Функциональная проверка на подставном хосте: живой jar не трогаем.
{
    const HOST = 'check-waf-proof.invalid';
    const DIR = 'C:/tmp/acct_check_waf';
    const key = lib.jarKey(HOST, DIR);
    const wrote = lib.putJarCookies(HOST, DIR, { acw_sc__v2: 'proof-1', session: 's-1' });
    const entry = lib.loadJar()[key];
    check(wrote === 2 && entry && Object.keys(entry.cookies).length === 2, `две куки записаны (получили ${wrote})`);
    check(/acw_sc__v2/.test(Object.keys(entry.cookies).join(',')), 'пруф WAF попал в jar');
    const again = lib.putJarCookies(HOST, DIR, { acw_sc__v2: 'proof-1' });
    check(again === 0, 'повторная запись того же значения ничего не меняет');
    const upd = lib.putJarCookies(HOST, DIR, { acw_sc__v2: 'proof-2' });
    check(upd === 1 && lib.loadJar()[key].cookies.acw_sc__v2 === 'proof-2', 'новое значение перетирает старое');
    check(lib.putJarCookies(HOST, DIR, {}) === 0, 'пустой набор jar не портит');
    const hdr = lib.effectiveCookieHeader(HOST, DIR, lib.loadJar());
    check(/acw_sc__v2=proof-2/.test(hdr) && /session=s-1/.test(hdr), 'обе куки уезжают в Cookie-заголовок запроса');
    const jar = lib.loadJar(); delete jar[key]; lib.saveJar(jar);
    check(!lib.loadJar()[key], 'тестовая запись убрана из jar');
}

// ── 2. браузер отдаёт куки перед закрытием окна ──
const harvest = cutFn(SESS, 'async function harvestCookiesToJar(');
check(/context\.cookies\('https:\/\/agentrouter\.org'\)/.test(harvest),
    'куки берутся из ЖИВОГО контекста, а не из профиля — иначе сессионных не увидеть');
check(/putJarCookies\('agentrouter\.org', profileDir/.test(harvest), 'уезжают в jar под профиль аккаунта');
check(/expires > 0/.test(harvest), 'сессионные куки называются отдельно — их на диске нет');
check(!/c\.value\}/.test(harvest) && !/JSON\.stringify\(map\)/.test(harvest), 'значения кук в лог не попадают');
{
    // Сбор обязан идти ДО закрытия контекста, иначе брать будет нечего.
    const calls = [...SESS.matchAll(/harvestCookiesToJar\(context\)/g)].map(m => m.index);
    check(calls.length >= 4, `сбор зовётся на всех путях закрытия (нашли ${calls.length})`);
    const closes = [...SESS.matchAll(/context\.close\(\)/g)].map(m => m.index);
    const okOrder = calls.every(c => closes.some(z => z > c));
    check(okOrder, 'каждый вызов сбора стоит перед каким-то context.close()');
}

// ── 3. честный текст про челлендж ──
const selfFn = LIB.slice(LIB.indexOf("await apiFetch(host, '/api/user/self'"));
const wafBranch = selfFn.slice(0, selfFn.indexOf('if (r.status === 401'));
check(/acw_sc__v2/.test(wafBranch), 'в диагнозе названа кука-пруф, а не «слишком часто»');
check(/hasProof/.test(wafBranch), 'текст различает «пруфа нет» и «пруф есть, а всё равно отбил»');
check(/открой ЛК/.test(wafBranch), 'сказано, что делать владельцу');
check(!/WAF-заглушка \(слишком часто\), пауза 10 мин/.test(wafBranch), 'старая формулировка-догадка убрана');
check(/coolDownHost\(host\)/.test(wafBranch), 'пауза по хосту осталась — залпом в челлендж лезть нельзя');

// ── 4. пауза по частоте: короткая, растущая, пробиваемая кликом ──
{
    const steps = LIB.match(/const COOLDOWN_STEPS_MS = \[([^\]]+)\]/);
    check(!!steps, 'пауза задана лестницей, а не одним числом');
    const first = steps ? Number(String(steps[1]).split(',')[0].replace(/[^\d]/g, '')) : 0;
    check(first > 0 && first <= 60_000, `первый отказ стоит не больше минуты (получили ${first / 1000}с)`);
    check(/STRIKE_FORGET_MS/.test(LIB), 'серия отказов забывается после тишины');
    const cool = cutFn(LIB, 'function coolDownHost(');
    check(/Math\.min\(prev\.n \+ 1/.test(cool), 'повторные отказы удлиняют паузу');
    check(/function clearHostStrikes\(/.test(LIB) && /clearHostStrikes\(host\)/.test(cutFn(LIB, 'function selfOk(')),
        'успешный ответ сбрасывает серию — иначе следующая заглушка начнёт с потолка');
    const inner = LIB.slice(LIB.indexOf('async function accountSelfInner('));
    check(/if \(cooling && !force\) return/.test(inner), 'автоматический тик пауза не пробивает');
    check(/cooling && force/.test(inner), 'клик владельца пробивает паузу одним запросом');
    check(/force,/.test(fs.readFileSync(path.join(__dirname, '..', 'routing', 'transparent-proxy.js'), 'utf8')),
        'дашборд передаёт force в accountSelf');
    check(!/COOLDOWN_MS = 10 \* 60_000/.test(LIB), 'глухая десятиминутная пауза убрана');
}

console.log(fail ? `\n❌ ${fail} провалено` : '\nПруф WAF: браузер кладёт куку в jar, бэкенд ходит с ней, диагноз честный.');
process.exit(fail ? 1 : 0);
