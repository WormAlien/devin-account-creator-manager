#!/usr/bin/env node
/**
 * check-hcnsec.js — статический регресс на полноту девятой вкладки (HCNsec).
 *
 * Что за шлюз. `api.hcnsec.cn` — очередная панель New API, поэтому вкладка делается
 * копией GoRouter, как KKtoken до неё. Одно структурное отличие, и оно снимает целый
 * пласт кода: **GitHub-входа у шлюза НЕТ** — `GET /api/status` отдаёт
 * `github_oauth=false` (живая проба 31.08), вход только email+пароль. Значит нет
 * GitHub-пула, а с ним трёх хендлеров, трёх роутов, ключа в `GH_POOL_*`, записи в
 * `ghLkPidsByTag` и трёх фронтовых GH-реестров. Всё это перечислено в ослаблениях ниже
 * и проверяется НА ОТСУТСТВИЕ: «дополнить копию до GoRouter» тут значит завести мёртвый
 * GitHub-UI на шлюзе, которому он физически не нужен.
 *
 * 🪤 ГЛАВНОЕ, что стоит денег и тишины: КАТАЛОГ ШЛЮЗА — 13 моделей, и годны из них
 * пять. Негодные отвечают НЕ ошибкой, поэтому со стороны это «модель тупит»:
 * `DeepSeek-V4-Pro` подменяет модель на `nvidia/nemotron-3-ultra-550b-a55b`, как только
 * в запросе есть `tools`; `glm-4.5-air` отдаёт ошибку апстрима под кодом **200**;
 * `auto` стримит без `message_stop`; `Qwen3.8-27B` не парсит инструменты;
 * `sensenova-6.8-flash-lite` держит зашитую личность; `MiniMax-M3` думает 22–60 с.
 * Отсюда секция «тир-карта»: белый список + явный запрет негодных.
 *
 * 🪤 Второе про тир-карту: ни одно значение не должно содержать `opus|sonnet|haiku`.
 * Каталог тут чужой (kimi/step/kat), а `TIER_RE` в keepalive определяет тир по этим
 * словам в имени модели — эхо-подмена с такими именами закольцевала бы резолв.
 *
 * Зачем файл существует. Вкладка шлюза — не один блок кода, а двадцать с лишним
 * упоминаний, размазанных по двум файлам на 15 и 23 тысячи строк: константы, роуты,
 * реестры (BACKENDS / CC_MODEL_PREFIX / NEWAPI_PROFILE_DIRS / MONEY_GW /
 * keepaliveInstances / список Health), фронтовые LABELS/COLORS/state.loaded, сама
 * разметка и обвязка снаружи (GW_BY_HOST, lifecycle, вотчдог, keepalive-restart.ps1,
 * HOST_AUTH, hub-balance, статуслайн, .gitignore). Забыть одну строчку из двадцати
 * легко, а симптом при этом не «не собралось», а тихая полуработа: вкладка есть, а
 * баланс не считается; аккаунт добавляется, а активация не поднимает keepalive;
 * авторотация молча обходит шлюз стороной.
 *
 * Инвариант одной строкой: HCNsec — полная копия GoRouter МИНУС GitHub-пул и выдача.
 * Поэтому почти все проверки здесь не «есть ли строка X», а сравнение ДВУХ МНОЖЕСТВ:
 * сколько у `go` роутов/хендлеров/хелперов/функций фронта/id — столько же обязано быть
 * у `hn`, минус явные списки ослаблений. Такая проверка переживает переименования и
 * ловит то, чего в спецификации не было.
 *
 * Сети нет, дашборд запускать не нужно, файлы только читаются. `:8200` не задет.
 *
 * Запуск: node tools/check-hcnsec.js      (exit 1 = копия неполная)
 *
 * 🪤 Ещё три факта провайдера, проверяемые ЯВНО, потому что стоят денег:
 *   • база для Claude Code — КОРЕНЬ, без `/v1`: `POST /v1/v1/messages` → 404, а
 *     `POST /messages` без префикса отдаёт **200 с HTML**. То есть промах с префиксом
 *     не упадёт, а нальёт мусора в ответ. `/v1` нужен только листингу — HN_BASE_URL.
 *   • реф-код у шлюза ЕСТЬ: `u4eN`, владелец принёс ссылку из кабинета 31.08 — уже после
 *     того, как вкладку собрали. Поэтому `hcnsec` заведён в `routing/lib/ref-codes.js`, а
 *     `hcnsec/open-session.js` обязан брать ссылку оттуда (не литералом) и проверять, что
 *     код осел в localStorage `aff`: одного захода по реф-ссылке панели не хватает.
 *   • `api.hcnsec.cn` в `FLAT_RATE_HOSTS` быть НЕ должно: тариф по токенам, хедж
 *     keepalive осмыслен.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PROXY = path.join(REPO, 'routing', 'transparent-proxy.js');
const HTML = path.join(REPO, 'routing', 'proxy-dashboard.html');
const KEEPALIVE = path.join(REPO, 'routing', 'keepalive-proxy.js');
const OPENJS = path.join(REPO, 'hcnsec', 'open-session.js');
const IGNORE = path.join(REPO, '.gitignore');

const HN_PORT = 20162;
const HOST = 'api.hcnsec.cn';

// ── ослабления: чего у HCNsec нет и быть не должно ────────────────────────────
// GitHub-пула нет (`github_oauth=false`, живая проба 31.08) — вход email+пароль.
const GH_LESS_HANDLERS = ['AddGithub', 'MapProfiles', 'SetGithub'];
const GH_LESS_ROUTES = ['add-github', 'map-profiles', 'set-github'];
// Обратная сторона того же различия: у hcnsec есть то, чего нет у GoRouter. Аккаунт здесь
// заводится НА КУПЛЕННОМ ЯЩИКЕ (регистрация просит код с почты, `email_verification=true`),
// поэтому место пикера гитхабов занял пикер ящиков из менеджера 📧. Список ЗАКРЫТЫЙ: любой
// другой лишний роут по-прежнему считается опечаткой или чужим хендлером.
const OL_ONLY_ROUTES = ['set-outlook', 'add-outlook'];
// 🪤 `map-profiles` вычтен из ПАРНОСТИ, но его отсутствие НЕ утверждается, и это
// разбор, а не небрежность. Спецификация вкладки относит ручку к GitHub-механике, а
// код говорит другое: `newapiMapProfiles` сопоставляет запись с профилем по API-КЛЮЧУ,
// вычитанному из панели куками профиля (`listAccountKeys`), и GitHub-логин у него лишь
// РЕЗЕРВ с пометкой «неточно». Для HCNsec это ровно тот путь, которым считается точный
// остаток (`/api/user/self` куками профиля — под это и заведён `NEWAPI_PROFILE_DIRS`).
// Поэтому здесь проверяется СОГЛАСОВАННОСТЬ четырёх точек, а не одна из версий: роут,
// хендлер, функция фронта и кнопка тулбара либо есть все, либо нет ни одной. Кнопка без
// роута — 404 на нажатие, роут без кнопки — мёртвый код.
const MAP_ONLY_GH = ['AddGithub', 'SetGithub'];
const MAP_ONLY_GH_ROUTES = ['add-github', 'set-github'];
const GH_LESS_FRONT = ['goMapProfiles'];
const GH_LESS_IDS = ['add-gh-hint'];
const GH_LESS_FRONT_REGS = ['ghAddPick', 'NEWAPI_SEED_PROV', 'GH_USE_META'];
// Выдачи (грант при регистрации) шлюз не заявляет — путь TrueSOTA: прикидка врала бы в
// обе стороны, а на завышенной авторотация берёт пустой аккаунт.
const GRANT_LESS = ['GRANT_STEP', 'DEFAULT_GRANT'];
// Своё, чего у GoRouter нет: пароль в форме ➕ — вход в панель email+пароль.
const HN_ONLY_IDS = ['add-pass'];

const fails = [];
let total = 0;

function section(title) { console.log(`\n── ${title} ──`); }
function check(cond, msg) {
    total += 1;
    console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
    if (!cond) fails.push(msg);
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// ── парсеры (те же, что в check-truesota.js / check-kktoken.js) ───────────────
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

const block = (head) => {
    const i = proxy.indexOf(head);
    if (i < 0) return '';
    const j = proxy.indexOf('\n};', i);
    return j < 0 ? proxy.slice(i, i + 4000) : proxy.slice(i, j + 3);
};
const listOf = (name) => (new RegExp(`^const ${name} = .+$`, 'm').exec(html) || [''])[0];

console.log('== check-hcnsec: HCNsec (hn) как копия GoRouter (go) минус GitHub-пул ==');

// ── 1. transparent-proxy.js: константы ────────────────────────────────────────
section('routing/transparent-proxy.js · константы HN_*');
{
    const val = (n) => constExpr(proxy, n);
    const has = (n, needle, why) => {
        const v = val(n);
        check(!!v && v.includes(needle), `${n} → ${needle}${v ? '' : ' (константы нет)'}${v && !v.includes(needle) ? ` — получено ${v} · ${why}` : ''}`);
    };

    has('HN_SESSIONS_FILE', "'hcnsec-sessions.json'", 'пул уедет не в свой файл');
    has('HN_ACTIVE_KEY_FILE', "'hcnsec-active-key.txt'", 'keepalive прочитает чужой ключ');
    has('HN_ACTIVE_MODEL_FILE', "'hcnsec-active-model.txt'", 'модель шлюза потеряется');
    has('HN_MODELMAP_FILE', "'hcnsec-modelmap.json'", 'тир-карта разъедется с keepalive');
    has('HN_SESSIONS_DIR', "'hcnsec', 'sessions'", 'импорт/шара сохранит state не туда');
    has('HN_SHARE_SCRIPT', "'hcnsec', 'share-session.js'", 'кнопка 🔗 позовёт несуществующий скрипт');

    // База Claude Code и база листинга моделей — РАЗНЫЕ, и это главная ловушка шлюза.
    const eq = (n, want, why) => {
        const got = val(n);
        check(got === want, `${n} = ${want} · ${why}${got === want ? '' : ` — получено ${got}`}`);
    };
    eq('HN_BASE_URL', `'https://${HOST}/v1'`, 'листинг моделей ходит С /v1');
    eq('HN_UPSTREAM', `'https://${HOST}'`, 'корень БЕЗ /v1: /v1/v1/messages → 404');
    // 🪤 Двойной /v1 проверяем ещё и формой, отдельно от точного значения: промах здесь
    // НЕ падает. `POST /v1/v1/messages` отдаёт 404, а `POST /messages` без префикса —
    // 200 с HTML, то есть агент получит мусор вместо ответа и будет искать причину в
    // модели. Поэтому два независимых утверждения о хвосте строки.
    check(!/\/v1'$/.test(val('HN_UPSTREAM') || "'?'"), 'HN_UPSTREAM НЕ кончается на /v1 (иначе /v1/v1/messages → 404)');
    check(/\/v1'$/.test(val('HN_BASE_URL') || "'?'"), 'HN_BASE_URL кончается на /v1 (без него листинг моделей отдаёт HTML с кодом 200)');

    // Порт объявлен через env с дефолтом (как у TrueSOTA/KKtoken в Health и spawn):
    // спавн, Health и keepalive-restart.ps1 читают одну переменную, и подмена порта на
    // время отладки не должна требовать правки кода.
    check((val('HN_KEEPALIVE_PORT') || '').includes(`process.env.HN_KEEPALIVE_PORT || ${HN_PORT}`),
        `HN_KEEPALIVE_PORT = Number(process.env.HN_KEEPALIVE_PORT || ${HN_PORT}) · свой порт keepalive`);
    check((val('HN_KEEPALIVE_URL') || '').includes('${HN_KEEPALIVE_PORT}'),
        'HN_KEEPALIVE_URL собирается из HN_KEEPALIVE_PORT, а не хардкодит число');

    // Полнота набора: у GO_* и HN_* обязаны совпадать суффиксы. Ловит константу,
    // о которой в спецификации не было ни слова.
    const goNames = names(proxy, /^const GO_([A-Z0-9_]+) = /gm);
    const hnNames = names(proxy, /^const HN_([A-Z0-9_]+) = /gm);
    const miss = lack(goNames, hnNames).filter((n) => !GRANT_LESS.includes(n));
    check(miss.length === 0,
        `на каждую GO_* есть HN_* (${goNames.size} шт.)${miss.length ? ' — не хватает: HN_' + miss.join(', HN_') : ''}`);
}

// ── 2. transparent-proxy.js: хендлеры и хелперы ───────────────────────────────
section('routing/transparent-proxy.js · хендлеры и хелперы');
{
    const goH = names(proxy, /function handleGo([A-Za-z0-9]+)\s*\(/g);
    const hnH = names(proxy, /function handleHn([A-Za-z0-9]+)\s*\(/g);
    const missH = lack(goH, hnH).filter((n) => !GH_LESS_HANDLERS.includes(n));
    check(missH.length === 0,
        `handleHn* повторяет handleGo* минус GitHub (${goH.size} шт. у go)${missH.length ? ' — нет: handleHn' + missH.join(', handleHn') : ''}`);

    const goF = names(proxy, /function go([A-Za-z0-9]+)\s*\(/g);
    const hnF = names(proxy, /function hn([A-Za-z0-9]+)\s*\(/g);
    const missF = lack(goF, hnF);
    check(missF.length === 0,
        `хелперы hn* повторяют go* (${goF.size} шт.)${missF.length ? ' — нет: hn' + missF.join(', hn') : ''}`);

    check(new RegExp(`const keepaliveHn = makeKeepaliveHandlers\\(Number\\(process\\.env\\.HN_KEEPALIVE_PORT \\|\\| ${HN_PORT}\\)\\)`).test(proxy),
        `keepaliveHn объявлен через makeKeepaliveHandlers(:${HN_PORT}) — иначе карточка keepalive на вкладке пустая`);
}

// ── 3. Роуты: ключевой инвариант ──────────────────────────────────────────────
section('routing/transparent-proxy.js · роуты /__switch/api/{go,hn}/*');
{
    const go = routeSet(proxy, 'go');
    const hn = routeSet(proxy, 'hn');
    check(go.size >= 20, `роутов go найдено ${go.size} (парсер жив)`);
    const miss = lack(go, hn).filter((r) => !GH_LESS_ROUTES.includes(r));
    const extra = lack(hn, go).filter((r) => !OL_ONLY_ROUTES.includes(r));
    check(miss.length === 0,
        `парных hn-роутов ${hn.size} из ${go.size - GH_LESS_ROUTES.length} ожидаемых${miss.length ? ' — не хватает: ' + miss.map((r) => '/hn/' + r).join(' ') : ''}`);
    // Лишних роутов быть не должно — кроме связки с менеджером ящиков (OL_ONLY_ROUTES):
    // у GoRouter её пары нет, потому что там аккаунт заводится на GitHub, а здесь на почте.
    // Всё остальное сверх набора GoRouter — либо опечатка, либо чужой хендлер.
    check(extra.length === 0,
        `лишних hn-роутов нет${extra.length ? ' — у go нет пары: ' + extra.map((r) => '/hn/' + r).join(' ') : ''}`);
    // И обратная проверка, положительная: связка обязана быть целиком. Половина
    // (ручка без кнопки или наоборот) — это 404 по клику, то есть худший вид поломки.
    for (const r of OL_ONLY_ROUTES) {
        check(hn.has(r), `роут /hn/${r} на месте — связка с менеджером 📧 вместо пикера гитхабов`);
    }
    check(/function handleHnSetOutlook\s*\(/.test(proxy) && /async function handleHnAddOutlook\s*\(/.test(proxy),
        'хендлеры handleHnSetOutlook и handleHnAddOutlook объявлены');
    check(/function olMarkTag\s*\(/.test(proxy) && /function olUsageMap\s*\(/.test(proxy),
        'занятость ящиков считает общий olMarkTag/olUsageMap — не вторая копия логики');
}

// ── 4. Серверные реестры: то, что легче всего забыть ──────────────────────────
section('routing/transparent-proxy.js · серверные реестры');
{
    const backends = block('const BACKENDS = {');
    check(/hcnsec:\s*\{/.test(backends), 'BACKENDS: запись hcnsec есть');
    check(new RegExp(`hcnsec:[\\s\\S]*?base_url: 'http://localhost:${HN_PORT}'`).test(backends),
        `BACKENDS.hcnsec.base_url = http://localhost:${HN_PORT} (клиент идёт в keepalive, не напрямую в шлюз)`);

    const prefix = block('const CC_MODEL_PREFIX = {');
    check(/hcnsec: 'hcnsec'/.test(prefix),
        "CC_MODEL_PREFIX: hcnsec → 'hcnsec' (иначе резолв модели не найдёт active-model.txt и окно упадёт до 200k)");

    const dirs = block('const NEWAPI_PROFILE_DIRS = {');
    check(new RegExp(`'${HOST.replace(/\./g, '\\.')}':`).test(dirs) && /hcnsec', 'profiles'/.test(dirs),
        `NEWAPI_PROFILE_DIRS: '${HOST}' → hcnsec/profiles · ключ с поддоменом, панель и API на одном хосте`);

    const inst = block('function keepaliveInstances() {');
    check(/\[HN_KEEPALIVE_PORT\]:\s*\{[^}]*spawn: hnKeepaliveSpawn/.test(inst),
        `keepaliveInstances: [HN_KEEPALIVE_PORT] → hnKeepaliveSpawn (иначе кнопка «перезапустить» в Health не знает про :${HN_PORT})`);

    const money = block('const MONEY_GW = {');
    check(/^\s*hn:/m.test(money), 'MONEY_GW: строка hn есть — иначе авторотация обходит шлюз стороной');
    check(new RegExp(`hn:[^\\n]*host: '${HOST.replace(/\./g, '\\.')}'`).test(money), `MONEY_GW.hn.host = '${HOST}'`);
    check(/hn:[^\n]*keyFile: HN_ACTIVE_KEY_FILE[^\n]*load: hnLoad[^\n]*save: hnSave/.test(money),
        'MONEY_GW.hn: keyFile/load/save указывают на HN-функции');
    check(/hn:[^\n]*balanceFn: hnBalance[^\n]*applyFn: hnApplyBalance/.test(money),
        'MONEY_GW.hn: balanceFn/applyFn на месте (без них ротация не проверит живой остаток)');

    check(new RegExp(`name: 'Keepalive HCNsec',\\s*port: Number\\(process\\.env\\.HN_KEEPALIVE_PORT \\|\\| ${HN_PORT}\\)`).test(proxy),
        `Health: сервис «Keepalive HCNsec» на :${HN_PORT} в списке checks`);
    check(/pools\.hcnsec\s*=/.test(proxy), 'сводка шапки (pools) считает hcnsec');
    // 🪤 Строку диспетчера ищем по `__switch` + `(ar|`, а не по `/__switch/api/`: в
    // исходнике это regexp-литерал с экранированными слешами, и поиск по «чистому» пути
    // не находит ничего — проверка молча превратилась бы в «строку не нашёл». Сам вид
    // группы не фиксируем: она растёт с каждым шлюзом.
    const rotLine = proxy.split('\n').find((l) => l.includes('__switch') && /\(ar\|/.test(l)) || '';
    check(/\|hn[|)]/.test(rotLine),
        `роуты авторотации принимают тег hn${rotLine ? ' — группа: ' + (/\((?:[a-z]{2}\|)+[a-z]{2}\)/.exec(rotLine) || ['?'])[0] : ' (строку диспетчера не нашёл)'}`);
}

// ── 5. Фронт: вкладка в дашборде ──────────────────────────────────────────────
section('routing/proxy-dashboard.html · вкладка');
{
    check(html.includes('data-tab="hcnsec"'), 'кнопка в сайдбаре: data-tab="hcnsec"');
    check(html.includes('data-tab-content="hcnsec"'), 'панель вкладки: data-tab-content="hcnsec"');

    // Вкладка ЖИВАЯ (решение владельца 31.08): шлюз новый, пять моделей исполняют
    // системный промпт. Проверяем обе стороны — и что она в дефолтном сайдбаре, и что её
    // НЕ унесло в «Чтим память»: переезд в легаси выглядел бы как «вкладка пропала», и
    // причина не читалась бы ниоткуда.
    const memoryGroup = (/data-extra-nav="memory"[\s\S]*?\n      <\/div>/.exec(html) || [''])[0];
    check(!/data-tab="hcnsec"/.test(memoryGroup), 'кнопка HCNsec НЕ в группе «Чтим память» — шлюз живой');
    const tabs = listOf('DEFAULT_TABS_VISIBLE');
    check(!!tabs && /'hcnsec'/.test(tabs),
        "DEFAULT_TABS_VISIBLE: 'hcnsec' на месте — иначе вкладки не видно в дефолтном сайдбаре");
    check(/hcnsec:/.test(listOf('LABELS')), 'LABELS: hcnsec (иначе в шапке будет «unknown»)');
    check(/hcnsec:/.test(listOf('COLORS')), 'COLORS: hcnsec (без цвета плашка активного бэкенда серая)');

    const loaded = (/loaded:\s*\{[^}]*\}/.exec(html) || [''])[0];
    check(/hcnsec: false/.test(loaded), 'state.loaded: hcnsec (иначе ленивая загрузка вкладки повторяется на каждый клик)');
    check(/^\s+hcnsec: \[\],?\s*$/m.test(html), 'state.hcnsec = [] — список аккаунтов вкладки, его читают renderHn и деньги в шапке');

    const ka = (/const KEEPALIVE_API = \{[\s\S]*?\n\};/.exec(html) || [''])[0];
    check(/hn: '\/__switch\/api\/hn\/keepalive'/.test(ka), "KEEPALIVE_API: hn → '/__switch/api/hn/keepalive'");
    const poll = (/const KEEPALIVE_POLL_TABS = \{[\s\S]*?\n\};/.exec(html) || [''])[0];
    check(/hcnsec: \['hn', '\/__switch\/api\/hn\/keepalive'\]/.test(poll),
        "KEEPALIVE_POLL_TABS: hcnsec → ['hn', …] — иначе карточка keepalive на открытой вкладке не обновляется");

    const mp = (/const MONEY_PROVIDERS = \{[\s\S]*?\n\};/.exec(html) || [''])[0];
    check(/hcnsec:\s*\{/.test(mp), 'MONEY_PROVIDERS: hcnsec (тумблер авторотации и тост о подмене)');
    check(/hcnsec:[^\n]*p: 'hn'/.test(mp), "MONEY_PROVIDERS.hcnsec.p = 'hn'");

    // Полнота копии по ФУНКЦИЯМ фронта: у GoRouter их 28, и на каждую обязана быть
    // hn-пара. Это ловит «сделал разметку, забыл половину обработчиков» — самый частый
    // вид недокопии, потому что вкладка при этом открывается и выглядит целой.
    const toHn = (n) => n.replace(/^renderGo/, 'renderHn').replace(/^loadGo/, 'loadHn').replace(/^go(?=[A-Z])/, 'hn');
    const goFront = names(html, /function ((?:render|load)?Go[A-Za-z0-9]*|go[A-Z][A-Za-z0-9]*)\s*\(/g);
    const missFront = [...goFront]
        .filter((n) => !GH_LESS_FRONT.includes(n))
        .filter((n) => !new RegExp(`function ${toHn(n)}\\s*\\(`).test(html));
    check(goFront.size >= 25, `функций go* во фронте найдено ${goFront.size} (парсер жив)`);
    check(missFront.length === 0,
        `на каждую функцию go* есть hn*${missFront.length ? ' — нет: ' + missFront.map(toHn).join(', ') : ''}`);

    check(/NEWAPI_RERENDER = \{[^}]*hn: \(\) => renderHn\(\)/.test(html),
        'NEWAPI_RERENDER: hn → renderHn (иначе фильтр и сортировка вкладку не перерисуют)');
    check(/for \(const p of \[[^\]]*'hn'[^\]]*\]\)/.test(html),
        "общий цикл по вкладкам-пулам включает 'hn' (фильтр/сортировка/сохранение режима)");
    check(/\['hcnsec',\s+\(\) => loadHnSessionsLight\(\)\]/.test(html),
        'NAV_COUNT_JOBS: счётчик в сайдбаре считает hcnsec на boot');

    // Дубль id — самая тихая поломка фронта: getElementById возьмёт первый, и вторая
    // половина вкладки перестанет обновляться без единой ошибки в консоли.
    const hnIds = idCounts(html, 'hn');
    const dup = [...hnIds].filter(([, n]) => n > 1).map(([id]) => id);
    check(hnIds.size > 0, `id вида hn-* в разметке: ${hnIds.size}`);
    check(dup.length === 0, `ни один hn-* id не дублируется${dup.length ? ' — дубли: ' + dup.join(', ') : ''}`);

    // Полнота копии по id, в ОБЕ стороны. Обратная сторона важна не меньше прямой:
    // лишний id — это либо чужой скопированный узел, либо GH-обвязка, которой тут не место.
    const goIds = new Set(idCounts(html, 'go').keys());
    const hnBare = new Set([...hnIds.keys()].map((id) => id.replace(/^hn-/, '')));
    const goBare = new Set([...goIds].map((id) => id.replace(/^go-/, '')));
    const missIds = [...goBare].filter((x) => !hnBare.has(x) && !GH_LESS_IDS.includes(x));
    const extraIds = [...hnBare].filter((x) => !goBare.has(x) && !HN_ONLY_IDS.includes(x));
    check(missIds.length === 0,
        `на каждый go-* элемент есть hn-* (${goIds.size} шт. у go)${missIds.length ? ' — нет: hn-' + missIds.join(', hn-') : ''}`);
    check(extraIds.length === 0,
        `лишних hn-* элементов нет${extraIds.length ? ' — у go нет пары: hn-' + extraIds.join(', hn-') : ''}`);
    for (const id of HN_ONLY_IDS) {
        check(hnBare.has(id), `hn-${id} на месте — вход в панель email+пароль, без поля пароля аккаунт не заведётся`);
    }

    // 🪤 Ни одного go/kk/jw/hc-имени внутри блока HCNSEC. Ровно этот баг 24.08 уцелел в
    // ШЕСТИ местах и не дал ни одной ошибки в консоли: новая вкладка исправно
    // перерисовывала таблицу соседа. Конец блока ищем по СЛЕДУЮЩЕМУ разделителю, а не по
    // имени соседа: порядок блоков в файле не зафиксирован.
    const jsStart = html.indexOf('// ═══════════════════ HCNSEC');
    const jsEnd = jsStart >= 0 ? html.indexOf('// ═══════════════════ ', jsStart + 24) : -1;
    const jsBlock = jsStart >= 0 ? html.slice(jsStart, jsEnd > jsStart ? jsEnd : html.length) : '';
    check(!!jsBlock, 'JS-блок HCNSEC найден по заголовку-разделителю');
    const strays = [...jsBlock.matchAll(/\b(renderGo[A-Za-z]*|loadGo[A-Za-z]*|go[A-Z][A-Za-z]*|renderKk[A-Za-z]*|loadKk[A-Za-z]*|kk[A-Z][A-Za-z]*|renderJw[A-Za-z]*|loadJw[A-Za-z]*|jw[A-Z][A-Za-z]*)\b/g)].map((m) => m[1]);
    const strayLit = [...jsBlock.matchAll(/('go'|'kk'|'jw'|'hc'|\bgo-[a-z]|\bkk-[a-z]|\bhc-[a-z])/g)].map((m) => m[1]);
    check(strays.length === 0 && strayLit.length === 0,
        `в JS-блоке HCNsec нет обращений к go/kk/jw/hc${strays.length || strayLit.length ? ' — найдено: ' + [...new Set([...strays, ...strayLit])].join(', ') : ''}`);

    // То же по разметке: скопированный чужой id виден только так — глобальная проверка
    // дублей его не поймает, если у соседа этот id единственный, а тут он третий.
    const mkStart = html.indexOf('<!-- ═════════ TAB: HCNSEC');
    const mkEnd = mkStart >= 0 ? html.indexOf('<!-- ═════════ TAB:', mkStart + 20) : -1;
    const mkBlock = mkStart >= 0 ? html.slice(mkStart, mkEnd > mkStart ? mkEnd : html.length) : '';
    check(!!mkBlock, 'разметка вкладки найдена по комментарию «TAB: HCNSEC»');
    const mkStray = [...mkBlock.matchAll(/id="((?:go|kk|jw|sk|ts|tb|xp|ar|hc)-[a-z0-9-]+)"/g)].map((m) => m[1]);
    check(mkStray.length === 0,
        `в разметке вкладки нет чужих id${mkStray.length ? ' — найдено: ' + [...new Set(mkStray)].join(', ') : ''}`);
}

// ── 6. Обвязка снаружи двух главных файлов ────────────────────────────────────
// Здесь живут самые тихие пропуски: вкладка полностью работает, но keepalive не гаснет
// по `hub stop`, вотчдог не слышит падения пула, статуслайн пишет «Custom🧪», а
// keepalive-restart.ps1 поднимает прокси без апстрима.
section('обвязка · GW_BY_HOST, lifecycle, вотчдог, ps1, HOST_AUTH, hub-balance, статуслайн, .gitignore');
{
    const H = HOST.replace(/\./g, '\\.');

    if (!keepalive) {
        check(false, 'routing/keepalive-proxy.js не читается');
    } else {
        check(new RegExp(`'${H}': 'hn'`).test(keepalive),
            `GW_BY_HOST: '${HOST}' → 'hn' · ключ С ПОДДОМЕНОМ, без строки авторотация молча выключена`);
    }

    const life = read(path.join(REPO, 'routing', 'lifecycle.js')) || '';
    check(new RegExp(`port: ${HN_PORT}, name: 'HCNsec keepalive'`).test(life),
        `lifecycle.js знает про :${HN_PORT} — иначе stop оставит прокси висеть`);

    const watchdog = read(path.join(REPO, 'routing', 'pool-watchdog.js')) || '';
    check(/backend: 'hcnsec'/.test(watchdog),
        'вотчдог пулов опрашивает hcnsec — шлюз живой, его падение должно быть слышно');

    const ps1 = read(path.join(REPO, 'routing', 'keepalive-restart.ps1')) || '';
    const ps1Block = (new RegExp(`${HN_PORT} = @\\{[\\s\\S]{0,400}?\\}`).exec(ps1) || [''])[0];
    check(new RegExp(`UPSTREAM = 'https://${H}';`).test(ps1Block) && /hcnsec-active-key\.txt/.test(ps1Block),
        `keepalive-restart.ps1: :${HN_PORT} → UPSTREAM https://${HOST} (БЕЗ /v1) и hcnsec-active-key.txt`);
    check(/hcnsec-modelmap\.json/.test(ps1Block),
        'keepalive-restart.ps1: MODELMAP_FILE = hcnsec-modelmap.json — иначе поднятый руками прокси игнорит тир-карту');

    // HOST_AUTH — таблица «какой схемой логина держится панель». Точный остаток читается
    // куками профиля через /api/user/self, и промах по схеме молчаливый: на classic-ветке
    // код ищет куку `session`, у jwt-сборки её нет, и баланс тихо падает в прикидку.
    // Значение не фиксируем (живым входом схема не подтверждена), но строка обязана быть.
    const acct = read(path.join(REPO, 'routing', 'lib', 'newapi-account.js')) || '';
    const authRow = (new RegExp(`'${H}': '(classic|jwt)'`).exec(acct) || [])[1];
    check(!!authRow, `HOST_AUTH: '${HOST}' → ${authRow || '(строки нет)'} · без записи баланс уедет в ветку по умолчанию`);

    const hubBal = read(path.join(REPO, 'internal', 'hub-balance.js')) || '';
    check(/id: 'hn',\s*file: 'hcnsec-sessions\.json',\s*name: 'HCNsec'/.test(hubBal),
        "hub-balance POOLS: { id: 'hn', file: 'hcnsec-sessions.json', name: 'HCNsec' } — иначе шлюза нет в «ЗАПАС» шапки hub.js");

    // Статуслайн определяет провайдера тремя путями (ключ, порт, хост) и лишь потом
    // рисует шкалу. 🪤 Пара строк про :20162 обязана стоять ВЫШЕ catch-all
    // `*localhost:201[6-9][0-9]*`, иначе шлюз показывается как `Custom🧪`.
    const sl = read(path.join(REPO, 'routing', 'statusline-autoreger.sh')) || '';
    check(/\*hcnsec-active-key\.txt\*\)\s*raw_target="hcnsec"/.test(sl), 'статуслайн: hcnsec-active-key.txt → hcnsec');
    const slPortIdx = sl.indexOf(`*localhost:${HN_PORT}*`);
    // 🪤 Индекс catch-all ищем на строке с `raw_target="custom"`, а не по самому шаблону:
    // тот же шаблон стоит в комментарии-предупреждении ВЫШЕ порта, и поиск по строке
    // находил комментарий — проверка падала на исправном файле.
    const slCatchIdx = sl.split('\n').reduce((acc, l, i, arr) => {
        if (acc >= 0) return acc;
        return /raw_target="custom"/.test(l) && /localhost:201/.test(l) ? arr.slice(0, i).join('\n').length : -1;
    }, -1);
    check(slPortIdx > 0 && sl.includes(`*127.0.0.1:${HN_PORT}*`) && (slCatchIdx < 0 || slPortIdx < slCatchIdx),
        `статуслайн: :${HN_PORT} (localhost и 127.0.0.1) распознаётся ВЫШЕ catch-all Custom-конвертеров`);
    check(new RegExp(`\\*${H}\\*\\)\\s*raw_target="hcnsec"`).test(sl), `статуслайн: хост ${HOST} → hcnsec`);
    check(/hcnsec\)\s*provider="hcnsec"/.test(sl), 'статуслайн: raw_target hcnsec → provider hcnsec (иначе в строке будет сырой тег)');
    check(/hcnsec-sessions\.json"\s+"\$PROF\/\.claude\/hcnsec-active-key\.txt"\s+"hn\/balance"/.test(sl),
        'статуслайн: шкала берёт кеш hcnsec-sessions.json и ручку hn/balance');
    const slAgg = sl.split('\n').find((l) => /agentrouter\|tabi\|gorouter/.test(l)) || '';
    check(/hcnsec/.test(slAgg), `статуслайн: hcnsec в общем списке провайдеров с кешем баланса${slAgg ? '' : ' (строку не нашёл)'}`);

    if (!ignore) {
        check(false, '.gitignore не читается');
    } else {
        // gh-sessions/ тут НЕТ намеренно: GitHub-пула у шлюза нет, каталог не создаётся.
        for (const p of ['hcnsec/profiles/', 'hcnsec/sessions/', 'routing/hcnsec-sessions.json']) {
            check(new RegExp(`^${p.replace(/[./]/g, '\\$&')}$`, 'm').test(ignore), `закрыт ${p}`);
        }
    }
}

// ── 6b. hcnsec/open-session.js: вход и каталоги ───────────────────────────────
section('hcnsec/open-session.js · вход и каталоги');
if (!openjs) {
    check(false, 'hcnsec/open-session.js не читается — открыть панель для входа руками нечем');
} else {
    check(new RegExp(`https://${HOST.replace(/\./g, '\\.')}`).test(openjs), `адреса ведут на ${HOST}`);
    // Каталоги профиля и снимков сессии — свои. Пула (`*-sessions.json`) этот скрипт не
    // трогает НАМЕРЕННО: у соседей его туда тянет gh-live-capture, а тут его нет.
    check(/const PROFILES_DIR = path\.join\(__dirname, 'profiles'\)/.test(openjs),
        'PROFILES_DIR = hcnsec/profiles — иначе вход руками осядет в чужом профиле');
    check(/const SESSIONS_DIR = path\.join\(__dirname, 'sessions'\)/.test(openjs),
        'SESSIONS_DIR = hcnsec/sessions — иначе снимок сессии уедет в чужой каталог');
    check(fs.existsSync(path.join(REPO, 'hcnsec', 'share-session.js')),
        'hcnsec/share-session.js на месте — иначе кнопка 🔗 «Поделиться» позовёт несуществующий скрипт');
    // Регистрация идёт по РЕФ-ССЫЛКЕ и с почтой под рукой — два свойства, каждое из
    // которых ломается молча. Литерал вместо ref-codes = потерянный реф-кредит; отсутствие
    // второй вкладки = уход за кодом в другой браузер посреди регистрации.
    check(/require\('\.\.\/routing\/lib\/ref-codes\.js'\)\.url\('hcnsec'\)/.test(openjs),
        'REGISTER_URL берётся из ref-codes.url(hcnsec) — не литералом, иначе правка кода в настройках не доедет');
    check(/localStorage\.getItem\('aff'\)/.test(openjs),
        'openRegister проверяет, что aff осел в localStorage — одного захода панели не хватает');
    check(/async function openMailTab\s*\(/.test(openjs) && /await openMailTab\(context\)/.test(openjs),
        'openMailTab объявлен и вызван — почта привязанного ящика открывается второй вкладкой');
    check(/HN_OL_EMAIL/.test(openjs) && /HN_OL_SNAPSHOT/.test(openjs),
        'ящик приезжает переменными среды HN_OL_EMAIL / HN_OL_SNAPSHOT, а не argv');
    check(/HN_OL_EMAIL: String\(olBox\.email/.test(proxy) && /HN_OL_SNAPSHOT: olSessionFile\(olBox\.id\)/.test(proxy),
        'сервер отдаёт скрипту адрес ящика и путь снимка — искать их скрипту неоткуда, пул закрыт');
    check(/MAIL_HOSTS/.test(openjs),
        'в профиль шлюза подкладываются ТОЛЬКО почтовые куки — чужая сессия панели её бы перетёрла');
}

// ── 7. Тир-карта: живое знание о каталоге ─────────────────────────────────────
// 🪤 Каталог шлюза — 13 моделей, годны пять (живая проба 31.08 по методике трёх
// запросов). Негодные не отдают ошибку, поэтому промах в тир-карте выглядит как
// «модель тупит», а не как поломка: `DeepSeek-V4-Pro` подменяет модель на
// `nvidia/nemotron-3-ultra-550b-a55b`, как только в запросе есть `tools`;
// `glm-4.5-air` отдаёт ошибку апстрима под кодом 200; `auto` стримит без
// `message_stop`; `Qwen3.8-27B` не парсит инструменты; `sensenova-6.8-flash-lite`
// держит зашитую личность; `MiniMax-M3` думает 22–60 с; `sensenova-u1.5-lite` — 404.
section('тир-карта · routing/hcnsec-modelmap.json');
{
    const OK_MODELS = ['kimi-k3', 'step-3.7-flash', 'step-explore', 'kat-coder-pro-v2.5', 'step-router-v1'];
    const BAD_MODELS = {
        'DeepSeek-V4-Pro': 'подменяет модель на nvidia/nemotron-3-ultra-550b-a55b при наличии tools',
        'DeepSeek-V4-Flash': 'то же семейство подмены',
        'glm-4.5-air': 'ошибка апстрима под кодом 200',
        'sensenova-u1.5-lite': '404',
        'auto': 'стрим без message_stop',
        'MiniMax-M3': '22–60 с на ответ',
        'Qwen3.8-27B': 'инструменты не парсятся',
        'sensenova-6.8-flash-lite': 'личность зашита в модель',
    };
    const MM = path.join(REPO, 'routing', 'hcnsec-modelmap.json');
    check(fs.existsSync(MM), 'routing/hcnsec-modelmap.json существует (keepalive читает его по mtime; без файла тир-карта пустая)');
    let mm = null;
    try { mm = JSON.parse(fs.readFileSync(MM, 'utf8')); } catch {}
    check(!!mm, 'hcnsec-modelmap.json читается как JSON');

    const vals = [];
    for (const tier of ['opus', 'sonnet', 'haiku']) {
        const v = mm ? String(mm[tier] || '') : '';
        vals.push([tier, v]);
        // Пустой тир — не «просто не настроено»: запрос такого тира падает БЕЗ РЕТРАЯ,
        // и сабагент умирает молча.
        check(!!v, `тир ${tier} заполнен — пустой тир роняет запрос без ретрая`);
        check(OK_MODELS.includes(v), `тир ${tier} → ${v || '(пусто)'} из белого списка годных (${OK_MODELS.join(', ')})`);
        // 🪤 Имя тира внутри имени модели ломает резолв: TIER_RE в keepalive определяет
        // тир по словам opus/sonnet/haiku, и на эхо-подмене они спутаются.
        check(!/(opus|sonnet|haiku)/i.test(v), `тир ${tier}: в имени модели нет opus/sonnet/haiku (иначе TIER_RE спутается на эхо-подмене)`);
    }
    const bad = vals.filter(([, v]) => Object.keys(BAD_MODELS).some((b) => b.toLowerCase() === v.toLowerCase()));
    check(bad.length === 0,
        `в тирах нет заведомо негодных моделей${bad.length ? ' — ' + bad.map(([t, v]) => `${t}: ${v} (${BAD_MODELS[Object.keys(BAD_MODELS).find((b) => b.toLowerCase() === v.toLowerCase())]})`).join('; ') : ''}`);

    // Тир-карту пишет ДАШБОРД через POST /__switch/api/hn/modelmap, а не человек файлом:
    // keepalive перечитывает файл по mtime, и правка мимо ручки разъезжается с UI.
    check(routeSet(proxy, 'hn').has('modelmap'), 'роут /hn/modelmap есть — тир-карту меняет дашборд, а не правка файла руками');
}

// ── 8. Коллизии: порт и короткий тег ──────────────────────────────────────────
section(`коллизии · порт ${HN_PORT}, тег hn и путаница с hc (HelpCoder)`);
{
    // Порты собираем в двух формах: числом (go/tb/xp/jw/sk/kk) и через env с дефолтом
    // (ts/hn) — иначе парсер «не видит» порт, и занятый соседом читается как свободный.
    const ports = Array.from(
        proxy.matchAll(/^const ([A-Z]{2})_KEEPALIVE_PORT = (?:Number\(process\.env\.[A-Z_]+ \|\| )?(\d+)/gm),
        (m) => [m[1], Number(m[2])],
    );
    const onPort = ports.filter(([, p]) => p === HN_PORT).map(([t]) => t);
    check(onPort.length === 1 && onPort[0] === 'HN',
        `порт ${HN_PORT} занят только HCNsec (нашлось: ${onPort.join(', ') || 'никем'})`);
    check(new Set(ports.map(([, p]) => p)).size === ports.length,
        `порты keepalive не пересекаются (${ports.map(([t, p]) => t + ':' + p).join(' ')})`);

    const others = (proxy.match(new RegExp(`http://localhost:${HN_PORT}`, 'g')) || []).length;
    check(others === 1, `на :${HN_PORT} смотрит ровно один backend (нашлось ${others})`);

    // Тег `hn` не должен вести к чужим функциям ни в одном реестре.
    const wrong = Array.from(proxy.matchAll(/\bhn: \(\)?[^,}\n]*/g))
        .map((m) => m[0])
        .filter((s) => /\b(ar|go|tb|xp|jw|sk|ts|kk)(Load|Save|Balance)/.test(s));
    check(wrong.length === 0, `тег hn нигде не подцеплен к чужим функциям${wrong.length ? ' — ' + wrong.join(' | ') : ''}`);

    // 🪤 `hn` рядом с `hc`: HelpCoder — отдельный шлюз (helpcoder.cc, HC_*, id hc-*), и
    // две буквы отличаются одной. Промах читался бы как «HCNsec работает, но ключи чужие».
    check(/const HC_BASE_URL = 'https:\/\/helpcoder\.cc'/.test(proxy),
        "HC_BASE_URL остался 'https://helpcoder.cc' — HelpCoder не задет правкой HCNsec");
    const hcConsts = (proxy.match(/^const HC_[A-Z0-9_]+ = .+$/gm) || []).filter((l) => /hcnsec/i.test(l));
    check(hcConsts.length === 0, `ни одна HC_*-константа не указывает на hcnsec${hcConsts.length ? ' — ' + hcConsts.join(' | ') : ''}`);
}

