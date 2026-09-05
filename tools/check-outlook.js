#!/usr/bin/env node
/**
 * check-outlook.js — регресс на менеджер Outlook-ящиков (вкладка `outlook`, тег `ol`).
 *
 * Инвариант одной строкой: пул ящиков разбирается из ЖИВЫХ чеков магазина, пароль не
 * покидает сервер ни ответом, ни логом, ни argv, а удаление ящика не оставляет за собой
 * ни профиля браузера, ни снимка сессии.
 *
 * Почему проверки поведенческие, а не «есть ли строка X». Менеджер собран из четырёх
 * частей (`routing/lib/outlook-pool.js`, блок `ol` в `routing/transparent-proxy.js`,
 * `outlook/*.js`, вкладка в дашборде), и каждая его поломка тихая:
 *   · парсер: файл магазина — это ПИСЬМО-ЧЕК с рекламой, рамками и строками ДРУГИХ
 *     покупок. Строка `почта:пароль:base32` — это GitHub-аккаунт, и заведённый ящиком он
 *     даёт профиль, в который не войти. Ошибка вылезет через неделю и руками;
 *   · пароль: `olSafe` — единственный фильтр между записью пула и браузером. Одно
 *     дописанное поле (в том числе сокращением `password,`) отдаёт пароль наружу, а
 *     `:8200` слушает без аутентификации;
 *   · креды в argv видны в диспетчере задач любому, кто его откроет;
 *   · удаление: оставленный профиль — не мусор, а ловушка: перезалив того же ящика
 *     подхватит лежащую там куку, и «свой» ящик молча покажет чужую почту;
 *   · `save` без `.tmp`+rename теряет запись при двух одновременных правках;
 *   · роут без хендлера (и наоборот) не роняет прокси — он просто отвечает 404 на нажатие.
 *
 * Что здесь ЖИВОЕ, а не разбор текста: парсер гоняется на настоящих чеках из
 * `~/Downloads` (счётом, без печати адресов и паролей), `save`/`load` — на подставном
 * `fs`, `read-code.js` запускается процессом, `.gitignore` спрашивается у самого git.
 * Сети нет, дашборд не нужен, `:8200` не задет, ни один файл не пишется.
 *
 * 🪤 Одна проверка красная НАМЕРЕННО и указывает на живую дырку, а не на спецификацию:
 * вывод дочерних скриптов (`outlook/open-session.js`, `outlook/read-code.js`) уезжает в
 * лог дашборда ЦЕЛИКОМ, а сами они печатают адрес ящика человеку в консоль — так и надо,
 * их запускают руками. Значит маску обязана ставить сторона, которая релеит строку:
 * `logLine(…${String(d)}…)` и хвост stderr читалки прогнать через `olMaskInText`, который
 * в том же блоке уже заведён под «адрес внутри чужого текста». Пока этого нет, полный
 * адрес купленного ящика лежит в логе, который уезжает в скриншоты README.
 *
 * Запуск: node tools/check-outlook.js        (exit 1 = связка порвана)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PROXY = path.join(REPO, 'routing', 'transparent-proxy.js');
const HTML = path.join(REPO, 'routing', 'proxy-dashboard.html');
const POOLJS = path.join(REPO, 'routing', 'lib', 'outlook-pool.js');
const OPENJS = path.join(REPO, 'outlook', 'open-session.js');
const CODEJS = path.join(REPO, 'outlook', 'read-code.js');
const EXAMPLE = path.join(REPO, 'outlook', 'accounts.example.json');
const DOWNLOADS = path.join(os.homedir(), 'Downloads');

// Двенадцать ручек вкладки и их методы. Набор — сама спецификация менеджера: список,
// пачка, одиночное заведение, четыре точечные правки, два окна (открыть/код), выдача
// ящика автоregу и пара health-чека.
const ROUTES = {
    list: 'GET', import: 'POST', add: 'POST', rename: 'POST', delete: 'POST', status: 'POST',
    mark: 'POST', open: 'POST', code: 'POST', available: 'GET',
    'health-check': 'POST', 'health-progress': 'GET',
};

// Живые чеки магазина. 🪤 Одна и та же пачка приходит в двух формах: `8089597` и `8091899`
// — это ящики (8 строк, но один адрес есть в обоих файлах, значит уникальных 7), а
// `8066475` / `8070830` / `8075943` — GitHub-аккаунты `почта:пароль:2FA` из тех же
// писем-чеков. Парсер обязан взять первые и не взять ни одной строки из вторых.
const RECEIPTS = {
    ящики: { prefixes: ['8089597', '8091899'], entries: 8, unique: 7 },
    гитхабы: { prefixes: ['8066475', '8070830', '8075943'], entries: 0 },
};

const printed = [];      // всё напечатанное — в конце проверяется на утечку адресов
const secrets = new Set(); // пароли из живых чеков: их не должно быть в выводе
const fails = [];
const skips = [];
let total = 0;

const say = (s) => { printed.push(String(s)); console.log(s); };
const section = (t) => say(`\n── ${t} ──`);
function check(cond, msg) {
    total += 1;
    say(`  ${cond ? '✓' : '✗'} ${msg}`);
    if (!cond) fails.push(msg);
    return !!cond;
}
const skip = (msg) => { skips.push(msg); say(`  · ${msg}`); };

// 🪤 CRLF нормализуем намеренно: transparent-proxy.js лежит в CRLF, остальные файлы в LF,
// и без нормализации терминатор `\n}\n` не находит конец функции — «тело хендлера»
// растягивается до конца файла, и любая проверка зеленеет случайно.
const read = (p) => { try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } catch { return null; } };

// Тело функции: от объявления до `}` в нулевой колонке (так отформатированы все функции
// верхнего уровня в этих файлах).
function body(src, name) {
    const m = new RegExp(`\\n(?:async )?function ${name}\\s*\\(`).exec(src || '');
    if (!m) return null;
    const from = m.index + 1;
    const end = src.indexOf('\n}\n', from);
    return end < 0 ? src.slice(from) : src.slice(from, end + 3);
}

const proxy = read(PROXY);
const html = read(HTML);
const poolSrc = read(POOLJS);
const openjs = read(OPENJS);
const codejs = read(CODEJS);

if (!proxy || !poolSrc) {
    console.log(`  ✗ не читается ${!proxy ? PROXY : POOLJS} — проверять нечего`);
    process.exit(1);
}

// Блок `ol` в прокси: от его заголовка до следующего такого же разделителя. Конец ищем по
// разделителю, а не по имени соседа: порядок блоков в файле не зафиксирован.
const OL_HEAD = '// ───── Outlook-ящики (ol)';
const olFrom = proxy.indexOf(OL_HEAD);
const olTo = olFrom >= 0 ? proxy.indexOf('\n// ───── ', olFrom + OL_HEAD.length) : -1;
const olBlock = olFrom >= 0 ? proxy.slice(olFrom, olTo > olFrom ? olTo : proxy.length) : '';

console.log('== check-outlook: пул ящиков, пароль, роуты, удаление ==');

// ── 1. Парсер чека: поведение, а не форма строк ───────────────────────────────
// Модуль подключаем настоящий: на загрузке он ничего не читает и не пишет, диск трогают
// только load()/save(), а их мы гоняем ниже на подставном fs.
section('routing/lib/outlook-pool.js · разбор письма-чека');
let pool = null;
try { pool = require(POOLJS); } catch (e) { check(false, `модуль пула не загружается: ${e.message}`); }

if (pool) {
    for (const fn of ['load', 'save', 'parseLine', 'parseBulk', 'isStudentDomain', 'profileLabel', 'STATUSES', 'KINDS']) {
        check(fn in pool, `модуль экспортирует ${fn} — на это опираются и прокси, и outlook/*.js`);
    }
    check(Array.isArray(pool.STATUSES) && pool.STATUSES.length === 4 && pool.STATUSES[0] === 'unknown',
        `STATUSES — четыре вердикта, первый unknown (получено: ${JSON.stringify(pool.STATUSES)})`);

    // Подставной чек: шум магазина, четыре разделителя, студенческий домен, строка чужой
    // покупки с 2FA, строка с адресом без пароля и строка вообще без адреса.
    const receipt = [
        'Заказ: 12345 от 31.08.2026',
        'Сайт: https://shop.invalid/order/12345',
        '🚨 Скидка 20% по промокоду на следующий заказ',
        '↓↓↓↓ Ваш заказ: ↓↓↓↓',
        'one.box' + '@outlook.com:Pw-1',
        'two.box' + '@outlook.com;Pw-2',
        'three.box' + '@hotmail.com|Pw-3',
        'four.box' + '@outlook.com\tPw-4',
        'five.box' + '@some-university.edu:Pw-5',
        'six.box' + '@gmail.com:Pw-6:JBSWY3DPEHPK3PXP',
        'seven.box' + '@outlook.com',
        'просто строка чека без адреса',
    ].join('\r\n');
    const r = pool.parseBulk(receipt, []);

    check(r.entries.length === 5, `из подставного чека взято ${r.entries.length} ящиков, ожидалось 5 (шум чека не считается)`);
    check(r.errors.length === 2, `ошибок ${r.errors.length}, ожидалось 2: строка без пароля и строка с 2FA-секретом`);
    // Строка без адреса — шум, а не ошибка: таких в чеке больше, чем полезных, и в отчёте
    // импорта они забили бы настоящие проблемы.
    check(!r.errors.some((x) => /адреса почты/.test(x.error)), 'строка без адреса молчит, а не попадает в ошибки');
    check(r.errors.some((x) => /2FA|base32/i.test(x.error)),
        'строка `почта:пароль:base32` отбита как аккаунт с 2FA — иначе получим профиль, в который не войти');
    check(r.errors.some((x) => /нет пароля/.test(x.error)), 'адрес без пароля — ошибка: в профиль войти нечем');
    check(r.entries.filter((e) => e.kind === 'student').length === 1,
        `студенческий ящик один (получено ${r.entries.filter((e) => e.kind === 'student').length}) — вид определяется доменом, а не полем магазина`);
    check(r.entries.every((e) => e.password && e.email && e.email === e.email.toLowerCase()),
        'у каждой записи есть адрес в нижнем регистре и непустой пароль');
    // Номер строки в ошибке — от начала ФАЙЛА, иначе «починить кривую строку» невозможно.
    check(r.errors.every((x) => x.line > 4), `номера строк в ошибках указывают в тело чека (${r.errors.map((x) => x.line).join(', ')})`);

    // Позиции полей не фиксированы: в тех же чеках соседние строки шестипольные.
    const shifted = pool.parseLine('login|shift.box' + '@outlook.com|Pw-9');
    check(!shifted.error && shifted.password === 'Pw-9',
        'адрес ищется по строке, а не берётся первым полем — пароль это первое непустое поле ПОСЛЕ адреса');
    const tailed = pool.parseLine('tail.box' + '@outlook.com:Pw-8:backup.box' + '@mail.invalid:31.08.2026');
    check(!tailed.error && tailed.note.includes('·'),
        'хвост строки (резервная почта, дата) сохраняется в note — по нему потом отличают, что за ящик куплен');

    // Дубли считаются и внутри пачки, и против пула: перезалив чека не должен плодить
    // второй профиль на тот же ящик.
    const dup = pool.parseBulk(['dup.box' + '@outlook.com:Pw-1', 'dup.box' + '@outlook.com:Pw-1'].join('\n'), []);
    check(dup.entries.length === 1 && dup.duplicates.length === 1, 'повтор внутри пачки заводится один раз');
    const vsPool = pool.parseBulk('dup.box' + '@outlook.com:Pw-1', [{ email: 'DUP.BOX' + '@Outlook.com' }]);
    check(vsPool.entries.length === 0 && vsPool.duplicates.length === 1,
        'дубль против пула виден без учёта регистра — иначе тот же ящик заведётся вторым профилем');

    for (const [dom, want] of [['.edu', true], ['.edu.au', true], ['.ac.uk', true], ['outlook.com', false], ['education.com', false]]) {
        const probe = 'x' + '@uni' + (dom.startsWith('.') ? dom : '.' + dom);
        check(pool.isStudentDomain(probe) === want, `домен ${dom}: студенческий = ${want}`);
    }
    check(pool.profileLabel('ol_1_0') === 'acct_ol_1_0', 'label профиля — acct_<id>: профиль привязан к id, а не к адресу');
}

// ── 2. Живые чеки магазина из ~/Downloads ─────────────────────────────────────
// 🔴 В вывод не уходит НИ ОДИН адрес и НИ ОДИН пароль — только счёт. Пароли живых чеков
// заодно складываем в `secrets`: в самом конце вывод проверяется на их отсутствие.
section(`живые чеки · ${DOWNLOADS}`);
if (!pool) {
    skip('модуль пула не загрузился — живые чеки проверять нечем');
} else {
    const listing = fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : [];
    const filesFor = (pfx) => listing.filter((n) => new RegExp(`^${pfx}_.*\\.txt$`).test(n));

    for (const [what, spec] of Object.entries(RECEIPTS)) {
        const found = spec.prefixes.map((p) => [p, filesFor(p)]);
        const missing = found.filter(([, f]) => !f.length).map(([p]) => p);
        if (missing.length) {
            // Downloads — не часть репо, владелец чистит папку когда хочет. Отсутствие
            // файла не поломка кода, но и молчать нельзя: проверка НЕ прошла.
            skip(`чеки ${what}: нет файлов ${missing.join(', ')} — проверка на живых данных пропущена`);
            continue;
        }
        let sum = 0, errs = 0;
        const emails = new Set();
        const texts = [];
        for (const [pfx, files] of found) {
            for (const f of files) {
                const text = fs.readFileSync(path.join(DOWNLOADS, f), 'utf8');
                texts.push(text);
                const r = pool.parseBulk(text, []);
                sum += r.entries.length;
                errs += r.errors.length;
                for (const e of r.entries) { emails.add(e.email); if (e.password) secrets.add(e.password); }
                say(`    ${pfx}: ящиков ${r.entries.length}, ошибок ${r.errors.length}, дублей ${r.duplicates.length}`);
            }
        }
        check(sum === spec.entries, `чеки ${what}: всего разобрано ${sum} ящиков, ожидалось ${spec.entries}`);
        if (spec.unique) {
            check(emails.size === spec.unique,
                `чеки ${what}: уникальных адресов ${emails.size} из ${sum} — один ящик продан в обоих чеках`);
            // Перезалив тех же файлов одной пачкой обязан дать ровно уникальные и посчитать дубль.
            const joint = pool.parseBulk(texts.join('\n'), []);
            check(joint.entries.length === spec.unique && joint.duplicates.length === sum - spec.unique,
                `обе пачки вместе: заведено ${joint.entries.length}, дублей ${joint.duplicates.length} — повтор не плодит второй профиль`);
            check(joint.errors.length === 0, `в чеках ящиков нет неразобранных строк с адресом (ошибок ${joint.errors.length})`);
        } else {
            // 🪤 Ноль записей — половина ответа. Вторая половина: строки НЕ проглочены
            // молча, иначе завтра парсер «перестанет видеть» настоящие ящики и это
            // выглядело бы так же — пустым импортом без единой жалобы.
            check(errs > 0, `чеки ${what}: ${errs} строк отбито с объяснением, а не проглочено молча`);
        }
    }
}

// ── 3. Пароль не уезжает клиенту ──────────────────────────────────────────────
// `olSafe` — единственный фильтр между записью пула и браузером, а `:8200` слушает без
// аутентификации. Ключи разбираем И в форме `key: value`, И сокращением `key,`: именно
// сокращение проскочило бы мимо наивной проверки на `password:`.
section('routing/transparent-proxy.js · пароль наружу не уходит');
{
    check(!!olBlock, 'блок Outlook в прокси найден по заголовку-разделителю');
    const safe = body(olBlock, 'olSafe');
    check(!!safe, 'функция olSafe найдена — публичная форма записи');
    const ret = safe ? (/return \{[\s\S]*?\n {4}\};/.exec(safe) || [''])[0] : '';
    const keys = ret.split('\n')
        .map((l) => (/^\s{8}([A-Za-z_$][\w$]*)\s*(:|,\s*$)/.exec(l) || [])[1])
        .filter(Boolean);
    check(keys.length > 8, `в публичной форме ${keys.length} полей (парсер жив)`);
    check(!keys.includes('password'), 'поля password в публичной форме записи НЕТ');
    check(keys.includes('hasPassword'), 'вместо пароля отдаётся hasPassword — фронту нужен только факт «пароль есть»');
    // Пароль в форме частичной маски тоже запрещён: у пароля первые символы — подсказка
    // к подбору, в отличие от hex-ключа у соседних вкладок.
    check(!/password[^\n]*slice\(/.test(ret), 'пароль не отдаётся даже обрезанным');

    const list = body(olBlock, 'handleOlList');
    check(!!list && /arr\.map\(olSafe\)/.test(list),
        '/ol/list отдаёт arr.map(olSafe), а не сам массив пула — иначе пароли уедут первым же запросом вкладки');

    // Ни одна запись не уходит в ответ мимо olSafe.
    const rawEntry = olBlock.split('\n')
        .filter((l) => /jsonRes\(/.test(l) && /entry:/.test(l) && !/olSafe\(/.test(l));
    check(rawEntry.length === 0,
        `каждая запись в ответе проходит через olSafe${rawEntry.length ? ` — сырых: ${rawEntry.length}` : ''}`);

    // Пароль не должен попадать ни в ответ, ни в лог ни одной строкой блока. Смотрим
    // ТОЛЬКО то, что стоит внутри вызова: `if (!password) return jsonRes(…)` — это
    // проверка на пустоту, а не утечка, и наивный поиск по строке ловил бы её.
    const leaky = olBlock.split('\n').filter((l) => {
        const at = Math.min(...['jsonRes(', 'logLine('].map((c) => { const i = l.indexOf(c); return i < 0 ? 1e9 : i; }));
        if (at === 1e9) return false;
        const arg = l.slice(at).replace(/hasPassword/g, '');
        return /password/i.test(arg);
    });
    check(leaky.length === 0,
        `ни один jsonRes/logLine не берёт password${leaky.length ? ` — строк: ${leaky.length}` : ''}`);

    // Логи уезжают в скриншоты README, поэтому адрес в них маскируется. Проверяем все
    // строки лога блока, а не наличие функции: маска, которую забыли позвать, бесполезна.
    const rawLog = olBlock.split('\n')
        .filter((l) => /logLine\(/.test(l) && /\.email/.test(l) && !/olMaskEmail\(/.test(l));
    check(rawLog.length === 0,
        `в логах адрес только маской olMaskEmail${rawLog.length ? ` — сырых строк: ${rawLog.length}` : ''}`);

    // Превью импорта показывает ЧУЖОЙ чек до того, как владелец решил его завести: там
    // маскируются и адреса, и тексты ошибок парсера (в них адрес целиком).
    const imp = body(olBlock, 'handleOlImport') || '';
    const dry = imp.slice(imp.indexOf('if (body.dryRun)'), imp.indexOf('const ts = Date.now()'));
    check(/preview:[^\n]*olMaskEmail/.test(dry), 'превью импорта маскирует адреса');
    check(/errors:[^\n]*olMaskInText/.test(dry),
        'ошибки парсера в превью прогоняются через olMaskInText — иначе тот же адрес видно строкой ниже');

    // 🪤 Вывод дочерних скриптов уезжает в лог ЦЕЛИКОМ (`outlook open [label]: …` из
    // stdout/stderr окна и хвост stderr читалки в «ответ не разобран»), а сами скрипты
    // печатают адрес ящика человеку в консоль — они для этого и написаны. Значит маску
    // обязана ставить сторона, которая строку релеит, и ставить её ровно тем
    // olMaskInText, который в этом же файле заведён под «адрес внутри чужого текста».
    // 🪤 Ищем строки релея по ПРИЗНАКУ ИСТОЧНИКА (`String(d)` из потока ребёнка, `tail.slice`
    // из его stderr), а не по форме подстановки: первая версия этой проверки требовала
    // ровно `${String(d)`, и после починки — `${olMaskInText(String(d)…)}` — перестала
    // находить строки вообще и объявила «проверять нечего». Чекер, который зеленеет от
    // того, что цель исчезла из его регулярки, хуже отсутствующего.
    const relay = olBlock.split('\n')
        .filter((l) => /logLine\(/.test(l) && /(String\(d\)|tail\.slice)/.test(l));
    const bare = relay.filter((l) => !/olMaskInText\(/.test(l));
    check(relay.length > 0 && bare.length === 0,
        relay.length === 0
            ? 'строк релея вывода ребёнка в лог не нашёл — проверять нечего'
            : `вывод дочерних скриптов маскируется olMaskInText при записи в лог${bare.length ? ` — сырых строк: ${bare.length} из ${relay.length}` : ''}`);
}

// ── 4. Креды в дочерние процессы — только средой ──────────────────────────────
// argv виден в диспетчере задач любому, кто его откроет. Аргументом уезжает ТОЛЬКО label.
section('креды в дочерние процессы · env, не argv');
{
    const spawns = [];
    for (let i = olBlock.indexOf('spawn('); i >= 0; i = olBlock.indexOf('spawn(', i + 1)) {
        spawns.push(olBlock.slice(i, i + 700));
    }
    check(spawns.length === 2, `в блоке ровно два запуска дочерних процессов (окно и читалка), нашлось ${spawns.length}`);
    spawns.forEach((s, n) => {
        const argv = s.slice(s.indexOf('['), s.indexOf(']') + 1);
        check(!/email|pass|creds/i.test(argv), `запуск #${n + 1}: в argv нет ни адреса, ни пароля — только скрипт и label (${argv.replace(/\s+/g, ' ')})`);
        const env = (/env:\s*\{[^}]*\}/.exec(s) || [''])[0];
        check(/OL_EMAIL/.test(env) && /OL_PASS/.test(env), `запуск #${n + 1}: креды переданы через env (OL_EMAIL, OL_PASS)`);
        check(/\.\.\.process\.env/.test(env), `запуск #${n + 1}: среда родителя не потеряна (…process.env) — иначе у ребёнка нет PATH`);
    });

    for (const [name, src] of [['outlook/open-session.js', openjs], ['outlook/read-code.js', codejs]]) {
        if (!src) { check(false, `${name} не читается`); continue; }
        // Позиционный контракт ровно один: argv[2] = label. Появившийся argv[3] означал бы,
        // что креды поехали аргументом.
        check(/process\.argv\[2\]/.test(src) && !/process\.argv\[[3-9]\]/.test(src),
            `${name}: из argv читается только label (argv[2])`);
        check(!/OL_PASS/.test(src) || /process\.env\.OL_PASS/.test(src),
            `${name}: пароль берётся из process.env.OL_PASS`);
        // Пароль не должен уходить в stdout: его релеит в лог дашборд.
        const printsPass = src.split('\n').filter((l) => /console\.(log|error)\(/.test(l)
            && /(OL_PASS|envPass|\bpassword\b|\.password)/.test(l) && !/Пароль подставлен|пароль подставить|Пароля нет|OL_EMAIL\/OL_PASS/.test(l));
        check(printsPass.length === 0, `${name}: пароль никуда не печатается${printsPass.length ? ` — строк: ${printsPass.length}` : ''}`);
    }
}

// ── 5. Двенадцать роутов, и у каждого живой хендлер ───────────────────────────
// Роут без хендлера прокси не роняет — он отвечает 404 на нажатие, и вкладка «просто не
// работает». Обратное так же тихо: хендлер без роута это мёртвый код.
section('роуты /__switch/api/ol/* · 12 ручек и парность с хендлерами');
{
    const disp = proxy.split('\n').filter((l) => l.includes('req.url') && l.includes('/__switch/api/ol/'));
    const seen = new Map();
    for (const l of disp) {
        const route = (/\/__switch\/api\/ol\/([a-z-]+)/.exec(l) || [])[1];
        const method = (/req\.method === '([A-Z]+)'/.exec(l) || [])[1];
        const handler = (/return (handle[A-Za-z0-9]+)\(/.exec(l) || [])[1];
        const exact = /req\.url === '/.test(l);
        if (route) seen.set(route, { method, handler, exact, line: l.trim() });
    }
    check(seen.size === 12 && disp.length === 12, `в диспетчере ровно 12 ol-роутов (строк ${disp.length}, уникальных ${seen.size})`);

    for (const [route, method] of Object.entries(ROUTES)) {
        const got = seen.get(route);
        check(!!got, `роут /ol/${route} есть в диспетчере`);
        if (!got) continue;
        check(got.method === method, `/ol/${route} — ${method} (получено ${got.method})`);
        check(!!got.handler && new RegExp(`\\n(?:async )?function ${got.handler}\\s*\\(`).test(proxy),
            `/ol/${route} → ${got.handler || '(хендлер не разобран)'} объявлен в файле`);
    }
    const extra = [...seen.keys()].filter((r) => !(r in ROUTES));
    check(extra.length === 0, `лишних ol-роутов нет${extra.length ? ' — ' + extra.join(', ') : ''}`);

    // 🪤 `available` принимает `?tag=<шлюз>`, значит сравнение по `===` промахнётся на
    // каждом реальном запросе: URL приходит с query. Только startsWith.
    const av = seen.get('available');
    check(!!av && !av.exact && /startsWith\('\/__switch\/api\/ol\/available'\)/.test(av.line),
        '/ol/available разбирается через startsWith — у него есть ?tag=, и точное сравнение дало бы 404 всегда');
    // Обратная сторона: у остальных query нет, и startsWith у них подхватывал бы соседей.
    const loose = [...seen].filter(([r, v]) => r !== 'available' && !v.exact).map(([r]) => r);
    check(loose.length === 0, `остальные роуты сравниваются точно${loose.length ? ' — вольные: ' + loose.join(', ') : ''}`);

    // Каждый объявленный хендлер должен быть кому-то нужен.
    const declared = new Set(Array.from(proxy.matchAll(/\n(?:async )?function (handleOl[A-Za-z0-9]+)\s*\(/g), (m) => m[1]));
    const wired = new Set([...seen.values()].map((v) => v.handler));
    const orphan = [...declared].filter((h) => !wired.has(h));
    check(orphan.length === 0, `мёртвых хендлеров handleOl* нет${orphan.length ? ' — ' + orphan.join(', ') : ''}`);

    // `available` — ручка автоrega, и её порядок несёт смысл: ящик с готовым профилем
    // вперёд, иначе автоподстановка встанет на ящике, в который надо входить руками.
    const avBody = body(olBlock, 'handleOlAvailable') || '';
    check(/status !== 'dead'/.test(avBody), '/ol/available не отдаёт мёртвые ящики');
    check(/usedOn[\s\S]{0,120}m\.tag === tag/.test(avBody), '/ol/available пропускает ящики, уже израсходованные на этом шлюзе');
    check(/hasProfile \|\| e\.hasSession/.test(avBody), '/ol/available ставит вперёд ящики с готовой сессией');
}

// ── 6. Запись пула: .tmp + rename, чтение терпит мусор ────────────────────────
// Проверяем ПОВЕДЕНИЕМ, на подставном `fs`: живой outlook/accounts.json трогать нельзя,
// а «есть ли в файле слово rename» ничего не доказывает — важен порядок и то, что по
// самому файлу пула прямой записи не бывает.
section('routing/lib/outlook-pool.js · save через .tmp + rename, load терпит мусор');
{
    function sandbox() {
        const calls = [];
        const fakeFs = {
            readFileSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
            writeFileSync: (p, data) => { calls.push({ op: 'write', p, data }); },
            renameSync: (a, b) => { calls.push({ op: 'rename', a, b }); },
            mkdirSync: (p) => { calls.push({ op: 'mkdir', p }); },
        };
        const mod = { exports: {} };
        const fn = new Function('require', 'module', 'exports', '__dirname', '__filename', poolSrc);
        fn((n) => (n === 'fs' ? fakeFs : require(n)), mod, mod.exports, path.dirname(POOLJS), POOLJS);
        return { p: mod.exports, calls, fakeFs };
    }

    let box = null;
    try { box = sandbox(); } catch (e) { check(false, `модуль пула не исполняется на подставном fs: ${e.message}`); }

    if (box) {
        const { p, calls, fakeFs } = box;
        p.save([{ id: 'ol_probe', email: 'probe', password: 'probe' }]);
        const writes = calls.filter((c) => c.op === 'write');
        const renames = calls.filter((c) => c.op === 'rename');
        check(writes.length === 1 && writes[0].p === p.FILE + '.tmp', 'save пишет во временный файл .tmp, а не в сам пул');
        check(renames.length === 1 && renames[0].a === p.FILE + '.tmp' && renames[0].b === p.FILE,
            'save заканчивается rename .tmp → accounts.json — два процесса не теряют запись');
        check(calls.findIndex((c) => c.op === 'write') < calls.findIndex((c) => c.op === 'rename'),
            'сначала запись, потом подмена (обратный порядок оставил бы пустой файл)');
        check(!calls.some((c) => c.op === 'write' && c.p === p.FILE), 'по самому accounts.json прямой записи нет');
        check(calls.some((c) => c.op === 'mkdir'), 'каталог outlook/ создаётся до записи — иначе первый импорт упадёт ENOENT');
        let round = null;
        try { round = JSON.parse(writes[0] ? writes[0].data : ''); } catch { /* ниже */ }
        check(Array.isArray(round) && round.length === 1, 'на диск уезжает валидный JSON-массив');

        // Чтение обязано быть терпимым: пул читают шесть точек, и исключение из load()
        // положило бы вкладку целиком.
        check(Array.isArray(p.load()) && p.load().length === 0, 'load без файла отдаёт пустой массив, а не бросает');
        // 🪤 BOM в исходнике этого файла держать нельзя (невидимый символ в коде), поэтому
        // он собирается escape-последовательностью.
        fakeFs.readFileSync = () => '﻿[{"id":"ol_1"}]';
        check(p.load().length === 1, 'load снимает BOM — файл, побывавший в блокноте, читается');
        fakeFs.readFileSync = () => '{"id":"ol_1"}';
        check(p.load().length === 0, 'объект вместо массива — пустой пул, а не запись-мутант');
        fakeFs.readFileSync = () => '[{ сломано';
        check(p.load().length === 0, 'битый JSON не роняет вкладку');
    }
}

