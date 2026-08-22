#!/usr/bin/env node
/**
 * check-gh-cred-pop.js — регресс-тест пути «регистрация из менеджера гитхабов в один клик».
 *
 * Инвариант одной строкой: клик по нику в пикере «🐙 из менеджера» доводит дело до конца
 * (создаёт запись и открывает регистрацию), а креды всплывают окном, приклеенным к строке
 * этого аккаунта, с живым 2FA.
 *
 * Почему файл существует: вся правка живёт в одном 17-тысячном `proxy-dashboard.html`, и
 * держится она на связках, которые легко разорвать, не заметив:
 *   - окно клеится к `tr[data-acct-id]` — стоит убрать якорь из рендера пула, и оно
 *     молча не покажется (позиционировать не от чего);
 *   - 2FA в окне тикает только потому, что `ghStartTimer` больше не выходит на невидимой
 *     вкладке GitHub, а `ghRenderCountdowns` обходит и окно тоже;
 *   - пикер обязан работать без индекса профилей (деградация), иначе первый холодный
 *     запуск оставит владельца с пустым списком;
 *   - запись создаётся тем же телом, что «Сохранить» (`api_key: ''`), иначе в пуле
 *     появятся записи с чужой формой и `no_key` не сработает.
 *
 * Проверка статическая: сети и браузера не требует, читает файл и парсит инлайн-скрипты.
 *
 * Запуск:  node tools/check-gh-cred-pop.js        (exit 1 = связка порвана)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');

const fails = [];
const ok = [];

let html = '';
try {
    html = fs.readFileSync(HTML, 'utf8');
} catch (e) {
    console.log(`  FAIL не читается ${HTML}: ${e.message}`);
    process.exit(1);
}

// Тело функции по имени: от объявления до строки, начинающейся с `}` в нулевой колонке.
// Годится ровно потому, что в этом файле все функции верхнего уровня так и отформатированы.
function body(name) {
    const re = new RegExp(`\\n(?:async )?function ${name}\\s*\\(`);
    const m = re.exec(html);
    if (!m) return null;
    const from = m.index + 1;
    const end = html.indexOf('\n}\n', from);
    return end < 0 ? html.slice(from) : html.slice(from, end + 3);
}

function has(name, needle, why) {
    const b = body(name);
    if (b === null) return fails.push(`функции ${name}() в файле нет — путь переименовали или снесли`);
    if (!b.includes(needle)) fails.push(`${name}(): нет «${needle}» — ${why}`);
    else ok.push(`${name}(): ${needle}`);
}

function hasNot(name, needle, why) {
    const b = body(name);
    if (b === null) return fails.push(`функции ${name}() в файле нет`);
    if (b.includes(needle)) fails.push(`${name}(): осталось «${needle}» — ${why}`);
    else ok.push(`${name}(): без «${needle}»`);
}

// ---- 1. Инлайн-скрипты вообще парсятся -------------------------------------
// Дешёвая проверка, которая ловит самое дорогое: сломанный шаблонный литерал гасит
// весь дашборд целиком, а не одну кнопку.
{
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
    let m, n = 0, bad = 0;
    while ((m = re.exec(html))) {
        if (/\bsrc=/.test(m[1])) continue;
        n++;
        try { new vm.Script(m[2], { filename: `inline-${n}` }); }
        catch (e) { bad++; fails.push(`инлайн-скрипт #${n} не парсится: ${e.message}`); }
    }
    if (!n) fails.push('в файле не нашлось ни одного инлайн-скрипта — парсер проверки сломан');
    else if (!bad) ok.push(`инлайн-скриптов ${n}, все парсятся`);
}

// ---- 2. Якорь строки в четырёх пулах ---------------------------------------
// XPeach сознательно не в счёте: вкладка легаси, догонять её не требуется. Остальные
// четыре обязаны быть все: список тегов перечислением, потому что число «≥3» пропустило
// бы пятый шлюз (jw, 22.08) молча — проверка осталась бы зелёной, ничего не проверив.
const CRED_TAGS = ['ar', 'go', 'tb', 'jw'];
{
    const anchors = (html.match(/<tr data-acct-id="\$\{esc\(s\.id \|\| ''\)\}"/g) || []).length;
    if (anchors < CRED_TAGS.length) fails.push(`строк с data-acct-id только ${anchors}, нужно ≥${CRED_TAGS.length} (${CRED_TAGS.join('/')}) — окну кредов не к чему клеиться`);
    else ok.push(`якорь data-acct-id в ${anchors} рендерах пула`);
    const seen = new Set(Array.from(html.matchAll(/\$\{ghCredBtn\(s, '([a-z]{2})', idJ\)\}/g), m => m[1]));
    const missing = CRED_TAGS.filter(t => !seen.has(t));
    if (missing.length) fails.push(`кнопки ghCredBtn нет на вкладках: ${missing.join(', ')} — там окно кредов не вызвать повторно`);
    else ok.push(`кнопка «🐙 креды» в ${seen.size} таблицах (${[...seen].join(', ')})`);
}


// ---- 3. Тикер добивает до окна ---------------------------------------------
has('ghRenderCountdowns', 'ghCredPopSync()', 'окно не переклеится после перерисовки таблицы');
has('ghRenderCountdowns', 'ghCredPopEl', 'отсчёт и подмена кода в окне встанут');
has('ghStartTimer', '!gridVisible && !ghCredPopEl',
    'тикер снова будет выходить на чужой вкладке, и 2FA в окне замрёт на прошлом окне');

// ---- 4. Пикер: развилка и деградация ---------------------------------------
has('newapiAddPickLoad', '/__switch/api/gh/available', 'пикер перестал узнавать, у кого есть сессия');
has('newapiAddPickLoad', 'newapiAddPickRender(prov, null,',
    'без ветки деградации холодный индекс оставит список пустым');
has('newapiAddPickRender', 'ghRowPickBlock', 'запреты в списке разъедутся с заселением');
has('newapiAddTakeGh', 'newapiAddInstant', 'клик перестал заводить запись');
has('newapiAddTakeGh', 'newapiAddSeedPick', 'клик по нику с готовой сессией перестал заселять');
hasNot('newapiAddTakeGh', 'mail.value',
    'вернулась подстановка в поле формы — это ровно те два лишних шага, которые убрали');

// ---- 5. Запись создаётся тем же телом, что «Сохранить» ---------------------
has('newapiAddInstant', "api_key: ''",
    'без пустого ключа сервер не поставит заглушку и status no_key, а значит не откроется регистрация');
has('newapiAddInstant', '/session/open', 'регистрация не стартует, останется просто запись в пуле');
has('newapiAddInstant', 'ghCredPopOpen(', 'креды после создания не всплывут');
// Заселение — сегодня это ЕДИНСТВЕННЫЙ живой путь (у всех аккаунтов пула сессия есть),
// и без этой строки окно не появлялось бы вообще никогда.
has('newapiAddGithub', 'ghCredPopOpen(', 'на пути заселения окно кредов не всплывёт');
has('ghCredPopOpen', 'loadGhKeys', 'вызов с пути заселения промолчит: хранилище там ещё не загружено');

// ---- 6. Один источник вердикта на два списка -------------------------------
has('newapiSeedRender', 'ghRowSeedBlock', 'модалка заселения снова считает запреты сама — они разъедутся с пикером');

// ---- 7. Личная привязка кредов не показывает ------------------------------
has('ghCredBtn', "ghId === 'personal'", 'у личного GitHub пароля нет вообще, кнопка обещала бы несуществующее');
has('ghCredPopOpen', "ghId === 'personal'", 'то же для прямого вызова окна');

// ---- 8. Окно не должно догонять страницу из JS (2026-08-22) ----------------
// Жалоба владельца: «окно когда появляется очень лагуче перемещается». Замерено: на
// `fixed` + подписке на `scroll` окно отставало от строки на 106 кадрах из 108 и до
// 413 px. После перевода в документные координаты — 0 кадров из 207 при 748 px прокрутки.
// Ниже — четыре условия, любое из которых в одиночку возвращает дёрганье.
{
    const b = body('ghCredPopOpen') || '';
    if (/'absolute z-\[150\]|"absolute z-\[150\]/.test(b) || b.includes('absolute z-[150]')) ok.push('ghCredPopOpen(): окно position:absolute (едет со страницей, не догоняет её)');
    else fails.push('ghCredPopOpen(): окно снова не absolute — на fixed его двигает JS, и оно отстаёт от прокрутки');
    if (b.includes("visibility = 'hidden'")) ok.push('ghCredPopOpen(): окно скрыто до позиционирования');
    else fails.push('ghCredPopOpen(): нет visibility=hidden до place() — окно вспыхнет на статическом месте и прыгнет (рендер асинхронный, 2 кадра замером)');
}
{
    const b = body('ghCredPopPlace') || '';
    if (b.includes('window.scrollY')) ok.push('ghCredPopPlace(): координаты документные (+scrollY)');
    else fails.push('ghCredPopPlace(): координаты снова в системе окна — окно оторвётся от строки при прокрутке');
    if (b.includes('!r.width && !r.height')) ok.push('ghCredPopPlace(): нулевой rect скрытой вкладки отбит');
    else fails.push('ghCredPopPlace(): нет защиты от нулевого rect — строка чужой (скрытой) таблицы уносит окно в угол (8,6)');
    if (b.includes('ghCredPop.above')) ok.push('ghCredPopPlace(): сторона запоминается, а не пересчитывается на каждом сдвиге');
    else fails.push('ghCredPopPlace(): сторона считается заново — окно перескочит на свою высоту посреди прокрутки (замерено 409 px)');
    // Зажим по вертикали обязан быть по ДОКУМЕНТУ (`Math.max(0, …)`). Сравниваем по коду
    // без комментариев: в них та самая ловушка описана дословно и ловилась бы regex'ом.
    const code = b.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    if (/const top = Math\.max\(0,/.test(code)) ok.push('ghCredPopPlace(): вертикальный зажим по документу, не по кромке экрана');
    else fails.push('ghCredPopPlace(): зажим не Math.max(0, …) — вариант с кромкой экрана перепривязывает окно к прокрутке (замерено 386 px)');
}
{
    // Подписка на scroll — ровно то, что убрали. Ищем во всём файле: она жила
    // не внутри функции, а рядом с ней.
    if (!/addEventListener\('scroll',\s*ghCredPopSync/.test(html)) ok.push('нет подписки ghCredPopSync на scroll');
    else fails.push("вернулась addEventListener('scroll', ghCredPopSync) — это и есть источник дёрганья");
}

for (const s of ok) console.log(`  ok   ${s}`);
for (const s of fails) console.log(`  FAIL ${s}`);
if (fails.length) {
    console.log(`\n[X] связка «клик из менеджера → запись → регистрация → окно кредов» порвана: ${fails.length} проблем(ы).`);
    console.log('    Разбор — wiki/entities/ABUSE HUB.md § «Регистрация из менеджера в один клик».');
    process.exit(1);
}
console.log('\n[OK] путь «из менеджера в один клик» цел');
