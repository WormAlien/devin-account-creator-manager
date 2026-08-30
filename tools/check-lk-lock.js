#!/usr/bin/env node
// Открытое окно ЛК держит БД куки → точный баланс не читается (разбор 2026-08-24).
//
// Стоило это владельцу петли: клик 💰 при открытом окне отвечал «в профиле нет куки —
// войди в ЛК заново», по этому совету окно открывалось снова, замок держался дальше, и
// аккаунт `WA justwoker` показывал вписанные вручную $0.26 при $604.38 в кабинете.
//
// Проверяем два конца починки: честный текст причины и автоматический перечёт после
// закрытия окна.
//
// Запуск: node tools/check-lk-lock.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../routing/lib/newapi-account.js');
// 🪤 Файлы репозитория в рабочей копии лежат в CRLF (`core.autocrlf=true`), а срезы
// функций ищут терминатор `\n}`. Без нормализации проверки не находят тело и краснеют
// (а в других чекерах ровно так же умели зеленеть) — поэтому читаем в LF.
const lf = (s) => s.replace(/\r\n/g, '\n');
const PROXY = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'transparent-proxy.js'), 'utf8'));
const LIB_SRC = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'lib', 'newapi-account.js'), 'utf8'));

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};

// ── 1. cookieDbLocked: есть, экспортирован, не врёт на обычных путях ──
check(typeof lib.cookieDbLocked === 'function', 'cookieDbLocked экспортирован из newapi-account');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lklock-'));
try {
    check(lib.cookieDbLocked(tmp) === false, 'профиль без БД куки заперым не считается');
    fs.mkdirSync(path.join(tmp, 'Default', 'Network'), { recursive: true });
    const db = path.join(tmp, 'Default', 'Network', 'Cookies');
    fs.writeFileSync(db, 'not-a-real-sqlite');
    check(lib.cookieDbLocked(tmp) === false, 'свободный файл БД заперым не считается');
    // Причина для незапертого профиля остаётся прежней — про отсутствие куки.
    const why = lib.cookieFailReason(tmp, 'api.justwoker.icu');
    check(/нет куки|ключ профиля|better-sqlite3/.test(why),
        `у свободного профиля причина прежняя (получили: ${why.slice(0, 60)}…)`);
    check(!/браузер этого аккаунта/i.test(why), 'про открытый браузер на свободном профиле не врём');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 2. порядок: замок проверяется РАНЬШЕ вывода «сессия не сохранилась» ──
const reason = LIB_SRC.slice(LIB_SRC.indexOf('function cookieFailReason('));
const reasonBody = reason.slice(0, reason.indexOf('\n}\n') + 2);
const lockAt = reasonBody.indexOf('if (cookieDbLocked(');
// Ищем именно RETURN со старым текстом, а не любое его упоминание: фраза «сессия не
// сохранилась» есть и в комментарии над проверкой замка (там объясняется, чем плох
// прежний совет), и по нему сравнение позиций переворачивалось.
const staleAt = reasonBody.indexOf('return `в профиле нет куки для');
check(lockAt > 0 && staleAt > 0 && lockAt < staleAt,
    'замок проверяется до совета «войди в ЛК заново» — иначе совет держит замок дальше');
check(/EBUSY/.test(LIB_SRC.slice(LIB_SRC.indexOf('function cookieDbLocked('), LIB_SRC.indexOf('function cookieFailReason('))),
    'ловим именно код блокировки (EBUSY и родня), а не любую ошибку чтения');

// ── 3. перечёт после закрытия окна ЛК ──
check(/function newapiRecheckAfterLk\(/.test(PROXY), 'newapiRecheckAfterLk есть');
const re = PROXY.slice(PROXY.indexOf('function newapiRecheckAfterLk('));
const reBody = re.slice(0, re.indexOf('\n}\n') + 2);
check(/force: true/.test(reBody), 'перечёт идёт с force — визит в ЛК уже снял годность сохранённой цифры');
check(/gw\.applyFn\(/.test(reBody) && /gw\.save\(/.test(reBody), 'результат применяется и сохраняется в пул');
check(/setTimeout/.test(reBody), 'пауза на флаш SQLite есть (запись на закрытии асинхронна)');
check(/logLine\(/.test(reBody), 'итог перечёта виден в логе — иначе молчаливая магия');

// Все пять шлюзов зовут перечёт из своего обработчика 'exit'.
// KKtoken (kk, 31.08) — восьмой шлюз, структурная копия GoRouter, значит и хвост тот же.
for (const [gw, tag] of [['ar', 'agentrouter'], ['go', 'gorouter'], ['jw', 'justwoker'], ['tb', 'tabi'], ['xp', 'xpeach'], ['kk', 'kktoken']]) {
    check(new RegExp(`newapiRecheckAfterLk\\('${gw}', id\\)`).test(PROXY), `${tag}: перечёт вызван после закрытия ЛК`);
}
// У AgentRouter путь чек-ина свой (снимок из браузера) — второй чек к шлюзу там не нужен.
// Спавн с 25.08 общий (arSpawnSession, очередь чек-инов), хвост живёт там же.
const arExit = PROXY.slice(PROXY.indexOf('function arSpawnSession('));
check(/else newapiRecheckAfterLk\('ar', id\)/.test(arExit.slice(0, 2500)),
    'у AgentRouter перечёт только для обычного визита, режимы чек-ина его не дублируют');

console.log(fail ? `\n❌ ${fail} провалено` : '\nЗамок куки: причина честная, перечёт после закрытия ЛК автоматический.');
process.exit(fail ? 1 : 0);
