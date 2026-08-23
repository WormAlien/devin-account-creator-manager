#!/usr/bin/env node
/**
 * check-checkin-balance.js — регресс-тест «баланс снят в браузере, а не спрошен заново».
 *
 * Зачем файл существует. Клик по подарку 🎁 у agentrouter.org открывал браузер, входил
 * через GitHub, ВСТАВАЛ НА СТРАНИЦЕ КОШЕЛЬКА (где сумма уже нарисована) и закрывался —
 * после чего за той же суммой шли ещё дважды: бэкенд (куки профиля с диска + запрос за
 * Aliyun WAF) и фронт (тот же путь, что кнопка 💰). Лишние минуты и рейт-лимит WAF,
 * из-за которого точный баланс всего пула на 10 минут вырождался в прикидку.
 * Теперь цифру отдаёт сам браузер маркером AUTOCHECKIN_RESULT, а дашборд применяет её.
 *
 * Цена ошибки здесь — деньги в пуле: цифра из ненадёжного источника запишет $0,
 * вышибет активный аккаунт (moneyKickOnZero) и сломает детект чек-ина навсегда
 * (grantedSelf станет нулём, и рост на $25 больше никогда не «случится»).
 *
 * Что проверяем:
 *   1. снимок применяется: balanceSource='self', ни одного вызова accountSelf;
 *   2. сырая quota делится на quota_per_unit ХОСТА, а не на хардкод 500000;
 *   3. granted = balance + spent (как в selfToBalance) — иначе поедет детект чек-ина;
 *   4. ГЛАВНОЕ: нулевой снимок ОТБРОШЕН (ответ колбэка GitHub отдаёт quota:0 —
 *      проверено живьём 2026-08-22 на аккаунте с $175);
 *   5. снимок с уменьшившейся выдачей отброшен (шлюз выданное не отбирает);
 *   6. со снимком не читаются ключи профилей (warmAesKeys не зовётся);
 *   7. selfCheckedAt — момент ПРИМЕНЕНИЯ: иначе newapiLkVisited (его зовёт чек-ин
 *      перед расчётом) запретит переиспользовать цифру, и следующий чек всё равно
 *      пойдёт к шлюзу — ровно то, что убирали;
 *   8. анкер по-прежнему главнее снимка, но снимок доезжает в bal.self (детект чек-ина);
 *   9. статика скрипта: цифра из ответа колбэка НЕ используется как баланс;
 *  10. статика фронта: после чек-ина не зовётся arCheckBalance (это был 3-й поход).
 *
 * Как: вырезает ТЕКСТ newapiBalance из transparent-proxy.js и прогоняет в песочнице
 * с заглушками. Ни одного сетевого запроса, живые пулы не задеты.
 *
 * Запуск: node tools/check-checkin-balance.js      (exit 1 = сломано)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DASH = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const HTML = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
const SESSION = path.join(__dirname, '..', 'agentrouter', 'open-session.js');
const src = fs.readFileSync(DASH, 'utf8');
const htmlSrc = fs.readFileSync(HTML, 'utf8');
const sessSrc = fs.readFileSync(SESSION, 'utf8');

const fails = [];
const ok = [];
function check(cond, msg) { (cond ? ok : fails).push(msg); }

// Вырезать функцию по балансу фигурных скобок. Тело считаем только ПОСЛЕ списка
// параметров, иначе дефолт аргумента `force = false` закрывает счётчик на себе же.
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

const body = cutFn(src, 'async function newapiBalance(');

// ── Песочница ────────────────────────────────────────────────────────────────
// quota_per_unit берём НЕ 500000: тест обязан падать, если делитель захардкодят.
const QPU = 250000;

function makeWorld(opts = {}) {
    const world = { selfCalls: 0, warmCalls: 0, syncCalls: 0, logs: [], fetches: [], lkOpened: opts.lkOpenedAt || 0 };
    const deps = {
        logLine: (m) => world.logs.push(String(m)),
        isRealKey: (k) => /^sk-/.test(String(k || '').trim()),
        round2: (v) => Math.round(Number(v) * 100) / 100,
        newapiLib: () => ({
            quotaPerUnit: async () => QPU,
            quotaToUsd: (q, qpu) => (q == null || !isFinite(q) ? null : Math.round((Number(q) / (qpu || 500000)) * 100) / 100),
            accountSelf: async () => {
                world.selfCalls += 1;
                return opts.selfAnswer || { ok: false, error: 'заглушка: сюда заходить не должны' };
            },
            warmAesKeys: () => ({ warmed: 0, failed: 0 }),
        }),
        newapiWarmProfileKeys: () => { world.warmCalls += 1; },
        newapiResolveProfile: () => ({ label: 'acct_test', dir: opts.noProfile ? null : 'C:/fake/profile' }),
        newapiLkOpenedAt: () => world.lkOpened,
        newapiSyncProfile: () => { world.syncCalls += 1; },
        // usage: живость ключа + легаси-расход. Отдаём центы, как настоящий эндпоинт.
        fetch: async (url) => {
            world.fetches.push(String(url));
            if (String(url).includes('/usage')) {
                if (opts.usageStatus && opts.usageStatus !== 200) return { status: opts.usageStatus };
                return { status: 200, json: async () => ({ total_usage: (opts.usageSpent || 0) * 100 }) };
            }
            return { status: 200, json: async () => ({ access_until: 0 }) };
        },
        AbortSignal: { timeout: () => undefined },
    };
    const factory = new Function('deps', `
        const { logLine, isRealKey, round2, newapiLib, newapiWarmProfileKeys,
                newapiResolveProfile, newapiLkOpenedAt, newapiSyncProfile, fetch, AbortSignal } = deps;
        ${body}
        return newapiBalance;
    `);
    world.run = (target, extra = {}) => factory(deps)({
        target,
        host: 'agentrouter.org',
        ccHeaders: {},
        usageUrl: 'https://x/dashboard/billing/usage',
        subUrl: null,
        guessGrant: (spent) => Math.max(175, Math.ceil(spent / 25) * 25),
        ...extra,
    });
    return world;
}

const KEY = 'sk-test-key';
const snap = (quota, used = 0) => ({ quota, used, id: 439148, username: 'github_439148', from: 'page-self' });

(async () => {
    // 1-3, 6-7. Обычный случай: снимок $175, расхода нет.
    {
        const w = makeWorld({ usageSpent: 0 });
        const target = { api_key: KEY, balanceSource: 'self', balance: 175, granted: 175, grantedSelf: 175 };
        const t0 = Date.now();
        const bal = await w.run(target, { selfSnapshot: snap(175 * QPU) });
        check(bal.balanceSource === 'self', 'снимок применён как точная цифра (balanceSource=self)');
        check(bal.balance === 175, `баланс делится на quota_per_unit хоста (${QPU}), не на хардкод: получили ${bal.balance}`);
        check(bal.granted === 175, `granted = balance + spent, как в selfToBalance: получили ${bal.granted}`);
        check(w.selfCalls === 0, 'accountSelf не вызван — второго запроса к шлюзу нет');
        check(w.warmCalls === 0, 'ключи профилей не расшифровывались (warmAesKeys не зван)');
        check(bal.self && bal.self.fromBrowser === 'page-self', 'источник снимка доезжает в bal.self.fromBrowser');
        const at = Date.parse(bal.self.selfCheckedAt);
        check(at >= t0, 'selfCheckedAt = момент применения, а не прошлое (иначе кеш не переиспользуется)');
    }

    // 7б. Тот же снимок при уже поставленной отметке визита в ЛК: цифра всё равно
    // должна годиться. Это и есть боевой порядок — чек-ин зовёт newapiLkVisited перед расчётом.
    {
        const w = makeWorld({ usageSpent: 0, lkOpenedAt: Date.now() });
        const bal = await w.run({ api_key: KEY }, { selfSnapshot: snap(175 * QPU) });
        check(bal.balanceSource === 'self' && bal.balance === 175,
            'свежий визит в ЛК не мешает применить снимок');
    }

    // 4. ГЛАВНОЕ: нулевой снимок (таким приходит ответ колбэка GitHub) — отбросить.
    {
        const w = makeWorld({ usageSpent: 0, selfAnswer: { ok: true, balance: 175, spent: 0, granted: 175, userId: 1 } });
        const target = { api_key: KEY, balanceSource: 'self', balance: 175, granted: 175, grantedSelf: 175 };
        const bal = await w.run(target, { selfSnapshot: snap(0, 0) });
        check(bal.balance === 175, `нулевой снимок отброшен, взята цифра обычного пути: получили ${bal.balance}`);
        check(w.selfCalls === 1, 'после отброшенного снимка идём обычным путём (accountSelf вызван)');
        check(w.logs.some(l => /снимок из браузера отброшен/.test(l)), 'причина отбраковки видна в логе');
    }

    // 5. Снимок с УМЕНЬШИВШЕЙСЯ выдачей — отбросить (шлюз выданное не отбирает).
    {
        const w = makeWorld({ usageSpent: 0, selfAnswer: { ok: true, balance: 300, spent: 0, granted: 300, userId: 1 } });
        const target = { api_key: KEY, balanceSource: 'self', balance: 300, granted: 300, grantedSelf: 300 };
        const bal = await w.run(target, { selfSnapshot: snap(100 * QPU) });
        check(bal.balance === 300, `снимок с выдачей МЕНЬШЕ известной отброшен: получили ${bal.balance}`);
        check(w.logs.some(l => /МЕНЬШЕ известной/.test(l)), 'в логе сказано, что выдача в снимке меньше известной');
    }

    // 5б. Рост выдачи (тот самый +$25) снимок пропускает — иначе подарок не засчитается.
    {
        const w = makeWorld({ usageSpent: 0 });
        const target = { api_key: KEY, balanceSource: 'self', balance: 175, granted: 175, grantedSelf: 175 };
        const bal = await w.run(target, { selfSnapshot: snap(200 * QPU) });
        check(bal.balance === 200 && bal.granted === 200, `рост выдачи 175→200 принят: получили ${bal.balance}/${bal.granted}`);
    }

    // 8. Анкер главнее снимка, но снимок обязан доехать в bal.self — на нём держится детект чек-ина.
    {
        const w = makeWorld({ usageSpent: 10 });
        const target = { api_key: KEY, balanceAnchor: 500, anchorSpent: 0, anchorGrantedSelf: 175 };
        const bal = await w.run(target, { selfSnapshot: snap(200 * QPU) });
        check(bal.balanceSource === 'anchor', 'вписанный руками баланс по-прежнему главнее снимка');
        check(bal.self && bal.self.granted === 200, 'снимок доехал в bal.self — детект чек-ина увидит рост выдачи');
        check(bal.balance === 515, `анкер + прирост выдачи − расход = 500+25−10: получили ${bal.balance}`);
    }

    // Ключ-заглушка: снимок ничего не меняет, no_key остаётся no_key.
    {
        const w = makeWorld({});
        const bal = await w.run({ api_key: 'nokey-stub' }, { selfSnapshot: snap(175 * QPU) });
        check(bal.status === 'no_key', 'аккаунт без настоящего ключа снимком не «оживает»');
    }

    // Мёртвый ключ: usage ответил 401 — снимок это НЕ перебивает. Отозванный ключ
    // важнее лежащих на аккаунте денег: забрать их всё равно нечем (тот же предикат,
    // что balanceUsable во фронте).
    {
        const w = makeWorld({ usageStatus: 401 });
        const bal = await w.run({ api_key: KEY }, { selfSnapshot: snap(175 * QPU) });
        check(bal.status === 'dead', `usage остаётся приговором о живости ключа: получили ${bal.status}`);
        check(w.selfCalls === 0, 'на мёртвом ключе за балансом никуда не ходим');
    }

    // ── Ветвь 4а: последняя точная цифра вместо прикидки, когда свежий self не дался ──
    // Это ровно тот случай, из-за которого 22.08 три аккаунта пула стояли в «~прикидке»
    // при известной точной цифре в `selfBalance`: self отбит WAF → guess.
    const cachedTarget = (over = {}) => ({
        api_key: KEY, balanceSource: 'self', balance: 175, granted: 175,
        selfBalance: 175, grantedSelf: 175, usageSpentAtSelf: 0,
        selfCheckedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),   // пять часов назад: TTL давно вышел
        ...over,
    });
    {
        const w = makeWorld({ usageSpent: 0 });
        const t = cachedTarget();
        const bal = await w.run(t);
        check(bal.balanceSource === 'self' && bal.balance === 175,
            `свежий self не дался, расход не сдвинулся → держим точные $175 (получили ${bal.balanceSource}/${bal.balance})`);
        check(bal.selfCached === true, 'цифра помечена как непереспрошенная (selfCached) — UI обязан это показать');
        check(!!bal.selfError, 'причина, почему не переспросили, доехала до UI');
        check(bal.selfCheckedAt === t.selfCheckedAt,
            'штамп НЕ обновлён: иначе перезапустится 20-минутный TTL и к шлюзу мы больше не пойдём');
        check(bal.granted === 175, 'выдача взята из grantedSelf — база детекта чек-ина не потеряна');
        check(w.selfCalls === 1, 'попытка спросить шлюз всё равно сделана (ветвь 4а — резерв, а не замена)');
    }
    {
        // Расход сдвинулся — цифра устарела, и подставлять её нельзя.
        const w = makeWorld({ usageSpent: 20 });
        const bal = await w.run(cachedTarget());
        check(bal.balanceSource === 'guess',
            `расход вырос с $0 до $20 → сохранённая цифра не годится, честная прикидка (получили ${bal.balanceSource})`);
    }
    {
        // Заходили в ЛК после чека: там могли налить, а наливка расход не двигает.
        const w = makeWorld({ usageSpent: 0, lkOpenedAt: Date.now() });
        const bal = await w.run(cachedTarget());
        check(bal.balanceSource === 'guess',
            `визит в ЛК после чека → цифра не годится, наливка расход не двигает (получили ${bal.balanceSource})`);
    }
    {
        // Анкер по-прежнему главнее сохранённой точной цифры.
        const w = makeWorld({ usageSpent: 0 });
        const bal = await w.run(cachedTarget({ balanceAnchor: 500, anchorSpent: 0 }));
        check(bal.balanceSource === 'anchor', 'вписанное руками главнее сохранённой точной цифры');
    }

    // Статика бэкенда: хвост чек-ина больше не форсит и не обнуляет цифру вслепую.
    {
        const finish = cutFn(src, 'async function arAutoCheckinFinish(');
        check(/arBalanceOnce\(target\.api_key, false, snap\)/.test(finish),
            'чек-ин зовёт баланс БЕЗ force: force гонит на WAF-заглушку и гасит точный баланс всему пулу на 10 минут');
        check(/if \(checkedIn !== false\) newapiLkVisited\(label\)/.test(finish),
            'newapiLkVisited только когда шлюз НЕ сказал «не наливал» — иначе годная цифра выбрасывается зря');
        const idxCheckedIn = finish.indexOf('const checkedIn =');
        const idxBal = finish.indexOf('const bal = await arBalanceOnce');
        check(idxCheckedIn > 0 && idxCheckedIn < idxBal,
            'checkedIn считается ДО чека баланса — от него зависит годность сохранённой цифры');
    }
    {
        const apply = cutFn(src, 'function newapiApplyBalance(');
        check(/seen && !bal\.selfCached/.test(apply),
            'у непереспрошенной цифры selfError не стирается — иначе «шлюз молчит» выглядит как норма');
    }
    {
        const seenFn = cutFn(htmlSrc, 'function applySelfSeen(');
        check(/data\.selfCached/.test(seenFn), 'фронт переносит признак selfCached в state');
        const badge = cutFn(htmlSrc, 'function balanceSourceBadge(');
        check(/s\.selfCached/.test(badge), 'бейдж источника отличает непереспрошенную цифру от свежей');
    }

    // 9. Статика скрипта: quota из ответа колбэка НЕ идёт в баланс.
    {
        const watch = cutFn(sessSrc, 'function watchOauthResult(');
        check(!/out\.self\s*=/.test(watch),
            'watchOauthResult не собирает баланс из колбэка (его quota обнулена шлюзом)');
        check(/checked_in/.test(watch), 'из колбэка по-прежнему берём checked_in');
        check(/function watchSelfResponses\(/.test(sessSrc),
            'перехват собственного /api/user/self страницы на месте');
        check(/AUTOCHECKIN_RESULT/.test(sessSrc) && /self:\s*selfSnap/.test(sessSrc),
            'снимок уезжает в маркер AUTOCHECKIN_RESULT');
        const usable = cutFn(sessSrc, 'function selfSnapshotUsable(');
        check(/quota\s*>\s*0/.test(usable), 'скрипт сам отбивает нулевую квоту, не надеясь на бэкенд');
    }

    // 10. Статика фронта: после чек-ина третьего похода за балансом нет.
    {
        const watch = cutFn(htmlSrc, 'async function arCheckinWatch(');
        check(!/arCheckBalance/.test(watch),
            'arCheckinWatch не зовёт arCheckBalance — третий запрос к шлюзу убран');
        check(/loadArSessionsLight\(\)/.test(watch),
            'итог берётся перечитыванием локального пула (в сеть не идём)');
        const lk = cutFn(htmlSrc, 'async function arCheckinLk(');
        check(/arCheckinWatch\(/.test(lk),
            'ручной режим 🌐 тоже ждёт итога — жать 💰 после него не нужно');
    }

    // Бэкенд: маркер ловится в ОБОИХ режимах, а не только в авто.
    {
        const open = cutFn(src, 'async function handleArSessionOpen(');
        check(/if \(wantCheckin\) outTail/.test(open), 'stdout копится для обоих режимов чек-ина');
        check(/if \(wantCheckin\) arAutoCheckinFinish\(/.test(open), 'хвост чек-ина зовётся для обоих режимов');
        const finish = cutFn(src, 'async function arAutoCheckinFinish(');
        check(/Number\(marker\.self\.quota\) > 0/.test(finish), 'бэкенд принимает только положительную квоту из маркера');
        check(/if \(!snap\) await new Promise/.test(finish), 'паузу на флаш кук платим только без снимка');
        const status = cutFn(src, 'function handleArCheckinStatus(');
        check(/state !== 'running'/.test(status), 'идущий прогон не выбрасывается по TTL (ручной ждёт человека 10 мин)');
    }

    console.log(`\n✅ ${ok.length} проверок пройдено`);
    for (const m of ok) console.log('   ·', m);
    if (fails.length) {
        console.log(`\n❌ ${fails.length} провалено:`);
        for (const m of fails) console.log('   ×', m);
        process.exit(1);
    }
    console.log('\nЧек-ин: баланс снимается в браузере, лишних запросов к шлюзу нет.');
})().catch(e => { console.error('❌ тест упал:', e.message); process.exit(1); });
