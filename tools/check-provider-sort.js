// tools/check-provider-sort.js
//
// Регресс на таблицы денежных шлюзов в routing/proxy-dashboard.html: выбираемый порядок
// (newapiSortList + селекты {ar,go,tb}-sort + клик по заголовку колонки), колонка
// «Добавлен», фильтр и подвал со счётом.
//
// Ловим ровно то, что легко сломать невнимательной правкой:
//   • дефолт обязан повторять зашитый до 22.08 порядок — мёртвые вниз, внутри новые
//     сверху, личный аккаунт владельца вниз своей группы (иначе «ничего не менялось»
//     на глаз, а список поехал);
//   • аккаунт без опрошенного баланса уходит в конец при ОБОИХ направлениях: в
//     «баланс ↑» сверху должны стоять те, кто на нуле, а не те, о ком мы не знаем;
//   • «email A→Z» — плоский алфавит, мёртвые вниз НЕ уезжают, иначе это не A→Z;
//   • неизвестный режим (переименовали option, а localStorage помнит старое значение)
//     не роняет рендер, а откатывается на дефолт;
//   • заголовок колонки и селект — ОДНА ручка: клик пишет режим в селект, иначе два
//     элемента показывали бы разное;
//   • `table()` расширен для сортируемых заголовков, но остальные 15 вкладок дашборда
//     обязаны получать ту же разметку, что раньше;
//   • порядок переживает F5, а фильтр — НЕ должен: вернуться к таблице, которая молча
//     показывает 1 запись из 6, худший из сюрпризов.
//
// Сети здесь нет: страницу и все её запросы отдаёт перехватчик playwright, данные
// подставляем в state руками. Сервер :8200 запускать не нужно.
// Запуск: node tools/check-provider-sort.js

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DASH = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
// Хост выдуманный: до сети запрос не доходит, но origin у страницы http — без него
// localStorage в Chromium недоступен, а именно в нём живёт выбранный порядок.
const URL = 'http://dashboard.test/__switch';

let failed = 0;
function ok(cond, msg) {
    console.log(`${cond ? '✅' : '❌'} ${msg}`);
    if (!cond) failed++;
}
function eq(got, want, msg) {
    ok(got === want, `${msg}${got === want ? '' : `\n     ожидалось: ${want}\n     получено:  ${got}`}`);
}

// Набор специально злой: мёртвый аккаунт САМЫЙ богатый и САМЫЙ свежий, у одного живого
// баланс не опрошен, один без ключа, один — личный аккаунт владельца.
const ACCOUNTS = [
    { id: 'a1', email: 'bravo@x.io',     api_key: 'sk-aaaa1111', status: 'live', created: '2026-08-20T10:00:00Z', balance: 20 },
    { id: 'a2', email: 'alpha@x.io',     api_key: 'sk-bbbb2222', status: 'live', created: '2026-08-01T10:00:00Z', balance: 5 },
    { id: 'a3', email: 'charlie@x.io',   api_key: 'sk-cccc3333', status: 'live', created: '2026-08-10T10:00:00Z' },
    { id: 'a4', email: 'delta@x.io',     api_key: 'sk-dddd4444', status: 'dead', created: '2026-08-21T10:00:00Z', balance: 99 },
    { id: 'a5', email: 'echo@x.io',      api_key: 'pending',                     created: '2026-08-15T10:00:00Z' },
    { id: 'a6', email: 'WormAlien@x.io', api_key: 'sk-ffff6666', status: 'live', created: '2026-08-12T10:00:00Z', balance: 300 },
];

// «кто где» читаем по коротким именам, а не по email — так падение читается глазами
const NAME = { a1: 'live20', a2: 'live5', a3: 'noBal', a4: 'DEAD99', a5: 'noKey', a6: 'owner' };

