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
 *   8. таблицы хостов дашборда и прокси совпадают (иначе прокси звонит в никуда);
 *   9. фронт: подмену видно без F5 (перерисовка НЕ ждёт тумблера «Автообновление»), а
 *      объявляет её журнал шлюза в «Истории уведомлений» — локальный тост из детектора
 *      убран 24.08 по просьбе владельца, он давал на одно событие вторую строку без
 *      причины отказа.
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
// Многострочная константа-объект (`const X = {\n ... \n};`): cutConst умеет только одну
// строку, а cutFn ждёт список параметров в скобках, которого у объекта нет.
function cutObjConst(text, name) {
    const start = text.indexOf(`const ${name} = {`);
    if (start < 0) throw new Error(`не нашёл объект-константу ${name}`);
    let depth = 0;
    for (let i = text.indexOf('{', start); i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') { depth -= 1; if (depth === 0) return `${text.slice(start, i + 1)};`; }
    }
    throw new Error(`не смог закрыть объект-константу ${name}`);
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
    //    🪤 Суммы подняты 31.08 вместе с порогом (1.0 → 2.0): прежний «small $1.85» был
    //    рассчитан на порог $1 и с новым перестал быть достаточным — на нём тест и
    //    покраснел, что правильно. Смысл проверки не изменился: берём самый маленький
    //    ИЗ ГОДНЫХ, а не самый маленький вообще.
    {
        const w = makeWorld({
            pool: [
                { name: 'active', balance: -0.16, active: true },
                { name: 'fat', balance: 1338.48 },
                { name: 'crumb', balance: 0.11 },
                { name: 'belowBar', balance: 1.85 },
                { name: 'small', balance: 2.40 },
                { name: 'mid', balance: 77.16 },
            ],
        });
        w.api.moneyState('go').enabled = true;
        const r = await w.api.moneyRotate('go', { reason: 'out-of-balance', fromKey: 'sk-active' });
        check(r.ok && nameByKey(w, activeKeyOf(w)) === 'small',
            `выбран самый маленький достаточный: ${r.email} (ждали small $2.40)`);
        check(nameByKey(w, activeKeyOf(w)) !== 'belowBar',
            'аккаунт ниже порога ($1.85 при пороге $2) не берётся, хотя он «самый маленький»');
        check(w.pool.filter(s => s.active).length === 1 && w.pool.find(s => s.active).email === 'small',
            'флаг active переставлен ровно на одного');
        check(w.probes.length === 1, `живой чек только у выбранного кандидата (было ${w.probes.length})`);
    }

    // 1б. Шлюз назвал нужную сумму — кандидатов ниже неё НЕ берём вовсе.
    //     Разбор 31.08 на Tabi: 32 аккаунта по $0.59–0.77 при предоплате $0.80, ротация
    //     уходила на $0.59 «последним шансом», отказ повторялся, и через пять ротаций та
    //     же ошибка уезжала клиенту. Честный `pool-dry` вместо этого — чтобы человек
    //     увидел «пополни», а не пять подмен подряд.
    {
        const w = makeWorld({
            pool: [
                { name: 'active', balance: 0.13, active: true },
                { name: 'crumb1', balance: 0.77 },
                { name: 'crumb2', balance: 0.60 },
                { name: 'crumb3', balance: 0.59 },
            ],
        });
        w.api.moneyState('go').enabled = true;
        const r = await w.api.moneyRotate('go', { reason: 'out-of-balance', fromKey: 'sk-active', needUsd: 0.80 });
        check(!r.ok && r.error === 'pool-dry',
            `сухой пул при известном «нужно $0.80» → pool-dry, а не подмена на $0.59 (получили ${JSON.stringify(r)})`);
        check(nameByKey(w, activeKeyOf(w)) === 'active',
            'активный ключ не переставлен: менять на заведомо недостаточный незачем');
    }

    // 1в. И без названной суммы кандидат ниже порога тоже не берётся. Раньше на это был
    //     «последний шанс» — но он срабатывал только ЗА лимитом живых проверок, то есть
    //     подмена шла на непроверенную цифру. Ставка на «кеш врёт в минус» стоила ровно
    //     того случая на Tabi, поэтому её больше нет: три вероятных кандидата и так
    //     переспрашиваются живьём, а если не годится никто — честный pool-dry.
    {
        const w = makeWorld({
            pool: [
                { name: 'active', balance: 0.13, active: true },
                { name: 'maybe', balance: 0.90 },
            ],
        });
        w.api.moneyState('go').enabled = true;
        const r = await w.api.moneyRotate('go', { reason: 'out-of-balance', fromKey: 'sk-active' });
        check(!r.ok && r.error === 'pool-dry',
            `без «нужно» кандидат ниже порога тоже не берётся: ${JSON.stringify(r)}`);
        check(nameByKey(w, activeKeyOf(w)) === 'active', 'активный ключ остался на месте');
    }

    // 2. Порог из кода, а не из головы: огрызок не годится, запас на пару запросов — годится.
    {
        const w = makeWorld({ pool: [{ name: 'a', balance: 5 }] });
        check(w.api.MONEY_MIN_BAL >= 1.6,
            `порог годности ${w.api.MONEY_MIN_BAL} даёт запас минимум на две предоплаты ($0.80 в пойманной ошибке)`);
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

    // 11. Реестр покрывает все пять шлюзов, и хосты совпадают с таблицей прокси.
    //     Разъезд здесь = прокси звонит в несуществующий пул и молча отдаёт 403.
    //     ⚠️ Список тегов в обоих regexp — не украшение: пятый шлюз (jw, 22.08) под
    //     старым `(ar|go|tb|xp)` не подходил ВООБЩЕ, и проверка «четыре шлюза»
    //     оставалась зелёной, ничего про JustWoker не проверив. Заводя шестой —
    //     дописывать тег здесь и поднимать число ниже.
    const MONEY_TAGS = ['ar', 'go', 'tb', 'xp', 'jw'];
    {
        const tags = MONEY_TAGS.join('|');
        const reg = /const MONEY_GW = \{([\s\S]*?)\n\};/.exec(src);
        check(!!reg, 'реестр MONEY_GW найден');
        const hostsDash = {};
        for (const m of (reg ? reg[1].matchAll(new RegExp(`^\\s*(${tags}):[\\s\\S]*?host: '([^']+)'`, 'gm')) : [])) hostsDash[m[2]] = m[1];
        const gw = /const GW_BY_HOST = \{([\s\S]*?)\n\};/.exec(kaSrc);
        check(!!gw, 'таблица GW_BY_HOST в keepalive-proxy.js найдена');
        const hostsProxy = {};
        for (const m of (gw ? gw[1].matchAll(new RegExp(`'([^']+)':\\s*'(${tags})'`, 'g')) : [])) hostsProxy[m[1]] = m[2];
        check(Object.keys(hostsDash).length === MONEY_TAGS.length,
            `в реестре ${MONEY_TAGS.length} шлюзов (нашли ${Object.keys(hostsDash).length}: ${Object.values(hostsDash).join(', ')})`);
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
            // `toast` подставлен не ради тоста, а ради его ОТСУТСТВИЯ: локальный тост
            // убран 24.08 (см. ниже), и если его вернут «для наглядности» — заглушка
            // это поймает.
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
            'на первом тике таблица не перерисовывается и никто ничего не объявляет');
        check(sideDetectRotation('gorouter', before) === false,
            'тот же активный ключ — не событие');
        check(calls.reload === 0, 'без смены ключа таблицу не трогаем (не прыгает под курсором)');
        check(sideDetectRotation('gorouter', after) === true, 'смена активного ключа поймана');
        check(calls.reload === 1, 'таблица открытой вкладки перерисована ровно один раз');
        check(calls.autoRefAsked === 0,
            'перерисовка НЕ спрашивает тумблер «Автообновление» — иначе метка снова врала бы до F5');
        // 🪤 Тоста в детекторе БОЛЬШЕ НЕТ — просьба владельца 24.08 («хочу, чтобы лог не был
        //    отдельным, а был в нашей Истории уведомлений»). Локальный тост давал на одно
        //    событие вторую строку, и без причины отказа. Проверяем ОТСУТСТВИЕ; кто теперь
        //    называет аккаунт и его баланс — блок 13б.
        check(calls.toasts.length === 0,
            `детектор молчит: объявлять подмену — дело журнала (тостов: ${calls.toasts.length})`);
        check(sideDetectRotation('gorouter', after) === false && calls.reload === 1,
            'повторный тик после подмены ничего не перерисовывает');
        // Вкладка шлюза закрыта — перерисовывать нечего, но событие всё равно событие:
        // возврат `true` форсирует перечит статуса, и свежая запись журнала доезжает в
        // историю сразу, а таблицу подтянет refreshNavCounts при открытии вкладки.
        {
            const w = factory({
                MONEY_PROVIDERS: { gorouter: { label: 'GoRouter', sym: '$', reload: () => { calls.reload += 1; } } },
                localStorage: { getItem: () => 'health' },
                toast: (m) => calls.toasts.push(m),
                console,
                autoRefreshEnabled: () => false,
            });
            const hits = calls.reload;
            const toastsWere = calls.toasts.length;
            w('gorouter', before);
            const seen = w('gorouter', after);
            check(calls.reload === hits, 'на чужой открытой вкладке таблица шлюза не перерисовывается');
            check(seen === true,
                'подмена с чужой вкладки — всё равно событие: `true` форсирует перечит статуса, иначе запись журнала ждала бы своего тика');
            check(calls.toasts.length === toastsWere,
                `и с чужой вкладки детектор молчит (тостов добавилось: ${calls.toasts.length - toastsWere})`);
        }
    }

    // 13б. Кто объявляет подмену теперь. Тост из sideDetectRotation убран 24.08 по просьбе
    //      владельца, но сама проверка обязана жить: подмена не должна проходить молча —
    //      человек узнаёт, НА КОГО переехали и СКОЛЬКО там денег. Источник честнее локального
    //      детекта: журнал `recent` из `/auto/status` помнит подмены, случившиеся при закрытой
    //      странице, и знает ПРИЧИНУ отказа. Строку журнала пишет moneyRotate в
    //      transparent-proxy.js (`st.recent.unshift({ ts, reason, from, to, balance, needUsd })`) —
    //      здесь ровно её форма, чтобы разъезд производителя и потребителя было видно.
    {
        const histParts = [
            cutObjConst(htmlSrc, 'MONEY_ROTATE_REASON'),
            cutConst(htmlSrc, '_moneyRotateSeen'),
            cutFn(htmlSrc, 'function moneyRotateToHistory('),
        ].join('\n');
        const world = { renders: 0, state: { toastLog: [] }, moneyAutoLast: {} };
        const toHistory = new Function('deps', `
            const { MONEY_PROVIDERS, moneyAutoLast, state, renderLogPanel } = deps;
            ${histParts}
            return moneyRotateToHistory;
        `)({
            MONEY_PROVIDERS: { gorouter: { label: 'GoRouter', sym: '$' } },
            moneyAutoLast: world.moneyAutoLast,
            state: world.state,
            renderLogPanel: () => { world.renders += 1; },
        });

        world.moneyAutoLast.gorouter = { recent: [{
            ts: Date.now(), reason: 'out-of-balance',
            from: 'cicidewiy', to: 'melodicknot', balance: 79, needUsd: 0.8,
        }] };
        toHistory('gorouter');
        const line = (world.state.toastLog[0] || {}).text || '';
        check(/melodicknot/.test(line) && /\$79\.00/.test(line),
            `история называет новый аккаунт и его баланс (${line || '—'})`);
        check(/cicidewiy/.test(line),
            'и с какого аккаунта ушли — иначе цепочку подмен по истории не собрать');
        check(/нет баланса/.test(line),
            'в строке есть причина отказа — то, чего локальный тост не знал вовсе');
        check(world.renders === 1, `панель истории перерисована один раз (было ${world.renders})`);
        // Статус опрашивается каждые 10 с и отдаёт те же 20 записей: без дедупа история
        // набивалась бы копиями одного события каждые десять секунд.
        toHistory('gorouter');
        check(world.state.toastLog.length === 1 && world.renders === 1,
            `повтор того же журнала историю не двоит (записей: ${world.state.toastLog.length})`);
        // И событие обязано доезжать в тот же тик: детектор рядом с импортом журнала, а его
        // `true` форсирует перечит статуса — иначе свежая запись ждала бы следующего опроса.
        const tick = cutFn(htmlSrc, 'async function sideBalanceTick(');
        check(/sideDetectRotation\(/.test(tick) && /moneyRotateToHistory\(/.test(tick),
            'детектор подмены и импорт журнала в историю стоят в одном тике');
        check(/moneyAutoFetch\([^)]*rotated/.test(tick),
            'возврат детектора форсирует перечит статуса — moneyAutoFetch(..., rotated)');
    }

    // 14. Тумблер ОДИН на все шлюзы. Был по шлюзу, и смена провайдера читалась как
    //     «авторотация выключилась»: включил на GoRouter, перешёл на Tabi — там свой
    //     флаг, по умолчанию выключённый, и следующий отказ по деньгам снова в лицо.
    {
        const w = makeWorld({ pool: [{ name: 'a', balance: 5, active: true }] });
        const st = w.api.moneyState;
        check(MONEY_TAGS.every(t => st(t).enabled === false),
            `по умолчанию авторотация выключена у всех ${MONEY_TAGS.length} шлюзов`);
        st('go').enabled = true;
        const onElsewhere = MONEY_TAGS.filter(t => t !== 'go' && st(t).enabled !== true);
        check(onElsewhere.length === 0,
            `включил на одном шлюзе — включено на всех (смена провайдера не выключает)${onElsewhere.length ? ' — мимо: ' + onElsewhere.join(', ') : ''}`);
        check(w.api.moneyAutoShared.enabled === true,
            'хранилище флага одно — moneyAutoShared, а не поле на каждом шлюзе');
        st('xp').enabled = false;
        check(st('go').enabled === false && st('jw').enabled === false, 'выключение тоже общее');
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
                MONEY_GW: Object.fromEntries(MONEY_TAGS.map(t => [t, {}])),
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
