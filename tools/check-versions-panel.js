#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  check-versions-panel.js — регресс на механику отката версий (04.09).
//
//  Откат делает `git reset --hard`, поэтому проверять его на живом репо нельзя:
//  одна ошибка = снесённая работа. Тест поднимает ОДНОРАЗОВЫЙ клон в temp, гоняет
//  listCommits/moveTo на нём и удаляет. Живой репо не трогается.
//
//  Потребитель механики — меню хаба (`hub.js`), НЕ веб-дашборд: когда дашборд
//  сломан, его же UI для откта недоступен, а хаб работает всегда.
//
//  Кейс-родитель: 04.09 владелец откатился руками (`git reset`), снёс два
//  незапушенных коммита агента, push молча упал. Инварианты отсюда:
//    1. state-файлы (тир-карты) переживают откат — иначе откат сбрасывает настройки;
//    2. грязный КОД блокирует откат, но снимается stash'ем по подтверждению;
//    3. незапушенные коммиты перед reset помечаются backup-тегом;
//    4. CRLF-фантомы свежего клона блокером НЕ считаются (пугать нечем);
//    5. несуществующий sha — внятная ошибка, а не исключение.
//
//  Запуск: node tools/check-versions-panel.js
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const fails = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, why) => { fails.push(`${n} — ${why}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${why}`); };
const t = (n, fn) => { try { const r = fn(); if (r === true || r === undefined) ok(n); else bad(n, String(r)); } catch (e) { bad(n, e.message); } };
// Асинхронные проверки собираются здесь и гоняются в конце: файл на CommonJS,
// top-level await в нём недоступен, а «прогнать экран вслепую» иначе не проверить.
const ASYNC = [];
const ta = (n, fn) => ASYNC.push([n, fn]);

// Клон делаем из живого репо, но правки берём с диска (cp), иначе тест проверял бы
// закоммиченную версию модуля, а не ту, которую сейчас пишут.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'check-versions-'));
const REPO = path.join(TMP, 'clone');
let G = null;

function git(...args) {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
}

try {
    execFileSync('git', ['clone', '--no-hardlinks', '--quiet', ROOT, REPO], { encoding: 'utf8' });
    fs.copyFileSync(path.join(ROOT, 'tools', 'git-pull-safe.js'), path.join(REPO, 'tools', 'git-pull-safe.js'));
    // Незакоммиченная копия модуля сама попала бы в «грязный код» и заблокировала
    // первый же moveTo — коммитим её в клоне, живого репо это не касается.
    git('add', 'tools/git-pull-safe.js');
    try { git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'test: модуль под тестом'); } catch { }
    G = require(path.join(REPO, 'tools', 'git-pull-safe.js'));
} catch (e) {
    console.error(`не удалось подготовить клон: ${e.message}`);
    process.exit(1);
}

console.log('\nОткат версий — механика listCommits/moveTo\n');

// Две точки истории клона: HEAD и что-то заведомо старше.
const HEAD_SHA = git('rev-parse', 'HEAD');
const OLD_SHA = git('rev-parse', 'HEAD~2');

t('listCommits отдаёт список с маркерами HEAD и origin', () => {
    const l = G.listCommits(5);
    if (!Array.isArray(l.commits) || l.commits.length !== 5) return `коммитов ${l.commits && l.commits.length}, ожидалось 5`;
    if (!l.headFull || !l.originFull) return 'нет headFull/originFull — маркеры «сейчас»/«на GitHub» в UI не разметятся';
    const c = l.commits[0];
    if (!c.sha || !c.short || !c.date || !c.subject) return `в записи не хватает полей: ${JSON.stringify(c)}`;
    return true;
});

t('CRLF-фантомы свежего клона блокером не считаются', () => {
    // Инвариант 4: dirtyRealFiles() без union с diff-files. Иначе на свежем клоне
    // с `.gitattributes` откат отказывал со списком файлов, которых никто не трогал.
    const l = G.listCommits(3);
    if (l.dirty.length) return `dirty непуст на чистом клоне: ${JSON.stringify(l.dirty)}`;
    return true;
});

t('откат чистого дерева переставляет HEAD', () => {
    const r = G.moveTo(OLD_SHA);
    if (!r.ok) return `ok=false, error=${r.error}`;
    if (git('rev-parse', 'HEAD') !== OLD_SHA) return 'HEAD не переставлен';
    return true;
});

