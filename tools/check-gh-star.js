#!/usr/bin/env node
/**
 * check-gh-star.js — регресс-тест кнопки ⭐ на карточке аккаунта в менеджере гитхабов.
 *
 * Инвариант одной строкой: клик по ⭐ открывает браузер, УЖЕ залогиненный этим GitHub,
 * ровно на github.com/WormAlien/hub-cc — и адрес задаёт СЕРВЕР своей константой, а не
 * тело запроса.
 *
 * Почему файл существует. Кнопка одна, а связка под ней размазана по трём файлам
 * (карточка в дашборде → ручка :8200 → github/open-session.js), и почти каждая её
 * поломка тихая — ошибки в консоли не будет:
 *   - адрес репозитория живёт в трёх местах (константа сервера, подпись кнопки,
 *     константа тостов). Сменили в одном — ⭐ уводит не туда;
 *   - «принимать url из тела запроса» — правка на одну строку, которая ничего видимого
 *     не ломает и при этом открывает дыру: :8200 слушает 0.0.0.0 без аутентификации,
 *     то есть «открой что угодно в залогиненном GitHub владельца» становится доступной
 *     командой для любого в локальной сети;
 *   - снимок сессии вливается ТОЛЬКО в чистый профиль. Снят гейт isFreshProfile —
 *     второй клик разлогинит аккаунт, который наладил первый: в живом профиле сессия
 *     свежее кеша (`_gh_sess` GitHub ротирует, снимок живёт до 7 суток);
 *   - кнопка Star приезжает react-партиалом через 170–300 мс ПОСЛЕ domcontentloaded:
 *     чтение DOM без waitForSelector даёт «звезды нет» всегда (замер 2026-08-22);
 *   - meta[name="user-login"] у анонимной страницы ПРИСУТСТВУЕТ с пустым content:
 *     проверка на наличие тега вместо непустого значения врёт «залогинен» в 100%;
 *   - argv-контракт позиционный (argv[3] цель, argv[4] снимок) — перепутали порядок,
 *     и Chromium получит путь к JSON вместо URL;
 *   - без disabled второй клик запустит второй харвест того же аккаунта поверх первого
 *     (оба пишут один и тот же github/sessions/<ghId>.json);
 *   - hex в классах кнопки = кнопка не поедет за темой дашборда (22 темы в OKLCH).
 *
 * Проверка статическая: ни сети, ни браузера, ни запущенного дашборда — только чтение
 * трёх файлов и разбор текста. :8200 не задет, node.exe не трогается.
 *
 * Запуск:  node tools/check-gh-star.js        (exit 1 = связка порвана)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
const HTML = path.join(REPO, 'routing', 'proxy-dashboard.html');
const PROXY = path.join(REPO, 'routing', 'transparent-proxy.js');
const OPENJS = path.join(REPO, 'github', 'open-session.js');

const REPO_URL = 'https://github.com/WormAlien/hub-cc';
const REPO_SHORT = 'github.com/WormAlien/hub-cc';

const ok = [];
const fails = [];

// 🪤 CRLF нормализуем НАМЕРЕННО: transparent-proxy.js лежит в CRLF (13529 строк из
// 13530) и с BOM, два других файла — в LF. Без нормализации терминатор `\n}\n` не
// находит конец функции, «тело handleGhStar» растягивается на 8000 строк до конца
// файла, и любая проверка «есть строка X» зеленеет случайно — тогда чекер бумажный.
const read = (p) => { try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } catch { return null; } };

function section(t) { console.log(`\n── ${t} ──`); }
function check(cond, msg) {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
    (cond ? ok : fails).push(msg);
    return !!cond;
}

// Тело функции по имени: от объявления до строки, начинающейся с `}` в нулевой
// колонке. Годится потому, что во всех трёх файлах функции верхнего уровня так и
// отформатированы (проверено на 14 функциях этой связки).
function body(src, name) {
    const m = new RegExp(`\\n(?:async )?function ${name}\\s*\\(`).exec(src);
    if (!m) return null;
    const from = m.index + 1;
    const end = src.indexOf('\n}\n', from);
    return end < 0 ? src.slice(from) : src.slice(from, end + 3);
}

const html = read(HTML), proxy = read(PROXY), openjs = read(OPENJS);
if (!html || !proxy || !openjs) {
    console.log(`  FAIL не читается ${!html ? HTML : !proxy ? PROXY : OPENJS} — проверять нечего`);
    process.exit(1);
}

console.log(`== check-gh-star: ⭐ из менеджера гитхабов на ${REPO_SHORT} ==`);

// ── 1. Синтаксис: то, что тронуто, вообще исполнимо ──────────────────────────
// Дешёвая проверка, ловящая самое дорогое: сломанный шаблонный литерал гасит весь
// дашборд, а не одну кнопку, а битый transparent-proxy.js не поднимет :8200 совсем.
section('синтаксис');
{
    for (const [p, src] of [[PROXY, proxy], [OPENJS, openjs]]) {
        let e = null;
        try { new vm.Script(src, { filename: p }); } catch (err) { e = err; }
        check(!e, `${path.basename(p)} парсится${e ? ': ' + e.message : ''}`);
    }
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
    const errs = [];
    let m, n = 0;
    while ((m = re.exec(html))) {
        if (/\bsrc=/.test(m[1])) continue;
        n++;
        try { new vm.Script(m[2], { filename: `inline-${n}` }); } catch (e) { errs.push(`#${n}: ${e.message}`); }
    }
    check(n > 0 && !errs.length, `инлайн-скриптов дашборда ${n}, все парсятся${errs.length ? ' — ' + errs.join('; ') : ''}`);
}

// ── 2. Фронт: кнопка живёт в подвале карточки и не своей темой ───────────────
section('routing/proxy-dashboard.html · кнопка ⭐ на карточке');
{
    const card = body(html, 'ghCardHtml') || '';
    check(!!card, 'ghCardHtml() на месте (карточка аккаунта рисуется ею)');
    const iOpen = card.indexOf('onclick="ghOpenGitHub(');
    const iStar = card.indexOf('onclick="ghStarRepo(');
    const iMenu = card.indexOf('onclick="ghToggleMenu(');
    check(iStar >= 0, 'в разметке карточки есть кнопка, вызывающая ghStarRepo()');
    check(iOpen >= 0 && iStar > iOpen && iMenu > iStar,
        '⭐ стоит в подвале между «Открыть GitHub ↗» и «⋯» — в том же ряду кнопок');
    const row = iOpen >= 0 ? card.lastIndexOf('<div class="flex gap-2">', iOpen) : -1;
    check(row >= 0 && iMenu > row && !card.slice(row, iMenu).includes('</div>'),
        'все три кнопки подвала в ОДНОМ контейнере flex gap-2 (⭐ не уехала в отдельный блок)');

    // Один и тот же id у трёх соседей: ⭐ обязана открывать сессию того аккаунта, на
    // карточке которого нажата. Расхождение здесь = звезда от чужого имени.
    const args = [...new Set(Array.from(
        card.matchAll(/onclick="(?:ghOpenGitHub|ghStarRepo|ghToggleMenu)\('([^']*)'\)"/g), (m) => m[1]))];
    check(args.length === 1 && args[0].includes('idJ'),
        `⭐ зовётся с тем же id, что соседние кнопки (${args.join(' / ') || 'ни одной'})`);

    const el = (() => {
        if (iStar < 0) return '';
        const s = card.lastIndexOf('<button', iStar);
        const e = card.indexOf('</button>', iStar);
        return s < 0 || e < 0 ? '' : card.slice(s, e + 9);
    })();
    const hex = el.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    check(!!el && !hex.length,
        `в классах ⭐ нет hex-цвета, только токены темы${hex.length ? ' — найдено: ' + hex.join(' ') : ''}`);
    check(/\$\{starBusy \? 'disabled' : ''\}/.test(el),
        'кнопка получает disabled на время работы (иначе второй клик = второй харвест поверх первого)');
    check(el.includes('⏳') && /cursor-wait|opacity-/.test(el),
        'занятость видна глазом: ⏳ вместо ⭐ плюс cursor-wait/opacity');
    check(el.includes(REPO_SHORT), `подпись кнопки называет ${REPO_SHORT} — тот же адрес, что у серверной константы`);
    check(/const starBusy = !!\(state\.ghStarBusy \|\| \{\}\)\[a\.id\]/.test(card),
        'ghCardHtml берёт занятость из state.ghStarBusy по id ЭТОЙ карточки');
}

// ── 3. Фронт: ghStarRepo() — запрос, четыре ветки ответа, снятие занятости ───
section('routing/proxy-dashboard.html · ghStarRepo()');
{
    const b = body(html, 'ghStarRepo') || '';
    check(!!b, 'ghStarRepo() объявлена');
    check(/if \(state\.ghStarBusy\[id\]\) return toast/.test(b),
        'повторный клик отбит ранним выходом (харвест молчит до минуты)');
    const iBusy = b.indexOf('state.ghStarBusy[id] = true');
    const iFetch = b.indexOf("fetch('/__switch/api/gh/star'");
    check(iBusy >= 0 && iFetch > iBusy, 'занятость ставится ДО запроса, а не после ответа');
    check(/fetch\('\/__switch\/api\/gh\/star', \{/.test(b) && /method: 'POST'/.test(b),
        "запрос POST на '/__switch/api/gh/star', без query-параметров в адресе");
    check(/body: JSON\.stringify\(\{ id \}\)/.test(b) && !/JSON\.stringify\(\{[^}]*url/.test(b),
        'в теле запроса только id — цель фронт не диктует');
    check(/res\.status === 404/.test(b) && /перезапусти/.test(b),
        '404 разобран отдельно: «ручки нет → :8200 на старом коде, перезапусти дашборд»');
    check(/if \(!res\.ok \|\| data\.error\)/.test(b),
        'ошибка ловится и по коду, и по полю error — keepalive мог отдать заголовки 200 раньше тела');
    check(/data\.already/.test(b) && /data\.navigated/.test(b) && /data\.handoffError/.test(b),
        'ветка «браузер уже открыт» различает переданную вкладку и провал handoff');
    check(/data\.from/.test(b) && /data\.cookieCount/.test(b),
        'успешный тост говорит, откуда сессия и сколько кук (кеш или харвест из профиля)');
    const iFin = b.indexOf('finally');
    check(iFin > 0 && /state\.ghStarBusy\[id\] = false/.test(b.slice(iFin)) && /ghRenderGrid\(\)/.test(b.slice(iFin)),
        'занятость снимается в finally с перерисовкой грида (иначе ⏳ залипнет насовсем)');
    check(/^const GH_STAR_REPO = 'github\.com\/WormAlien\/hub-cc';$/m.test(html),
        `фронтовая GH_STAR_REPO = '${REPO_SHORT}' — только для подписи и тостов`);
}

// ── 4. Сервер: цель — константа, а не параметр ───────────────────────────────
section('routing/transparent-proxy.js · handleGhStar() и GH_STAR_REPO_URL');
{
    check(new RegExp(`^const GH_STAR_REPO_URL = '${REPO_URL.replace(/[./]/g, '\\$&')}';$`, 'm').test(proxy),
        `GH_STAR_REPO_URL ровно '${REPO_URL}' — литерал, ни env, ни аргумента`);
    const b = body(proxy, 'handleGhStar') || '';
    check(!!b, 'handleGhStar() объявлена');
    check(/const \{ id \} = await readJsonBody\(req\);/.test(b), 'из тела запроса читается ТОЛЬКО id');
    const smells = ['req.url', 'body.url', '.url ||', 'searchParams', 'new URL(req'].filter((s) => b.includes(s));
    check(!smells.length,
        `цель не берётся из запроса: ни req.url, ни поля url в теле${smells.length ? ' — найдено: ' + smells.join(', ') : ''}`);
    check(/spawn\(process\.execPath, \[script, label, GH_STAR_REPO_URL, seedPath\]/.test(b),
        'в open-session.js уходит константа сервера: [script, label, GH_STAR_REPO_URL, seedPath]');

    const iKa = b.indexOf('const stopKeepalive = jsonKeepalive(res);');
    check(iKa >= 0 && iKa < b.indexOf('readJsonBody'), 'ответ обёрнут jsonKeepalive ДО первой долгой операции');
    check(/finally \{ stopKeepalive\(\); \}/.test(b), 'keepalive снимается в finally (иначе интервал капает в мёртвый сокет)');

    const iAlready = b.indexOf('if (ghPidAlive(prevPid))');
    check(iAlready >= 0, 'живой браузер профиля распознаётся по pid — второй Chromium на том же --user-data-dir портит профиль');
    const bounds = [b.indexOf('let seedPath'), b.indexOf('if (ghProfileNeedsSession')].filter((i) => i > iAlready);
    const already = iAlready < 0 ? '' : b.slice(iAlready, bounds.length ? Math.min(...bounds) : iAlready + 900);
    check(/ghHandoffUrl\(ghProfileDir\(label\), GH_STAR_REPO_URL\)/.test(already),
        'в этой ветке вкладка отдаётся живому окну через ghHandoffUrl, а не спавнится второй браузер');
    check(/already: true/.test(already) && /navigated: !!h\.ok/.test(already),
        'ответ ветки несёт already + navigated — фронт различает «передал вкладку» и «не смог»');

    const iFresh = b.indexOf('if (ghProfileNeedsSession(gsl, label))');
    check(iFresh >= 0, 'снимок берётся только профилю БЕЗ живой сессии — гейт ghProfileNeedsSession на месте');
    check(iFresh >= 0 && b.indexOf('ghStarSnapshot(acct)') > iFresh, 'ghStarSnapshot зовётся внутри гейта, а не до него');
    check(/acct\.status === 'dead'/.test(b), 'аккаунт, помеченный dead, отбивается текстом, а не открывается пустым окном');
    check(/'lockfile'/.test(b),
        'перед спавном проверяется lockfile профиля: осиротевшее окно переживает рестарт :8200, а ghLkPids живёт в памяти — '
        + 'без этой проверки владелец получал бы «готово» без окна (проба ждёт 2 с, playwright на занятом профиле — 30)');
    check(/jsonRes\(res, 409, \{ error: s\.error \}\)/.test(b), 'провал снимка уезжает кодом 409 с текстом причины');
    check(/ghLkPids\.set\(label, proc\.pid\)/.test(b) && /ghLkPids\.delete\(label\)/.test(b),
        'pid браузера кладётся в ghLkPids и снимается на выходе — иначе handoff не найдёт окно');
    check(/await sessionOpenEarlyFailure\(proc\)/.test(b), 'ранний вылет open-session.js становится 502, а не «ok» с мёртвым pid');
    check(b.includes("const label = 'acct_' + id;"), "профиль привязан к стабильному id ('acct_' + id) — как в handleGhOpen");
}

// ── 5. Сервер: каскад снимка (кеш → индекс → свободный профиль → харвест) ────
section('routing/transparent-proxy.js · каскад ghStarSnapshot()');
{
    const b = body(proxy, 'ghStarSnapshot') || '';
    check(!!b, 'ghStarSnapshot() объявлена');
    const iCache = b.indexOf('gsl.readCache(acct.id)');
    const iHarvest = b.indexOf('ghHarvest(gsl');
    check(iCache >= 0 && iHarvest > iCache, 'кеш снимка читается ДО харвеста — иначе каждый клик запускает Chromium на минуту');
    check(/if \(snap && gsl\.cacheStale\(snap\)\) snap = null/.test(b),
        'просроченный кеш (TTL 7 суток) отбрасывается, а не отдаётся как живой');
    check(/indexByLogin\(\)\.get\(nick\.toLowerCase\(\)\)/.test(b), 'источники ищутся по нику в индексе профилей');
    check(/\.filter\(s => s\.hasUserSession\)/.test(b), 'источниками считаются только профили с живой GitHub-сессией');
    check(/\.filter\(s => !ghProfileBusy\(s\)\)/.test(b),
        'профиль с ОТКРЫТЫМ браузером отфильтрован: Chromium не отдаст банку кук и перезапишет её на закрытии');
    check(/for \(const src of free\)/.test(b),
        'перебираются ВСЕ свободные источники — мёртвая сессия в одном профиле не хоронит аккаунт с живой в другом');
    check(/ghHarvestInFlight\.has\(acct\.id\)/.test(b) && /ghHarvestInFlight\.add\(acct\.id\)/.test(b)
        && /finally \{\s*ghHarvestInFlight\.delete\(acct\.id\)/.test(b),
        'параллельный харвест одного аккаунта отбит: ghHarvest пишет github/sessions/<id>.json обычным writeFileSync, '
        + 'а звать его умеют и ⭐, и пикер add-github — два писателя рвут снимок');
    check(/Date\.now\(\) > deadline/.test(b),
        'у перебора есть общий дедлайн: у популярных ников до семи источников по 60 с каждый, без лимита клик висел бы 7 минут');
    check(/gsl\.indexInfo\(\)/.test(b) && /ghIndexBuilding\(\)/.test(b),
        'пустой/строящийся индекс профилей называется своей причиной, а не «сессии на диске нет» — последний совет ещё и '
        + 'создаёт профиль без сессии, которому потом нужен тот же снимок');
    const c3 = /r\.code === 3 \? '([^']+)'/.exec(b);
    const c2 = /r\.code === 2 \? '([^']+)'/.exec(b);
    check(!!c3 && !!c2 && c3[1] !== c2[1],
        `коды харвеста разведены разными текстами: 3 → «${c3 ? c3[1] : '—'}», 2 → «${c2 ? c2[1] : '—'}»`);
    check(/return \{ error:/.test(b) && !/return null/.test(b),
        'любой отказ возвращает { error: … } — владелец видит причину, а не пустой снимок');
    check(/from: 'кеш'/.test(b) && /from: `\$\{src\.tag\}\/\$\{src\.label\}`/.test(b),
        'источник снимка называется в ответе: «кеш» или tag/label профиля (это и печатает тост)');
}

// ── 6. Сервер: роут один, POST, строгое равенство ────────────────────────────
section('routing/transparent-proxy.js · роут /__switch/api/gh/star');
{
    const lines = proxy.split('\n').filter((l) => l.includes('req.url') && l.includes('/__switch/api/gh/star'));
    check(lines.length === 1, `роут объявлен ровно один раз (нашлось ${lines.length})`);
    const l = lines[0] || '';
    check(/req\.method === 'POST'/.test(l), 'роут только POST — на GET ⭐ дёргалась бы картинкой с любой страницы');
    check(l.includes("req.url === '/__switch/api/gh/star'"), 'сравнение строгое, без startsWith: «?url=…» до хендлера не доедет');
    check(/return handleGhStar\(req, res\)/.test(l), 'роут ведёт в handleGhStar');
    const openRoute = proxy.split('\n').filter((x) => x.includes('req.url') && x.includes('/__switch/api/gh/open'));
    check(openRoute.length === 1 && /handleGhOpen/.test(openRoute[0]),
        'роут /api/gh/open на месте — ⭐ добавлена РЯДОМ, а не вместо «Открыть GitHub»');
}

// ── 7. Сервер: прежний путь не тронут, handoff строго один ───────────────────
section('routing/transparent-proxy.js · handleGhOpen() и ghHandoffUrl()');
{
    const b = body(proxy, 'handleGhOpen') || '';
    check(/const \{ id \} = await readJsonBody\(req\);/.test(b),
        'handleGhOpen требует по-прежнему только id — новых обязательных полей не завёл');
    check(/spawn\(process\.execPath, \[script, label\], \{/.test(b),
        'handleGhOpen спавнит open-session.js без URL и без снимка — прежнее поведение сохранено');

    const calls = (proxy.match(/ghHandoffUrl\(/g) || []).length;
    check(calls === 2, `ghHandoffUrl упомянут ровно дважды — объявление и один вызов из ветки живого pid (нашлось ${calls})`);
    const h = body(proxy, 'ghHandoffUrl') || '';
    check(/require\('playwright'\)\.chromium\.executablePath\(\)/.test(h),
        'handoff берёт бинарь playwright: у chrome-headless-shell нет ProcessSingleton, и он поднял бы ВТОРОЙ инстанс на профиле');
    check(/`--user-data-dir=\$\{profileDir\}`/.test(h) && /'--no-first-run', url/.test(h),
        'handoff передаёт профиль и URL аргументами командной строки');
    check(/setTimeout\(/.test(h) && /'передача вкладки не завершилась/.test(h),
        'handoff не висит вечно: таймаут и внятная ошибка вместо молчания');
    check(/code === 0 \? \{ ok: true \}/.test(h), 'успехом считается только код 0 — штатный выход второго процесса');

    const f = body(proxy, 'ghProfileNeedsSession') || '';
    check(/profilesFromIndex\(\)/.test(f) && /hasUserSession/.test(f),
        'ghProfileNeedsSession спрашивает индекс профилей про ЖИВУЮ сессию, а не наличие Default/Preferences '
        + '(Preferences создаётся при первом запуске без всякого входа — на этом признаке ⭐ деградировала навсегда)');
    check(/if \(!fs\.existsSync\(dir\)\) return true/.test(f), 'профиля ещё нет → снимок нужен');
    check(/return !rec \|\| !rec\.hasUserSession/.test(f),
        'индекс не знает профиль → считаем, что сессии нет: влить лишний раз безопаснее, чем открыть анонимное окно и соврать');
    check(fs.existsSync(path.join(REPO, 'github', 'open-session.js')), 'github/open-session.js на месте — его путь и спавнит ручка');
}

// ── 8. Браузерный скрипт: чужой URL, гейт снимка, честный отчёт ──────────────
section('github/open-session.js · цель, снимок, отчёт');
{
    const v = body(openjs, 'validTarget') || '';
    check(!!v, 'validTarget() объявлена');
    check(/u\.protocol !== 'https:'/.test(v),
        'validTarget режет не-https: file:/chrome: в аргументе = «открой локальный файл в залогиненном профиле»');
    check(/u\.hostname\.toLowerCase\(\) !== 'github\.com'/.test(v),
        "пускается только hostname === 'github.com' — github.com.evil.tld и https://github.com@evil.tld отбиваются разбором URL");
    check(/s\.startsWith\('-'\)/.test(v),
        'ведущий дефис отбит: иначе аргумент уедет Chromium как флаг (--remote-debugging-port=9222)');

    const m = body(openjs, 'main') || '';
    check(/const targetUrl = validTarget\(process\.argv\[3\]\)/.test(m),
        'цель = argv[3] и проверяется ВНУТРИ main — отказ уезжает одной строкой в Server Logs, а не стектрейсом');
    check(/^const seedFile = String\(process\.argv\[4\] \|\| ''\)\.trim\(\);$/m.test(openjs),
        'снимок = argv[4]: порядок аргументов совпадает со спавном ручки');
    check(/const seed = loadSeed\(\);/.test(m),
        'снимок читается всегда, когда его дали: решение «нужна ли профилю сессия» принимает ручка по индексу профилей, '
        + 'а не скрипт по наличию Preferences');
    const as = body(openjs, 'applySeed') || '';
    check(/out\.cookies = true/.test(as) && /out\.storages\+\+/.test(as),
        'успех кук и успех localStorage считаются РАЗДЕЛЬНО: addCookies — всё или ничего, и раньше флаг перетирался циклом '
        + 'localStorage, то есть скрипт печатал «влил 12 кук» там, где не влил ни одной');
    check(/seeded\.cookies/.test(m), 'строка «влил снимок» печатается только при успехе именно КУК');
    const isf = body(openjs, 'isFreshProfile') || '';
    check(/'Default', 'Preferences'/.test(isf), 'чистота профиля = отсутствие Default/Preferences');

    const iSeed = m.indexOf('await applySeed(context, seed)');
    const iGoto = m.indexOf('await page.goto(');
    check(iSeed >= 0 && iGoto > iSeed, 'куки вливаются ДО первой навигации — иначе GitHub успеет отдать страницу логина');
    const ap = body(openjs, 'applySeed') || '';
    check(/await context\.addCookies\(seed\.cookies\)/.test(ap), 'снимок вливается context.addCookies (форма storageState)');
    check(/await page\.goto\(targetUrl \|\| GITHUB_LOGIN_URL/.test(m), 'без argv[3] цель прежняя — GITHUB_LOGIN_URL');
    check(/^const GITHUB_LOGIN_URL = 'https:\/\/github\.com\/login';$/m.test(openjs), "GITHUB_LOGIN_URL = 'https://github.com/login'");

    const w = body(openjs, 'whoAmI') || '';
    check(/meta\[name="user-login"\]/.test(w), 'ник берётся из meta[name="user-login"]');
    check(/return v && v\.trim\(\) \? v\.trim\(\) : null/.test(w),
        '🪤 проверяется НЕПУСТОЙ content: у анонимной страницы тег есть, но пустой — иначе «залогинен» врёт всегда');

    const r = body(openjs, 'reportStar') || '';
    check(/await page\.waitForSelector\('\[data-testid="star-button"\]'/.test(r),
        'состояние звезды читается через waitForSelector — кнопка приезжает партиалом через 170–300 мс после DCL');
    check(!!r && !/page\.\$\(|page\.\$eval\(/.test(r),
        'в reportStar нет мгновенного чтения DOM ($ / $eval): на domcontentloaded оно дало бы «звезды нет» всегда');
    check(/\/\^Unstar\/i/.test(r) && /\/\^Star\/i/.test(r),
        'Star и Unstar различаются по aria-label — иначе «уже поставлена» не отличить от «нажми»');
    check(/if \(who\) await reportStar\(page\)/.test(m), 'о звезде докладываем только когда мы действительно залогинены');
    check(/console\.error\('❌ Ошибка:', err\.message\)/.test(openjs) && /process\.exit\(1\)/.test(openjs),
        'отказ = одна строка «❌ Ошибка: …» и код 1 (враждебный URL не создаёт профиль)');
}

// ── итог ─────────────────────────────────────────────────────────────────────
console.log(`\ncheck-gh-star: ${ok.length}/${ok.length + fails.length}`);
if (fails.length) {
    console.log(`\n[X] связка «⭐ на карточке → ручка :8200 → браузер с готовой сессией» порвана: ${fails.length} проблем(ы):`);
    for (const m of fails) console.log(`   • ${m}`);
    console.log('\nЧто именно ломается от каждой из них — в шапке этого файла.');
    process.exit(1);
}
console.log(`[OK] путь «⭐ → сессия аккаунта → ${REPO_SHORT}» цел`);








