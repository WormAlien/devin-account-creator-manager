#!/usr/bin/env node
/**
 * check-keepalive-bring.js — регресс-тест подъёма keepalive-инстансов.
 *
 * Зачем файл существует: keepalive — отдельный detached-процесс, и пока он мёртв,
 * у Claude Code нет апстрима вообще (settings.json смотрит ровно в один порт).
 * До 21.08 подъём был дырявым в два независимых шага:
 *   1. проба «свободен ли порт» делалась через bind, и ЗАНЯТЫЙ порт читался как
 *      «уже работает» (`already: true`) — то есть зомби считался живым прокси;
 *   2. spawn() возвращал ok сразу, не дожидаясь, что порт ожил, — то есть ребёнок,
 *      умерший на старте, тоже считался успехом (и оставлял в логе бодрый pid).
 * Поймано у второго пользователя: после обновления и добавления аккаунта GoRouter
 * :20156 не отвечал, активация и рестарт дашборда «успешно» его не поднимали,
 * помогала только кнопка «перезапустить» в Health. Теперь все пути идут через
 * keepaliveBring(), и цена ошибки в нём — ровно тот же тихий 502 на каждый запрос.
 *
 * Как: вырезает ТЕКСТ функций probeStatus/portAnswers/keepaliveBring из
 * transparent-proxy.js и прогоняет со заглушками fetch/kill/portIsFree. Ничего не
 * спавнит и не убивает — живой стек на :20133/:20156 не задет.
 *
 * Запуск: node tools/check-keepalive-bring.js      (exit 1 = подъём сломан)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROXY = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const src = fs.readFileSync(PROXY, 'utf8');

const fails = [];
const ok = [];
function check(cond, msg) { (cond ? ok : fails).push(msg); }

// Вырезать функцию по балансу фигурных скобок от её объявления. Тело начинаем
// считать только ПОСЛЕ списка параметров: у keepaliveBring(port, opts = {}) первая
// `{` — это дефолт аргумента, и наивный счётчик закрывался на нём же.
function cutFn(text, head) {
    const start = text.indexOf(head);
    if (start < 0) throw new Error(`не нашёл в transparent-proxy.js: ${head}`);
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

const parts = [
    cutFn(src, 'async function probeStatus('),
    cutFn(src, 'async function portAnswers('),
    cutFn(src, 'async function keepaliveBring('),
];

// Заглушечное окружение: тот же код, но fetch/kill/portIsFree под нашим контролем.
function makeWorld(opts) {
    const world = {
        // Сколько проб /status ещё вернут «мертво», прежде чем порт начнёт отвечать.
        deadProbes: opts.deadProbes || 0,
        listening: !!opts.listening,       // кто-то держит порт (bind не пройдёт)
        spawnOk: opts.spawnOk !== false,
        spawnRevives: opts.spawnRevives !== false,   // ожил ли порт после спавна
        killed: 0, spawns: 0, probes: 0, sleeps: 0, logs: [],
    };
    const deps = {
        napMs: async () => { world.sleeps += 1; },
        logLine: (m) => world.logs.push(m),
        killPortListeners: () => { world.killed += 1; world.listening = false; world.deadProbes = 0; return 1; },
        portIsFree: async () => !world.listening,
        keepaliveInstances: () => ({
            20156: {
                name: 'GoRouter',
                spawn: async () => {
                    world.spawns += 1;
                    if (!world.spawnOk) return { ok: false, error: 'spawn failed' };
                    if (world.spawnRevives) { world.alive = true; world.listening = true; }
                    return { ok: true, pid: 4242 };
                },
            },
            20100: { name: 'Front Door', spawn: async () => ({ ok: true, pid: 1 }), statusPath: '/__frontdoor/api/status' },
        }),
        fetch: async () => {
            world.probes += 1;
            if (world.deadProbes > 0) { world.deadProbes -= 1; throw new Error('ECONNREFUSED'); }
            if (!world.alive) throw new Error('ECONNREFUSED');
            return { ok: true, json: async () => ({ stats: { requests: 7 } }) };
        },
        AbortSignal: { timeout: () => null },
        Date,
    };
    const factory = new Function('deps', `
        const { napMs, logLine, killPortListeners, portIsFree, keepaliveInstances, fetch, AbortSignal } = deps;
        ${parts.join('\n')}
        return { keepaliveBring, portAnswers, probeStatus };
    `);
    world.api = factory(deps);
    return world;
}

async function main() {
    // 1. Живой прокси не трогаем: ни спавна, ни убийства.
    {
        const w = makeWorld({ listening: true });
        w.alive = true;
        const r = await w.api.keepaliveBring(20156);
        check(r.ok && r.already, `живой порт: already (${JSON.stringify(r).slice(0, 80)})`);
        check(w.spawns === 0 && w.killed === 0, `живой порт: ни спавна, ни kill (spawns ${w.spawns}, kill ${w.killed})`);
        check(r.status && r.status.stats, 'живой порт: тело /status возвращается наверх (его показывает Health)');
    }

    // 2. Медленный, но живой прокси не должен быть убит: пробуем ТРИ раза.
    //    Это главный предохранитель — иначе всплеск нагрузки = обрыв всех сессий CC.
    {
        const w = makeWorld({ listening: true, deadProbes: 2 });
        w.alive = true;
        const r = await w.api.keepaliveBring(20156);
        check(r.ok && r.already, 'медленный порт: ответил с 3-й пробы → already');
        check(w.killed === 0, `медленный порт: НЕ убит (kill ${w.killed})`);
    }

    // 3. Порт свободен → спавн и ожидание живого /status.
    {
        const w = makeWorld({ listening: false });
        const r = await w.api.keepaliveBring(20156);
        check(r.ok && !r.already && r.pid === 4242, `свободный порт: спавн и pid (${JSON.stringify(r).slice(0, 90)})`);
        check(w.killed === 0, 'свободный порт: убивать некого');
    }

    // 4. Зомби: порт занят, /status молчит → убить, дождаться, поднять.
    {
        const w = makeWorld({ listening: true });      // alive не выставлен = не отвечает
        const r = await w.api.keepaliveBring(20156);
        check(r.ok && r.killed === 1, `зомби: убит и поднят (${JSON.stringify(r).slice(0, 90)})`);
        check(w.spawns === 1, `зомби: ровно один спавн (было ${w.spawns})`);
        check(w.logs.some(l => /зомби/.test(l)), 'зомби: в лог написано, что порт держал зомби');
    }

    // 5. Спавн прошёл, но порт не ожил → честный провал, а не молчаливый ok.
    {
        const w = makeWorld({ listening: false, spawnRevives: false });
        const r = await w.api.keepaliveBring(20156, { waitMs: 0 });
        check(!r.ok && /не ответил/.test(r.error || ''), `мёртвый ребёнок: ok:false (${r.error})`);
        check(r.pid === 4242, 'мёртвый ребёнок: pid всё равно отдан — по нему искать труп в логах');
    }

    // 6. Сам спавн не смог — ошибка наверх как есть.
    {
        const w = makeWorld({ listening: false, spawnOk: false });
        const r = await w.api.keepaliveBring(20156);
        check(!r.ok && r.error === 'spawn failed', `спавн упал: ошибка наверх (${r.error})`);
    }

    // 7. force (кнопка «перезапустить» в Health) обязан убить даже живого — иначе
    //    после обновления keepalive-proxy.js новый код не подхватится.
    {
        const w = makeWorld({ listening: true });
        w.alive = true;
        const r = await w.api.keepaliveBring(20156, { force: true });
        check(r.ok && !r.already && w.killed === 1 && w.spawns === 1,
            `force: живой убит и переспавнен (kill ${w.killed}, spawns ${w.spawns}, already ${!!r.already})`);
        check(w.probes > 0, 'force: живость всё равно проверяется после спавна');
    }

    // 8. Чужой порт (конвертер, omniroute) — не наше дело, но и не молчание.
    {
        const w = makeWorld({ listening: false });
        const r = await w.api.keepaliveBring(20150);
        check(!r.ok && /не keepalive-инстанс/.test(r.error || ''), `чужой порт: понятная ошибка (${r.error})`);
        check(w.spawns === 0, 'чужой порт: ничего не спавним');
    }

    // 9. Регресс на источник бага: bind-проба больше не считается доказательством
    //    живости. Читаем сам текст функции — на неё опирались все автопути.
    {
        const bring = parts[2];
        check(/portAnswers\(/.test(bring), 'keepaliveBring спрашивает /status по HTTP (portAnswers), а не только bind');
        check(/killPortListeners\(/.test(bring), 'keepaliveBring умеет снять зомби с занятого порта');
        const spawnFns = (src.match(/if \(!free\) return \{ ok: true, already: true \};/g) || []).length;
        check(spawnFns >= 1, `низкоуровневые спавны остались идемпотентными по bind (${spawnFns} шт.)`);
        // Тег провайдера НЕ перечисляем: список `(ar|go|tb|xp)` пропустил бы пятый шлюз
        // (jw, 22.08) молча — проверка осталась бы зелёной, ничего не проверив. Любой
        // `await <что-то>KeepaliveSpawn()` в обход keepaliveBring — дыра по определению.
        const direct = (src.match(/await \w+KeepaliveSpawn\(\)/g) || []);
        check(direct.length === 0, `прямых вызовов спавна в обход keepaliveBring нет (нашлось ${direct.length}${direct.length ? ': ' + direct.join(', ') : ''})`);
        // Карта порт→спавн обязана знать про все инстансы, включая :20158.
        const inst = (/function keepaliveInstances\(\) \{[\s\S]*?\n\}/.exec(src) || [''])[0];
        const ports = (inst.match(/\[\w+_KEEPALIVE_PORT\]:/g) || []).length;
        check(ports >= 5, `keepaliveInstances знает ${ports} keepalive-портов (пять шлюзов + front-door)`);
        check(/\[JW_KEEPALIVE_PORT\]: \{ name: 'JustWoker', spawn: jwKeepaliveSpawn \}/.test(inst),
            'JustWoker :20158 в карте порт→спавн — иначе кнопка «перезапустить» в Health его не поднимет');
    }


    for (const m of ok) console.log(`  ok   ${m}`);
    for (const m of fails) console.log(`  FAIL ${m}`);
    console.log(fails.length
        ? `\ncheck-keepalive-bring: ${fails.length} провал(ов) из ${ok.length + fails.length}`
        : `\ncheck-keepalive-bring OK (${ok.length} проверок)`);
    process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error('check-keepalive-bring упал:', e.message); process.exit(1); });