t('state-файл (тир-карта) переживает откат', () => {
    // Инвариант 1. Правку кладём ту же, что делает дашборд: JSON + '\n'.
    const f = path.join(REPO, 'routing', 'tabi-modelmap.json');
    fs.writeFileSync(f, JSON.stringify({ opus: 'MARKER-KEEP', sonnet: '', haiku: '' }, null, 2) + '\n');
    const r = G.moveTo(HEAD_SHA);
    if (!r.ok) return `ok=false, error=${r.error}`;
    if (!r.preserved.includes('routing/tabi-modelmap.json')) return `preserved=${JSON.stringify(r.preserved)}`;
    if (!fs.readFileSync(f, 'utf8').includes('MARKER-KEEP')) return 'правка тир-карты потеряна — откат сбросил настройки';
    return true;
});

t('грязный код блокирует откат и предлагает stash', () => {
    // Инвариант 2, первая половина: молча прятать чужие правки нельзя.
    fs.appendFileSync(path.join(REPO, 'routing', 'transparent-proxy.js'), '\n// dirty marker\n');
    const r = G.moveTo(OLD_SHA);
    if (r.ok) return 'откат прошёл, хотя в коде незакоммиченные правки';
    if (!r.can_stash) return 'нет can_stash — UI не покажет кнопку «спрятать и откатить»';
    if (!r.blocking.includes('routing/transparent-proxy.js')) return `blocking=${JSON.stringify(r.blocking)}`;
    return true;
});

t('stashBlocking снимает блокировку, правки уходят в стэш', () => {
    // Вторая половина инварианта 2.
    const r = G.moveTo(OLD_SHA, { stashBlocking: true });
    if (!r.ok) return `ok=false, error=${r.error}`;
    if (!r.stashed.includes('routing/transparent-proxy.js')) return `stashed=${JSON.stringify(r.stashed)}`;
    if (!git('stash', 'list')) return 'stash пуст — правки потеряны, а не спрятаны';
    return true;
});

t('незапушенный коммит помечается backup-тегом до reset', () => {
    // Инвариант 3 — ровно тот случай 04.09: reset срезает коммиты, которых нет на
    // origin. reflog их держит, но тег виден человеку и живёт после чистки.
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'local-only, нет на origin');
    const doomed = git('rev-parse', 'HEAD');
    const r = G.moveTo(OLD_SHA);
    if (!r.ok) return `ok=false, error=${r.error}`;
    if (!r.backupRef) return 'backupRef пуст — срезанный коммит нечем найти';
    const tagged = git('rev-parse', r.backupRef);
    if (tagged !== doomed) return `тег ${r.backupRef} смотрит не на срезанный коммит`;
    return true;
});

t('на откате без незапушенного тег НЕ создаётся', () => {
    // Обратная сторона инварианта 3: тег на каждый клик = мусор в списке тегов.
    // Стартуем строго с origin/master — всё, что срежется, есть на origin, терять
    // нечего. 🪤 HEAD клона брать нельзя: в нём коммит самого теста, он не на
    // origin, и тег будет создан ПРАВИЛЬНО (первый прогон теста поймал это).
    G.moveTo('origin/master');
    const before = git('tag', '-l', 'backup/*').split('\n').filter(Boolean).length;
    const r = G.moveTo(OLD_SHA);
    if (!r.ok) return `ok=false, error=${r.error}`;
    if (r.backupRef) return `создан тег ${r.backupRef}, хотя срезанные коммиты все на origin`;
    const after = git('tag', '-l', 'backup/*').split('\n').filter(Boolean).length;
    if (after !== before) return `тегов было ${before}, стало ${after}`;
    return true;
});

t('повторный откат той же работы тег не дублирует', () => {
    // Три клика «откатить» подряд не должны оставить три тега на одну работу.
    G.moveTo('origin/master');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'ещё один local-only');
    const first = G.moveTo(OLD_SHA);
    if (!first.backupRef) return 'первый откат не создал тег';
    const count1 = git('tag', '-l', 'backup/*').split('\n').filter(Boolean).length;
    // Вернулись на ту же работу и откатились снова — тег должен переиспользоваться.
    G.moveTo(first.backupRef);
    const second = G.moveTo(OLD_SHA);
    if (second.backupRef !== first.backupRef) return `второй откат сделал новый тег ${second.backupRef} вместо ${first.backupRef}`;
    const count2 = git('tag', '-l', 'backup/*').split('\n').filter(Boolean).length;
    if (count2 !== count1) return `тегов было ${count1}, стало ${count2} — плодятся на повторном откате`;
    return true;
});