// ── 7. Удаление сносит ТРИ вещи и в правильном порядке ────────────────────────
// 🪤 Оставленный профиль — не мусор, а ловушка: перезалив того же ящика подхватит лежащую
// там куку, и «свой» ящик молча покажет чужую почту.
section('routing/transparent-proxy.js · удаление ящика');
{
    const del = body(olBlock, 'handleOlDelete') || '';
    check(!!del, 'handleOlDelete найден');
    const iProfile = del.indexOf('rmSync(olProfileDir(');
    const iSession = del.indexOf('rmSync(olSessionFile(');
    const iSplice = del.indexOf('arr.splice(');
    const iSave = del.indexOf('olPool.save(');
    check(iProfile > 0, 'папка профиля браузера удаляется');
    check(iSession > 0, 'снимок сессии удаляется');
    check(iSplice > 0 && iSave > iSplice, 'запись убирается из пула и пул сохраняется');
    check(iProfile < iSplice && iSession < iSplice,
        'файлы сносятся ДО правки пула — если профиль не удалился, запись остаётся видимой, а не сиротеет');
    check(/jsonRes\(res, 409[\s\S]{0,200}не удалился/.test(del),
        'неудача удаления профиля отдаёт 409 с причиной, а не молчаливый успех');
    check(/olPidAlive\(pid\)/.test(del) && del.indexOf('olPidAlive(pid)') < iProfile,
        'открытое окно ящика ловится ДО удаления: на Windows живой Chromium не отдаст каталог');
    check(/olLkPids\.delete\(label\)/.test(del), 'pid окна вычищается из карты — иначе повторное открытие упрётся в мёртвый pid');
}

// ── 8. .gitignore: спрашиваем сам git, а не читаем файл глазами ────────────────
// Пул, профили и снимки сессий — живые креды владельца, пример же обязан доехать до
// чужой машины. Проверяем через `git check-ignore`: правило может стоять с
// отрицанием, шаблоном или в другом файле игнора, и текстовый поиск это упустит.
section('.gitignore · пул и профили закрыты, пример открыт');
{
    const ignored = (rel) => spawnSync('git', ['check-ignore', '-q', rel], { cwd: REPO }).status === 0;
    for (const rel of ['outlook/accounts.json', 'outlook/accounts.json.tmp',
        'outlook/profiles/acct_ol_1/Default/Cookies', 'outlook/sessions/ol_1.json']) {
        check(ignored(rel), `git игнорирует ${rel}`);
    }
    check(!ignored('outlook/accounts.example.json'),
        'outlook/accounts.example.json НЕ игнорируется — без примера на чужой машине непонятно, что за схема у пула');

    // Пример — единственная документация схемы, и он обязан покрывать все поля, которые
    // читает публичная форма записи: иначе новый ящик у соседа выйдет с undefined в UI.
    let ex = null;
    try { ex = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')); } catch { /* ниже */ }
    check(Array.isArray(ex) && ex.length >= 2, 'пример — массив хотя бы из двух записей (личный ящик и студенческий)');
    if (Array.isArray(ex) && ex.length) {
        const safe = body(olBlock, 'olSafe') || '';
        const readFields = new Set(Array.from(safe.matchAll(/\be\.([a-zA-Z]+)\b/g), (m) => m[1]));
        const missing = [...readFields].filter((f) => !(f in ex[0]));
        check(missing.length === 0, `в примере есть все поля, которые читает olSafe${missing.length ? ' — нет: ' + missing.join(', ') : ` (${readFields.size} шт.)`}`);
        check(ex.some((e) => e.kind === 'student'), 'в примере показан студенческий ящик — вид определяется доменом');
        check(ex.every((e) => pool ? pool.STATUSES.includes(e.status) : true), 'статусы в примере из STATUSES');
        check(ex.every((e) => /^ol_\d+_\d+$/.test(String(e.id))), 'id в примере по схеме ol_<ts>_<n> — по нему строится имя профиля');
    }
}

// ── 9. read-code.js живьём: ответ дашборду всегда одна строка JSON ─────────────
// 🪤 Дашборд парсит stdout читалки целиком. Стектрейс или «просто ничего» в этом месте он
// прочитает как «сервис сломался», поэтому неизвестный label обязан отвечать таким же
// JSON, как удача. Проверка живая: Chromium не поднимается, ящика с таким label нет.
section('outlook/read-code.js · неизвестный label отвечает валидным JSON');
{
    const run = (args) => spawnSync(process.execPath, [CODEJS, ...args], { cwd: REPO, encoding: 'utf8', timeout: 60000 });
    const cases = [
        { args: ['acct_ol_no_such_box_' + Date.now()], why: 'unknown_label', re: /unknown_label/ },
        { args: [], why: 'no_label', re: /no_label/ },
    ];
    for (const c of cases) {
        const r = run(c.args);
        if (r.error) { check(false, `запуск читалки (${c.why}) не состоялся: ${r.error.message}`); continue; }
        const lines = String(r.stdout || '').trim().split('\n').filter(Boolean);
        check(lines.length === 1, `${c.why}: в stdout ровно одна строка (получено ${lines.length}) — отладка идёт в stderr`);
        let obj = null;
        try { obj = JSON.parse(lines[0] || ''); } catch { /* ниже */ }
        check(!!obj && typeof obj === 'object', `${c.why}: stdout разбирается как JSON`);
        check(!!obj && obj.ok === false, `${c.why}: ok:false, а не исключение`);
        check(!!obj && c.re.test(String(obj.error || '')), `${c.why}: причина названа полем error (${obj ? obj.error : '—'})`);
        check(r.status === 1, `${c.why}: код выхода 1 (получено ${r.status}) — дашборд отличает «нет ящика» от таймаута`);
    }
}

// ── 10. Вкладка в дашборде ────────────────────────────────────────────────────
// Кнопка без панели открывает пустоту, панель без кнопки недоступна, а вкладка вне
// DEFAULT_TABS_VISIBLE не видна в сайдбаре свежей установки — три разных тихих промаха.
section('routing/proxy-dashboard.html · вкладка outlook');
if (!html) {
    check(false, 'routing/proxy-dashboard.html не читается');
} else {
    check(html.includes('data-tab="outlook"'), 'кнопка в сайдбаре: data-tab="outlook"');
    check(html.includes('data-tab-content="outlook"'), 'панель вкладки: data-tab-content="outlook"');
    const tabs = (/^const DEFAULT_TABS_VISIBLE = \[([^\]]+)\]/m.exec(html) || [])[1];
    const names = String(tabs || '').split(',').map((s) => s.trim().replace(/['"]/g, ''));
    check(names.includes('outlook'), `DEFAULT_TABS_VISIBLE содержит outlook (${names.length} вкладок)`);
    // Порядок в этом списке — порядок кнопок сайдбара. Ящики нужны рядом с гитхабами:
    // это два пула под одну и ту же регистрацию.
    check(names.indexOf('outlook') === names.indexOf('github') + 1,
        `outlook идёт сразу за github (получено: ${names[names.indexOf('outlook') - 1] || '—'} → outlook)`);

    // 🪤 Фронт и сервер писали параллельно, и первый же прогон дал молчаливую поломку на
    // стыке (фронт ждал `accounts`, сервер отдавал `entries`). Проверяем стык там, где он
    // проверяем статически: каждая ручка, которую фронт зовёт, обязана существовать.
    const used = new Set(Array.from(html.matchAll(/fetch\('(\/__switch\/api\/ol\/[a-z-]+)'/g), (m) => m[1].split('/ol/')[1]));
    const unknown = [...used].filter((r) => !(r in ROUTES));
    check(used.size > 0, `фронт зовёт ${used.size} ol-ручек`);
    check(unknown.length === 0, `все ручки, которые зовёт вкладка, есть на сервере${unknown.length ? ' — нет: ' + unknown.join(', ') : ''}`);

    // Пароль во фронт не приезжает вообще, значит его негде и прочитать: единственный
    // источник пароля на вкладке — поле формы ➕.
    const from = html.indexOf('// ═══════════════════ OUTLOOK');
    const to = from >= 0 ? html.indexOf('// ═══════════════════ ', from + 30) : -1;
    const front = from >= 0 ? html.slice(from, to > from ? to : html.length) : '';
    check(!!front, 'JS-блок вкладки найден по заголовку-разделителю');
    const reads = front.split('\n').filter((l) => /\b[a-z][\w$]*\.password\b/.test(l) && !/hasPassword/.test(l));
    check(reads.length === 0, `вкладка нигде не читает пароль из записи${reads.length ? ` — строк: ${reads.length}` : ''}`);
    check(/hasPassword/.test(front), 'вкладка показывает факт «пароль есть» через hasPassword');
    check(/ol-add-pass/.test(html), 'поле пароля есть только в форме заведения ящика');
}

// ── 11. Две тихие потери данных, каждая в одну строку ─────────────────────────
// Обе правки уже терялись однажды (`git reset --hard` 04.09) и ни одной проверкой не
// ловились: после потери код валиден, вкладка открывается, в логе тишина — просто ящик
// после «Проверить сессии» выглядит незалогиненным, а ник из формы не доезжает до пула.
// Поэтому проверки положительные: сторожим наличие правильной формы, а не отсутствие
// неправильной — вторую легко обойти переписыванием той же ошибки другими словами.
section('тихие потери данных · дата сессии и ник из формы');
{
    // 🪤 `sessionAt` — единственный след входа, когда снимок storageState не снялся:
    // open-session.js ставит эту дату ВНЕ try/catch снимка. Значит health-чек обязан
    // обновлять поле только вверх; присваивание с `: null` стирало его при каждом прогоне,
    // и возраст сессии считался по пустому месту → «сессии нет» на живом ящике.
    // 🪤 Прогон health-чека лежит ЗА границей `olBlock`: у него свой заголовок-разделитель
    // (`// ───── Health-чек ящиков…`), и срез ol-блока до него не доходит. Берём отдельным
    // срезом и сторожим сам срез — иначе проверки ниже зеленели бы от того, что искать негде.
    const HEALTH_HEAD = '// ───── Health-чек ящиков';
    const hFrom = proxy.indexOf(HEALTH_HEAD);
    const hTo = hFrom >= 0 ? proxy.indexOf('\n// ───── ', hFrom + HEALTH_HEAD.length) : -1;
    const healthBlock = hFrom >= 0 ? proxy.slice(hFrom, hTo > hFrom ? hTo : proxy.length) : '';
    check(!!healthBlock, 'блок health-чека найден по своему заголовку-разделителю');
    const health = body(healthBlock, 'olHealthRun') || '';
    check(!!health, 'функция olHealthRun найдена — прогон health-чека');
    const setsSession = health.split('\n').filter((l) => /x\.sessionAt\s*=/.test(l));
    check(setsSession.length === 1, `дату сессии прогон пишет одной строкой (нашлось ${setsSession.length})`);
    check(setsSession.length > 0 && setsSession.every((l) => !/:\s*null/.test(l)),
        'дата сессии не обнуляется при отсутствии снимка — иначе прогон стирает единственный след входа');
    check(/if \(st\)\s*x\.sessionAt\s*=/.test(health),
        'запись даты закрыта условием if (st) — поле обновляется по факту существующего файла');
    // Возраст в самом прогоне тоже обязан откатываться на дату из пула, иначе вход без
    // снимка попадёт в счётчик `missing` и вкладка предложит логиниться заново.
    check(/t\.sessionAt/.test(health), 'возраст в прогоне считается с откатом на sessionAt из пула');

    // 🪤 Форма ➕ шлёт `nickname`, `olNewEntry` его принимает и нормализует — но между ними
    // стоит литерал, и достаточно не перечислить в нём поле, чтобы подпись молча
    // подменилась частью адреса до `@`. Ошибки при этом нет: запись сохраняется.
    const add = body(olBlock, 'handleOlAdd') || '';
    check(!!add, 'функция handleOlAdd найдена');
    check(/nickname:\s*body\.nickname/.test(add),
        'ник доезжает из тела запроса: /ol/add передаёт nickname: body.nickname в olNewEntry');
    const entry = body(olBlock, 'olNewEntry') || '';
    check(/nickname:\s*String\(src\.nickname/.test(entry),
        'olNewEntry нормализует ник сам (trim + откат на локальную часть адреса) — хендлеру довольно передать сырое поле');
    if (html) {
        check(/api\/ol\/add[\s\S]{0,400}nickname:/.test(html),
            'форма заведения ящика во фронте действительно шлёт nickname — иначе проверка выше сторожила бы мёртвое поле');
    } else {
        skip('дашборд не читается — что шлёт форма ➕, проверить нечем');
    }
}

// ── итог ──────────────────────────────────────────────────────────────────────
// Самопроверка вывода: этот файл читают в чужом терминале и в скриншотах README, поэтому
// ни один адрес и ни один живой пароль не должны попасть в него даже случайно — например
// через текст ошибки парсера, где адрес стоит целиком.
{
    const leakEmail = printed.filter((l) => /[^\s:;|(]+@[^\s:;|)]+\.[A-Za-z]{2,}/.test(l));
    const leakPass = printed.filter((l) => [...secrets].some((s) => s.length > 3 && l.includes(s)));
    total += 2;
    if (leakEmail.length) { fails.push('в выводе есть адрес почты'); console.log(`  ✗ в выводе нет адресов почты — найдено строк: ${leakEmail.length}`); }
    else console.log('  ✓ в выводе нет ни одного адреса почты');
    if (leakPass.length) { fails.push('в выводе есть пароль из живого чека'); console.log(`  ✗ в выводе нет паролей — найдено строк: ${leakPass.length}`); }
    else console.log(`  ✓ в выводе нет паролей из живых чеков (сверено с ${secrets.size})`);
}

console.log(`\ncheck-outlook: ${total - fails.length}/${total}${skips.length ? `, пропущено ${skips.length}` : ''}`);
if (skips.length) for (const s of skips) console.log(`   · ${s}`);
if (fails.length) {
    console.log(`\n✗ провалено ${fails.length}:`);
    for (const m of fails) console.log(`   • ${m}`);
    console.log('\nЧто именно ломается от каждой из них — в шапке этого файла.');
    process.exit(1);
}
console.log('пул разбирается из живых чеков · пароль не покидает сервер · удаление сносит профиль и снимок');
