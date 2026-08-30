#!/usr/bin/env node
/**
 * check-truesota.js — статический регресс на полноту седьмой вкладки (TrueSOTA).
 *
 * Что за шлюз. `true-sota.com` — первый в дашборде НЕ на New-API: под ним открытый
 * **sub2api** (github.com/Wei-Shaw/sub2api, LGPL-3.0), Go+Vue шлюз, раздающий квоту
 * подписок (Claude, Codex, Gemini, Grok, Antigravity) как API-ключи. Отсюда три
 * структурных отличия, которые этот файл и охраняет:
 *   • панель `/api/v1/*` вместо `/api/*`, `GET /api/status` отдаёт 404;
 *   • вход держится на JWT в **localStorage** профиля, а не на куке — поэтому баланс
 *     и токены считает свой модуль `routing/lib/truesota-account.js`, а не
 *     `newapi-account.js`, и у вкладки есть две лишние ручки (`key-create`, `token`);
 *   • «баланс» — остаток КВОТЫ (лимит ключа либо самое узкое окно подписки), а не
 *     кошелёк. Поэтому констант «угадать выдачу» (GRANT_STEP/DEFAULT_GRANT) у TS нет
 *     намеренно, и их отсутствие проверяется явно.
 *
 * 🪤 ГЛАВНОЕ, что стоит денег и тишины: РАБОЧИХ МОДЕЛЕЙ ДВЕ — `claude-opus-5` и
 * `claude-opus-5-thinking`. Остальные 16 из каталога шлюз обслуживает реселлом Kiro:
 * подставляет СВОЙ системный промпт (префикс 4.1–6.9к токенов), а наш `system` до
 * модели не доезжает. Замер 25.08: на `system: "тебя зовут NAIL-7"` sonnet-4-6,
 * sonnet-5, opus-4-5/4-6/4-7/4-8 и haiku-4-5 отвечают «My name is Kiro» — и то же
 * самое, когда инструкция уехала в сообщение пользователя; `claude-opus-5` отвечает
 * «NAIL-7» и корректно возвращает `tool_use` (id `toolu_bdrk_…`, то есть канал через
 * Bedrock). Коварство в том, что непригодные модели отвечают 200 и вызывают
 * инструменты — со стороны это «модель тупит», а не поломка. Поэтому секция «живой
 * статус» требует opus-only тир-карту и метку непригодных моделей в UI.
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
 * Инвариант одной строкой: TrueSOTA — ПОЛНАЯ копия GoRouter, кроме перечисленного выше.
 * Поэтому почти все проверки здесь не «есть ли строка X», а сравнение ДВУХ МНОЖЕСТВ:
 * сколько у `go` роутов/хендлеров/хелперов/id — столько же обязано быть у `ts`. Такая
 * проверка переживает переименования и ловит то, чего в спецификации не было.
 *
 * Сети нет, дашборд запускать не нужно, файлы только читаются. `:8200` не задет.
 *
 * Запуск: node tools/check-truesota.js      (exit 1 = копия неполная)
 *
 * 🪤 Ещё три факта провайдера, проверяемые ЯВНО:
 *   • база для Claude Code — КОРЕНЬ, без `/v1`: `/v1` нужен только листингу моделей
 *     (TS_BASE_URL), а запросы keepalive добавляет к корню сам (TS_UPSTREAM).
 *   • реф-ссылка приходит из `routing/lib/ref-codes.js`, а не литералом. Дефолтного
 *     кода у TrueSOTA НЕТ: аккаунта на шлюзе не было, а выдуманный код = потерянный
 *     реф. Поэтому `url('truesota')` обязан отдавать корень, а форма — `/register?aff=`
 *     (у sub2api не `/sign-up`, как у New-API). Инварианты точки — `check-ref-codes.js`.
 *   • `true-sota.com` обязан быть в `FLAT_RATE_HOSTS` keepalive-прокси: тариф
 *     подписочный, дубль съедает окно плана и ничего не ускоряет.
 *
 * Авто-заведения (⚡, как у JustWoker) у вкладки НЕТ намеренно: на регистрации капча
 * Turnstile, а почтовая регистрация ограничена белым списком доменов. Путь один —
 * GitHub-вход руками, дальше ключ создаёт сама панель кнопкой 🔑➕.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PROXY = path.join(REPO, 'routing', 'transparent-proxy.js');
const HTML = path.join(REPO, 'routing', 'proxy-dashboard.html');
const KEEPALIVE = path.join(REPO, 'routing', 'keepalive-proxy.js');
const OPENJS = path.join(REPO, 'truesota', 'open-session.js');
const IGNORE = path.join(REPO, '.gitignore');

const TS_PORT = 20160;

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

console.log('== check-truesota: TrueSOTA (ts) как полная копия GoRouter (go) ==');

// ── 1. transparent-proxy.js: константы ────────────────────────────────────────
section('routing/transparent-proxy.js · константы TS_*');
{
    const val = (n) => constExpr(proxy, n);
    const has = (n, needle, why) => {
        const v = val(n);
        check(!!v && v.includes(needle), `${n} → ${needle}${v ? '' : ' (константы нет)'}${v && !v.includes(needle) ? ` — получено ${v} · ${why}` : ''}`);
    };

    has('TS_SESSIONS_FILE', "'truesota-sessions.json'", 'пул уедет не в свой файл');
    has('TS_ACTIVE_KEY_FILE', "'truesota-active-key.txt'", 'keepalive прочитает чужой ключ');
    has('TS_ACTIVE_MODEL_FILE', "'truesota-active-model.txt'", 'модель шлюза потеряется');
    has('TS_MODELMAP_FILE', "'truesota-modelmap.json'", 'тир-карта разъедется с keepalive');
    has('TS_SESSIONS_DIR', "'truesota', 'sessions'", 'импорт/шара сохранит state не туда');
    has('TS_SHARE_SCRIPT', "'truesota', 'share-session.js'", 'кнопка 🔗 позовёт несуществующий скрипт');

    // База Claude Code и база листинга моделей — РАЗНЫЕ, и это главная ловушка шлюза.
    const eq = (n, want, why) => {
        const got = val(n);
        check(got === want, `${n} = ${want} · ${why}${got === want ? '' : ` — получено ${got}`}`);
    };
    eq('TS_BASE_URL', "'https://true-sota.com/v1'", 'листинг моделей ходит С /v1');
    eq('TS_UPSTREAM', "'https://true-sota.com'", 'корень БЕЗ /v1: /v1/v1/messages → 404');
    // 🪤 Порт объявлен через env с дефолтом, а не числом: SeekAi и раньше держал
    // число, но у TrueSOTA спавн, Health и keepalive-restart.ps1 читают одну и ту же
    // переменную, и подмена порта на время отладки не должна требовать правки кода.
    check((val('TS_KEEPALIVE_PORT') || '').includes(`process.env.TS_KEEPALIVE_PORT || ${TS_PORT}`),
        `TS_KEEPALIVE_PORT = process.env.TS_KEEPALIVE_PORT || ${TS_PORT} · свой порт keepalive`);
    check((val('TS_KEEPALIVE_URL') || '').includes('${TS_KEEPALIVE_PORT}'),
        'TS_KEEPALIVE_URL собирается из TS_KEEPALIVE_PORT, а не хардкодит число');

    // Полнота набора: у GO_* и TS_* обязаны совпадать суффиксы. Ловит константу,
    // о которой в спецификации не было ни слова.
    const goNames = names(proxy, /^const GO_([A-Z0-9_]+) = /gm);
    const tsNames = names(proxy, /^const TS_([A-Z0-9_]+) = /gm);
    // 🪤 Двух констант у TrueSOTA нет НАМЕРЕННО: GRANT_STEP/DEFAULT_GRANT — это резерв
    // «угадать выдачу» у New-API-кошелька. Здесь тариф подписочный, выдумывать остаток
    // нечем, и прикидка врала бы в обе стороны (на завышенной авторотация берёт пустой
    // аккаунт). Отсутствие проверяем явно, чтобы «дополнить копию» никто не пришёл.
    const GRANT_LESS = ['GRANT_STEP', 'DEFAULT_GRANT'];
    const miss = lack(goNames, tsNames).filter((n) => !GRANT_LESS.includes(n));
    check(miss.length === 0,
        `на каждую GO_* есть TS_* (${goNames.size} шт.)${miss.length ? ' — не хватает: TS_' + miss.join(', TS_') : ''}`);
    for (const n of GRANT_LESS) {
        check(!tsNames.has(n), `TS_${n} НЕТ — у подписочной квоты выдачи не существует, прикидка запрещена`);
    }
}

// ── 2. transparent-proxy.js: хендлеры и хелперы ───────────────────────────────
section('routing/transparent-proxy.js · хендлеры и хелперы');
{
    const goH = names(proxy, /function handleGo([A-Za-z0-9]+)\s*\(/g);
    const tsH = names(proxy, /function handleTs([A-Za-z0-9]+)\s*\(/g);
    const missH = lack(goH, tsH);
    check(missH.length === 0,
        `handleTs* повторяет handleGo* (${goH.size} шт.)${missH.length ? ' — нет: handleTs' + missH.join(', handleTs') : ''}`);

    const goF = names(proxy, /function go([A-Za-z0-9]+)\s*\(/g);
    const tsF = names(proxy, /function ts([A-Za-z0-9]+)\s*\(/g);
    // base64url-кодек переиспользован из блока SeekAi (skB64UrlEncode/Decode): это
    // чистая функция без провайдерской специфики, и вторая копия только разъезжалась бы.
    // Поэтому проверяем не «есть tsB64Url*», а что share/import вообще чем-то кодируются.
    const B64_SHARED = ['B64UrlEncode', 'B64UrlDecode'];
    const missF = lack(goF, tsF).filter((n) => !B64_SHARED.includes(n));
    check(missF.length === 0,
        `хелперы ts* повторяют go* (${goF.size} шт.)${missF.length ? ' — нет: ts' + missF.join(', ts') : ''}`);
    check(/skB64UrlEncode\(JSON\.stringify\(payload\)\)/.test(proxy) && /skB64UrlDecode\(share\)/.test(proxy),
        'share/import переиспользуют кодек skB64Url* (одна реализация на две вкладки)');

    check(new RegExp(`const keepaliveTs = makeKeepaliveHandlers\\(Number\\(process\\.env\\.TS_KEEPALIVE_PORT \\|\\| ${TS_PORT}\\)\\)`).test(proxy),
        `keepaliveTs объявлен через makeKeepaliveHandlers(:${TS_PORT}) — иначе карточка keepalive на вкладке пустая`);
}

// ── 3. Роуты: ключевой инвариант ──────────────────────────────────────────────
section('routing/transparent-proxy.js · роуты /__switch/api/{go,ts}/*');
{
    const go = routeSet(proxy, 'go');
    const ts = routeSet(proxy, 'ts');
    check(go.size >= 20, `роутов go найдено ${go.size} (парсер жив)`);
    const miss = lack(go, ts);
    const extra = lack(ts, go);
    check(miss.length === 0,
        `парных ts-роутов ${ts.size} из ${go.size}${miss.length ? ' — не хватает: ' + miss.map((r) => '/ts/' + r).join(' ') : ''}`);
    // Две лишние ручки ЗАКОННЫ и специфичны для sub2api:
    //   key-create — панель сама создаёт ключ (`POST /api/v1/keys` отдаёт его целиком);
    //   token      — состояние ВХОДА (JWT в localStorage профиля), у New-API аналога нет.
    // Авто-заведения (⚡) у вкладки нет: на регистрации капча Turnstile.
    const TS_ONLY = ['key-create', 'token'];
    const extraUnknown = extra.filter((r) => !TS_ONLY.includes(r));
    check(extraUnknown.length === 0,
        `лишних ts-роутов нет${extraUnknown.length ? ' — у go нет пары: ' + extraUnknown.map((r) => '/ts/' + r).join(' ') : ''}`);
    for (const r of TS_ONLY) {
        check(ts.has(r), `роут /ts/${r} на месте — без него вкладка не заведёт ключ и не покажет состояние входа`);
    }
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
    check(/truesota:\s*\{/.test(backends), 'BACKENDS: запись truesota есть');
    check(new RegExp(`truesota:[\\s\\S]*?base_url: 'http://localhost:${TS_PORT}'`).test(backends),
        `BACKENDS.truesota.base_url = http://localhost:${TS_PORT}`);

    const prefix = block('const CC_MODEL_PREFIX = {');
    check(/truesota: 'truesota'/.test(prefix),
        "CC_MODEL_PREFIX: truesota → 'truesota' (иначе резолв модели не найдёт active-model.txt и окно упадёт до 200k)");

    for (const reg of ['GH_POOL_LOADERS', 'GH_POOL_FILES', 'GH_POOL_SAVERS', 'GH_POOL_LABELS']) {
        const line = (new RegExp(`^const ${reg} = .+$`, 'm').exec(proxy) || [''])[0];
        check(/\bts:/.test(line), `${reg}: ключ ts есть — иначе менеджер гитхабов не видит седьмой пул`);
    }
    check(/ts: 'TrueSOTA'/.test(proxy), "GH_POOL_LABELS: ts → 'TrueSOTA'");

    const dirs = block('const NEWAPI_PROFILE_DIRS = {');
    check(/'true-sota\.com':/.test(dirs) && /truesota', 'profiles'/.test(dirs),
        "NEWAPI_PROFILE_DIRS: 'true-sota.com' → truesota/profiles (панель и API на одном домене)");

    const inst = block('function keepaliveInstances() {');
    check(/\[TS_KEEPALIVE_PORT\]:\s*\{[^}]*spawn: tsKeepaliveSpawn/.test(inst),
        `keepaliveInstances: [TS_KEEPALIVE_PORT] → tsKeepaliveSpawn (иначе кнопка «перезапустить» в Health не знает про :${TS_PORT})`);

    const money = block('const MONEY_GW = {');
    check(/^\s*ts:/m.test(money), 'MONEY_GW: строка ts есть — иначе авторотация обходит шлюз стороной');
    check(/ts:[^\n]*host: 'true-sota\.com'/.test(money), "MONEY_GW.ts.host = 'true-sota.com'");
    check(/ts:[^\n]*keyFile: TS_ACTIVE_KEY_FILE[^\n]*load: tsLoad[^\n]*save: tsSave/.test(money),
        'MONEY_GW.ts: keyFile/load/save указывают на TS-функции');
    check(/ts:[^\n]*balanceFn: tsBalance[^\n]*applyFn: tsApplyBalance/.test(money),
        'MONEY_GW.ts: balanceFn/applyFn на месте (без них ротация не проверит живой остаток)');

    check(new RegExp(`name: 'Keepalive TrueSOTA',\\s*port: Number\\(process\\.env\\.TS_KEEPALIVE_PORT \\|\\| ${TS_PORT}\\)`).test(proxy),
        `Health: сервис «Keepalive TrueSOTA» на :${TS_PORT} в списке checks`);
    check(/pools\.truesota\s*=/.test(proxy), 'сводка шапки (pools) считает truesota');
    check(/ts: tsLkPids/.test(proxy), 'ghLkPidsByTag знает про ts — иначе харвест полезет в профиль с открытым браузером');
    // 🪤 Раньше здесь стояла ЗАМОРОЖЕННАЯ группа `(ar|go|tb|xp|jw|sk|ts)`, и проверка
    // падала от добавления восьмого шлюза (kk, 31.08) — при полностью исправном роуте.
    // Список тегов растёт с каждой вкладкой, поэтому ищем свой тег в строке диспетчера.
    const tsRotLine = proxy.split('\n').find((l) => l.includes('__switch') && /\(ar\|/.test(l)) || '';
    check(/\|ts[|)]/.test(tsRotLine), 'роуты авторотации принимают тег ts');
}

// ── 5. Фронт: вкладка в дашборде ──────────────────────────────────────────────
section('routing/proxy-dashboard.html · вкладка');
{
    check(html.includes('data-tab="truesota"'), 'кнопка в сайдбаре: data-tab="truesota"');
    check(html.includes('data-tab-content="truesota"'), 'панель вкладки: data-tab-content="truesota"');

    // Вкладка ЖИВАЯ (решение владельца 25.08): она в дефолтном сайдбаре и НЕ в «Чтим
    // память». Проверяем обе стороны: переезд в легаси-группу выглядел бы как «вкладка
    // пропала», и причина не читалась бы ниоткуда.
    const memoryGroup = (/data-extra-nav="memory"[\s\S]*?\n      <\/div>/.exec(html) || [''])[0];
    check(!/data-tab="truesota"/.test(memoryGroup),
        'кнопка TrueSOTA НЕ в группе «Чтим память» — шлюз живой');
    const listOf = (name) => (new RegExp(`^const ${name} = .+$`, 'm').exec(html) || [''])[0];
    const tabs = listOf('DEFAULT_TABS_VISIBLE');
    check(!!tabs && /'truesota'/.test(tabs),
        "DEFAULT_TABS_VISIBLE: 'truesota' на месте — иначе вкладки не видно в дефолтном сайдбаре");
    check(/truesota:/.test(listOf('LABELS')), 'LABELS: truesota (иначе в шапке будет «unknown»)');
    check(/truesota:/.test(listOf('COLORS')), 'COLORS: truesota (без цвета плашка активного бэкенда серая)');

    const loaded = (/loaded:\s*\{[^}]*\}/.exec(html) || [''])[0];
    check(/truesota: false/.test(loaded), 'state.loaded: truesota (иначе ленивая загрузка вкладки повторяется на каждый клик)');

    const ka = (/const KEEPALIVE_API = \{[\s\S]*?\n\};/.exec(html) || [''])[0];
    check(/ts: '\/__switch\/api\/ts\/keepalive'/.test(ka), "KEEPALIVE_API: ts → '/__switch/api/ts/keepalive'");

    const mp = (/const MONEY_PROVIDERS = \{[\s\S]*?\n\};/.exec(html) || [''])[0];
    check(/truesota:\s*\{/.test(mp), 'MONEY_PROVIDERS: truesota (тумблер авторотации и тост о подмене)');
    check(/truesota:[^\n]*p: 'ts'/.test(mp), "MONEY_PROVIDERS.truesota.p = 'ts'");

    for (const fn of ['loadTsSessions', 'loadTsSessionsLight', 'renderTs']) {
        check(new RegExp(`function ${fn}\\s*\\(`).test(html), `функция ${fn}() объявлена`);
    }
    check(/NEWAPI_RERENDER = \{[^}]*ts: \(\) => renderTs\(\)/.test(html),
        'NEWAPI_RERENDER: ts → renderTs (иначе фильтр и сортировка вкладку не перерисуют)');
    // 🪤 Было `\[[^\]]*'ts'\]` — то есть «'ts' последний в массиве». Восьмой шлюз
    // дописался после него, и проверка упала на исправном коде. Ищем вхождение.
    check(/for \(const p of \[[^\]]*'ts'[^\]]*\]\)/.test(html),
        "общий цикл по вкладкам-пулам включает 'ts' (фильтр/сортировка/сохранение режима)");
    check(/\['truesota',\s+\(\) => loadTsSessionsLight\(\)\]/.test(html),
        'NAV_COUNT_JOBS: счётчик в сайдбаре считает truesota на boot');
    // Дубль id — самая тихая поломка фронта: getElementById возьмёт первый, и вторая
    // половина вкладки перестанет обновляться без единой ошибки в консоли.
    const tsIds = idCounts(html, 'ts');
    const dup = [...tsIds].filter(([, n]) => n > 1).map(([id]) => id);
    check(tsIds.size > 0, `id вида ts-* в разметке: ${tsIds.size}`);
    check(dup.length === 0, `ни один ts-* id не дублируется${dup.length ? ' — дубли: ' + dup.join(', ') : ''}`);

    // Полнота копии: на каждый go-* элемент есть ts-*.
    const goIds = new Set(idCounts(html, 'go').keys());
    const tsHas = new Set([...tsIds.keys()].map((id) => id.replace(/^ts-/, '')));
    const missIds = [...goIds].map((id) => id.replace(/^go-/, '')).filter((x) => !tsHas.has(x));
    check(missIds.length === 0,
        `на каждый go-* элемент есть ts-* (${goIds.size} шт.)${missIds.length ? ' — нет: ts-' + missIds.join(', ts-') : ''}`);

    // Ни одного jw-имени внутри ts-блока: ровно так 24.08 уцелел вызов renderJw() в
    // шести местах — вкладка TrueSOTA перерисовывала таблицу JustWoker.
    const jsStart = html.indexOf('// ═══════════════════ TRUESOTA');
    const jsEnd = html.indexOf('// ═══════════════════ TABI TOKEN');
    const jsBlock = jsStart >= 0 && jsEnd > jsStart ? html.slice(jsStart, jsEnd) : '';
    check(!!jsBlock, 'JS-блок TRUESOTA найден по заголовку');
    const strays = [...jsBlock.matchAll(/\b(renderJw|loadJw[A-Za-z]*|jw[A-Z][A-Za-z]*)\b/g)].map((m) => m[1]);
    check(strays.length === 0,
        `в JS-блоке TrueSOTA нет вызовов jw-функций${strays.length ? ' — найдено: ' + [...new Set(strays)].join(', ') : ''}`);
}

// ── 6. truesota/open-session.js: рефка и адреса ────────────────────────────────
section('truesota/open-session.js · рефка и адреса');
if (!openjs) {
    check(false, 'truesota/open-session.js не читается — регистрация по рефке невозможна');
} else {
    check(/const REGISTER_URL = require\(['"]\.\.\/routing\/lib\/ref-codes\.js['"]\)\.url\(['"]truesota['"]\)/.test(openjs),
        'REGISTER_URL берётся из routing/lib/ref-codes.js, а не литералом');
    // 🪤 Дефолтного реф-кода у TrueSOTA НЕТ: аккаунта на шлюзе не было, а выдуманный код
    // = молча потерянный реф. Поэтому url() обязан отдавать корень, а не `?aff=` пустышку,
    // и open-session в этом случае сам ведёт на /register (проверяем и это).
    let refUrl = null;
    try { refUrl = require(path.join(REPO, 'routing', 'lib', 'ref-codes.js')).url('truesota'); } catch {}
    check(refUrl === 'https://true-sota.com/', "модуль без своего кода отдаёт корень 'https://true-sota.com/', а не ссылку с пустым aff=", );
    check(/'https:\/\/true-sota\.com\/register'/.test(openjs),
        'без реф-кода open-session ведёт на /register (форма sub2api, не /sign-up как у New-API)');
    check(/const CONSOLE_URL = 'https:\/\/true-sota\.com\/keys';/.test(openjs),
        'CONSOLE_URL = /keys — именно там аккаунт берёт ключ и видит квоту');
    check(/const ROOT_URL = 'https:\/\/true-sota\.com\/';/.test(openjs), 'ROOT_URL на true-sota.com');
    check(/truesota-sessions\.json/.test(openjs),
        'poolFile у gh-live-capture указывает на truesota-sessions.json (иначе ручной GitHub-вход осядет в чужом пуле)');
    check(fs.existsSync(path.join(REPO, 'truesota', 'share-session.js')), 'truesota/share-session.js на месте');
}

// ── 7. keepalive-proxy.js: тариф и цель ротации ───────────────────────────────
section('routing/keepalive-proxy.js · тариф и цель ротации');
if (!keepalive) {
    check(false, 'routing/keepalive-proxy.js не читается');
} else {
    check(/FLAT_RATE_HOSTS = new Set\(\[[^\]]*'true-sota\.com'/.test(keepalive),
        'true-sota.com в FLAT_RATE_HOSTS — хедж выключен: тариф подписочный, дубль съедает окно плана и не ускоряет');
    check(/'true-sota\.com': 'ts'/.test(keepalive),
        "GW_BY_HOST: 'true-sota.com' → 'ts' (без строки авторотация молча выключена)");
}

// ── 7b. Легаси-раскладка (решение владельца 2026-08-24) ───────────────────────
// Шлюз оказался реселлом веб-Клода: свой системный промпт (~200 токенов, инструменты
// claude.ai) он ставит вместо нашего, а присланный `system` уезжает к модели как текст
// пользователя. `tools` при этом работают — потому симптом и читался как «модель тупит».
// Для Claude Code это непригодно, вкладка ушла в «Чтим память». Проверки ниже держат
// именно этот статус: случайный возврат в живые должен быть заметен.
section('живой статус · ref-codes, вотчдог и тир-карта');
{
    let rc = null;
    try { rc = require(path.join(REPO, 'routing', 'lib', 'ref-codes.js')); } catch { /* ниже */ }
    check(!!rc, 'routing/lib/ref-codes.js загружается');
    check(rc && Array.isArray(rc.ACTIVE_PROVIDERS) && rc.ACTIVE_PROVIDERS.includes('truesota'),
        'truesota В ACTIVE_PROVIDERS — шлюз живой, строка настройки рефки человеку нужна');
    check(rc && rc.PROVIDERS.includes('truesota'),
        'truesota есть в PROVIDERS — резолв рефки нужен truesota/open-session.js');

    const watchdog = read(path.join(REPO, 'routing', 'pool-watchdog.js')) || '';
    check(/backend: 'truesota'/.test(watchdog),
        'вотчдог пулов опрашивает truesota — шлюз живой, его падение должно быть слышно');

    // 🪤 Тир-карта opus-only. Это НЕ вкусовщина: 16 из 18 моделей каталога подменяют
    // системный промпт промптом Kiro (замер 25.08), и sonnet-тир увёл бы туда агента
    // молча. Пустой тир тоже запрещён — запрос такого тира падает без ретрая.
    const OK_MODELS = ['claude-opus-5', 'claude-opus-5-thinking'];
    let mm = null;
    try { mm = JSON.parse(fs.readFileSync(path.join(REPO, 'routing', 'truesota-modelmap.json'), 'utf8')); } catch {}
    check(!!mm, 'truesota-modelmap.json читается как JSON');
    for (const tier of ['opus', 'sonnet', 'haiku']) {
        const v = mm ? String(mm[tier] || '') : '';
        check(!!v, `тир ${tier} заполнен — пустой тир роняет запрос без ретрая`);
        check(OK_MODELS.includes(v), `тир ${tier} → ${v || '(пусто)'} из списка исполняющих системный промпт (${OK_MODELS.join(', ')})`);
    }
    check(/const TS_SYSTEM_HONORED = new Set\(\['claude-opus-5', 'claude-opus-5-thinking'\]\)/.test(proxy),
        'TS_SYSTEM_HONORED в дашборде перечисляет обе годные модели — по нему помечается каталог и предупреждает set-model');
    check(/systemHonored/.test(html),
        'вкладка помечает непригодные модели (systemHonored) — иначе выбор sonnet выглядит законным');
}