t('несуществующий sha — внятная ошибка, не исключение', () => {
    const r = G.moveTo('deadbeef99');
    if (r.ok) return 'ok=true на несуществующем коммите';
    if (!/не найден/.test(r.error || '')) return `error=${r.error}`;
    return true;
});

t('повторный откат на тот же коммит — already, без работы', () => {
    const cur = git('rev-parse', 'HEAD');
    const r = G.moveTo(cur);
    if (!r.ok || !r.already) return `ok=${r.ok}, already=${r.already}`;
    return true;
});

t('moveTo("origin/master") возвращает на свежую версию', () => {
    // Кнопка «Вернуться на последнюю»: та же операция, что откат, но вперёд.
    const r = G.moveTo('origin/master');
    if (!r.ok) return `ok=false, error=${r.error}`;
    if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/master')) return 'HEAD не совпал с origin/master';
    return true;
});

// Экран крутится вслепую: readKey подменён сценарием нажатий, вывод — в массив.
// Так ловится то, чего статическая проверка не видит: перерисовка кадра на стрелку.
// Возвращает { gitCalls, cursorUps, printed }.
function driveVersionsScreen(keys) {
    const src = fs.readFileSync(path.join(ROOT, 'hub.js'), 'utf8');
    const i = src.indexOf('async function doVersions(');
    const j = src.indexOf('\n// ── Обновление', i);
    if (i < 0 || j < 0) throw new Error('doVersions() в hub.js не найдена');
    const G = require(path.join(ROOT, 'tools', 'git-pull-safe'));
    let gitCalls = 0;
    const spy = Object.assign({}, G, { listCommits: (n) => { gitCalls++; return G.listCommits(n); } });
    const printed = [], raw = [];
    let ki = 0;
    const id = s => s, tag = (_, s) => s;
    const fn = new Function('require', 'line', 'dim', 'bold', 'red', 'green', 'yellow', 'cyan', 'e',
        'clearScreen', 'CURSOR', 'readKey', 'keyName', 'confirm', 'pause', 'gitHead', 'doRestart',
        'process', 'out', 'eraseLine', 'TTY', src.slice(i, j) + '; return doVersions;')(
        (p) => (p === './tools/git-pull-safe' ? spy : require(p)),
        (s = '') => printed.push(String(s)), id, id, id, id, id, id, tag,
        () => { }, '>', async () => ({ name: keys[ki++] || 'q' }), k => k.name,
        async () => false, async () => { }, () => 'head', async () => { }, process,
        s => raw.push(s), () => { }, true);
    return fn().then(() => ({
        gitCalls, printed,
        cursorUps: raw.filter(s => /\x1b\[\d+A/.test(s)).length,
    }));
}

ta('экран рисуется и отдаёт список с маркерами', async () => {
    const r = await driveVersionsScreen(['q']);
    if (!r.printed.some(l => l.includes('Версии кода'))) return 'нет шапки экрана';
    if (!r.printed.some(l => l.includes('◀ сейчас'))) return 'нет маркера «сейчас» — непонятно, где стоим';
    if (!r.printed.some(l => l.includes('на GitHub'))) return 'нет маркера «на GitHub» — непонятно, куда возвращаться';
    return true;
});

ta('стрелка НЕ перерисовывает кадр и НЕ дёргает git', async () => {
    // Ровно та болезнь, что лечили в главном меню 25.08 и снова получили здесь:
    // draw() чистит экран и заново зовёт `git log` + пачку `rev-parse` — владелец
    // видит чёрный экран на каждое нажатие. Стрелка обязана перерисовать ДВЕ строки.
    const r = await driveVersionsScreen(['down', 'down', 'up', 'q']);
    if (r.gitCalls !== 1) return `listCommits вызван ${r.gitCalls} раз — кадр перерисовывается на стрелку`;
    if (r.cursorUps !== 6) return `точечных подъёмов курсора ${r.cursorUps}, ожидалось 6 (3 стрелки × 2 строки)`;
    return true;
});

t('откат заведён в меню хаба рядом с «Обновить»', () => {
    // Механика без точки входа мертва, а пункт легко потерять при мерже. Плюс место
    // важно само по себе: откатываются, когда дашборд сломан, и в вебе кнопки не
    // будет — 04.09 панель из дашборда убрали именно поэтому.
    const src = fs.readFileSync(path.join(ROOT, 'hub.js'), 'utf8');
    if (!/async function doVersions\(/.test(src)) return 'нет функции doVersions()';
    if (!/require\('\.\/tools\/git-pull-safe'\)/.test(src)) return 'doVersions не берёт механику из tools/git-pull-safe';
    const m = src.match(/function menuItems\(\) \{[\s\S]*?\n\}/);
    if (!m) return 'menuItems() не найдена';
    // Считаем по строкам, а не по офсетам: сама строка пункта «Версии» начинается с
    // `{ key:`, и поиск этого маркера «между пунктами» по срезу ловил её же.
    const lines = m[0].split('\n');
    const iUpd = lines.findIndex(l => l.includes("label: 'Обновить'"));
    const iVer = lines.findIndex(l => l.includes("label: 'Версии'"));
    if (iVer < 0) return 'в меню нет пункта «Версии»';
    if (iVer < iUpd) return 'пункт «Версии» стоит ВЫШЕ «Обновить» — просили рядом, ниже';
    const between = lines.slice(iUpd + 1, iVer).filter(l => /\{\s*key:/.test(l.replace(/\/\/.*$/, '')));
    if (between.length) return `между «Обновить» и «Версии» ещё ${between.length} пункт(ов) — соседство потеряно`;
    if (!/label: 'Версии'[^}]*noPause: true/.test(m[0])) return 'у «Версий» нет noPause — «q назад» упрётся в «Enter — вернуться»';
    return true;
});

t('в веб-дашборде отката НЕТ', () => {
    // Обратная сторона решения 04.09: панель в UI была снята намеренно. Если она
    // вернётся, вернётся и исходная беда — сломанный дашборд не может предложить
    // свой же UI для починки.
    const html = fs.readFileSync(path.join(ROOT, 'routing', 'proxy-dashboard.html'), 'utf8');
    for (const token of ['dashCheckout', 'loadDashCommits', 'dash-commits-box']) {
        if (html.includes(token)) return `в дашборде снова есть ${token} — откат должен жить только в хабе`;
    }
    const proxy = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8');
    for (const route of ['dashboard/commits', 'dashboard/checkout']) {
        if (proxy.includes(route)) return `в проксе снова есть ручка ${route}`;
    }
    return true;
});

t('после отката хаб предлагает перезапуск стека', () => {
    // Файлы на диске уже другие, а в памяти процессов прежний код: без рестарта
    // откат виден только в git и читается как «откат не сработал».
    const src = fs.readFileSync(path.join(ROOT, 'hub.js'), 'utf8');
    const i = src.indexOf('async function doVersions(');
    const seg = src.slice(i, src.indexOf('\n// ── Обновление', i));
    if (!/doRestart\(/.test(seg)) return 'doVersions не зовёт doRestart — откат останется только в git';
    if (!/backupRef/.test(seg)) return 'doVersions не показывает backup-тег — срезанные коммиты нечем найти';
    return true;
});

t('механика не пушит на GitHub', () => {
    // Решение владельца 04.09: люди скачивают с GitHub, плохая версия у них
    // лечится коммитом-фиксом вперёд, а не стиранием истории. Никакого push
    // (тем более force) в moveTo() быть не должно.
    const mod = fs.readFileSync(path.join(ROOT, 'tools', 'git-pull-safe.js'), 'utf8');
    const seg = mod.slice(mod.indexOf('function moveTo'));
    if (/'push'/.test(seg)) return 'moveTo() пушит — откат не должен трогать remote';
    return true;
});

(async () => {
    for (const [n, fn] of ASYNC) {
        try { const r = await fn(); if (r === true || r === undefined) ok(n); else bad(n, String(r)); }
        catch (e) { bad(n, e.message); }
    }

    // Клон свой, созданный этой же сессией -> удаляем напрямую (правило корзины на
    // временные артефакты не распространяется).
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }

    const head = fails.length ? '[31m[FAIL][0m' : '[32m[OK][0m';
    console.log(`
${head} проверок ${pass}, ошибок ${fails.length}`);
    if (fails.length) { for (const f of fails) console.error(`  · ${f}`); process.exit(1); }
})();
