#!/usr/bin/env node
/**
 * check-kktoken.js — статический регресс на полноту восьмой вкладки (KKtoken).
 *
 * Что за шлюз. `kktoken.cc` — очередная панель New API, поэтому вкладка делается
 * копией GoRouter один-в-один, без структурных отличий вроде sub2api у TrueSOTA.
 *
 * 🪤 ГЛАВНОЕ, что стоит денег и тишины: КАТАЛОГ ТУТ ТОЛЬКО OPUS — четыре модели,
 * `claude-opus-5`, `claude-opus-5-thinking`, `claude-opus-4-8`,
 * `claude-opus-4-8-thinking`. `claude-sonnet-5` и `gpt-5` на этом токене отдают
 * 403 в 6 попытках из 6 — их физически нет. Поэтому тир-карта opus-only во ВСЕХ
 * трёх тирах, и это не вкусовщина: пустой тир оставлять нельзя, keepalive отправит
 * `claude-haiku-*`, а «model not supported» — постоянная ошибка без ретрая.
 * Секция «живой статус» держит именно это.
 *
 * Зачем файл существует. Вкладка шлюза — не один блок кода, а двадцать с лишним
 * упоминаний, размазанных по двум файлам на 15 и 23 тысячи строк: константы, роуты,
 * реестры (BACKENDS / CC_MODEL_PREFIX / GH_POOL_* / NEWAPI_PROFILE_DIRS / MONEY_GW /
 * keepaliveInstances / список Health), фронтовые LABELS/COLORS/state.loaded и сама
 * разметка. Забыть одну строчку из двадцати легко, а симптом при этом не «не
 * собралось», а тихая полуработа: вкладка есть, а баланс не считается; аккаунт
 * добавляется, а активация не поднимает keepalive; авторотация молча обходит шлюз
 * стороной.
 *
 * Инвариант одной строкой: KKtoken — ПОЛНАЯ копия GoRouter. Поэтому почти все
 * проверки здесь не «есть ли строка X», а сравнение ДВУХ МНОЖЕСТВ: сколько у `go`
 * роутов/хендлеров/хелперов/id — столько же обязано быть у `kk`. Такая проверка
 * переживает переименования и ловит то, чего в спецификации не было.
 *
 * Сети нет, дашборд запускать не нужно, файлы только читаются. `:8200` не задет.
 *
 * Запуск: node tools/check-kktoken.js      (exit 1 = копия неполная)
 *
 * 🪤 Три факта провайдера, которые проверяются ЯВНО, потому что стоят денег:
 *   • база для Claude Code — КОРЕНЬ, без `/v1`: у New-API `POST /v1/v1/messages`
 *     отдаёт 404. `/v1` нужен только листингу моделей — KK_BASE_URL.
 *   • реф-ссылка приходит из `routing/lib/ref-codes.js`, а не литералом: код владельца
 *     (`Sog2`) лежит дефолтом в `routing/ref-codes.default.json`, пользователь форка
 *     вписывает свой через 💩 в «Настройках». Полный набор инвариантов этой точки —
 *     `tools/check-ref-codes.js`.
 *   • `kktoken.cc` обязан быть в `FLAT_RATE_HOSTS` keepalive-прокси: тариф per-call
 *     ещё не замерен, а при почти фиксированной плате за вызов включённый хедж
 *     удвоил бы счёт, ничего не ускорив. Замерили обратное — снимать осознанно.
 *
 * Авто-заведения (⚡, как у JustWoker) у вкладки НЕТ намеренно: на регистрации
 * включён `turnstile_check` (капча Cloudflare), сценарий без человека не
 * гарантирован — вход только руками в открытом окне (`kktoken/open-session.js`).
 * Поэтому множества роутов kk и go сравниваются в ОБЕ стороны без исключений.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PROXY = path.join(REPO, 'routing', 'transparent-proxy.js');
const HTML = path.join(REPO, 'routing', 'proxy-dashboard.html');
const KEEPALIVE = path.join(REPO, 'routing', 'keepalive-proxy.js');
const OPENJS = path.join(REPO, 'kktoken', 'open-session.js');
const IGNORE = path.join(REPO, '.gitignore');

const KK_PORT = 20161;

const fails = [];
let total = 0;

function section(title) { console.log(`\n── ${title} ──`); }
function check(cond, msg) {
    total += 1;
    console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
    if (!cond) fails.push(msg);
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// ── парсеры (те же, что в check-justwoker.js) ─────────────────────────────────
function constExpr(src, name) {
    const m = new RegExp(`^const ${name} = (.+);\\s*$`, 'm').exec(src);
    return m ? m[1].trim() : null;
}
function names(src, re) {
    return new Set(Array.from(src.matchAll(re), (m) => m[1]));
}
const lack = (want, got) => [...want].filter((x) => !got.has(x));

// Роуты берём только со строк диспетчера (в них есть `req.url`): те же адреса стоят
// в комментариях над обработчиками, и без фильтра комментарий сошёл бы за роут.
function routeSet(src, tag) {
    const out = new Set();
    const re = new RegExp(`/__switch/api/${tag}/([a-z0-9/_-]+)`, 'g');
    for (const line of src.split('\n')) {
        if (!line.includes('req.url')) continue;
        for (const m of line.matchAll(re)) out.add(m[1]);
    }
    return out;
}
function idCounts(src, pfx) {
    const out = new Map();
    for (const m of src.matchAll(new RegExp(`id=["'](${pfx}-[a-z0-9-]+)["']`, 'g'))) {
        out.set(m[1], (out.get(m[1]) || 0) + 1);
    }
    return out;
}

const proxy = read(PROXY);
const html = read(HTML);
const keepalive = read(KEEPALIVE);
const openjs = read(OPENJS);
const ignore = read(IGNORE);

if (!proxy || !html) {
    console.log(`  ✗ не читается ${!proxy ? PROXY : HTML} — проверять нечего`);
    process.exit(1);
}

console.log('== check-kktoken: KKtoken (kk) как полная копия GoRouter (go) ==');

// ── 1. transparent-proxy.js: константы ────────────────────────────────────────
section('routing/transparent-proxy.js · константы KK_*');
{
    const val = (n) => constExpr(proxy, n);
    const has = (n, needle, why) => {
        const v = val(n);
        check(!!v && v.includes(needle), `${n} → ${needle}${v ? '' : ' (константы нет)'}${v && !v.includes(needle) ? ` — получено ${v} · ${why}` : ''}`);
    };

    has('KK_SESSIONS_FILE', "'kktoken-sessions.json'", 'пул уедет не в свой файл');
    has('KK_ACTIVE_KEY_FILE', "'kktoken-active-key.txt'", 'keepalive прочитает чужой ключ');
    has('KK_ACTIVE_MODEL_FILE', "'kktoken-active-model.txt'", 'модель шлюза потеряется');
    has('KK_MODELMAP_FILE', "'kktoken-modelmap.json'", 'тир-карта разъедется с keepalive');
    has('KK_SESSIONS_DIR', "'kktoken', 'sessions'", 'импорт/шара сохранит state не туда');
    has('KK_SHARE_SCRIPT', "'kktoken', 'share-session.js'", 'кнопка 🔗 позовёт несуществующий скрипт');

    // База Claude Code и база листинга моделей — РАЗНЫЕ, и это главная ловушка шлюза.
    const eq = (n, want, why) => {
        const got = val(n);
        check(got === want, `${n} = ${want} · ${why}${got === want ? '' : ` — получено ${got}`}`);
    };
    eq('KK_BASE_URL', "'https://kktoken.cc/v1'", 'листинг моделей ходит С /v1');
    eq('KK_UPSTREAM', "'https://kktoken.cc'", 'корень БЕЗ /v1: /v1/v1/messages → 404');
    eq('KK_KEEPALIVE_PORT', String(KK_PORT), 'свой порт keepalive');
    check((val('KK_KEEPALIVE_URL') || '').includes('${KK_KEEPALIVE_PORT}'),
        'KK_KEEPALIVE_URL собирается из KK_KEEPALIVE_PORT, а не хардкодит число');

    // Полнота набора: у GO_* и KK_* обязаны совпадать суффиксы. Ловит константу,
    // о которой в спецификации не было ни слова.
    const goNames = names(proxy, /^const GO_([A-Z0-9_]+) = /gm);
    const kkNames = names(proxy, /^const KK_([A-Z0-9_]+) = /gm);
    const miss = lack(goNames, kkNames);
    check(miss.length === 0,
        `на каждую GO_* есть KK_* (${goNames.size} шт.)${miss.length ? ' — не хватает: KK_' + miss.join(', KK_') : ''}`);
}

// ── 2. transparent-proxy.js: хендлеры и хелперы ───────────────────────────────
section('routing/transparent-proxy.js · хендлеры и хелперы');
{
    const goH = names(proxy, /function handleGo([A-Za-z0-9]+)\s*\(/g);
    const kkH = names(proxy, /function handleKk([A-Za-z0-9]+)\s*\(/g);
    const missH = lack(goH, kkH);
    check(missH.length === 0,
        `handleKk* повторяет handleGo* (${goH.size} шт.)${missH.length ? ' — нет: handleKk' + missH.join(', handleKk') : ''}`);

    const goF = names(proxy, /function go([A-Za-z0-9]+)\s*\(/g);
    const kkF = names(proxy, /function kk([A-Za-z0-9]+)\s*\(/g);
    const missF = lack(goF, kkF);
    check(missF.length === 0,
        `хелперы kk* повторяют go* (${goF.size} шт.)${missF.length ? ' — нет: kk' + missF.join(', kk') : ''}`);

    check(new RegExp(`const keepaliveKk = makeKeepaliveHandlers\\(Number\\(process\\.env\\.KK_KEEPALIVE_PORT \\|\\| ${KK_PORT}\\)\\)`).test(proxy),
        `keepaliveKk объявлен через makeKeepaliveHandlers(:${KK_PORT}) — иначе карточка keepalive на вкладке пустая`);
}

// ── 3. Роуты: ключевой инвариант ──────────────────────────────────────────────
section('routing/transparent-proxy.js · роуты /__switch/api/{go,kk}/*');
{
    const go = routeSet(proxy, 'go');
    const kk = routeSet(proxy, 'kk');
    check(go.size >= 20, `роутов go найдено ${go.size} (парсер жив)`);
    const miss = lack(go, kk);
    const extra = lack(kk, go);
    check(miss.length === 0,
        `парных kk-роутов ${kk.size} из ${go.size}${miss.length ? ' — не хватает: ' + miss.map((r) => '/kk/' + r).join(' ') : ''}`);
    // У KKtoken авто-заведения нет, поэтому лишних роутов быть не должно вовсе.
    check(extra.length === 0,
        `лишних kk-роутов нет${extra.length ? ' — у go нет пары: ' + extra.map((r) => '/kk/' + r).join(' ') : ''}`);
}

// ── 4. Реестры: то, что легче всего забыть ────────────────────────────────────
section('routing/transparent-proxy.js · реестры');
{
    const block = (head) => {
        const i = proxy.indexOf(head);
        if (i < 0) return '';
        const j = proxy.indexOf('\n};', i);
        return j < 0 ? proxy.slice(i, i + 4000) : proxy.slice(i, j + 3);
    };

    const backends = block('const BACKENDS = {');
    check(/kktoken:\s*\{/.test(backends), 'BACKENDS: запись kktoken есть');
    check(new RegExp(`kktoken:[\\s\\S]*?base_url: 'http://localhost:${KK_PORT}'`).test(backends),
        `BACKENDS.kktoken.base_url = http://localhost:${KK_PORT}`);

    const prefix = block('const CC_MODEL_PREFIX = {');
    check(/kktoken: 'kktoken'/.test(prefix),
        "CC_MODEL_PREFIX: kktoken → 'kktoken' (иначе резолв модели не найдёт active-model.txt и окно упадёт до 200k)");

    for (const reg of ['GH_POOL_LOADERS', 'GH_POOL_FILES', 'GH_POOL_SAVERS', 'GH_POOL_LABELS']) {
        const line = (new RegExp(`^const ${reg} = .+$`, 'm').exec(proxy) || [''])[0];
        check(/\bkk:/.test(line), `${reg}: ключ kk есть — иначе менеджер гитхабов не видит восьмой пул`);
    }
    check(/kk: 'KKtoken'/.test(proxy), "GH_POOL_LABELS: kk → 'KKtoken'");

    const dirs = block('const NEWAPI_PROFILE_DIRS = {');
    check(/'kktoken\.cc':/.test(dirs) && /kktoken', 'profiles'/.test(dirs),
        "NEWAPI_PROFILE_DIRS: 'kktoken.cc' → kktoken/profiles (панель и API на одном домене)");

    const inst = block('function keepaliveInstances() {');
    check(/\[KK_KEEPALIVE_PORT\]:\s*\{[^}]*spawn: kkKeepaliveSpawn/.test(inst),
        `keepaliveInstances: [KK_KEEPALIVE_PORT] → kkKeepaliveSpawn (иначе кнопка «перезапустить» в Health не знает про :${KK_PORT})`);

    const money = block('const MONEY_GW = {');
    check(/^\s*kk:/m.test(money), 'MONEY_GW: строка kk есть — иначе авторотация обходит шлюз стороной');
    check(/kk:[^\n]*host: 'kktoken\.cc'/.test(money), "MONEY_GW.kk.host = 'kktoken.cc'");
    check(/kk:[^\n]*keyFile: KK_ACTIVE_KEY_FILE[^\n]*load: kkLoad[^\n]*save: kkSave/.test(money),
        'MONEY_GW.kk: keyFile/load/save указывают на KK-функции');
    check(/kk:[^\n]*balanceFn: kkBalance[^\n]*applyFn: kkApplyBalance/.test(money),
        'MONEY_GW.kk: balanceFn/applyFn на месте (без них ротация не проверит живой остаток)');

    check(new RegExp(`name: 'Keepalive KKtoken',\\s*port: Number\\(process\\.env\\.KK_KEEPALIVE_PORT \\|\\| ${KK_PORT}\\)`).test(proxy),
        `Health: сервис «Keepalive KKtoken» на :${KK_PORT} в списке checks`);
    check(/pools\.kktoken\s*=/.test(proxy), 'сводка шапки (pools) считает kktoken');
    check(/kk: kkLkPids/.test(proxy), 'ghLkPidsByTag знает про kk — иначе харвест полезет в профиль с открытым браузером');
    // Набор тегов в regexp роутов авторотации растёт (25.08 добавился `ts`, 31.08 — `kk`),
    // и новый тег дописывают в КОНЕЦ группы. Поэтому ищем строку диспетчера и проверяем
    // вхождение `kk` в неё, а не точный вид группы: жёсткий шаблон ронял бы этот регресс
    // на каждом следующем шлюзе с сообщением «kk потерялся», хотя терялся бы только шаблон.
    // 🪤 Строку ищем по `__switch` + `(ar|`, а не по `/__switch/api/`: в исходнике это
    // regexp-литерал, где слеши экранированы (`\/__switch\/api\/`), и поиск по «чистому»
    // пути не находит ничего — проверка молча превращалась в «строку диспетчера не нашёл».
    const rotLine = proxy.split('\n').find((l) => l.includes('__switch') && /\(ar\|/.test(l)) || '';
    check(/\|kk[|)]/.test(rotLine), `роуты авторотации принимают тег kk${rotLine ? ' — группа: ' + (/\((?:[a-z]{2}\|)+[a-z]{2}\)/.exec(rotLine) || ['?'])[0] : ' (строку диспетчера не нашёл)'}`);
}

// ── 5. Фронт: вкладка в дашборде ──────────────────────────────────────────────
section('routing/proxy-dashboard.html · вкладка');
{
    check(html.includes('data-tab="kktoken"'), 'кнопка в сайдбаре: data-tab="kktoken"');
    check(html.includes('data-tab-content="kktoken"'), 'панель вкладки: data-tab-content="kktoken"');

    // Вкладка ЖИВАЯ: шлюз новый и рабочий (4 модели Opus). Проверяем обе стороны —
    // и что кнопка в дефолтном сайдбаре есть, и что её НЕ унесло в «Чтим память»:
    // переезд в легаси-группу выглядел бы как «вкладка пропала», и причина не читалась
    // бы ниоткуда. Уход в легаси — осознанная правка этого файла, а не побочный эффект.
    const memoryGroup = (/data-extra-nav="memory"[\s\S]*?\n      <\/div>/.exec(html) || [''])[0];
    check(!/data-tab="kktoken"/.test(memoryGroup),
        'кнопка KKtoken НЕ в группе «Чтим память» — шлюз живой');
    const listOf = (name) => (new RegExp(`^const ${name} = .+$`, 'm').exec(html) || [''])[0];
    const tabs = listOf('DEFAULT_TABS_VISIBLE');
    check(!!tabs && /'kktoken'/.test(tabs),
        "DEFAULT_TABS_VISIBLE: 'kktoken' на месте — иначе вкладки не видно в дефолтном сайдбаре");
    check(/kktoken:/.test(listOf('LABELS')), 'LABELS: kktoken (иначе в шапке будет «unknown»)');
    check(/kktoken:/.test(listOf('COLORS')), 'COLORS: kktoken (без цвета плашка активного бэкенда серая)');

    const loaded = (/loaded:\s*\{[^}]*\}/.exec(html) || [''])[0];
    check(/kktoken: false/.test(loaded), 'state.loaded: kktoken (иначе ленивая загрузка вкладки повторяется на каждый клик)');

    const ka = (/const KEEPALIVE_API = \{[\s\S]*?\n\};/.exec(html) || [''])[0];
    check(/kk: '\/__switch\/api\/kk\/keepalive'/.test(ka), "KEEPALIVE_API: kk → '/__switch/api/kk/keepalive'");

    const mp = (/const MONEY_PROVIDERS = \{[\s\S]*?\n\};/.exec(html) || [''])[0];
    check(/kktoken:\s*\{/.test(mp), 'MONEY_PROVIDERS: kktoken (тумблер авторотации и тост о подмене)');
    check(/kktoken:[^\n]*p: 'kk'/.test(mp), "MONEY_PROVIDERS.kktoken.p = 'kk'");

    for (const fn of ['loadKkSessions', 'loadKkSessionsLight', 'renderKk']) {
        check(new RegExp(`function ${fn}\\s*\\(`).test(html), `функция ${fn}() объявлена`);
    }
    check(/NEWAPI_RERENDER = \{[^}]*kk: \(\) => renderKk\(\)/.test(html),
        'NEWAPI_RERENDER: kk → renderKk (иначе фильтр и сортировка вкладку не перерисуют)');
    // Список вкладок-пулов растёт (25.08 добавился 'ts'), поэтому проверяем ВХОЖДЕНИЕ
    // 'kk', а не точный литерал: жёсткое сравнение падало на каждом новом шлюзе и
    // сообщало «kk потерялся», хотя терялся только шаблон в этой строке.
    check(/for \(const p of \[[^\]]*'kk'[^\]]*\]\)/.test(html),
        "общий цикл по вкладкам-пулам включает 'kk'");
    check(/\['kktoken',\s+\(\) => loadKkSessionsLight\(\)\]/.test(html),
        'NAV_COUNT_JOBS: счётчик в сайдбаре считает kktoken на boot');
    // Дубль id — самая тихая поломка фронта: getElementById возьмёт первый, и вторая
    // половина вкладки перестанет обновляться без единой ошибки в консоли.
    const kkIds = idCounts(html, 'kk');
    const dup = [...kkIds].filter(([, n]) => n > 1).map(([id]) => id);
    check(kkIds.size > 0, `id вида kk-* в разметке: ${kkIds.size}`);
    check(dup.length === 0, `ни один kk-* id не дублируется${dup.length ? ' — дубли: ' + dup.join(', ') : ''}`);

    // Полнота копии: на каждый go-* элемент есть kk-*.
    const goIds = new Set(idCounts(html, 'go').keys());
    const kkHas = new Set([...kkIds.keys()].map((id) => id.replace(/^kk-/, '')));
    const missIds = [...goIds].map((id) => id.replace(/^go-/, '')).filter((x) => !kkHas.has(x));
    check(missIds.length === 0,
        `на каждый go-* элемент есть kk-* (${goIds.size} шт.)${missIds.length ? ' — нет: kk-' + missIds.join(', kk-') : ''}`);

    // Ни одного jw-имени внутри kk-блока: ровно так 24.08 уцелел вызов renderJw() в
    // шести местах — вкладка KKtoken перерисовывала таблицу JustWoker.
    // Конец блока ищем по СЛЕДУЮЩЕМУ заголовку-разделителю, а не по имени соседа:
    // порядок блоков в файле не зафиксирован, и хардкод соседа сломался бы при вставке
    // вкладки в другое место.
    const jsStart = html.indexOf('// ═══════════════════ KKTOKEN');
    const jsEnd = jsStart >= 0 ? html.indexOf('// ═══════════════════ ', jsStart + 24) : -1;
    const jsBlock = jsStart >= 0 ? html.slice(jsStart, jsEnd > jsStart ? jsEnd : html.length) : '';
    check(!!jsBlock, 'JS-блок KKTOKEN найден по заголовку');
    const strays = [...jsBlock.matchAll(/\b(renderJw|loadJw[A-Za-z]*|jw[A-Z][A-Za-z]*)\b/g)].map((m) => m[1]);
    check(strays.length === 0,
        `в JS-блоке KKtoken нет вызовов jw-функций${strays.length ? ' — найдено: ' + [...new Set(strays)].join(', ') : ''}`);
}

// ── 6. kktoken/open-session.js: рефка и адреса ────────────────────────────────
section('kktoken/open-session.js · рефка и адреса');
if (!openjs) {
    check(false, 'kktoken/open-session.js не читается — регистрация по рефке невозможна');
} else {
    check(/const REGISTER_URL = require\(['"]\.\.\/routing\/lib\/ref-codes\.js['"]\)\.url\(['"]kktoken['"]\)/.test(openjs),
        'REGISTER_URL берётся из routing/lib/ref-codes.js, а не литералом');
    let refUrlOk = false;
    try {
        refUrlOk = require(path.join(REPO, 'routing', 'lib', 'ref-codes.js')).url('kktoken')
            === 'https://kktoken.cc/sign-up?aff=Sog2';
    } catch { refUrlOk = false; }
    check(refUrlOk, "модуль без переопределения отдаёт 'https://kktoken.cc/sign-up?aff=Sog2' — реф-кредит владельца");
    check(/const CONSOLE_URL = 'https:\/\/kktoken\.cc\//.test(openjs), 'CONSOLE_URL на kktoken.cc');
    check(/const ROOT_URL = 'https:\/\/kktoken\.cc\/';/.test(openjs), 'ROOT_URL на kktoken.cc');
    check(/kktoken-sessions\.json/.test(openjs),
        'poolFile у gh-live-capture указывает на kktoken-sessions.json (иначе ручной GitHub-вход осядет в чужом пуле)');
    check(fs.existsSync(path.join(REPO, 'kktoken', 'share-session.js')), 'kktoken/share-session.js на месте');
}

// ── 7. keepalive-proxy.js: тариф и цель ротации ───────────────────────────────
section('routing/keepalive-proxy.js · тариф и цель ротации');
if (!keepalive) {
    check(false, 'routing/keepalive-proxy.js не читается');
} else {
    check(/FLAT_RATE_HOSTS = new Set\(\[[^\]]*'kktoken\.cc'/.test(keepalive),
        'kktoken.cc в FLAT_RATE_HOSTS — хедж выключен (тариф per-call не замерен; при почти фиксированной плате за вызов дубль удвоил бы счёт)');
    check(/'kktoken\.cc': 'kk'/.test(keepalive),
        "GW_BY_HOST: 'kktoken.cc' → 'kk' (без строки авторотация молча выключена)");
}

// ── 7b. Живой статус: ref-codes, вотчдог и тир-карта ──────────────────────────
// Вкладка живая, и три вещи ниже — ровно то, чем «живая» отличается от легаси:
// строка настройки рефки видна человеку, вотчдог слышит падение пула, а тир-карта
// не уводит агента в модель, которой на токене нет.
section('живой статус · ref-codes, вотчдог и тир-карта');
{
    let rc = null;
    try { rc = require(path.join(REPO, 'routing', 'lib', 'ref-codes.js')); } catch { /* ниже */ }
    check(!!rc, 'routing/lib/ref-codes.js загружается');
    check(rc && Array.isArray(rc.ACTIVE_PROVIDERS) && rc.ACTIVE_PROVIDERS.includes('kktoken'),
        'kktoken В ACTIVE_PROVIDERS — шлюз живой, строка настройки рефки человеку нужна');
    check(rc && rc.PROVIDERS.includes('kktoken'),
        'kktoken есть в PROVIDERS — резолв рефки нужен kktoken/open-session.js');

    const watchdog = read(path.join(REPO, 'routing', 'pool-watchdog.js')) || '';
    check(/backend: 'kktoken'/.test(watchdog),
        'вотчдог пулов опрашивает kktoken — шлюз живой, его падение должно быть слышно');

    // 🪤 Тир-карта opus-only. Это НЕ вкусовщина: каталог шлюза — четыре модели, все Opus,
    // а `claude-sonnet-5` и `gpt-5` отдают 403 в 6 попытках из 6, их физически нет.
    // Пустой тир тоже запрещён: keepalive отправит `claude-haiku-*`, а «model not
    // supported» — постоянная ошибка, ретрая на неё нет.
    const OK_MODELS = ['claude-opus-5', 'claude-opus-5-thinking', 'claude-opus-4-8', 'claude-opus-4-8-thinking'];
    let mm = null;
    try { mm = JSON.parse(fs.readFileSync(path.join(REPO, 'routing', 'kktoken-modelmap.json'), 'utf8')); } catch {}
    check(!!mm, 'kktoken-modelmap.json читается как JSON');
    for (const tier of ['opus', 'sonnet', 'haiku']) {
        const v = mm ? String(mm[tier] || '') : '';
        check(!!v, `тир ${tier} заполнен — пустой тир роняет запрос без ретрая`);
        check(OK_MODELS.includes(v), `тир ${tier} → ${v || '(пусто)'} из каталога шлюза (${OK_MODELS.join(', ')})`);
    }
}