// ── 9. Отсутствие лишнего: каждое ослабление проверено НА ОТСУТСТВИЕ ──────────
// Ослабление без такой проверки — это дырка: множества сходятся, а «дополнить копию до
// GoRouter» никто не остановит. Здесь ровно те элементы, которые вычтены выше.
section('отсутствие лишнего · GitHub-пул, выдача, рефка, плоский тариф');
{
    // Выдачи нет: путь TrueSOTA. Прикидка гранта врала бы в обе стороны, а на завышенной
    // авторотация выбирает пустой аккаунт и молча остаётся без ключа.
    const hnNames = names(proxy, /^const HN_([A-Z0-9_]+) = /gm);
    for (const n of GRANT_LESS) {
        check(!hnNames.has(n), `HN_${n} НЕТ — бонуса при регистрации шлюз не заявляет, прикидка остатка запрещена`);
    }

    // GitHub-пула нет: `github_oauth=false` в GET /api/status (живая проба 31.08).
    const hnH = names(proxy, /function handleHn([A-Za-z0-9]+)\s*\(/g);
    for (const n of MAP_ONLY_GH) {
        check(!hnH.has(n), `handleHn${n} НЕТ — GitHub-входа у шлюза нет, хендлер был бы мёртвым кодом`);
    }
    const hnRoutes = routeSet(proxy, 'hn');
    for (const r of MAP_ONLY_GH_ROUTES) {
        check(!hnRoutes.has(r), `роута /hn/${r} НЕТ — вход только email+пароль`);
    }
    // Сопоставление профилей — согласованность четырёх точек (разбор у MAP_ONLY_GH выше).
    const mapPts = {
        'роут /hn/map-profiles': hnRoutes.has('map-profiles'),
        'handleHnMapProfiles': hnH.has('MapProfiles'),
        'функция hnMapProfiles() во фронте': /function hnMapProfiles\s*\(/.test(html),
        'кнопка 🔗 Профили в тулбаре': /onclick="hnMapProfiles\(\)"/.test(html),
    };
    const on = Object.entries(mapPts).filter(([, v]) => v).map(([k]) => k);
    const off = Object.entries(mapPts).filter(([, v]) => !v).map(([k]) => k);
    check(on.length === 0 || off.length === 0,
        `сопоставление профилей согласовано — либо все четыре точки, либо ни одной${on.length && off.length ? ` · есть: ${on.join(', ')} · нет: ${off.join(', ')}` : (on.length ? ' (есть везде)' : ' (нет нигде)')}`);

    for (const reg of ['GH_POOL_LOADERS', 'GH_POOL_FILES', 'GH_POOL_SAVERS', 'GH_POOL_LABELS']) {
        const line = (new RegExp(`^const ${reg} = .+$`, 'm').exec(proxy) || [''])[0];
        check(!/\bhn:/.test(line), `${reg}: ключа hn НЕТ — иначе менеджер гитхабов покажет пул, которого не существует`);
    }
    const lkLine = proxy.split('\n').find((l) => /return \{ github: ghLkPids/.test(l)) || '';
    check(!!lkLine && !/\bhn:/.test(lkLine),
        `ghLkPidsByTag: ключа hn НЕТ${lkLine ? '' : ' (строку не нашёл — проверять нечего)'}`);

    // Фронт: три GH-реестра и подсказка под полем email.
    check(!/id="hn-add-gh-hint"/.test(html),
        'hn-add-gh-hint НЕТ — строка «🐙 в менеджере такого нет» на шлюзе без GitHub-входа только путает');
    for (const reg of GH_LESS_FRONT_REGS) {
        const src = (new RegExp(`const ${reg} = \\{[\\s\\S]*?\\n\\};`).exec(html) || new RegExp(`^const ${reg} = .+$`, 'm').exec(html) || [''])[0];
        check(!!src && !/\bhn:/.test(src), `${reg}: ключа hn НЕТ${src ? '' : ` (реестр ${reg} не нашёл)`}`);
    }

    // Рефка ЕСТЬ с 31.08 — владелец принёс код из кабинета уже после того, как вкладку
    // собрали. 🪤 Порядок обратный обычному, поэтому проверок больше, чем у соседей:
    // прежняя версия этого файла утверждала «hcnsec НЕ в ref-codes», и такой чекер
    // защищал бы ровно ту ошибку, из-за которой реф-кредит уходит молча.
    let rc = null;
    try { rc = require(path.join(REPO, 'routing', 'lib', 'ref-codes.js')); } catch { /* ниже */ }
    check(!!rc, 'routing/lib/ref-codes.js загружается');
    check(rc && rc.PROVIDERS.includes('hcnsec'), 'hcnsec в PROVIDERS ref-codes — реф-код владельца есть');
    check(rc && rc.ACTIVE_PROVIDERS.includes('hcnsec'), 'hcnsec в ACTIVE_PROVIDERS — строка настройки рефки видна в UI');
    check(rc && rc.SHAPES.hcnsec && rc.SHAPES.hcnsec.path === '/sign-up?aff=',
        'форма регистрации hcnsec — /sign-up?aff= (New API)');
    check(rc && rc.SHAPES.hcnsec && rc.SHAPES.hcnsec.host === 'api.hcnsec.cn',
        'хост рефки — api.hcnsec.cn');
    check(rc && /^https:\/\/api\.hcnsec\.cn\/sign-up\?aff=.+/.test(String(rc.url('hcnsec'))),
        'url(hcnsec) отдаёт ссылку с непустым aff', rc ? String(rc.url('hcnsec')) : '');
    // Ссылка обязана резолвиться модулем, а не литералом: иначе правка кода в «Настройках»
    // не доедет до регистрации, и человек будет думать, что настроил рефку.
    const refReq = !!openjs && /require\(['"][^'"]*ref-codes[^'"]*['"]\)/.test(openjs);
    check(refReq, 'hcnsec/open-session.js берёт ссылку из ref-codes, а не литералом');
    check(!!openjs && /\.url\(['"]hcnsec['"]\)/.test(openjs), "open-session.js зовёт url('hcnsec')");
    check(!openjs || !/['"]https:\/\/api\.hcnsec\.cn\/sign-up/.test(openjs),
        'литеральной ссылки на регистрацию в open-session.js больше нет');
    // Одного захода по реф-ссылке мало: код оседает в localStorage `aff`, и на свежем
    // профиле не с первого раза. Без проверки регистрация уходит без реф-кредита молча.
    check(!!openjs && /localStorage\.getItem\('aff'\)/.test(openjs),
        'open-session.js проверяет, осел ли реф-код в localStorage `aff`');
    // gh-live-capture — часть GitHub-механики: снимать GitHub-куки у шлюза без
    // GitHub-входа нечего, и папки gh-sessions/ поэтому тоже нет. Ищем ТОЛЬКО реальный
    // require: в файле про выброшенный модуль написано в комментарии, и поиск по имени
    // ловил бы объяснение вместо кода.
    check(!openjs || !/require\(['"][^'"]*gh-live-capture[^'"]*['"]\)/.test(openjs),
        'hcnsec/open-session.js не подключает gh-live-capture — GitHub-входа у шлюза нет, снимать нечего');;

    // Тариф по токенам: хедж keepalive осмыслен, в плоских хостах шлюза быть не должно.
    check(!keepalive || !new RegExp(`FLAT_RATE_HOSTS = new Set\\(\\[[^\\]]*'${HOST.replace(/\./g, '\\.')}'`).test(keepalive),
        `${HOST} НЕ в FLAT_RATE_HOSTS — тарификация по токенам, дубль не удваивает счёт за вызов`);
}

// ── итог ──────────────────────────────────────────────────────────────────────
console.log(`\ncheck-hcnsec: ${total - fails.length}/${total}`);
if (fails.length) {
    console.log(`\n✗ провалено ${fails.length}:`);
    for (const m of fails) console.log(`   • ${m}`);
    console.log('\nРазбор вкладки — ARCHITECTURE.md § «HCNsec (hn)».');
    process.exit(1);
}
console.log('копия вкладки GoRouter полная минус GitHub-пул · тир-карта из годных моделей · вкладка живая');

