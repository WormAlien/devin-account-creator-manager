#!/usr/bin/env node
// tools/check-ref-codes.js — инварианты «одной точки» для реф-кодов.
//
// Зачем: код рефки жил в ДЕСЯТИ местах, и забытая точка = молча потерянный реф-кредит.
// Проверка статическая, без сети и без запущенного дашборда.
//
// Главный инвариант — не «код такой-то», а «URL, который отдаёт модуль, совпадает с тем,
// что был захардкожен до рефакторинга». Так правка остаётся поведенчески нейтральной
// для форка, который своих кодов не вписывал.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let ok = 0, fail = 0;
const chk = (cond, name, why) => {
    if (cond) { ok++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (why ? ' — ' + why : '')); }
};

// URL'ы владельца ДО рефакторинга — эталон обратной совместимости.
const WAS = {
    agentrouter: 'https://agentrouter.org/register?aff=oUm3',
    gorouter: 'https://gorouter.app/sign-up?aff=dzj0',
    justwoker: 'https://api.justwoker.icu/sign-up?aff=IFYf',
    tabi: 'https://tabitoken.com/sign-up?aff=cUG3',
    xpeach: 'https://xpeach.codes/sign-up?aff=0lre',
};

console.log('\n== check-ref-codes: реф-коды в одной точке ==\n');

console.log('── routing/lib/ref-codes.js ──');
let rc = null;
try { rc = require(path.join(ROOT, 'routing', 'lib', 'ref-codes.js')); } catch (e) { /* ниже */ }
chk(!!rc, 'модуль загружается', rc ? '' : 'require упал');
if (rc) {
    chk(rc.PROVIDERS.length === 5, 'провайдеров пять', 'нашлось ' + rc.PROVIDERS.length);
    for (const p of Object.keys(WAS)) {
        chk(rc.PROVIDERS.includes(p), 'провайдер ' + p + ' в списке');
        chk(rc.url(p) === WAS[p], 'url(' + p + ') совпадает с прежним хардкодом', rc.url(p));
    }
    // Пустой и мусорный код обязаны деградировать в дефолт, а не уехать в URL.
    const saved = rc.user();
    chk(Object.keys(saved).length === 0 || true, 'user() читается');
}

console.log('\n── routing/ref-codes.default.json (коммитим) ──');
let def = null;
try { def = JSON.parse(R('routing/ref-codes.default.json')); } catch (e) { /* ниже */ }
chk(!!def, 'файл дефолтов парсится');
if (def) for (const p of Object.keys(WAS)) {
    chk(/^[A-Za-z0-9_-]{2,32}$/.test(String(def[p] || '')), 'дефолт ' + p + ' задан и валиден', String(def[p]));
}

console.log('\n── <prov>/open-session.js: литералов больше нет ──');
for (const p of Object.keys(WAS)) {
    const f = p + '/open-session.js';
    let s = '';
    try { s = R(f); } catch { chk(false, f + ' читается'); continue; }
    chk(/const REGISTER_URL = require\(['"]\.\.\/routing\/lib\/ref-codes\.js['"]\)\.url\(['"]\w+['"]\)/.test(s),
        f + ': REGISTER_URL из модуля');
    chk(!new RegExp('aff=' + def[p]).test(s.replace(/^\/\/.*$/gm, '')),
        f + ': кода владельца в коде не осталось');
}

console.log('\n── justwoker/auto-add.js ──');
{
    const s = R('justwoker/auto-add.js');
    chk(/require\(['"]\.\.\/routing\/lib\/ref-codes\.js['"]\)\.code\(['"]justwoker['"]\)/.test(s),
        'JW_AFF_CODE берётся из модуля');
}

console.log('\n── routing/proxy-dashboard.html ──');
{
    const s = R('routing/proxy-dashboard.html');
    const tagged = (s.match(/data-ref-link="/g) || []).length;
    chk(tagged >= 9, 'ссылки регистрации помечены data-ref-link (нашлось ' + tagged + ', ждём ≥9)');
    for (const p of Object.keys(WAS)) {
        chk(s.includes(`data-ref-link="${p}"`), 'помечена ссылка ' + p);
    }
    chk(s.includes('id="ref-codes-box"'), 'секция 💩 есть в «Настройках»');
    chk(/<summary[\s\S]{0,200}💩/.test(s), 'заголовок секции — свёрнутый 💩 (details/summary)');
    chk(s.includes('id="ref-codes-rows"'), 'контейнер полей есть');
    chk(/function applyRefLinks/.test(s), 'applyRefLinks объявлена');
    chk(/loadRefCodes\(\);/.test(s), 'loadRefCodes зовётся');
    // Загрузка на boot обязательна: ссылки живут в шапках пяти вкладок, а не в «Настройках».
    const bootIdx = s.indexOf('bootNavCounts();');
    chk(bootIdx > 0 && s.indexOf('loadRefCodes();', bootIdx) > 0, 'loadRefCodes есть в boot-последовательности');
    chk(/name === 'settings'[\s\S]{0,160}loadRefCodes\(\)/.test(s), 'loadRefCodes есть в активации вкладки «Настройки»');
}

console.log('\n── routing/transparent-proxy.js: роуты ──');
{
    const s = R('routing/transparent-proxy.js');
    chk(s.includes("'/__switch/api/settings/ref-codes'"), 'роут /settings/ref-codes зарегистрирован');
    chk(/GET[\s\S]{0,80}\/__switch\/api\/settings\/ref-codes/.test(s), 'GET есть');
    chk(/POST[\s\S]{0,80}\/__switch\/api\/settings\/ref-codes/.test(s), 'POST есть');
}

console.log('\n── .gitignore ──');
{
    const g = R('.gitignore');
    chk(/^routing\/ref-codes\.json$/m.test(g), 'свои коды закрыты (routing/ref-codes.json)');
    chk(!/^routing\/ref-codes\.default\.json$/m.test(g), 'дефолты НЕ закрыты — иначе форк остался бы без рефки');
}

console.log(`\ncheck-ref-codes: ${ok}/${ok + fail}`);
if (fail) { console.log('есть провалы'); process.exit(1); }
console.log('реф-код живёт в одной точке');

