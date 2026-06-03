// Одноразовый инспектор instanttempemail.com.
// Запускает headed Chromium, сидит 30с (за это время можно глянуть как идёт письмо),
// дампит: URL, видимый текст, HTML, скриншот, список input/button/data-* атрибутов,
// сетевые запросы (REST/WS endpoints).
//
// Запуск:  node freemodel/lib/inspect_instanttempemail.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'logs', 'inspect_ite');
fs.mkdirSync(OUT, { recursive: true });

const stamp = Date.now();
const log = (msg) => {
    console.log(msg);
    fs.appendFileSync(path.join(OUT, `log_${stamp}.txt`), msg + '\n');
};

(async () => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Записываем все http(s) и ws запросы
    const reqs = [];
    page.on('request', r => {
        if (/^(https?|wss?):/.test(r.url())) {
            reqs.push({ method: r.method(), url: r.url(), type: r.resourceType() });
        }
    });
    page.on('websocket', ws => {
        log(`[WS] ${ws.url()}`);
        ws.on('framereceived', f => log(`[WS ←] ${String(f.payload).slice(0, 300)}`));
        ws.on('framesent', f => log(`[WS →] ${String(f.payload).slice(0, 300)}`));
    });

    log('[ITE] открываю https://instanttempemail.com/');
    await page.goto('https://instanttempemail.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    // Сразу дампим всё что видим
    const dumpPhase = async (label) => {
        const text = await page.locator('body').innerText().catch(() => '');
        const html = await page.content().catch(() => '');
        fs.writeFileSync(path.join(OUT, `${label}_${stamp}.txt`), text);
        fs.writeFileSync(path.join(OUT, `${label}_${stamp}.html`), html);
        await page.screenshot({ path: path.join(OUT, `${label}_${stamp}.png`), fullPage: true }).catch(() => {});
        log(`[ITE] dumped ${label} → text/html/png`);
    };

    await dumpPhase('initial');

    // Анализ интересных элементов
    const probe = await page.evaluate(() => {
        const pick = (el) => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            cls: el.className && typeof el.className === 'string' ? el.className : null,
            text: (el.innerText || '').slice(0, 120),
            value: el.value || null,
            placeholder: el.placeholder || null,
            attrs: Array.from(el.attributes || [])
                .filter(a => a.name.startsWith('data-') || ['name','role','type','aria-label','href'].includes(a.name))
                .map(a => `${a.name}="${a.value}"`).join(' '),
        });
        return {
            url: location.href,
            inputs: Array.from(document.querySelectorAll('input,textarea')).map(pick),
            buttons: Array.from(document.querySelectorAll('button,a[role=button]')).map(pick),
            // Всё что выглядит как email на странице
            emailLike: Array.from(document.querySelectorAll('*'))
                .filter(el => /[\w.+-]+@[\w.-]+\.\w{2,}/.test(el.innerText || ''))
                .slice(0, 10)
                .map(el => ({ ...pick(el), match: (el.innerText || '').match(/[\w.+-]+@[\w.-]+\.\w{2,}/)?.[0] })),
            // Кандидаты на inbox-контейнер
            possibleInbox: Array.from(document.querySelectorAll('[class*=inbox i],[class*=mail i],[class*=message i],[id*=inbox i],[role=list]'))
                .slice(0, 10).map(pick),
        };
    });
    fs.writeFileSync(path.join(OUT, `probe_${stamp}.json`), JSON.stringify(probe, null, 2));
    log(`[ITE] probe: ${probe.inputs.length} inputs, ${probe.buttons.length} buttons, ${probe.emailLike.length} email-like nodes`);
    if (probe.emailLike[0]) log(`[ITE]   email found: ${probe.emailLike[0].match}`);

    // Сетевые запросы за первые 5 сек
    fs.writeFileSync(path.join(OUT, `requests_${stamp}.json`), JSON.stringify(reqs, null, 2));
    log(`[ITE] ${reqs.length} requests so far`);

    log('[ITE] держу окно 60с. Если хочешь — отправь на видимый email письмо вручную, посмотрим как прилетит.');
    await page.waitForTimeout(60000);

    await dumpPhase('after_60s');
    fs.writeFileSync(path.join(OUT, `requests_final_${stamp}.json`), JSON.stringify(reqs, null, 2));

    log('[ITE] готово. Закрываю.');
    await browser.close();
})();
