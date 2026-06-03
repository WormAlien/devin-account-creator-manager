// freemodel/lib/test_instanttempemail.js
//
// Одноразовый тест клиента instanttempemail.
//   1. Создаёт ящик, печатает адрес и токен.
//   2. Поллит inbox каждые 4с, показывает что приходит.
//   3. Для каждого письма: ключи объекта, текст-haystack, извлечённый OTP, magic-link.
//   4. Никакого fromHint фильтра — всё письмо проходит, чтобы видеть и спам.
//
// Запуск:
//   node freemodel/lib/test_instanttempemail.js
//
// Что делать:
//   - получи адрес из консоли
//   - со своего gmail пошли на него письмо с "Your code is 123456" (или любой текст)
//   - смотри в консоль — должно вытащить 123456
//   - Ctrl+C когда наглядишься

const ite = require('./instanttempemail');

(async () => {
    console.log('[test] создаю ящик...');
    const { address, token, expires } = await ite.createEmail();
    console.log(`[test] адрес : ${address}`);
    console.log(`[test] token : ${token}`);
    console.log(`[test] истечёт: ${expires}`);
    console.log('[test] поллинг каждые 4с. Шли на этот адрес письмо.');
    console.log('[test] Ctrl+C для выхода.\n');

    const seen = new Set();
    while (true) {
        let emails = [];
        try {
            emails = await ite.fetchInbox(token);
        } catch (e) {
            console.log(`[test] inbox error: ${e.message}`);
            await sleep(4000);
            continue;
        }

        for (let i = 0; i < emails.length; i++) {
            const em = emails[i];
            const id = JSON.stringify({
                k: Object.keys(em).sort(),
                s: (em.subject || em.title || em.from || JSON.stringify(em)).toString().slice(0, 60),
            });
            if (seen.has(id)) continue;
            seen.add(id);

            console.log(`\n━━━━━━━━━━ письмо #${i} ━━━━━━━━━━`);
            console.log(`[ключи] ${Object.keys(em).join(', ')}`);
            console.log(`[raw  ] ${JSON.stringify(em).slice(0, 600)}`);
            const text = ite.emailToText(em);
            console.log(`[text ] ${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`);
            const code = ite.extractOtp6(text);
            const link = ite.extractMagicLink(text);
            console.log(`[OTP  ] ${code || '(не нашёл 6-значного кода)'}`);
            console.log(`[link ] ${link || '(нет freemodel.dev ссылки)'}`);
        }

        process.stdout.write('.');
        await sleep(4000);
    }
})().catch(e => {
    console.error(`💥 ${e.message}`);
    process.exit(1);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
