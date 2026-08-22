#!/usr/bin/env node
/**
 * check-autorotate.js — регресс-тест авторотации аккаунтов денежных шлюзов.
 *
 * Зачем файл существует. Шлюз отказывает по деньгам ПОСРЕДИ работы Claude Code:
 * `403 Insufficient account balance` или его китайский вариант
 * `预扣费额度失败, 用户剩余额度: $0.309854, 需要预扣费额度: $0.800000`. До ротации оба
 * текста доезжали до клиента и роняли задачу, хотя в пуле лежали живые деньги
 * (замер 22.08: активный аккаунт GoRouter −$0.16 при $2006 на 25 живых ключах).
 * Теперь keepalive-прокси на такой ответ просит дашборд подменить активный ключ и
 * повторяет запрос. Цена ошибки в этой логике — либо запрос всё равно падает в лицо
 * пользователю, либо пул прокручивается зря и деньги размазываются по огрызкам.
 *
 * Что проверяем:
 *   1. выбор кандидата: самый маленький, которому ХВАТАЕТ (жирные — в резерве);
 *   2. цепочку: кеш обещал деньги, живой чек показал меньше нужного → следующий;
 *   3. пометки ушедшему аккаунту (dead / реальный остаток из текста ошибки);
 *   4. дедуп и мьютекс: пять параллельных сессий Orca = одна подмена, не пять;
 *   5. сухой пул: ротации нет, ошибка обязана уйти клиенту (врать нельзя);
 *   6. ротация НЕ трогает settings.json (иначе бэкап и запись на каждый отказ);
 *   7. в прокси проверка «нет баланса» стоит РАНЬШЕ isTransientBody — иначе
 *      китайский текст съест RETRY_NO_ZH, а английский уйдёт в три пустых ретрая;
 *   8. таблицы хостов дашборда и прокси совпадают (иначе прокси звонит в никуда).
 *
 * Как: вырезает ТЕКСТ функций ротации из transparent-proxy.js и прогоняет их в
 * песочнице с заглушками fs/баланса. Ни одного сетевого запроса, живые пулы и
 * `~/.claude/*-active-key.txt` не задеты.
 *
 * Запуск: node tools/check-autorotate.js      (exit 1 = ротация сломана)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DASH = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const KA = path.join(__dirname, '..', 'routing', 'keepalive-proxy.js');
const HTML = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
const src = fs.readFileSync(DASH, 'utf8');
const kaSrc = fs.readFileSync(KA, 'utf8');
const htmlSrc = fs.readFileSync(HTML, 'utf8');

const fails = [];
const ok = [];
function check(cond, msg) { (cond ? ok : fails).push(msg); }

// Вырезать функцию по балансу фигурных скобок (как в check-keepalive-bring.js):
// тело считаем только ПОСЛЕ списка параметров, иначе дефолт аргумента `opts = {}`
// закрывает счётчик на себе же.
function cutFn(text, head) {
    const start = text.indexOf(head);
    if (start < 0) throw new Error(`не нашёл в исходнике: ${head}`);
    let i = start, paren = 0, sawParen = false;
    for (; i < text.length; i += 1) {
        const c = text[i];
        if (c === '(') { paren += 1; sawParen = true; }
        else if (c === ')') { paren -= 1; if (sawParen && paren === 0) { i += 1; break; } }
    }
    let depth = 0, seen = false;
    for (; i < text.length; i += 1) {
        const c = text[i];
        if (c === '{') { depth += 1; seen = true; }
        else if (c === '}') {
            depth -= 1;
            if (seen && depth === 0) return text.slice(start, i + 1);
        }
    }
    throw new Error(`не смог закрыть тело: ${head}`);
}
// Однострочное объявление константы — берём ИЗ ИСХОДНИКА, а не подставляем своё
// число: тест обязан ломаться, если порог в коде поедет.
function cutConst(text, name) {
    const m = new RegExp(`^const ${name} = [^\\n]+$`, 'm').exec(text);
    if (!m) throw new Error(`не нашёл константу ${name}`);
    return m[0];
}

const parts = [
    cutConst(src, 'MONEY_MIN_BAL'),
    cutConst(src, 'MONEY_MAX_PROBES'),
    cutConst(src, 'MONEY_DEDUP_MS'),
    cutConst(src, 'moneyAuto'),
    cutConst(src, 'moneyAutoShared'),
    cutFn(src, 'function moneyState('),
    cutFn(src, 'function moneyUsable('),
    cutFn(src, 'function moneyRank('),
    cutFn(src, 'function moneySwitchKey('),
    cutFn(src, 'async function moneyRotate('),
];

// ── Песочница ────────────────────────────────────────────────────────────────
// Пул задаётся списком {name, balance, status}. balanceFn отдаёт «живую» цифру:
// по умолчанию ту же, что в кеше; live[name] — если хотим расхождение (кеш врал).
function makeWorld(opts = {}) {
    const pool = (opts.pool || []).map((s, i) => Object.assign({
        id: 'go_' + i,
        email: s.name,
        api_key: s.key || ('sk-' + s.name),
        active: false,
        status: 'live',
    }, s));
    const world = {
        pool, saves: 0, probes: [], logs: [],
        keyFile: { 'go.txt': opts.activeKey || (pool.find(s => s.active) || {}).api_key || '' },
    };
    const deps = {
        fs: {
            readFileSync: (f) => {
                if (f !== 'go.txt') throw new Error('ENOENT ' + f);
                return world.keyFile['go.txt'];
            },
            writeFileSync: (f, v) => { world.keyFile[f] = v; },
        },
        logLine: (m) => world.logs.push(m),
        isRealKey: (k) => /^sk-/.test(String(k || '').trim()),
        round2: (v) => Math.round(Number(v) * 100) / 100,
        MONEY_GW: {
            go: {
                tag: 'gorouter', label: 'GoRouter', host: 'gorouter.app', keyFile: 'go.txt',
                load: () => world.pool,
                save: () => { world.saves += 1; },
                balanceFn: async (target) => {
                    world.probes.push(target.email);
                    const live = (opts.live || {})[target.email];
                    return { status: 'live', balance: live === undefined ? target.balance : live };
                },
                applyFn: (target, bal) => { target.balance = bal.balance; target.status = bal.status; },
            },
        },
        Date,
    };
    const factory = new Function('deps', `
        const { fs, logLine, isRealKey, round2, MONEY_GW } = deps;
        ${parts.join('\n')}
        return { moneyRotate, moneyRank, moneyUsable, moneyState, moneyAutoShared, MONEY_MIN_BAL };
    `);
    world.api = factory(deps);
    return world;
}
const activeKeyOf = (w) => w.keyFile['go.txt'];
const nameByKey = (w, key) => (w.pool.find(s => s.api_key === key) || {}).email || null;

async function main() {
    // 1. Кандидат — самый маленький, которому хватает. Огрызок ниже порога не берём:
    //    на нём предоплата под запрос не пройдёт, и мы бы вернулись сюда же.
    {
        const w = makeWorld({
            pool: [
                { name: 'active', balance: -0.16, active: true },
                { name: 'fat', balance: 1338.48 },
                { name: 'crumb', balance: 0.11 },
                { name: 'small', balance: 1.85 },
                { name: 'mid', balance: 77.16 },
            ],
        });
        w.api.moneyState('go').enabled = true;
        const r = await w.api.moneyRotate('go', { reason: 'out-of-balance', fromKey: 'sk-active' });
        check(r.ok && nameByKey(w, activeKeyOf(w)) === 'small',
            `выбран самый маленький достаточный: ${r.email} (ждали small $1.85)`);
        check(w.pool.filter(s => s.active).length === 1 && w.pool.find(s => s.active).email === 'small',
            'флаг active переставлен ровно на одного');
        check(w.probes.length === 1, `живой чек только у выбранного кандидата (было ${w.probes.length})`);
    }

    // 2. Порог из кода, а не из головы: 0.11 не годится, 1.85 годится.
    {
        const w = makeWorld({ pool: [{ name: 'a', balance: 5 }] });
        check(w.api.MONEY_MIN_BAL >= 0.8,
            `порог годности ${w.api.MONEY_MIN_BAL} покрывает предоплату шлюза ($0.80 в пойманной ошибке)`);
    }

    // 3. Шлюз сказал, сколько нужно ($5) — маленькие мимо, берём самого маленького из
    //    достаточных. Так работает «если на маленьком не хватает, ротируй дальше».
    {
        const w = makeWorld({
            pool: [
                { name: 'active', balance: 0.3, active: true },
                { name: 'small', balance: 1.85 },
                { name: 'enough', balance: 7.34 },
                { name: 'fat', balance: 79.12 },
            ],
        });
        w.api.moneyState('go').enabled = true;
        const r = await w.api.moneyRotate('go', { reason: 'out-of-balance', fromKey: 'sk-active', needUsd: 5 });
        check(r.ok && r.email === 'enough', `нужно $5 → взят enough $7.34 (получили ${r.email})`);
    }

    // 4. Цепочка: кеш обещал деньги, живой чек показал меньше нужного → следующий.
    //    Ровно этот случай владелец назвал «если не хватит, оно должно ротировать дальше».
    {
        const w = makeWorld({
            pool: [
                { name: 'active', balance: 0, active: true },
                { name: 'stale', balance: 4.69 },     // в кеше $4.69...
                { name: 'real', balance: 5.37 },
            ],
            live: { stale: 0.02 },                    // ...а на самом деле $0.02
        });
        w.api.moneyState('go').enabled = true;
        const r = await w.api.moneyRotate('go', { reason: 'out-of-balance', fromKey: 'sk-active' });
        check(r.ok && r.email === 'real', `протухший кандидат пропущен, взят real (получили ${r.email})`);
        check(w.probes.join(',') === 'stale,real', `порядок проверок stale→real (было ${w.probes.join(',')})`);
        check(w.pool.find(s => s.email === 'stale').balance === 0.02, 'кеш протухшего исправлен живой цифрой');
    }

    // 5. Пометки ушедшему: мёртвый ключ → status dead; остаток из текста ошибки → в кеш.
    {
        const w = makeWorld({ pool: [{ name: 'active', balance: 3, active: true }, { name: 'next', balance: 9 }] });
        w.api.moneyState('go').enabled = true;
        await w.api.moneyRotate('go', { reason: 'dead', fromKey: 'sk-active' });
        check(w.pool.find(s => s.email === 'active').status === 'dead', 'ушедший по dead помечен status:dead');
    }
    {
        const w = makeWorld({ pool: [{ name: 'active', balance: 12, active: true }, { name: 'next', balance: 9 }] });
        w.api.moneyState('go').enabled = true;
        await w.api.moneyRotate('go', { reason: 'out-of-balance', fromKey: 'sk-active', leftUsd: 0.309854 });
        const gone = w.pool.find(s => s.email === 'active');
        check(gone.balance === 0.31 && gone.balanceSource === 'gateway',
            `остаток из текста ошибки лёг в кеш: ${gone.balance} / ${gone.balanceSource}`);
        check(gone.status !== 'dead', 'аккаунт без денег НЕ помечается мёртвым — деньги вернутся, ключ живой');
    }

    // 6. Дедуп: второй отказ на СТАРОМ ключе сразу после подмены не крутит пул заново.
    //    Без этого пять сессий Orca на одном ключе высаживают пять аккаунтов подряд.
    {
        const w = makeWorld({
            pool: [
                { name: 'active', balance: 0, active: true },
                { name: 'first', balance: 10 },
                { name: 'second', balance: 20 },
            ],
        });
        w.api.moneyState('go').enabled = true;
        const a = await w.api.moneyRotate('go', { reason: 'out-of-balance', fromKey: 'sk-active' });
        const b = await w.api.moneyRotate('go', { reason: 'out-of-balance', fromKey: 'sk-active' });
        check(a.ok && a.email === 'first', `первая подмена → first (${a.email})`);
        check(b.ok && b.already === true, 'вторая просьба с тем же старым ключом → already, без новой подмены');
        check(nameByKey(w, activeKeyOf(w)) === 'first', 'активным остался first');
    }

    // 7. Мьютекс: пять одновременных просьб = одна подмена.
    {
        const w = makeWorld({
            pool: [
                { name: 'active', balance: 0, active: true },
                { name: 'first', balance: 10 },
                { name: 'second', balance: 20 },
                { name: 'third', balance: 30 },
            ],
        });
        w.api.moneyState('go').enabled = true;
        const rs = await Promise.all(Array.from({ length: 5 }, () =>
            w.api.moneyRotate('go', { reason: 'out-of-balance', fromKey: 'sk-active' })));
        check(rs.every(r => r.ok && r.email === rs[0].email), 'все пять получили один и тот же аккаунт');
        check(w.probes.length === 1, `живой чек сделан один раз (было ${w.probes.length})`);
    }

    // 8. Сухой пул: подменять нечем — честный отказ, чтобы прокси отдал ошибку клиенту.
    {
        const w = makeWorld({
            pool: [
                { name: 'active', balance: 0, active: true },
                { name: 'dead', balance: 50, status: 'dead' },        // деньги на мёртвом ключе не деньги
                { name: 'nokey', balance: 50, key: 'no-key-abc' },    // заглушка вместо ключа
                { name: 'crumb', balance: 0.2 },                      // ниже порога
            ],
        });
        w.api.moneyState('go').enabled = true;
        const r = await w.api.moneyRotate('go', { reason: 'out-of-balance', fromKey: 'sk-active' });
        check(!r.ok && r.error === 'pool-dry', `сухой пул → pool-dry (получили ${JSON.stringify(r)})`);
        check(nameByKey(w, activeKeyOf(w)) === 'active', 'активный ключ не тронут');
    }

    // 9. Предикат годности: мёртвый / без ключа / без цифры баланса — не кандидаты.
    {
        const w = makeWorld({ pool: [] });
        const u = w.api.moneyUsable;
        check(u({ api_key: 'sk-x', balance: 5, status: 'live' }), 'живой с балансом — кандидат');
        check(!u({ api_key: 'sk-x', balance: 5, status: 'dead' }), 'мёртвый ключ — не кандидат');
        check(!u({ api_key: 'no-key-1', balance: 5 }), 'заглушка вместо ключа — не кандидат');
        check(!u({ api_key: 'sk-x', status: 'live' }), 'без опрошенного баланса — не кандидат');
        check(!u({ api_key: 'sk-x', balance: 5, banned: true }), 'забаненный вручную — не кандидат');
    }

    // 10. Ротация не трогает settings.json: провайдер тот же, база уже смотрит на его
    //     keepalive. Иначе на каждый отказ шлюза мы бы писали settings и плодили бэкапы.
    {
        const body = cutFn(src, 'async function moneyRotate(') + cutFn(src, 'function moneySwitchKey(');
        check(!/SETTINGS_FILE|writeSettings|makeSettingsBackup/.test(body),
            'moneyRotate/moneySwitchKey не пишут settings.json');
        check(/active = s\.api_key === key/.test(body) && /writeFileSync\(gw\.keyFile/.test(body),
            'подмена = файл активного ключа + флаг active в пуле');
    }

    // 11. Реестр покрывает все четыре шлюза, и хосты совпадают с таблицей прокси.
    //     Разъезд здесь = прокси звонит в несуществующий пул и молча отдаёт 403.
    {
        const reg = /const MONEY_GW = \{([\s\S]*?)\n\};/.exec(src);
        check(!!reg, 'реестр MONEY_GW найден');
        const hostsDash = {};
        for (const m of (reg ? reg[1].matchAll(/^\s*(ar|go|tb|xp):[\s\S]*?host: '([^']+)'/gm) : [])) hostsDash[m[2]] = m[1];
        const gw = /const GW_BY_HOST = \{([\s\S]*?)\n\};/.exec(kaSrc);
        check(!!gw, 'таблица GW_BY_HOST в keepalive-proxy.js найдена');
        const hostsProxy = {};
        for (const m of (gw ? gw[1].matchAll(/'([^']+)':\s*'(ar|go|tb|xp)'/g) : [])) hostsProxy[m[1]] = m[2];
        check(Object.keys(hostsDash).length === 4, `в реестре четыре шлюза (нашли ${Object.keys(hostsDash).length})`);
        check(JSON.stringify(hostsDash) === JSON.stringify(hostsProxy)
            || Object.keys(hostsDash).every(h => hostsProxy[h] === hostsDash[h]),
            `хосты дашборда и прокси совпадают (${JSON.stringify(hostsDash)} vs ${JSON.stringify(hostsProxy)})`);
    }

    // 12. Порядок в прокси: «нет баланса» решается ДО isTransientBody. Иначе китайский
    //     текст уйдёт в RETRY_NO_ZH (постоянная → 403 клиенту), а английский — в три
    //     пустых ретрая и 502. Ровно так и было до ротации.
    {
        const branch = kaSrc.indexOf('if (shouldRetryStatus(status)) {');
        const reason = kaSrc.indexOf('rotateReason(status, buf)', branch);
        const transient = kaSrc.indexOf('isTransientBody(status, buf)', branch);
        check(branch > 0 && reason > 0 && reason < transient,
            'в ветке ответа rotateReason проверяется раньше isTransientBody');
        check(/launched >= cfg\.maxAttempts \+ bonusAttempts/.test(kaSrc),
            'у цепочки ротаций свой бюджет попыток (bonusAttempts), а не бюджет ретраев');
        check(/rotations < MAX_ROTATIONS/.test(kaSrc), 'цепочка ротаций ограничена сверху');
        check(!/log\(`[^`]*\$\{sentKey\}/.test(kaSrc) && !/fromKey: sentKey \|\| null[^]]*log/.test(kaSrc),
            'ключ в лог не пишется — только маска');
    }

    // 13. Фронт: подмена активного аккаунта видна БЕЗ F5. Флаг `active` в
    //     `<prov>-sessions.json` переезжает сразу, но таблицу шлюза с зелёной меткой
    //     перерисовывал только autoRefreshTick — а он слушается тумблера
    //     «Автообновление». С выключенным тумблером метка врала до перезагрузки
    //     страницы: ротация сработала, а на экране прежний аккаунт.
    //     Функцию режем из HTML и прогоняем в песочнице.
    {
        const fnSrc = cutFn(htmlSrc, 'function sideDetectRotation(');
        const mapSrc = cutConst(htmlSrc, '_sideActiveKey');
        const calls = { reload: 0, toasts: [], autoRefAsked: 0 };
        const acct = (name, key, bal, active) => ({ email: name, api_key: key, balance: bal, active });
        const factory = new Function('deps', `
            const { MONEY_PROVIDERS, localStorage, toast, console, autoRefreshEnabled } = deps;
            ${mapSrc}
            ${fnSrc}
            return sideDetectRotation;
        `);
        const sideDetectRotation = factory({
            MONEY_PROVIDERS: { gorouter: { label: 'GoRouter', sym: '$', reload: () => { calls.reload += 1; } } },
            localStorage: { getItem: () => 'gorouter' },
            toast: (m) => calls.toasts.push(m),
            console,
            // Тумблер выключен. Если функция его спросит — тест это увидит и упадёт.
            autoRefreshEnabled: () => { calls.autoRefAsked += 1; return false; },
        });

        const before = [acct('cicidewiy', 'sk-a', 0, true), acct('melodicknot', 'sk-b', 79, false)];
        const after = [acct('cicidewiy', 'sk-a', 0, false), acct('melodicknot', 'sk-b', 79, true)];

        check(sideDetectRotation('gorouter', before) === false,
            'первый тик после загрузки страницы подменой не считается');
        check(calls.reload === 0 && calls.toasts.length === 0,
            'на первом тике таблица не перерисовывается и тоста нет');
        check(sideDetectRotation('gorouter', before) === false,
            'тот же активный ключ — не событие');
        check(calls.reload === 0, 'без смены ключа таблицу не трогаем (не прыгает под курсором)');
        check(sideDetectRotation('gorouter', after) === true, 'смена активного ключа поймана');
        check(calls.reload === 1, 'таблица открытой вкладки перерисована ровно один раз');
        check(calls.autoRefAsked === 0,
            'перерисовка НЕ спрашивает тумблер «Автообновление» — иначе метка снова врала бы до F5');
        check(calls.toasts.length === 1 && /melodicknot/.test(calls.toasts[0]) && /\$79/.test(calls.toasts[0]),
            `тост называет новый аккаунт и его баланс (${calls.toasts[0] || '—'})`);
        check(sideDetectRotation('gorouter', after) === false && calls.reload === 1,
            'повторный тик после подмены ничего не перерисовывает');
        // Вкладка шлюза закрыта — перерисовывать нечего, но событие всё равно событие:
        // тост нужен, а таблицу подтянет refreshNavCounts при открытии.
        {
            const w = factory({
                MONEY_PROVIDERS: { gorouter: { label: 'GoRouter', sym: '$', reload: () => { calls.reload += 1; } } },
                localStorage: { getItem: () => 'health' },
                toast: (m) => calls.toasts.push(m),
                console,
                autoRefreshEnabled: () => false,
            });
            const hits = calls.reload;
            w('gorouter', before);
            w('gorouter', after);
            check(calls.reload === hits, 'на чужой открытой вкладке таблица шлюза не перерисовывается');
            check(calls.toasts.length === 2, 'тост о подмене приходит и с другой вкладки');
        }
    }

    // 14. Тумблер ОДИН на все шлюзы. Был по шлюзу, и смена провайдера читалась как
    //     «авторотация выключилась»: включил на GoRouter, перешёл на Tabi — там свой
    //     флаг, по умолчанию выключённый, и следующий отказ по деньгам снова в лицо.
    {
        const w = makeWorld({ pool: [{ name: 'a', balance: 5, active: true }] });
        const st = w.api.moneyState;
        check(st('go').enabled === false && st('tb').enabled === false,
            'по умолчанию авторотация выключена у всех шлюзов');
        st('go').enabled = true;
        check(st('ar').enabled === true && st('tb').enabled === true && st('xp').enabled === true,
            'включил на одном шлюзе — включено на всех (смена провайдера не выключает)');
        check(w.api.moneyAutoShared.enabled === true,
            'хранилище флага одно — moneyAutoShared, а не поле на каждом шлюзе');
        st('xp').enabled = false;
        check(st('go').enabled === false, 'выключение тоже общее');
        // Журнал подмен и дедуп обязаны остаться ПО шлюзу: это состояние работы,
        // а не выбор пользователя. Слить их вместе — потерять, кто куда переехал.
        st('go').recent.push({ to: 'go-acct' });
        st('go').lastAt = 111;
        check(st('tb').recent.length === 0 && st('tb').lastAt === 0,
            'журнал подмен и дедуп остались раздельными по шлюзам');
    }

    // 15. Файл состояния: новый формат — один флаг, старый (по шлюзу) читается как
    //     «включён хоть где-то = включён». Иначе владелец, у которого тумблер стоял на
    //     GoRouter, после обновления нашёл бы авторотацию молча выключенной.
    {
        const persistParts = [
            cutConst(src, 'moneyAutoShared'),
            cutFn(src, 'function moneySavePersist('),
            cutFn(src, 'function moneyLoadPersist('),
        ].join('\n');
        const makePersist = (fileBody) => {
            const disk = { has: fileBody !== null, body: fileBody };
            const logs = [];
            const deps = {
                fs: {
                    existsSync: (f) => (f === 'AUTO.json' ? disk.has : true),
                    mkdirSync: () => {},
                    readFileSync: () => disk.body,
                    writeFileSync: (f, v) => { disk.has = true; disk.body = v; },
                },
                path: { dirname: () => 'logs', join: () => 'AUTO.json' },
                MONEY_AUTO_FILE: 'AUTO.json',
                MONEY_GW: { ar: {}, go: {}, tb: {}, xp: {} },
                logLine: (m) => logs.push(m),
            };
            const f = new Function('deps', `
                const { fs, path, MONEY_AUTO_FILE, MONEY_GW, logLine } = deps;
                ${persistParts}
                return { moneySavePersist, moneyLoadPersist, moneyAutoShared, disk: null };
            `);
            return Object.assign(f(deps), { disk, logs });
        };

        const legacy = makePersist(JSON.stringify({ ar: { enabled: false }, go: { enabled: true }, tb: { enabled: false }, xp: { enabled: false } }));
        legacy.moneyLoadPersist();
        check(legacy.moneyAutoShared.enabled === true,
            'старый формат: тумблер стоял на GoRouter → после обновления авторотация всё ещё включена');

        const legacyOff = makePersist(JSON.stringify({ ar: { enabled: false }, go: { enabled: false } }));
        legacyOff.moneyLoadPersist();
        check(legacyOff.moneyAutoShared.enabled === false, 'старый формат без включённых — выключено');

        const fresh = makePersist(null);
        fresh.moneyAutoShared.enabled = true;
        fresh.moneySavePersist();
        check(/"enabled":\s*true/.test(fresh.disk.body) && !/"go"/.test(fresh.disk.body),
            `на диск пишется один общий флаг, без разбивки по шлюзам (${String(fresh.disk.body).replace(/\s+/g, ' ').trim()})`);
        const reread = makePersist(fresh.disk.body);
        reread.moneyLoadPersist();
        check(reread.moneyAutoShared.enabled === true, 'новый формат читается обратно — переживает рестарт дашборда');

        const offFile = makePersist(JSON.stringify({ enabled: false }));
        offFile.moneyAutoShared.enabled = true;   // мусор в памяти обязан быть перезатёрт
        offFile.moneyLoadPersist();
        check(offFile.moneyAutoShared.enabled === false,
            'явное `{enabled:false}` в файле уважается, а не «включаем, если хоть что-то»');
    }

    // 16. Рукопожатие фронта и бэкенда: `shared: true` в статусе. HTML читается с диска
    //     на каждый запрос (обновляется по F5), а бэкенд — только рестартом `:8200`.
    //     В окне между F5 и рестартом новый фронт видит СТАРЫЙ статус без этого поля и
    //     обязан не подставлять состояние одного шлюза другому — иначе пообещает
    //     включённую авторотацию там, где её нет.
    {
        const statusFn = cutFn(src, 'function moneyAutoStatus(');
        check(/shared:\s*true/.test(statusFn), 'статус шлюза несёт признак `shared: true`');
        const anyKnown = cutFn(htmlSrc, 'function moneyAutoAnyKnown(');
        check(/\.shared/.test(anyKnown),
            'фронт подставляет чужой статус только при `shared` (совместимость со старым процессом :8200)');
        const toggle = cutFn(htmlSrc, 'async function sideAutoToggle(');
        check(/if \(st\.shared\)/.test(toggle),
            'раскраска соседних вкладок после клика тоже под `shared`');
    }

    // 17. Мерж-запись баланса не воскрешает `active` ушедшего аккаунта. Балансовый чек
    //     снимает снимок пула ДО запроса в биллинг (1-2 с), и если в это окно сменился
    //     активный ключ, Object.assign возвращал на диск `active: true` ушедшего — в файле
    //     оказывалось ДВА активных (пойман 22.08: previoussack $0.58 + greedybelieve $105).
    //     Правда о владении ключом — только файл `<prov>-active-key.txt`.
    {
        const mergeSrc = [
            cutConst(src, 'BALANCE_CLEARABLE'),
            cutFn(src, 'function arSaveMerge('),
        ].join('\n');
        const makeDisk = (arr, keyFile) => {
            const world = { disk: arr, keyFile };
            const deps = {
                fs: {
                    readFileSync: (f) => {
                        if (f === 'AR_KEY') { if (world.keyFile === null) throw new Error('ENOENT'); return world.keyFile; }
                        throw new Error('ENOENT ' + f);
                    },
                },
                arLoad: () => JSON.parse(JSON.stringify(world.disk)),
                arSave: (a) => { world.disk = a; },
                AR_ACTIVE_KEY_FILE: 'AR_KEY',
            };
            const f = new Function('deps', `
                const { fs, arLoad, arSave, AR_ACTIVE_KEY_FILE } = deps;
                ${mergeSrc}
                return arSaveMerge;
            `);
            return { world, arSaveMerge: f(deps) };
        };
        const act = (w) => w.disk.filter(s => s.active).map(s => s.email);

        // Гонка: снимок снят до подмены, ротация переставила активного, чек добрался
        // до диска после неё и принёс `active: true` старого владельца.
        {
            const { world, arSaveMerge } = makeDisk(
                [{ email: 'gone', api_key: 'sk-a', active: false }, { email: 'now', api_key: 'sk-b', active: true }],
                'sk-b',
            );
            arSaveMerge({ email: 'gone', api_key: 'sk-a', active: true, balance: 0.58 });
            check(act(world).join(',') === 'now',
                `мерж не воскресил active ушедшего (активны: ${act(world).join(',') || '—'})`);
            check(world.disk.find(s => s.api_key === 'sk-a').balance === 0.58,
                'цифра баланса из того же мержа при этом записана');
        }
        // Лечение уже испорченного файла: два активных на входе, один на выходе.
        {
            const { world, arSaveMerge } = makeDisk(
                [{ email: 'gone', api_key: 'sk-a', active: true }, { email: 'now', api_key: 'sk-b', active: true }],
                'sk-b',
            );
            arSaveMerge({ email: 'now', api_key: 'sk-b', balance: 105 });
            check(act(world).join(',') === 'now',
                `испорченный файл вылечен по файлу ключа (активны: ${act(world).join(',') || '—'})`);
        }
        // Файла ключа нет — активного не выдумываем, чужие флаги не трогаем.
        {
            const { world, arSaveMerge } = makeDisk(
                [{ email: 'a', api_key: 'sk-a', active: true }, { email: 'b', api_key: 'sk-b', active: false }],
                null,
            );
            arSaveMerge({ email: 'b', api_key: 'sk-b', balance: 3 });
            check(act(world).join(',') === 'a',
                `без файла ключа флаги не переставляются (активны: ${act(world).join(',') || '—'})`);
        }
        // Новая запись из мержа не приезжает активной.
        {
            const { world, arSaveMerge } = makeDisk([{ email: 'a', api_key: 'sk-a', active: true }], 'sk-a');
            arSaveMerge({ email: 'fresh', api_key: 'sk-new', active: true, balance: 9 });
            check(act(world).join(',') === 'a' && world.disk.length === 2,
                `дописанная мержем запись не становится активной (активны: ${act(world).join(',') || '—'})`);
        }
        // BALANCE_CLEARABLE продолжает работать: метка ошибки снимается успешным чеком.
        {
            const { world, arSaveMerge } = makeDisk(
                [{ email: 'a', api_key: 'sk-a', active: true, balanceError: 'таймаут' }], 'sk-a',
            );
            arSaveMerge({ email: 'a', api_key: 'sk-a', balance: 5 });
            check(!('balanceError' in world.disk[0]), 'успешный чек по-прежнему снимает balanceError');
        }
    }

    // Итог
    for (const m of ok) console.log(`  ok   ${m}`);
    for (const m of fails) console.log(`  FAIL ${m}`);
    console.log(`\nauto-rotate: ${ok.length} ok, ${fails.length} fail`);
    process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
    console.error('check-autorotate упал:', e.message);
    process.exit(1);
});