async function main() {
    const html = fs.readFileSync(DASH, 'utf8');
    const browser = await chromium.launch();
    const page = await browser.newPage();

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    // Всё, что страница попросит: сама страница, пустой JSON на свои эндпоинты, пустышка
    // на CDN (tailwind/sortable). Без перехвата CDN тест зависел бы от интернета.
    await page.route('**/*', (route) => {
        const u = route.request().url();
        if (u === URL) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        if (/\.js(\?|$)/.test(u)) return route.fulfill({ contentType: 'application/javascript', body: '' });
        return route.fulfill({ contentType: 'application/json', body: '{}' });
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.newapiSortList === 'function', null, { timeout: 15000 });

    // --- 1. селекты на месте, набор пунктов разный ----------------------------------
    const opts = await page.evaluate(() => {
        const get = (id) => {
            const el = document.getElementById(id);
            return el ? [...el.options].map((o) => o.value) : null;
        };
        return { ar: get('ar-sort'), go: get('go-sort'), tb: get('tb-sort'), xp: get('xp-sort') };
    });
    const BASE = ['date-desc', 'date-asc', 'bal-desc', 'bal-asc', 'status', 'email'];
    eq(JSON.stringify(opts.ar), JSON.stringify([...BASE, 'gift']), 'AgentRouter: 6 режимов + 🎁 подарок');
    eq(JSON.stringify(opts.go), JSON.stringify(BASE), 'GoRouter: 6 режимов, без 🎁 (колонки чек-ина нет)');
    eq(JSON.stringify(opts.tb), JSON.stringify(BASE), 'Tabi: 6 режимов, без 🎁');
    ok(opts.xp === null, 'XPeach без селекта — вкладка легаси, сортировать нечего');

    // --- 2. порядок по режимам -------------------------------------------------------
    const order = (mode, prov, ownerLast) => page.evaluate(
        ([mode, prov, ownerLast, accounts, name]) => {
            localStorage.setItem('dash-sort-' + prov, mode);
            const el = document.getElementById(prov + '-sort');
            // селект перебивает localStorage, поэтому режим ставим и в него; неизвестное
            // значение DOM игнорирует — ровно тот случай, который и надо проверить
            if (el) el.value = mode;
            return newapiSortList(accounts, prov, { ownerLast }).map((s) => name[s.id]).join(' ');
        },
        [mode, prov, !!ownerLast, ACCOUNTS, NAME],
    );

    eq(await order('date-desc', 'tb', true), 'live20 noKey noBal live5 owner DEAD99',
        'дата ↓ повторяет зашитый до 22.08 порядок (новые сверху, owner и DEAD внизу)');
    eq(await order('date-asc', 'tb', true), 'live5 noBal noKey live20 owner DEAD99',
        'дата ↑ — старые сверху, инварианты те же');
    eq(await order('bal-desc', 'tb', true), 'owner live20 live5 noKey noBal DEAD99',
        'баланс ↓ — owner НЕ прячется вниз, мёртвый богач всё равно внизу');
    eq(await order('bal-asc', 'tb', true), 'live5 live20 owner noKey noBal DEAD99',
        'баланс ↑ — сверху нулевые, «не опрошен» в конце при обоих направлениях');
    eq(await order('status', 'tb', true), 'live20 owner noBal live5 noKey DEAD99',
        'статус — live, затем без ключа, затем мёртвые');
    eq(await order('email', 'tb', true), 'live5 live20 noBal DEAD99 noKey owner',
        'email A→Z — плоский алфавит, мёртвые вниз не уезжают');
    eq(await order('gift', 'ar'), 'live20 owner noBal live5 noKey DEAD99',
        '🎁 подарок — готовые к чек-ину сверху');
    eq(await order('несуществующий-режим', 'tb', true), 'live20 noKey noBal live5 owner DEAD99',
        'неизвестный режим (переименовали option) откатывается на дату ↓, а не падает');

    // --- 3. сквозной путь: селект → рендер таблицы ------------------------------------
    const rendered = await page.evaluate((accounts) => {
        state.agentrouter = accounts;
        const el = document.getElementById('ar-sort');
        el.value = 'bal-desc';
        el.dispatchEvent(new Event('change'));       // так же, как клик пользователя
        const cell = (tr) => tr.querySelector('td')?.textContent.trim().replace(/^🌟\s*/, '');
        return {
            rows: [...document.querySelectorAll('#ar-list tbody tr')].map(cell),
            saved: localStorage.getItem('dash-sort-ar'),
        };
    }, ACCOUNTS);
    eq(rendered.saved, 'bal-desc', 'выбор записан в localStorage');
    eq(rendered.rows.join(' '), 'WormAlien@x.io bravo@x.io alpha@x.io echo@x.io charlie@x.io delta@x.io',
        'таблица перерисовалась в выбранном порядке (без запроса к серверу)');

    // --- 4. выбор переживает F5 -------------------------------------------------------
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.newapiSortList === 'function', null, { timeout: 15000 });
    eq(await page.evaluate(() => document.getElementById('ar-sort').value), 'bal-desc',
        'после перезагрузки селект восстановлен из localStorage');

    // Мусор в хранилище не должен оставлять селект пустым: значения нет среди option,
    // восстановление обязано его проигнорировать.
    await page.evaluate(() => localStorage.setItem('dash-sort-go', 'gift'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.newapiSortList === 'function', null, { timeout: 15000 });
    eq(await page.evaluate(() => document.getElementById('go-sort').value), 'date-desc',
        'чужой режим в localStorage (🎁 у GoRouter) игнорируется, селект остаётся на дефолте');

    // --- 5. колонка «Добавлен» ---------------------------------------------------------
    const dateCol = await page.evaluate((accounts) => {
        state.agentrouter = accounts;
        document.getElementById('ar-filter').value = '';
        document.getElementById('ar-sort').value = 'date-desc';
        renderAr();
        const heads = [...document.querySelectorAll('#ar-list thead th')].map((th) => th.textContent.trim());
        const idx = heads.findIndex((h) => h.startsWith('Добавлен'));
        const first = document.querySelector('#ar-list tbody tr');
        const cell = idx >= 0 ? first.querySelectorAll('td')[idx] : null;
        return { heads, idx, text: cell && cell.textContent.trim(), tip: cell && cell.querySelector('span')?.title };
    }, ACCOUNTS);
    ok(dateCol.idx >= 0, `колонка «Добавлен» есть (${dateCol.heads.length} колонок: ${dateCol.heads.join(' | ')})`);
    eq(dateCol.text, '20.08', 'дата этого года — без года, чтобы колонка была узкой');
    ok(/^Добавлен .*· \d+[сдмч] назад$/.test(dateCol.tip || ''), `тултип с полной датой и возрастом: «${dateCol.tip}»`);

    // --- 6. заголовок колонки — та же ручка, что селект ---------------------------------
    const hdr = await page.evaluate((accounts) => {
        state.agentrouter = accounts;
        document.getElementById('ar-filter').value = '';
        document.getElementById('ar-sort').value = 'date-desc';
        renderAr();
        // каждый раз ищем заново: клик перерисовывает thead целиком
        const btn = (txt) => [...document.querySelectorAll('#ar-list thead th button')]
            .find((b) => b.textContent.trim().startsWith(txt));
        const mode = () => document.getElementById('ar-sort').value;
        const out = { sortable: [...document.querySelectorAll('#ar-list thead th')].map((th) => (th.querySelector('button') ? '*' : '') + th.textContent.trim().split(' ')[0]) };
        out.dateMark = btn('Добавлен').textContent.trim();
        btn('Баланс').click();  out.bal1 = mode();
        btn('Баланс').click();  out.bal2 = mode();      // повторный клик по активной = разворот
        out.balMark = btn('Баланс').textContent.trim();
        btn('Email').click();   out.mail1 = mode();
        btn('Email').click();   out.mail2 = mode();     // пары нет — режим не меняется
        out.mailMark = btn('Email').textContent.trim();
        return out;
    }, ACCOUNTS);
    eq(hdr.sortable.join(' '), '*Email API *Status *Баланс *🎁 GitHub *Добавлен Actions',
        'кнопками стали только сортируемые заголовки (API Key, GitHub, Actions — нет)');
    eq(hdr.dateMark, 'Добавлен ↓', 'активная направленная колонка помечена стрелкой');
    eq(hdr.bal1, 'bal-desc', 'клик по «Баланс» ставит баланс ↓');
    eq(hdr.bal2, 'bal-asc', 'повторный клик разворачивает в баланс ↑');
    eq(hdr.balMark, 'Баланс ↑', 'стрелка развернулась вместе с порядком');
    eq(hdr.mail1, 'email', 'клик по «Email» ставит email A→Z');
    eq(hdr.mail2, 'email', 'повторный клик по «Email» ничего не меняет — пары у режима нет');
    eq(hdr.mailMark, 'Email ·', 'у ненаправленного режима точка, а не стрелка: клик разворота не делает');

    // --- 7. table() для остальных 15 вкладок не изменился -------------------------------
    const plain = await page.evaluate(() => table([{ label: 'A' }, { label: 'B', align: 'center' }], '<tr></tr>', 'подвал'));
    ok(!plain.includes('<button'), 'заголовки без `sort` остались обычными <th> — 15 других вкладок не задеты');
    ok(plain.includes('подвал'), 'подвал на месте');

    // --- 8. фильтр и подвал -------------------------------------------------------------
    const shot = (q) => page.evaluate(([accounts, q]) => {
        state.agentrouter = accounts;
        document.getElementById('ar-sort').value = 'date-desc';
        const f = document.getElementById('ar-filter');
        f.value = q;
        f.dispatchEvent(new Event('input'));
        return {
            rows: [...document.querySelectorAll('#ar-list tbody tr')].map((tr) => tr.querySelector('td').textContent.trim()),
            foot: document.querySelector('#ar-list > div')?.textContent.trim() || '',
            empty: document.querySelector('#ar-list > div.p-12')?.textContent.trim() || '',
        };
    }, [ACCOUNTS, q]);

    const none = await shot('');
    eq(none.foot, '6 ключей · 🟢 4 live · 🔴 1 dead · ⚪ 1 без ключа · 🎁 4 подарка',
        'подвал вместо «6 ключей» считает то, что иначе считаешь глазами');
    const byMail = await shot('alpha');
    eq(byMail.rows.join(' '), 'alpha@x.io', 'фильтр по email');
    eq(byMail.foot, 'показано 1 из 6 · 🟢 1 live · 🎁 1 подарок',
        'при фильтре подвал показывает «сколько из сколько», нули не печатаются');
    const byKey = await shot('dddd4444');
    eq(byKey.rows.join(' '), 'delta@x.io', 'фильтр находит по хвосту API-ключа');
    const nothing = await shot('такого-нет');
    ok(/ничего — 0 из 6/.test(nothing.empty), `пустой результат объясняет себя: «${nothing.empty}»`);
    await page.evaluate(() => { const f = document.getElementById('ar-filter'); f.value = ''; f.dispatchEvent(new Event('input')); });

    // --- 9. фильтр НЕ переживает F5 ----------------------------------------------------
    await page.evaluate(() => {
        const f = document.getElementById('ar-filter');
        f.value = 'alpha';
        f.dispatchEvent(new Event('input'));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.newapiSortList === 'function', null, { timeout: 15000 });
    eq(await page.evaluate(() => document.getElementById('ar-filter').value), '',
        'фильтр после F5 пуст — вернуться к таблице, молча показывающей 1 из 6, нельзя');

    // Ошибки страницы, не связанные с заглушённой сетью и отсутствующим tailwind.
    const real = errors.filter((e) => !/Failed to load|net::|Unexpected end of JSON|Tailwind|SyntaxError: Unexpected token/i.test(e));
    ok(real.length === 0, `консоль без своих ошибок${real.length ? ':\n     ' + real.slice(0, 5).join('\n     ') : ''}`);

    await browser.close();
    console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ всё зелёное');
    process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('❌ ' + e.stack); process.exit(1); });