// ── 8. .gitignore: приватное закрыто ─────────────────────────────────────────
section('.gitignore · приватные данные шлюза');
if (!ignore) {
    check(false, '.gitignore не читается');
} else {
    for (const p of ['truesota/profiles/', 'truesota/sessions/', 'truesota/gh-sessions/', 'routing/truesota-sessions.json']) {
        check(new RegExp(`^${p.replace(/[./]/g, '\\$&')}$`, 'm').test(ignore), `закрыт ${p}`);
    }
}
// ── 9. Коллизии: порт и короткий тег ─────────────────────────────────────────
section(`коллизии · порт ${TS_PORT} и тег ts`);
{
    // Порты собираем в двух формах: числом (как у go/tb/xp) и через env с дефолтом
    // (TrueSOTA) — иначе парсер «не видит» порт и коллизия читается как «занят никем».
    const ports = Array.from(
        proxy.matchAll(/^const ([A-Z]{2})_KEEPALIVE_PORT = (?:Number\(process\.env\.[A-Z_]+ \|\| )?(\d+)/gm),
        (m) => [m[1], Number(m[2])],
    );
    const onPort = ports.filter(([, p]) => p === TS_PORT).map(([t]) => t);
    check(onPort.length === 1 && onPort[0] === 'TS',
        `порт ${TS_PORT} занят только TrueSOTA (нашлось: ${onPort.join(', ') || 'никем'})`);
    check(new Set(ports.map(([, p]) => p)).size === ports.length,
        `порты keepalive не пересекаются (${ports.map(([t, p]) => t + ':' + p).join(' ')})`);

    const others = (proxy.match(new RegExp(`base_url: 'http://localhost:${TS_PORT}'`, 'g')) || []).length;
    check(others === 1, `на :${TS_PORT} смотрит ровно один backend (нашлось ${others})`);

    // Тег `ts` не должен вести к чужим функциям ни в одном реестре.
    const wrong = Array.from(proxy.matchAll(/\bts: \(\)?[^,}\n]*/g))
        .map((m) => m[0])
        .filter((s) => /\b(ar|go|tb|xp|jw)(Load|Save|Balance)/.test(s));
    check(wrong.length === 0, `тег ts нигде не подцеплен к чужим функциям${wrong.length ? ' — ' + wrong.join(' | ') : ''}`);

    check(fs.existsSync(path.join(REPO, 'routing', 'truesota-modelmap.json')),
        'routing/truesota-modelmap.json существует (keepalive читает его по mtime; без файла тир-карта пустая)');
    // lifecycle.js гасит keepalive по списку портов: забытая строка = живой прокси
    // после «остановил всё».
    const life = read(path.join(REPO, 'routing', 'lifecycle.js')) || '';
    check(new RegExp(`port: ${TS_PORT}, name: 'TrueSOTA keepalive'`).test(life),
        `lifecycle.js знает про :${TS_PORT} — иначе stop оставит прокси висеть`);
}

// ── итог ──────────────────────────────────────────────────────────────────────
console.log(`\ncheck-truesota: ${total - fails.length}/${total}`);
if (fails.length) {
    console.log(`\n✗ провалено ${fails.length}:`);
    for (const m of fails) console.log(`   • ${m}`);
    console.log('\nРазбор вкладки — ARCHITECTURE.md § «TrueSOTA (sk)».');
    process.exit(1);
}
console.log('копия вкладки GoRouter полная · тир-карта opus-only · вкладка живая');