// ── 8. .gitignore: приватное закрыто ─────────────────────────────────────────
section('.gitignore · приватные данные шлюза');
if (!ignore) {
    check(false, '.gitignore не читается');
} else {
    for (const p of ['kktoken/profiles/', 'kktoken/sessions/', 'kktoken/gh-sessions/', 'routing/kktoken-sessions.json']) {
        check(new RegExp(`^${p.replace(/[./]/g, '\\$&')}$`, 'm').test(ignore), `закрыт ${p}`);
    }
}
// ── 9. Коллизии: порт и короткий тег ─────────────────────────────────────────
section(`коллизии · порт ${KK_PORT} и тег kk`);
{
    // Порты собираем в двух формах: числом (go/tb/xp/jw/sk/kk) и через env с дефолтом
    // (TrueSOTA) — иначе парсер «не видит» TS_KEEPALIVE_PORT, и занятый соседом порт
    // читался бы как свободный.
    const ports = Array.from(
        proxy.matchAll(/^const ([A-Z]{2})_KEEPALIVE_PORT = (?:Number\(process\.env\.[A-Z_]+ \|\| )?(\d+)/gm),
        (m) => [m[1], Number(m[2])],
    );
    const onPort = ports.filter(([, p]) => p === KK_PORT).map(([t]) => t);
    check(onPort.length === 1 && onPort[0] === 'KK',
        `порт ${KK_PORT} занят только KKtoken (нашлось: ${onPort.join(', ') || 'никем'})`);
    check(new Set(ports.map(([, p]) => p)).size === ports.length,
        `порты keepalive не пересекаются (${ports.map(([t, p]) => t + ':' + p).join(' ')})`);

    const others = (proxy.match(new RegExp(`base_url: 'http://localhost:${KK_PORT}'`, 'g')) || []).length;
    check(others === 1, `на :${KK_PORT} смотрит ровно один backend (нашлось ${others})`);

    // Тег `kk` не должен вести к чужим функциям ни в одном реестре.
    const wrong = Array.from(proxy.matchAll(/\bkk: \(\)?[^,}\n]*/g))
        .map((m) => m[0])
        .filter((s) => /\b(ar|go|tb|xp|jw|sk|ts)(Load|Save|Balance)/.test(s));
    check(wrong.length === 0, `тег kk нигде не подцеплен к чужим функциям${wrong.length ? ' — ' + wrong.join(' | ') : ''}`);

    check(fs.existsSync(path.join(REPO, 'routing', 'kktoken-modelmap.json')),
        'routing/kktoken-modelmap.json существует (keepalive читает его по mtime; без файла тир-карта пустая)');
    // lifecycle.js гасит keepalive по списку портов: забытая строка = живой прокси
    // после «остановил всё».
    const life = read(path.join(REPO, 'routing', 'lifecycle.js')) || '';
    check(new RegExp(`port: ${KK_PORT}, name: 'KKtoken keepalive'`).test(life),
        `lifecycle.js знает про :${KK_PORT} — иначе stop оставит прокси висеть`);
}

// ── итог ──────────────────────────────────────────────────────────────────────
console.log(`\ncheck-kktoken: ${total - fails.length}/${total}`);
if (fails.length) {
    console.log(`\n✗ провалено ${fails.length}:`);
    for (const m of fails) console.log(`   • ${m}`);
    console.log('\nРазбор вкладки — ARCHITECTURE.md § «KKtoken (kk)».');
    process.exit(1);
}
console.log('копия вкладки GoRouter полная · тир-карта opus-only · вкладка живая');

