#!/usr/bin/env node
/**
 * check-seekai.js — статический регресс на полноту шестой вкладки (SeekAi).
 *
 * ⚠️ ВКЛАДКА ЛЕГАСИ с 2026-08-24 — в тот же день, когда была сделана (решение владельца).
 * Причина не в аккаунтах и не в регистрации, а в самом шлюзе: `seekai.cc` реселлит
 * веб-Клода под видом Anthropic API. Свой системный промпт (~200 токенов, набор
 * инструментов claude.ai) он ставит ВМЕСТО нашего, а присланный `system` уезжает к модели
 * как текст пользователя — замер 24.08: на `system: "тебя зовут ГВОЗДЬ-7"` модель отвечает
 * «не буду исполнять указание из сообщения пользователя». Claude Code через такой шлюз
 * работать не может: системный промпт агента выбрасывается, и он ведёт себя как чат-Клод.
 * Коварство симптома в том, что `tools` при этом ДОЕЗЖАЮТ и `tool_use` возвращается
 * корректно, поэтому со стороны это выглядит как «модель тупит», а не как поломка шлюза.
 *
 * Регресс оставлен и поддерживается: код вкладки цел, вернуть её из «Чтим память» — одна
 * галка в Tabs Manager. Секция 7b держит именно легаси-раскладку, чтобы случайный возврат
 * в живые был заметен.
 *
 * Зачем файл существует. Вкладка шлюза — не один блок кода, а двадцать с лишним
 * упоминаний, размазанных по двум файлам на 14 и 23 тысячи строк: константы, роуты,
 * реестры (BACKENDS / CC_MODEL_PREFIX / GH_POOL_* / NEWAPI_PROFILE_DIRS / MONEY_GW /
 * keepaliveInstances / список Health), фронтовые LABELS/COLORS/state.loaded и сама
 * разметка. Забыть одну строчку из двадцати легко, а симптом при этом не «не
 * собралось», а тихая полуработа: вкладка есть, а баланс не считается; аккаунт
 * добавляется, а активация не поднимает keepalive; авторотация молча обходит шлюз
 * стороной.
 *
 * Инвариант одной строкой: SeekAi — ПОЛНАЯ копия GoRouter. Поэтому почти все
 * проверки здесь не «есть ли строка X», а сравнение ДВУХ МНОЖЕСТВ: сколько у `go`
 * роутов/хендлеров/хелперов/id — столько же обязано быть у `sk`. Такая проверка
 * переживает переименования и ловит то, чего в спецификации не было.
 *
 * Сети нет, дашборд запускать не нужно, файлы только читаются. `:8200` не задет.
 *
 * Запуск: node tools/check-seekai.js      (exit 1 = копия неполная)
 *
 * 🪤 Три факта провайдера, которые проверяются ЯВНО, потому что стоят денег:
 *   • база для Claude Code — КОРЕНЬ, без `/v1`: `POST /v1/v1/messages` отдаёт 404
 *     (`Invalid URL`, замер 24.08). `/v1` нужен только листингу моделей — SK_BASE_URL.
 *   • реф-ссылка приходит из `routing/lib/ref-codes.js`, а не литералом: код владельца
 *     лежит дефолтом в `routing/ref-codes.default.json` (`prEx`), пользователь форка
 *     вписывает свой через 💩 в «Настройках». Полный набор инвариантов этой точки —
 *     `tools/check-ref-codes.js`.
 *   • `seekai.cc` обязан быть в `FLAT_RATE_HOSTS` keepalive-прокси: шлюз берёт почти
 *     фиксированную плату за вызов (замер 24.08: 3.38¢ и 3.16¢ за ~211 токенов), и
 *     включённый хедж удвоил бы счёт, ничего не ускорив.
 *
 * Авто-заведения (⚡, как у JustWoker) у вкладки НЕТ намеренно: у панели включены
 * turnstile и подтверждение почты, сценарий без человека не гарантирован. Поэтому
 * множества роутов sk и go сравниваются в ОБЕ стороны без исключений.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PROXY = path.join(REPO, 'routing', 'transparent-proxy.js');
const HTML = path.join(REPO, 'routing', 'proxy-dashboard.html');
const KEEPALIVE = path.join(REPO, 'routing', 'keepalive-proxy.js');
const OPENJS = path.join(REPO, 'seekai', 'open-session.js');
const IGNORE = path.join(REPO, '.gitignore');

const SK_PORT = 20159;

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

console.log('== check-seekai: SeekAi (sk) как полная копия GoRouter (go) ==');

// ── 1. transparent-proxy.js: константы ────────────────────────────────────────
section('routing/transparent-proxy.js · константы SK_*');
{
    const val = (n) => constExpr(proxy, n);
    const has = (n, needle, why) => {
        const v = val(n);
        check(!!v && v.includes(needle), `${n} → ${needle}${v ? '' : ' (константы нет)'}${v && !v.includes(needle) ? ` — получено ${v} · ${why}` : ''}`);
    };

    has('SK_SESSIONS_FILE', "'seekai-sessions.json'", 'пул уедет не в свой файл');
    has('SK_ACTIVE_KEY_FILE', "'seekai-active-key.txt'", 'keepalive прочитает чужой ключ');
    has('SK_ACTIVE_MODEL_FILE', "'seekai-active-model.txt'", 'модель шлюза потеряется');
    has('SK_MODELMAP_FILE', "'seekai-modelmap.json'", 'тир-карта разъедется с keepalive');
    has('SK_SESSIONS_DIR', "'seekai', 'sessions'", 'импорт/шара сохранит state не туда');
    has('SK_SHARE_SCRIPT', "'seekai', 'share-session.js'", 'кнопка 🔗 позовёт несуществующий скрипт');

    // База Claude Code и база листинга моделей — РАЗНЫЕ, и это главная ловушка шлюза.
    const eq = (n, want, why) => {
        const got = val(n);
        check(got === want, `${n} = ${want} · ${why}${got === want ? '' : ` — получено ${got}`}`);
    };
    eq('SK_BASE_URL', "'https://seekai.cc/v1'", 'листинг моделей ходит С /v1');
    eq('SK_UPSTREAM', "'https://seekai.cc'", 'корень БЕЗ /v1: /v1/v1/messages → 404');
    eq('SK_KEEPALIVE_PORT', String(SK_PORT), 'свой порт keepalive');
    check((val('SK_KEEPALIVE_URL') || '').includes('${SK_KEEPALIVE_PORT}'),
        'SK_KEEPALIVE_URL собирается из SK_KEEPALIVE_PORT, а не хардкодит число');

    // Полнота набора: у GO_* и SK_* обязаны совпадать суффиксы. Ловит константу,
    // о которой в спецификации не было ни слова.
    const goNames = names(proxy, /^const GO_([A-Z0-9_]+) = /gm);
    const skNames = names(proxy, /^const SK_([A-Z0-9_]+) = /gm);
    const miss = lack(goNames, skNames);
    check(miss.length === 0,
        `на каждую GO_* есть SK_* (${goNames.size} шт.)${miss.length ? ' — не хватает: SK_' + miss.join(', SK_') : ''}`);
}

// ── 2. transparent-proxy.js: хендлеры и хелперы ───────────────────────────────
section('routing/transparent-proxy.js · хендлеры и хелперы');
{
    const goH = names(proxy, /function handleGo([A-Za-z0-9]+)\s*\(/g);
    const skH = names(proxy, /function handleSk([A-Za-z0-9]+)\s*\(/g);
    const missH = lack(goH, skH);
    check(missH.length === 0,
        `handleSk* повторяет handleGo* (${goH.size} шт.)${missH.length ? ' — нет: handleSk' + missH.join(', handleSk') : ''}`);

    const goF = names(proxy, /function go([A-Za-z0-9]+)\s*\(/g);
    const skF = names(proxy, /function sk([A-Za-z0-9]+)\s*\(/g);
    const missF = lack(goF, skF);
    check(missF.length === 0,
        `хелперы sk* повторяют go* (${goF.size} шт.)${missF.length ? ' — нет: sk' + missF.join(', sk') : ''}`);

    check(new RegExp(`const keepaliveSk = makeKeepaliveHandlers\\(Number\\(process\\.env\\.SK_KEEPALIVE_PORT \\|\\| ${SK_PORT}\\)\\)`).test(proxy),
        `keepaliveSk объявлен через makeKeepaliveHandlers(:${SK_PORT}) — иначе карточка keepalive на вкладке пустая`);
}

// ── 3. Роуты: ключевой инвариант ──────────────────────────────────────────────
section('routing/transparent-proxy.js · роуты /__switch/api/{go,sk}/*');
{
    const go = routeSet(proxy, 'go');
    const sk = routeSet(proxy, 'sk');
    check(go.size >= 20, `роутов go найдено ${go.size} (парсер жив)`);
    const miss = lack(go, sk);
    const extra = lack(sk, go);
    check(miss.length === 0,
        `парных sk-роутов ${sk.size} из ${go.size}${miss.length ? ' — не хватает: ' + miss.map((r) => '/sk/' + r).join(' ') : ''}`);
    // У SeekAi авто-заведения нет, поэтому лишних роутов быть не должно вовсе.
    check(extra.length === 0,
        `лишних sk-роутов нет${extra.length ? ' — у go нет пары: ' + extra.map((r) => '/sk/' + r).join(' ') : ''}`);
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
    check(/seekai:\s*\{/.test(backends), 'BACKENDS: запись seekai есть');
    check(new RegExp(`seekai:[\\s\\S]*?base_url: 'http://localhost:${SK_PORT}'`).test(backends),
        `BACKENDS.seekai.base_url = http://localhost:${SK_PORT}`);

    const prefix = block('const CC_MODEL_PREFIX = {');
    check(/seekai: 'seekai'/.test(prefix),
        "CC_MODEL_PREFIX: seekai → 'seekai' (иначе резолв модели не найдёт active-model.txt и окно упадёт до 200k)");

    for (const reg of ['GH_POOL_LOADERS', 'GH_POOL_FILES', 'GH_POOL_SAVERS', 'GH_POOL_LABELS']) {
        const line = (new RegExp(`^const ${reg} = .+$`, 'm').exec(proxy) || [''])[0];
        check(/\bsk:/.test(line), `${reg}: ключ sk есть — иначе менеджер гитхабов не видит шестой пул`);
    }
    check(/sk: 'SeekAi'/.test(proxy), "GH_POOL_LABELS: sk → 'SeekAi'");

    const dirs = block('const NEWAPI_PROFILE_DIRS = {');
    check(/'seekai\.cc':/.test(dirs) && /seekai', 'profiles'/.test(dirs),
        "NEWAPI_PROFILE_DIRS: 'seekai.cc' → seekai/profiles (панель и API на одном домене)");

    const inst = block('function keepaliveInstances() {');
    check(/\[SK_KEEPALIVE_PORT\]:\s*\{[^}]*spawn: skKeepaliveSpawn/.test(inst),
        `keepaliveInstances: [SK_KEEPALIVE_PORT] → skKeepaliveSpawn (иначе кнопка «перезапустить» в Health не знает про :${SK_PORT})`);

    const money = block('const MONEY_GW = {');
    check(/^\s*sk:/m.test(money), 'MONEY_GW: строка sk есть — иначе авторотация обходит шлюз стороной');
    check(/sk:[^\n]*host: 'seekai\.cc'/.test(money), "MONEY_GW.sk.host = 'seekai.cc'");
    check(/sk:[^\n]*keyFile: SK_ACTIVE_KEY_FILE[^\n]*load: skLoad[^\n]*save: skSave/.test(money),
        'MONEY_GW.sk: keyFile/load/save указывают на SK-функции');
    check(/sk:[^\n]*balanceFn: skBalance[^\n]*applyFn: skApplyBalance/.test(money),
        'MONEY_GW.sk: balanceFn/applyFn на месте (без них ротация не проверит живой остаток)');

    check(new RegExp(`name: 'Keepalive SeekAi',\\s*port: Number\\(process\\.env\\.SK_KEEPALIVE_PORT \\|\\| ${SK_PORT}\\)`).test(proxy),
        `Health: сервис «Keepalive SeekAi» на :${SK_PORT} в списке checks`);
    check(/pools\.seekai\s*=/.test(proxy), 'сводка шапки (pools) считает seekai');
    check(/sk: skLkPids/.test(proxy), 'ghLkPidsByTag знает про sk — иначе харвест полезет в профиль с открытым браузером');
    check(/\(ar\|go\|tb\|xp\|jw\|sk\)/.test(proxy), 'роуты авторотации принимают тег sk');
}

// ── 5. Фронт: вкладка в дашборде ──────────────────────────────────────────────
section('routing/proxy-dashboard.html · вкладка');
{
    check(html.includes('data-tab="seekai"'), 'кнопка в сайдбаре: data-tab="seekai"');
    check(html.includes('data-tab-content="seekai"'), 'панель вкладки: data-tab-content="seekai"');

    // ЛЕГАСИ с 2026-08-24 (решение владельца): вкладка живёт в свёрнутой группе «Чтим
    // память» рядом с XPeach, а в дефолтном сайдбаре её нет. Причина — не регистрация,
    // а сам шлюз: `seekai.cc` реселлит веб-Клода и ставит СВОЙ системный промпт вместо
    // нашего (замер 24.08), поэтому Claude Code через него работать не может.
    // Проверяем именно легаси-раскладку: вернуть вкладку в живые = осознанная правка,
    // а не побочный эффект.
    const memoryGroup = (/data-extra-nav="memory"[\s\S]*?\n      <\/div>/.exec(html) || [''])[0];
    check(/data-tab="seekai"/.test(memoryGroup),
        'кнопка SeekAi лежит в группе «Чтим память» (data-extra-nav="memory")');
    const listOf = (name) => (new RegExp(`^const ${name} = .+$`, 'm').exec(html) || [''])[0];
    const tabs = listOf('DEFAULT_TABS_VISIBLE');
    check(!!tabs && !/'seekai'/.test(tabs),
        "DEFAULT_TABS_VISIBLE: 'seekai' там НЕТ — легаси-вкладка в дефолтный сайдбар не попадает (как xpeach)");
    check(/seekai:/.test(listOf('LABELS')), 'LABELS: seekai (иначе в шапке будет «unknown»)');
    check(/seekai:/.test(listOf('COLORS')), 'COLORS: seekai (без цвета плашка активного бэкенда серая)');

    const loaded = (/loaded:\s*\{[^}]*\}/.exec(html) || [''])[0];
    check(/seekai: false/.test(loaded), 'state.loaded: seekai (иначе ленивая загрузка вкладки повторяется на каждый клик)');

    const ka = (/const KEEPALIVE_API = \{[\s\S]*?\n\};/.exec(html) || [''])[0];
    check(/sk: '\/__switch\/api\/sk\/keepalive'/.test(ka), "KEEPALIVE_API: sk → '/__switch/api/sk/keepalive'");

    const mp = (/const MONEY_PROVIDERS = \{[\s\S]*?\n\};/.exec(html) || [''])[0];
    check(/seekai:\s*\{/.test(mp), 'MONEY_PROVIDERS: seekai (тумблер авторотации и тост о подмене)');
    check(/seekai:[^\n]*p: 'sk'/.test(mp), "MONEY_PROVIDERS.seekai.p = 'sk'");

    for (const fn of ['loadSkSessions', 'loadSkSessionsLight', 'renderSk']) {
        check(new RegExp(`function ${fn}\\s*\\(`).test(html), `функция ${fn}() объявлена`);
    }
    check(/NEWAPI_RERENDER = \{[^}]*sk: \(\) => renderSk\(\)/.test(html),
        'NEWAPI_RERENDER: sk → renderSk (иначе фильтр и сортировка вкладку не перерисуют)');
    check(/\['ar', 'go', 'tb', 'jw', 'sk'\]/.test(html),
        "общий цикл по New-API-вкладкам включает 'sk'");
    check(/\['seekai',\s+\(\) => loadSkSessionsLight\(\)\]/.test(html),
        'NAV_COUNT_JOBS: счётчик в сайдбаре считает seekai на boot');
    // Дубль id — самая тихая поломка фронта: getElementById возьмёт первый, и вторая
    // половина вкладки перестанет обновляться без единой ошибки в консоли.
    const skIds = idCounts(html, 'sk');
    const dup = [...skIds].filter(([, n]) => n > 1).map(([id]) => id);
    check(skIds.size > 0, `id вида sk-* в разметке: ${skIds.size}`);
    check(dup.length === 0, `ни один sk-* id не дублируется${dup.length ? ' — дубли: ' + dup.join(', ') : ''}`);

    // Полнота копии: на каждый go-* элемент есть sk-*.
    const goIds = new Set(idCounts(html, 'go').keys());
    const skHas = new Set([...skIds.keys()].map((id) => id.replace(/^sk-/, '')));
    const missIds = [...goIds].map((id) => id.replace(/^go-/, '')).filter((x) => !skHas.has(x));
    check(missIds.length === 0,
        `на каждый go-* элемент есть sk-* (${goIds.size} шт.)${missIds.length ? ' — нет: sk-' + missIds.join(', sk-') : ''}`);

    // Ни одного jw-имени внутри sk-блока: ровно так 24.08 уцелел вызов renderJw() в
    // шести местах — вкладка SeekAi перерисовывала таблицу JustWoker.
    const jsStart = html.indexOf('// ═══════════════════ SEEKAI');
    const jsEnd = html.indexOf('// ═══════════════════ TABI TOKEN');
    const jsBlock = jsStart >= 0 && jsEnd > jsStart ? html.slice(jsStart, jsEnd) : '';
    check(!!jsBlock, 'JS-блок SEEKAI найден по заголовку');
    const strays = [...jsBlock.matchAll(/\b(renderJw|loadJw[A-Za-z]*|jw[A-Z][A-Za-z]*)\b/g)].map((m) => m[1]);
    check(strays.length === 0,
        `в JS-блоке SeekAi нет вызовов jw-функций${strays.length ? ' — найдено: ' + [...new Set(strays)].join(', ') : ''}`);
}

// ── 6. seekai/open-session.js: рефка и адреса ────────────────────────────────
section('seekai/open-session.js · рефка и адреса');
if (!openjs) {
    check(false, 'seekai/open-session.js не читается — регистрация по рефке невозможна');
} else {
    check(/const REGISTER_URL = require\(['"]\.\.\/routing\/lib\/ref-codes\.js['"]\)\.url\(['"]seekai['"]\)/.test(openjs),
        'REGISTER_URL берётся из routing/lib/ref-codes.js, а не литералом');
    let refUrlOk = false;
    try {
        refUrlOk = require(path.join(REPO, 'routing', 'lib', 'ref-codes.js')).url('seekai')
            === 'https://seekai.cc/sign-up?aff=prEx';
    } catch { refUrlOk = false; }
    check(refUrlOk, "модуль без переопределения отдаёт 'https://seekai.cc/sign-up?aff=prEx' — реф-кредит владельца");
    check(/const CONSOLE_URL = 'https:\/\/seekai\.cc\//.test(openjs), 'CONSOLE_URL на seekai.cc');
    check(/const ROOT_URL = 'https:\/\/seekai\.cc\/';/.test(openjs), 'ROOT_URL на seekai.cc');
    check(/seekai-sessions\.json/.test(openjs),
        'poolFile у gh-live-capture указывает на seekai-sessions.json (иначе ручной GitHub-вход осядет в чужом пуле)');
    check(fs.existsSync(path.join(REPO, 'seekai', 'share-session.js')), 'seekai/share-session.js на месте');
}

// ── 7. keepalive-proxy.js: тариф и цель ротации ───────────────────────────────
section('routing/keepalive-proxy.js · тариф и цель ротации');
if (!keepalive) {
    check(false, 'routing/keepalive-proxy.js не читается');
} else {
    check(/FLAT_RATE_HOSTS = new Set\(\[[^\]]*'seekai\.cc'/.test(keepalive),
        'seekai.cc в FLAT_RATE_HOSTS — хедж выключен (замер 24.08: ~3.2¢ за вызов, дубль удвоил бы счёт)');
    check(/'seekai\.cc': 'sk'/.test(keepalive),
        "GW_BY_HOST: 'seekai.cc' → 'sk' (без строки авторотация молча выключена)");
}

// ── 7b. Легаси-раскладка (решение владельца 2026-08-24) ───────────────────────
// Шлюз оказался реселлом веб-Клода: свой системный промпт (~200 токенов, инструменты
// claude.ai) он ставит вместо нашего, а присланный `system` уезжает к модели как текст
// пользователя. `tools` при этом работают — потому симптом и читался как «модель тупит».
// Для Claude Code это непригодно, вкладка ушла в «Чтим память». Проверки ниже держат
// именно этот статус: случайный возврат в живые должен быть заметен.
section('легаси-статус · ref-codes и вотчдог');
{
    let rc = null;
    try { rc = require(path.join(REPO, 'routing', 'lib', 'ref-codes.js')); } catch { /* ниже */ }
    check(!!rc, 'routing/lib/ref-codes.js загружается');
    check(rc && Array.isArray(rc.ACTIVE_PROVIDERS) && !rc.ACTIVE_PROVIDERS.includes('seekai'),
        'seekai НЕ в ACTIVE_PROVIDERS — легаси, в списках для человека его нет');
    check(rc && rc.PROVIDERS.includes('seekai'),
        'seekai остался в PROVIDERS — резолв рефки нужен seekai/open-session.js');

    const watchdog = read(path.join(REPO, 'routing', 'pool-watchdog.js')) || '';
    check(!/backend: 'seekai'/.test(watchdog),
        'вотчдог пулов НЕ опрашивает seekai — тревога о шлюзе, которым не пользуются, учит игнорировать вотчдог');
}

