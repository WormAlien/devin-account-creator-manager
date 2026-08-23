#!/usr/bin/env node
/**
 * check-justwoker.js — статический регресс на полноту пятой вкладки (JustWoker).
 *
 * Зачем файл существует. Вкладка шлюза — не один блок кода, а двадцать с лишним
 * упоминаний, размазанных по двум файлам на 13 и 17 тысяч строк: константы, роуты,
 * реестры (BACKENDS / CC_MODEL_PREFIX / GH_POOL_* / NEWAPI_PROFILE_DIRS / MONEY_GW /
 * keepaliveInstances / список Health), фронтовые LABELS/COLORS/state.loaded и сама
 * разметка. Забыть одну строчку из двадцати легко, а симптом при этом не «не
 * собралось», а тихая полуработа: вкладка есть, а баланс не считается; аккаунт
 * добавляется, а активация не поднимает keepalive; авторотация молча обходит шлюз
 * стороной. Ровно так жилось XPeach'у, который до 22.08 был копией на 80%.
 *
 * Инвариант одной строкой: JustWoker — ПОЛНАЯ копия GoRouter. Поэтому почти все
 * проверки здесь не «есть ли строка X», а сравнение ДВУХ МНОЖЕСТВ: сколько у `go`
 * роутов/хендлеров/хелперов/id — столько же обязано быть у `jw`. Такая проверка
 * переживает переименования и ловит то, чего в спецификации не было.
 *
 * Сети нет, дашборд запускать не нужно, файлы только читаются. `:8200` не задет.
 *
 * Запуск: node tools/check-justwoker.js      (exit 1 = копия неполная)
 *
 * 🪤 Два факта провайдера, которые проверяются ЯВНО, потому что стоят денег:
 *   • база для Claude Code — КОРЕНЬ, без `/v1`: `POST /v1/v1/messages` отдаёт 404
 *     (замер 22.08). `/v1` нужен только листингу моделей — это JW_BASE_URL.
 *   • реф-ссылка приходит из `routing/lib/ref-codes.js` (с 23.08), а не литералом:
 *     код владельца лежит дефолтом в `routing/ref-codes.default.json`, пользователь
 *     форка вписывает свой через 💩 в «Настройках». Проверяем и то, что скрипт тянет
 *     URL из модуля, и то, что модуль без переопределения отдаёт прежнюю ссылку
 *     владельца — иначе рефакторинг тихо увёл бы реф-кредит. Полный набор
 *     инвариантов одной точки — `tools/check-ref-codes.js`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PROXY = path.join(REPO, 'routing', 'transparent-proxy.js');
const HTML = path.join(REPO, 'routing', 'proxy-dashboard.html');
const OPENJS = path.join(REPO, 'justwoker', 'open-session.js');
const IGNORE = path.join(REPO, '.gitignore');

const JW_PORT = 20158;

const fails = [];
let total = 0;

function section(title) { console.log(`\n── ${title} ──`); }
function check(cond, msg) {
    total += 1;
    console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
    if (!cond) fails.push(msg);
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// ── парсеры ───────────────────────────────────────────────────────────────────
// Правая часть однострочного `const NAME = …;` как ТЕКСТ: сравнивать значения
// исполнением нельзя (в них path.join и os.homedir()), а текст врать не умеет.
function constExpr(src, name) {
    const m = new RegExp(`^const ${name} = (.+);\\s*$`, 'm').exec(src);
    return m ? m[1].trim() : null;
}
// Множество имён по regex с одной группой — основа всех парных проверок.
function names(src, re) {
    return new Set(Array.from(src.matchAll(re), (m) => m[1]));
}
const lack = (want, got) => [...want].filter((x) => !got.has(x));

// Роуты берём только со строк диспетчера (в них есть `req.url`): в файле те же
// адреса стоят в комментариях над каждым обработчиком, и без фильтра комментарий
// сошёл бы за реализованный роут.
function routeSet(src, tag) {
    const out = new Set();
    const re = new RegExp(`/__switch/api/${tag}/([a-z0-9/_-]+)`, 'g');
    for (const line of src.split('\n')) {
        if (!line.includes('req.url')) continue;
        for (const m of line.matchAll(re)) out.add(m[1]);
    }
    return out;
}

// id элементов: считаем ОБЪЯВЛЕНИЯ (`id="…"`), а не обращения getElementById —
// иначе дубль в разметке спрятался бы за десятком честных чтений.
function idCounts(src, pfx) {
    const out = new Map();
    for (const m of src.matchAll(new RegExp(`id=["'](${pfx}-[a-z0-9-]+)["']`, 'g'))) {
        out.set(m[1], (out.get(m[1]) || 0) + 1);
    }
    return out;
}

const proxy = read(PROXY);
const html = read(HTML);
const openjs = read(OPENJS);
const ignore = read(IGNORE);

if (!proxy || !html) {
    console.log(`  ✗ не читается ${!proxy ? PROXY : HTML} — проверять нечего`);
    process.exit(1);
}

console.log('== check-justwoker: JustWoker (jw) как полная копия GoRouter (go) ==');

// ── 1. transparent-proxy.js: константы ────────────────────────────────────────
section('routing/transparent-proxy.js · константы JW_*');
{
    const val = (n) => constExpr(proxy, n);
    const has = (n, needle, why) => {
        const v = val(n);
        check(!!v && v.includes(needle), `${n} → ${needle}${v ? '' : ' (константы нет)'}${v && !v.includes(needle) ? ` — получено ${v} · ${why}` : ''}`);
    };

    has('JW_SESSIONS_FILE', "'justwoker-sessions.json'", 'пул уедет не в свой файл');
    has('JW_ACTIVE_KEY_FILE', "'justwoker-active-key.txt'", 'keepalive прочитает чужой ключ');
    has('JW_ACTIVE_MODEL_FILE', "'justwoker-active-model.txt'", 'модель шлюза потеряется');
    has('JW_MODELMAP_FILE', "'justwoker-modelmap.json'", 'тир-карта разъедется с keepalive');
    has('JW_SESSIONS_DIR', "'justwoker', 'sessions'", 'импорт/шара сохранит state не туда');
    has('JW_SHARE_SCRIPT', "'justwoker', 'share-session.js'", 'кнопка 🔗 позовёт несуществующий скрипт');

    // База Claude Code и база листинга моделей — РАЗНЫЕ, и это главная ловушка шлюза.
    const eq = (n, want, why) => {
        const got = val(n);
        check(got === want, `${n} = ${want} · ${why}${got === want ? '' : ` — получено ${got}`}`);
    };
    eq('JW_BASE_URL', "'https://api.justwoker.icu/v1'", 'листинг моделей ходит С /v1');
    eq('JW_UPSTREAM', "'https://api.justwoker.icu'", 'корень БЕЗ /v1: /v1/v1/messages → 404');
    eq('JW_KEEPALIVE_PORT', String(JW_PORT), 'свой порт keepalive');
    check((val('JW_KEEPALIVE_URL') || '').includes('${JW_KEEPALIVE_PORT}'),
        'JW_KEEPALIVE_URL собирается из JW_KEEPALIVE_PORT, а не хардкодит число');


    // Полнота набора: у GO_* и JW_* обязаны совпадать суффиксы. Ловит константу,
    // о которой в спецификации не было ни слова.
    const goNames = names(proxy, /^const GO_([A-Z0-9_]+) = /gm);
    const jwNames = names(proxy, /^const JW_([A-Z0-9_]+) = /gm);
    const miss = lack(goNames, jwNames);
    check(miss.length === 0,
        `на каждую GO_* есть JW_* (${goNames.size} шт.)${miss.length ? ' — не хватает: JW_' + miss.join(', JW_') : ''}`);
}

// ── 2. transparent-proxy.js: хендлеры и хелперы ───────────────────────────────
section('routing/transparent-proxy.js · хендлеры и хелперы');
{
    const goH = names(proxy, /function handleGo([A-Za-z0-9]+)\s*\(/g);
    const jwH = names(proxy, /function handleJw([A-Za-z0-9]+)\s*\(/g);
    const missH = lack(goH, jwH);
    check(missH.length === 0,
        `handleJw* повторяет handleGo* (${goH.size} шт.)${missH.length ? ' — нет: handleJw' + missH.join(', handleJw') : ''}`);

    const goF = names(proxy, /function go([A-Za-z0-9]+)\s*\(/g);
    const jwF = names(proxy, /function jw([A-Za-z0-9]+)\s*\(/g);
    const missF = lack(goF, jwF);
    check(missF.length === 0,
        `хелперы jw* повторяют go* (${goF.size} шт.)${missF.length ? ' — нет: jw' + missF.join(', jw') : ''}`);

    check(/const keepaliveJw = makeKeepaliveHandlers\(Number\(process\.env\.JW_KEEPALIVE_PORT \|\| 20158\)\)/.test(proxy),
        'keepaliveJw объявлен через makeKeepaliveHandlers(:20158) — иначе карточка keepalive на вкладке пустая');
}

// ── 3. Роуты: ключевой инвариант ──────────────────────────────────────────────
// На каждый `/__switch/api/go/…` обязан быть парный `/__switch/api/jw/…`. Считаем
// оба множества и сравниваем: пропущенный роут = кнопка на вкладке, которая молча
// получает 404 и в UI выглядит «ничего не произошло».
section('routing/transparent-proxy.js · роуты /__switch/api/{go,jw}/*');
{
    const go = routeSet(proxy, 'go');
    const jw = routeSet(proxy, 'jw');
    const miss = lack(go, jw);
    // Роуты, которые у JustWoker есть НАМЕРЕННО и у GoRouter пары иметь не должны.
    // `auto-add` — авто-заведение аккаунта без человека. Оно не переносится на go
    // копированием: у GoRouter вход через GitHub уезжает в ПОПАП, а у JustWoker идёт
    // в той же вкладке (замер рекордером 2026-08-22), и ключ там приходит прямо в
    // ответе OAuth-колбэка. Сценарий надо снимать заново под каждую панель, поэтому
    // «копия один в один» на эту ручку не распространяется.
    const JW_ONLY = new Set(['auto-add', 'auto-add/state']);
    const extra = lack(jw, go).filter((r) => !JW_ONLY.has(r));
    check(go.size >= 20, `роутов go найдено ${go.size} (парсер жив)`);
    check(miss.length === 0,
        `парных jw-роутов ${jw.size} из ${go.size}${miss.length ? ' — не хватает: ' + miss.map((r) => '/jw/' + r).join(' ') : ''}`);
    check(extra.length === 0,
        `лишних jw-роутов нет${extra.length ? ' — у go нет пары: ' + extra.map((r) => '/jw/' + r).join(' ') : ''}`);
    // Исключения обязаны существовать: опечатка в JW_ONLY иначе просто отключила бы
    // проверку, и настоящий лишний роут проехал бы незамеченным.
    check([...JW_ONLY].every((r) => jw.has(r)),
        `исключения JW_ONLY на месте (${[...JW_ONLY].map((r) => '/jw/' + r).join(' ')})`);
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
    check(/justwoker:\s*\{/.test(backends), 'BACKENDS: запись justwoker есть');
    check(new RegExp(`justwoker:[\\s\\S]*?base_url: 'http://localhost:${JW_PORT}'`).test(backends),
        `BACKENDS.justwoker.base_url = http://localhost:${JW_PORT}`);

    const prefix = block('const CC_MODEL_PREFIX = {');
    check(/justwoker: 'justwoker'/.test(prefix),
        "CC_MODEL_PREFIX: justwoker → 'justwoker' (иначе резолв модели не найдёт active-model.txt и окно упадёт до 200k)");

    for (const reg of ['GH_POOL_LOADERS', 'GH_POOL_FILES', 'GH_POOL_SAVERS', 'GH_POOL_LABELS']) {
        const line = (new RegExp(`^const ${reg} = .+$`, 'm').exec(proxy) || [''])[0];
        check(/\bjw:/.test(line), `${reg}: ключ jw есть — иначе менеджер гитхабов не видит пятый пул`);
    }
    check(/jw: 'JustWoker'/.test(proxy), "GH_POOL_LABELS: jw → 'JustWoker'");

    const dirs = block('const NEWAPI_PROFILE_DIRS = {');
    check(/'api\.justwoker\.icu':/.test(dirs) && /justwoker', 'profiles'/.test(dirs),
        "NEWAPI_PROFILE_DIRS: 'api.justwoker.icu' → justwoker/profiles (поддомен обязателен, justwoker.icu не резолвится)");

    const inst = block('function keepaliveInstances() {');
    check(/\[JW_KEEPALIVE_PORT\]:\s*\{[^}]*spawn: jwKeepaliveSpawn/.test(inst),
        'keepaliveInstances: [JW_KEEPALIVE_PORT] → jwKeepaliveSpawn (иначе кнопка «перезапустить» в Health не знает про :20158)');

    const money = block('const MONEY_GW = {');
    check(/^\s*jw:/m.test(money), 'MONEY_GW: строка jw есть — иначе авторотация обходит шлюз стороной');
    check(/jw:[^\n]*host: 'api\.justwoker\.icu'/.test(money), "MONEY_GW.jw.host = 'api.justwoker.icu'");
    check(/jw:[^\n]*keyFile: JW_ACTIVE_KEY_FILE[^\n]*load: jwLoad[^\n]*save: jwSave/.test(money),
        'MONEY_GW.jw: keyFile/load/save указывают на JW-функции');
    check(/jw:[^\n]*balanceFn: jwBalance[^\n]*applyFn: jwApplyBalance/.test(money),
        'MONEY_GW.jw: balanceFn/applyFn на месте (без них ротация не проверит живой остаток)');

    check(/name: 'Keepalive JustWoker',\s*port: Number\(process\.env\.JW_KEEPALIVE_PORT \|\| 20158\)/.test(proxy),
        'Health: сервис «Keepalive JustWoker» на :20158 в списке checks');
    check(/pools\.justwoker\s*=/.test(proxy), 'сводка шапки (pools) считает justwoker');
}

// ── 5. Фронт: вкладка в дашборде ──────────────────────────────────────────────
section('routing/proxy-dashboard.html · вкладка');
{
    check(html.includes('data-tab="justwoker"'), 'кнопка в сайдбаре: data-tab="justwoker"');
    check(html.includes('data-tab-content="justwoker"'), 'панель вкладки: data-tab-content="justwoker"');

    const listOf = (name) => (new RegExp(`^const ${name} = .+$`, 'm').exec(html) || [''])[0];
    const tabs = listOf('DEFAULT_TABS_VISIBLE');
    check(/'justwoker'/.test(tabs),
        "DEFAULT_TABS_VISIBLE: 'justwoker' в whitelist — иначе на свежей установке вкладки просто нет");
    check(/justwoker:/.test(listOf('LABELS')), 'LABELS: justwoker (иначе в шапке будет «unknown»)');
    check(/justwoker:/.test(listOf('COLORS')), 'COLORS: justwoker (без цвета плашка активного бэкенда серая)');

    const loaded = (/loaded:\s*\{[^}]*\}/.exec(html) || [''])[0];
    check(/justwoker: false/.test(loaded), 'state.loaded: justwoker (иначе ленивая загрузка вкладки повторяется на каждый клик)');

    const ka = (/const KEEPALIVE_API = \{[\s\S]*?\n\};/.exec(html) || [''])[0];
    check(/jw: '\/__switch\/api\/jw\/keepalive'/.test(ka), "KEEPALIVE_API: jw → '/__switch/api/jw/keepalive'");

    const mp = (/const MONEY_PROVIDERS = \{[\s\S]*?\n\};/.exec(html) || [''])[0];
    check(/justwoker:\s*\{/.test(mp), 'MONEY_PROVIDERS: justwoker (тумблер авторотации и тост о подмене)');
    check(/justwoker:[^\n]*p: 'jw'/.test(mp), "MONEY_PROVIDERS.justwoker.p = 'jw'");

    for (const fn of ['loadJwSessions', 'loadJwSessionsLight', 'renderJw']) {
        check(new RegExp(`function ${fn}\\s*\\(`).test(html), `функция ${fn}() объявлена`);
    }

    // Дубль id — самая тихая поломка фронта: getElementById возьмёт первый, и вторая
    // половина вкладки перестанет обновляться без единой ошибки в консоли.
    const jwIds = idCounts(html, 'jw');
    const dup = [...jwIds].filter(([, n]) => n > 1).map(([id]) => id);
    check(jwIds.size > 0, `id вида jw-* в разметке: ${jwIds.size}`);
    check(dup.length === 0, `ни один jw-* id не дублируется${dup.length ? ' — дубли: ' + dup.join(', ') : ''}`);

    // Полнота копии: на каждый go-* элемент есть jw-*.
    const goIds = new Set(idCounts(html, 'go').keys());
    const jwHas = new Set([...jwIds.keys()].map((id) => id.replace(/^jw-/, '')));
    const missIds = [...goIds].map((id) => id.replace(/^go-/, '')).filter((s) => !jwHas.has(s));
    check(missIds.length === 0,
        `на каждый go-* элемент есть jw-* (${goIds.size} шт.)${missIds.length ? ' — нет: jw-' + missIds.join(', jw-') : ''}`);
}

// ── 6. justwoker/open-session.js: рефка и адреса ──────────────────────────────
section('justwoker/open-session.js · рефка и адреса');
if (!openjs) {
    check(false, 'justwoker/open-session.js не читается — регистрация по рефке невозможна');
} else {
    // Реф-ссылка с 23.08 берётся из routing/lib/ref-codes.js — литерала в файле больше
    // нет намеренно (пользователь форка вписывает свой код через 💩 в «Настройках»).
    // Проверяем ДВА условия: скрипт тянет URL из модуля, и модуль без переопределения
    // отдаёт ровно прежнюю ссылку владельца. Подробнее — tools/check-ref-codes.js.
    check(/const REGISTER_URL = require\(['"]\.\.\/routing\/lib\/ref-codes\.js['"]\)\.url\(['"]justwoker['"]\)/.test(openjs),
        'REGISTER_URL берётся из routing/lib/ref-codes.js, а не литералом');
    let refUrlOk = false;
    try {
        refUrlOk = require(path.join(REPO, 'routing', 'lib', 'ref-codes.js')).url('justwoker')
            === 'https://api.justwoker.icu/sign-up?aff=IFYf';
    } catch { refUrlOk = false; }
    check(refUrlOk, "модуль без переопределения отдаёт 'https://api.justwoker.icu/sign-up?aff=IFYf' — реф-кредит владельца");
    check(/const CONSOLE_URL = 'https:\/\/api\.justwoker\.icu\//.test(openjs), 'CONSOLE_URL на api.justwoker.icu');
    check(/const ROOT_URL = 'https:\/\/api\.justwoker\.icu\/';/.test(openjs), 'ROOT_URL на api.justwoker.icu');
    check(/justwoker-sessions\.json/.test(openjs),
        'poolFile у gh-live-capture указывает на justwoker-sessions.json (иначе ручной GitHub-вход осядет в чужом пуле)');
    check(/github_minimum_account_age_days|365/.test(openjs),
        'в файле зафиксировано требование возраста GitHub-аккаунта (365 дней) — иначе отказ сайта читается как баг скрипта');
    check(fs.existsSync(path.join(REPO, 'justwoker', 'share-session.js')), 'justwoker/share-session.js на месте');
}

// ── 7. .gitignore: приватное закрыто ─────────────────────────────────────────
section('.gitignore · приватные данные шлюза');
if (!ignore) {
    check(false, '.gitignore не читается');
} else {
    for (const p of ['justwoker/profiles/', 'justwoker/sessions/', 'justwoker/gh-sessions/', 'routing/justwoker-sessions.json']) {
        check(new RegExp(`^${p.replace(/[./]/g, '\\$&')}$`, 'm').test(ignore), `закрыт ${p}`);
    }
}

// ── 8. Коллизии: порт и короткий тег ─────────────────────────────────────────
section('коллизии · порт 20158 и тег jw');
{
    const ports = Array.from(proxy.matchAll(/^const ([A-Z]{2})_KEEPALIVE_PORT = (\d+);/gm), (m) => [m[1], Number(m[2])]);
    const on20158 = ports.filter(([, p]) => p === JW_PORT).map(([t]) => t);
    check(on20158.length === 1 && on20158[0] === 'JW',
        `порт ${JW_PORT} занят только JustWoker (нашлось: ${on20158.join(', ') || 'никем'})`);
    check(new Set(ports.map(([, p]) => p)).size === ports.length,
        `порты keepalive не пересекаются (${ports.map(([t, p]) => t + ':' + p).join(' ')})`);

    const others = (proxy.match(new RegExp(`base_url: 'http://localhost:${JW_PORT}'`, 'g')) || []).length;
    check(others === 1, `на :${JW_PORT} смотрит ровно один backend (нашлось ${others})`);

    // Тег `jw` не должен вести к чужим функциям ни в одном реестре.
    const wrong = Array.from(proxy.matchAll(/\bjw: \(\)?[^,}\n]*/g))
        .map((m) => m[0])
        .filter((s) => /\b(ar|go|tb|xp)(Load|Save|Balance)/.test(s));
    check(wrong.length === 0, `тег jw нигде не подцеплен к чужим функциям${wrong.length ? ' — ' + wrong.join(' | ') : ''}`);

    check(fs.existsSync(path.join(REPO, 'routing', 'justwoker-modelmap.json')),
        'routing/justwoker-modelmap.json существует (keepalive читает его по mtime; без файла тир-карта пустая)');
}

// ── итог ──────────────────────────────────────────────────────────────────────
console.log(`\ncheck-justwoker: ${total - fails.length}/${total}`);
if (fails.length) {
    console.log(`\n✗ провалено ${fails.length}:`);
    for (const m of fails) console.log(`   • ${m}`);
    console.log('\nРазбор вкладки — ARCHITECTURE.md § «JustWoker (jw)».');
    process.exit(1);
}
console.log('копия вкладки GoRouter полная');
