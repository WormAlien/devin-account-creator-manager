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

    // 8. Цифра сайта главнее вписанной вручную (решение владельца 2026-08-24).
    // До этого анкер перекрывал self, и на JustWoker это дало $0.26 в дашборде при
    // $604.38 в кабинете: анкер вписан, когда столько и было, потом шлюз налил.
    {
        const w = makeWorld({ usageSpent: 10 });
        const target = { api_key: KEY, balanceAnchor: 500, anchorSpent: 0, anchorGrantedSelf: 175 };
        const bal = await w.run(target, { selfSnapshot: snap(200 * QPU) });
        check(bal.balanceSource === 'self', 'снимок с сайта главнее вписанного вручную');
        check(bal.balance === 200, `показан остаток сайта, а не анкер: получили ${bal.balance}`);
        check(bal.self && bal.self.granted === 200, 'снимок доехал в bal.self — детект чек-ина увидит рост выдачи');
        check(w.logs.some(l => /беру цифру сайта .* вместо вписанных вручную/.test(l)),
            'расхождение с анкером сказано в логе, а не только в тултипе');
    }

    // 8а. Анкер — резерв: сайт не ответил, памятной цифры нет → показываем вписанное,
    // а не прикидку ceil(spent/25)*25.
    {
        const w = makeWorld({ usageSpent: 10, selfAnswer: { ok: false, error: 'в профиле нет куки' } });
        const target = { api_key: KEY, profile: 'p', balanceAnchor: 500, anchorSpent: 0 };
        const bal = await w.run(target);
        check(bal.balanceSource === 'anchor', 'без цифры сайта возвращается вписанное вручную');
        check(bal.balance === 490, `вписанное минус расход: 500−10, получили ${bal.balance}`);
        check(!!bal.selfError, 'причина, почему сайт не ответил, доехала до UI');
    }

    // 8б. Тот самый разбор с JustWoker: анкер $0.26 не должен прятать точные $524.38,
    // когда памятная цифра шлюза годна (расход не сдвинулся, в ЛК не заходили).
    {
        const w = makeWorld({ usageSpent: 0.02, selfAnswer: { ok: false, error: 'в профиле нет куки' } });
        const target = {
            api_key: KEY, profile: 'p',
            balanceAnchor: 0.26, anchorSpent: 0.02, anchorGrantedSelf: 524.4,
            selfBalance: 524.38, grantedSelf: 524.4, usageSpentAtSelf: 0.02,
            selfCheckedAt: new Date(Date.now() - 20 * 3600_000).toISOString(),
        };
        const bal = await w.run(target);
        check(bal.balanceSource === 'self' && bal.balance === 524.38,
            `памятная точная цифра главнее анкера $0.26: получили ${bal.balanceSource}/${bal.balance}`);
        check(bal.selfCached === true, 'цифра помечена непереспрошенной — UI обязан это показать');
    }

    // 8в. Живой случай владельца 24.08: анкер $0.26 от 22.08 против памятной точной
    // $604.38, снятой ПОСЛЕ визита в ЛК (то есть строгая ветвь 4а не пускает).
    // Побеждает цифра шлюза: обе могут занижать, но её занижение честнее.
    {
        const w = makeWorld({ usageSpent: 0.03, lkOpenedAt: Date.now(), selfAnswer: { ok: false, error: 'браузер этого аккаунта ОТКРЫТ' } });
        const target = {
            api_key: KEY, profile: 'p',
            balanceAnchor: 0.26, anchorSpent: 0.02,
            selfBalance: 604.38, grantedSelf: 604.4, usageSpentAtSelf: 0.02,
            selfCheckedAt: new Date(Date.now() - 3600_000).toISOString(),
        };
        const bal = await w.run(target);
        check(bal.balanceSource === 'self', `памятная цифра шлюза бьёт анкер (получили ${bal.balanceSource})`);
        check(bal.balance === 604.37, `из памятной вычтен расход с того чека: 604.38−0.01, получили ${bal.balance}`);
        check(bal.selfCached === true && !!bal.selfError, 'цифра помечена непереспрошенной и причина видна');
        check(w.logs.some(l => /ПАМЯТНУЮ цифру шлюза/.test(l)), 'подмена анкера памятной цифрой сказана в логе');
    }

    // 8г. Обратный случай: анкер БОЛЬШЕ памятной цифры — не понижаем. Владелец мог
    // видеть кабинет позже нашего чека, и его цифра тогда свежее.
    {
        const w = makeWorld({ usageSpent: 0, lkOpenedAt: Date.now(), selfAnswer: { ok: false, error: 'нет куки' } });
        const target = {
            api_key: KEY, profile: 'p',
            balanceAnchor: 500, anchorSpent: 0,
            selfBalance: 100, grantedSelf: 100, usageSpentAtSelf: 0,
            selfCheckedAt: new Date(Date.now() - 3600_000).toISOString(),
        };
        const bal = await w.run(target);
        check(bal.balanceSource === 'anchor' && bal.balance === 500,
            `анкер выше памятной цифры остаётся (получили ${bal.balanceSource}/${bal.balance})`);
    }

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
        // 🪤 Инвариант ПЕРЕВЁРНУТ 25.08. Расход сдвинулся — сохранённая цифра уже не точна,
        // но она всё равно ближе к правде, чем прикидка: расход мы вычитаем сами, а
        // `ceil(spent/25)*25` умеет ЗАВЫШАТЬ. Разбор `lustrouscult`: браузер снял $225
        // (подарок лёг), следующий чек попал в WAF-заглушку, и таблица показала прикидку
        // $175 — то есть решения о деньгах принимались бы по числу, которого нет.
        const w = makeWorld({ usageSpent: 20 });
        const bal = await w.run(cachedTarget());
        check(bal.balanceSource === 'self' && bal.balance === 155,
            `память шлюза минус расход (175−20) главнее прикидки: получили ${bal.balanceSource}/${bal.balance}`);
        check(bal.selfCached === true, 'цифра помечена непереспрошенной, причина видна');
    }
    {
        // Прикидка остаётся ровно там, где помнить нечего.
        const w = makeWorld({ usageSpent: 20 });
        const bal = await w.run({ api_key: KEY, profile: 'p' });
        check(bal.balanceSource === 'guess', `без памяти о шлюзе — честная прикидка (получили ${bal.balanceSource})`);
    }
    {
        // Заходили в ЛК после чека: там могли налить, а наливка расход не двигает. Раньше
        // это роняло в прикидку; теперь показывается память шлюза — занижение безопасно.
        const w = makeWorld({ usageSpent: 0, lkOpenedAt: Date.now() });
        const bal = await w.run(cachedTarget());
        check(bal.balanceSource === 'self' && bal.balance === 175,
            `визит в ЛК: держим память шлюза, а не прикидку (получили ${bal.balanceSource}/${bal.balance})`);
    }
    {
        // Обратное правило с 24.08: сохранённая точная цифра главнее вписанного руками.
        // Анкер остаётся в записи, но всплывает только когда цифры сайта нет вообще.
        const w = makeWorld({ usageSpent: 0 });
        const bal = await w.run(cachedTarget({ balanceAnchor: 500, anchorSpent: 0 }));
        check(bal.balanceSource === 'self' && bal.balance === 175,
            `сохранённая точная цифра главнее вписанного руками (получили ${bal.balanceSource}/${bal.balance})`);
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

    // 9а. Подарок виден только после обновления страницы: предподарочная цифра не должна
    // уехать в маркер как точная (жалоба владельца 2026-08-23).
    {
        check(/reset\(\)\s*\{[^}]*this\.last\s*=\s*null/.test(cutFn(sessSrc, 'function watchSelfResponses(')),
            'у перехвата self есть reset() — предподарочные ответы забываются');
        // Эталон снимается НАМЕРЕННО и при живой сессии — внутри uiLogout, до клика по
        // «выйти». Раньше он брался из случайно перехваченного ответа страницы, и оба
        // живых прогона 25.08 остались без эталона: логаут обрывает летящий запрос self.
        const logoutFn = cutFn(sessSrc, 'async function uiLogout(');
        check(/readBaselineSelf\(page\)/.test(logoutFn),
            'эталон снимается внутри uiLogout, пока сессия жива');
        const baseFn = cutFn(sessSrc, 'async function readBaselineSelf(');
        check(/readStoredUser\(/.test(baseFn) && /siteSelfOk\(/.test(baseFn),
            'у эталона два источника: localStorage и свой запрос');
        const baselineAt = sessSrc.indexOf('const baseline = takenBaseline');
        const resetAt = sessSrc.indexOf('selfWatch.reset();', baselineAt);
        check(baselineAt > 0 && sessSrc.lastIndexOf('await doCheckinLogout(', baselineAt) > 0,
            'эталон берётся из результата doCheckinLogout, перехват — только фолбэк');
        check(resetAt > baselineAt, 'после снятия эталона перехват сбрасывается');
        check(/function reloadForFreshSelf\(/.test(sessSrc)
            && /reloadForFreshSelf\(page, selfWatch, baseline, expectGrowth, settleOnly\)/.test(sessSrc),
            'страница перезагружается перед снятием цифры — кабинет иначе показывает старый остаток');
        check(/const settleOnly = !expectGrowth && auto && !gatewaySaysNo/.test(sessSrc),
            'без эталона цифра берётся вторым чтением, а не первым');
        const reload = cutFn(sessSrc, 'async function reloadForFreshSelf(');
        const full = cutFn(sessSrc, 'async function fullReloadConsole(');
        check(/page\.reload\(/.test(full) && /agentrouter\\.org\\\/console/.test(full),
            'перезагружаем только страницы консоли — на URL колбэка лежит одноразовый code');
        const pre = cutFn(sessSrc, 'function selfIsPreGift(');
        check(/quota\)\s*<=\s*Number\(baseline\.quota\)/.test(pre),
            'равенство эталону тоже считается предподарочным — это и есть «надо обновить»');
        check(/const expectGrowth = !!\(auto && baseline && !gatewaySaysNo\)/.test(sessSrc),
            'роста ждём всегда при известном эталоне — флаг checked_in для этого решения не годится');
        check(/checkedIn === false/.test(sessSrc) && /gatewaySaysNo/.test(sessSrc),
            'единственное, что решает флаг шлюза — явное checked_in: false (окно не сменилось)');
        check(/GIFT_SETTLE_MS/.test(reload) && /GIFT_TOTAL_BUDGET_MS/.test(reload),
            'между кругами есть пауза, у ожидания есть общий потолок');
        check(/GIFT_RELOAD_ATTEMPTS = 6/.test(sessSrc), 'кругов шесть, а не три — зачисление не мгновенное');
        check(/waitUntil: 'load'/.test(full) && !/domcontentloaded/.test(full),
            'перезагрузка ждёт load, а не domcontentloaded — иначе отсчёт течёт до отрисовки');
        check(/waitSpaReady\(/.test(full) && /waitBalanceRendered\(/.test(full),
            'ждём и поднявшуюся SPA, и НАРИСОВАННУЮ цифру на странице');
        // 🪤 Скелетон карточки vs `$0.00` в блоке приглашений: искать любое `$` нельзя.
        const drawn = cutFn(sessSrc, 'async function waitBalanceRendered(');
        check(/BALANCE_LABEL_RE/.test(drawn) && /当前余额/.test(sessSrc),
            'цифру ищем рядом с подписью карточки баланса, а не где угодно на странице');
        check(!/\$\\s\*\\d|\\d\[\\d\\s\.,\]\*\\s\*\\\$/.test(sessSrc),
            'старая проверка «любое $ на странице» убрана — она ловила $0.00 из блока приглашений');
        check(/AR_SELF_PROBE/.test(sessSrc),
            'диагностическая сверка своим запросом выключена по умолчанию (лишний запрос ловит WAF)');
        check(/GIFT_WAF_SETTLE_MS/.test(reload) && /заглушки WAF/.test(reload),
            'круг с заглушками WAF ждёт дольше обычного — частить бессмысленно');
        const cap = cutFn(sessSrc, 'async function captureSelfSnapshot(');
        check((cap.match(/!stale\(/g) || []).length >= 3,
            'предподарочную цифру отбивают все три источника (перехват, localStorage, свой запрос)');
        check(/return null;/.test(cap) && /предподарочные/.test(cap),
            'все источники предподарочные → снимок не отправляется, дашборд считает сам');
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
        // Спавн вынесен из обработчика в arSpawnSession (25.08, очередь чек-инов) —
        // проверки смотрят туда же, поведение то же.
        const open = cutFn(src, 'function arSpawnSession(');
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