// ── 8. .gitignore: приватное закрыто ─────────────────────────────────────────
section('.gitignore · приватные данные шлюза');
if (!ignore) {
    check(false, '.gitignore не читается');
} else {
    for (const p of ['seekai/profiles/', 'seekai/sessions/', 'seekai/gh-sessions/', 'routing/seekai-sessions.json']) {
        check(new RegExp(`^${p.replace(/[./]/g, '\\$&')}$`, 'm').test(ignore), `закрыт ${p}`);
    }
}
// ── 9. Коллизии: порт и короткий тег ─────────────────────────────────────────
section(`коллизии · порт ${SK_PORT} и тег sk`);
{
    const ports = Array.from(proxy.matchAll(/^const ([A-Z]{2})_KEEPALIVE_PORT = (\d+);/gm), (m) => [m[1], Number(m[2])]);
    const onPort = ports.filter(([, p]) => p === SK_PORT).map(([t]) => t);
    check(onPort.length === 1 && onPort[0] === 'SK',
        `порт ${SK_PORT} занят только SeekAi (нашлось: ${onPort.join(', ') || 'никем'})`);
    check(new Set(ports.map(([, p]) => p)).size === ports.length,
        `порты keepalive не пересекаются (${ports.map(([t, p]) => t + ':' + p).join(' ')})`);

    const others = (proxy.match(new RegExp(`base_url: 'http://localhost:${SK_PORT}'`, 'g')) || []).length;
    check(others === 1, `на :${SK_PORT} смотрит ровно один backend (нашлось ${others})`);

    // Тег `sk` не должен вести к чужим функциям ни в одном реестре.
    const wrong = Array.from(proxy.matchAll(/\bsk: \(\)?[^,}\n]*/g))
        .map((m) => m[0])
        .filter((s) => /\b(ar|go|tb|xp|jw)(Load|Save|Balance)/.test(s));
    check(wrong.length === 0, `тег sk нигде не подцеплен к чужим функциям${wrong.length ? ' — ' + wrong.join(' | ') : ''}`);

    check(fs.existsSync(path.join(REPO, 'routing', 'seekai-modelmap.json')),
        'routing/seekai-modelmap.json существует (keepalive читает его по mtime; без файла тир-карта пустая)');
    // lifecycle.js гасит keepalive по списку портов: забытая строка = живой прокси
    // после «остановил всё».
    const life = read(path.join(REPO, 'routing', 'lifecycle.js')) || '';
    check(new RegExp(`port: ${SK_PORT}, name: 'SeekAi keepalive'`).test(life),
        `lifecycle.js знает про :${SK_PORT} — иначе stop оставит прокси висеть`);
}

// ── итог ──────────────────────────────────────────────────────────────────────
console.log(`\ncheck-seekai: ${total - fails.length}/${total}`);
if (fails.length) {
    console.log(`\n✗ провалено ${fails.length}:`);
    for (const m of fails) console.log(`   • ${m}`);
    console.log('\nРазбор вкладки — ARCHITECTURE.md § «SeekAi (sk)».');
    process.exit(1);
}
console.log('копия вкладки GoRouter полная (статус вкладки — легаси, «Чтим память»)');

