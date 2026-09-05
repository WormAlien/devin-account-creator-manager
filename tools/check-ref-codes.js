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
// seekai добавлен 24.08 вместе с шестой вкладкой: до рефакторинга он не существовал,
// поэтому эталон здесь — не «прежний хардкод», а ссылка, которую дал владелец.
const WAS = {
    agentrouter: 'https://agentrouter.org/register?aff=oUm3',
    gorouter: 'https://gorouter.app/sign-up?aff=dzj0',
    justwoker: 'https://api.justwoker.icu/sign-up?aff=IFYf',
    seekai: 'https://seekai.cc/sign-up?aff=prEx',
    tabi: 'https://tabitoken.com/sign-up?aff=cUG3',
    xpeach: 'https://xpeach.codes/sign-up?aff=0lre',
};

console.log('\n== check-ref-codes: реф-коды в одной точке ==\n');

console.log('── routing/lib/ref-codes.js ──');
let rc = null;
try { rc = require(path.join(ROOT, 'routing', 'lib', 'ref-codes.js')); } catch (e) { /* ниже */ }
chk(!!rc, 'модуль загружается', rc ? '' : 'require упал');
if (rc) {
    chk(rc.PROVIDERS.length === 9, 'провайдеров девять', 'нашлось ' + rc.PROVIDERS.length);
    for (const p of Object.keys(WAS)) {
        chk(rc.PROVIDERS.includes(p), 'провайдер ' + p + ' в списке');
        chk(rc.url(p) === WAS[p], 'url(' + p + ') совпадает с прежним хардкодом', rc.url(p));
    }
    // Решение владельца 23.08: XPeach легаси и в списки, которые видит человек, не
    // попадает. С 24.08 к нему добавился SeekAi (реселл веб-Клода: подменяет системный
    // промпт, для Claude Code непригоден), с 05.09 — TrueSOTA. 🪤 У TrueSOTA причина
    // ДРУГАЯ: шлюз рабочий, но узкий — наш системный промпт исполняют только
    // `claude-opus-5` и `claude-opus-5-thinking`, остальные 16 моделей каталога это реселл
    // Kiro. Резолв для всех трёх обязан остаться — `<prov>/open-session.js` просит url().
    chk(Array.isArray(rc.ACTIVE_PROVIDERS), 'ACTIVE_PROVIDERS экспортирован');
    chk(rc.ACTIVE_PROVIDERS && !rc.ACTIVE_PROVIDERS.includes('xpeach'),
        'XPeach НЕ в живом наборе — легаси, в настройках ему места нет');
    chk(rc.ACTIVE_PROVIDERS && !rc.ACTIVE_PROVIDERS.includes('seekai'),
        'SeekAi НЕ в живом наборе — легаси с 24.08');
    chk(rc.ACTIVE_PROVIDERS && !rc.ACTIVE_PROVIDERS.includes('truesota'),
        'TrueSOTA НЕ в живом наборе — легаси с 05.09 (шлюз рабочий, но узкий: opus-only)');
    chk(rc.ACTIVE_PROVIDERS && rc.ACTIVE_PROVIDERS.length === 6,
        'живых провайдеров шесть (ar/go/jw/tb/kktoken/hcnsec)', 'нашлось ' + (rc.ACTIVE_PROVIDERS || []).length);
    // TrueSOTA заведён 2026-08-25 БЕЗ дефолтного кода: аккаунта на шлюзе ещё не было.
    // Поэтому url() обязан отдавать корень, а не ссылку с пустым `aff=` — иначе панель
    // примет битый параметр за код, и реф-кредит потеряется вообще (см. ref-codes.js § url).
    // Легаси-статус 05.09 на резолве не сказывается: `url('truesota')` просит
    // `truesota/open-session.js`, и проверки ниже остаются в силе.
    chk(rc.PROVIDERS.includes('truesota'), 'провайдер truesota в списке');
    chk(rc.url('truesota') === 'https://true-sota.com/',
        'url(truesota) без кода = корень сайта', rc.url('truesota'));
    chk(rc.SHAPES && rc.SHAPES.truesota && rc.SHAPES.truesota.path === '/register?aff=',
        'форма регистрации truesota — /register?aff= (sub2api, не /sign-up как у New-API)');
    chk(rc.url('xpeach') === WAS.xpeach, 'url(xpeach) всё ещё резолвится — легаси-скрипт им пользуется');
    chk(rc.url('seekai') === WAS.seekai, 'url(seekai) всё ещё резолвится — легаси-скрипт им пользуется');
    // KKtoken заведён 2026-08-31 — восьмой шлюз, New API, реф-код владельца есть сразу.
    // В WAS его нет намеренно: WAS — эталон «прежнего хардкода», а этого провайдера до
    // рефакторинга не существовало, и цикл по WAS требует `<prov>/open-session.js`.
    chk(rc.PROVIDERS.includes('kktoken'), 'провайдер kktoken в списке');
    chk(rc.url('kktoken') === 'https://kktoken.cc/sign-up?aff=Sog2',
        'url(kktoken) собирается из кода владельца Sog2', rc.url('kktoken'));
    chk(rc.SHAPES && rc.SHAPES.kktoken && rc.SHAPES.kktoken.path === '/sign-up?aff=',
        'форма регистрации kktoken — /sign-up?aff= (New API, как у go/tb/jw)');
    chk(rc.ACTIVE_PROVIDERS && rc.ACTIVE_PROVIDERS.includes('kktoken'),
        'kktoken в живом наборе — шлюз рабочий, рефку настраивать есть смысл');
    // HCNsec заведён 2026-08-31 — девятый шлюз, New API. 🪤 Порядок был обратный обычного:
    // вкладку собрали с литеральной ссылкой и записью «рефки нет», а код владелец принёс
    // после. Поэтому проверки ниже стоят парой с теми, что в `tools/check-hcnsec.js`:
    // там утверждается, что `hcnsec/open-session.js` берёт ссылку из ref-codes, а не
    // литералом — иначе правка кода в настройках не доехала бы до регистрации.
    chk(rc.PROVIDERS.includes('hcnsec'), 'провайдер hcnsec в списке');
    chk(rc.url('hcnsec') === 'https://api.hcnsec.cn/sign-up?aff=u4eN',
        'url(hcnsec) собирается из кода владельца u4eN', rc.url('hcnsec'));
    chk(rc.SHAPES && rc.SHAPES.hcnsec && rc.SHAPES.hcnsec.path === '/sign-up?aff=',
        'форма регистрации hcnsec — /sign-up?aff= (New API, как у go/tb/jw/kk)');
    chk(rc.SHAPES && rc.SHAPES.hcnsec && rc.SHAPES.hcnsec.host === 'api.hcnsec.cn',
        'хост hcnsec — api.hcnsec.cn (панель и шлюз на одном домене)');
    chk(rc.ACTIVE_PROVIDERS && rc.ACTIVE_PROVIDERS.includes('hcnsec'),
        'hcnsec в живом наборе — шлюз рабочий, рефку настраивать есть смысл');
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
// kktoken мимо цикла по WAS (см. выше), но дефолт у него есть и он обязан быть валиден.
if (def) chk(def.kktoken === 'Sog2', 'дефолт kktoken = Sog2', String(def.kktoken));
// hcnsec — тем же порядком: код владельца приехал живой ссылкой из его кабинета.
if (def) chk(def.hcnsec === 'u4eN', 'дефолт hcnsec = u4eN', String(def.hcnsec));

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
    chk(!/\['agentrouter'[^\]]*'xpeach'\]/.test(s), 'в фолбэк-списке 💩 нет xpeach (легаси)');
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

