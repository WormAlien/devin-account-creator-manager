#!/usr/bin/env node
/*
 * git-pull-safe.js — обновление кода репо, которое не спотыкается о локальное
 * состояние.
 *
 * Проблема: часть трекаемых в git JSON'ов дашборд перезаписывает сам — маппинг
 * claude-тиров по вкладкам, активный бэкенд, маппинг claude→gpt. Стоит поменять
 * модель в UI, и `git pull --ff-only` навсегда упирается в
 *   error: Your local changes to the following files would be overwritten by merge:
 *     routing/ar-modelmap.json
 * У двух друзей обновление дашборда встало именно так.
 *
 * Здесь единственная реализация «безопасного pull» на весь репо: содержимое
 * файлов состояния сохраняем в память → `git checkout --` → pull → пишем назад.
 * Настройки пользователя выживают, даже если апстрим менял тот же файл.
 * Грязный настоящий код не трогаем: возвращаем список файлов, решает человек.
 *
 * Использование:
 *   node tools/git-pull-safe.js          # CLI (update.sh / fix.sh)
 *   require('../tools/git-pull-safe')    # дашборд, ручка update-pull
 *
 * Коды выхода CLI: 0 — обновлено (или уже актуально), 3 — мешают правки кода,
 * 4 — история разошлась (свои коммиты; грубая починка запрещена), 1 — прочая
 * ошибка git (нет сети, конфликт, не репо).
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

// Пути от корня репо, ровно как их печатает `git diff --name-only`.
// ⚠️ Перечисление держим только для обратной совместимости и как «якорь» в тесте:
// решает isStateFile(), у него паттерн. Причина — живой случай 21.08: список знал
// ar/gorouter/tabi-modelmap.json, а `routing/xpeach-modelmap.json` в нём забыли,
// хотя дашборд его пишет ровно так же (XP_MODELMAP_FILE). Второй пользователь
// поправил тир-карту XPeach в UI, и обновление встало насмерть: кнопка в дашборде
// показывала сырое «Your local changes … would be overwritten by merge», а
// починка этой ошибки доезжает только через то же обновление.
const LOCAL_STATE_FILES = [
    'routing/ar-modelmap.json',
    'routing/gorouter-modelmap.json',
    'routing/tabi-modelmap.json',
    'routing/xpeach-modelmap.json',
    'routing/proxy-target.json',
    'routing/fm-openai-config.json',
    // Время сброса чек-ина AR и размер бонуса. Дашборд пишет файл сам
    // (`AR_CHECKIN_FILE`, transparent-proxy.js:8136 — тот же `JSON.stringify + '\n'`,
    // что и тир-карты), но под паттерн `*-modelmap.json` он не попадает, поэтому
    // здесь перечислением. Те же грабли, что были с `xpeach-modelmap.json`.
    'routing/ar-checkin.json',
    // Тумблер front-door: в репо лежит enabled:false, у владельца включён — иначе
    // каждый git pull упирался бы в «локальные правки» из-за одного булева.
    'routing/frontdoor.json',
];

// Тир-карты заводятся вместе с провайдером, и строчку в списке забыть легко.
// Поэтому любой трекаемый `routing/<что-то>-modelmap.json` — файл состояния
// по определению: его единственный писатель — вкладка провайдера в дашборде.
const STATE_PATTERNS = [/^routing\/[A-Za-z0-9_-]+-modelmap\.json$/];

function isStateFile(f) {
    return LOCAL_STATE_FILES.includes(f) || STATE_PATTERNS.some(re => re.test(f));
}

function git(...args) {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
}

// Грязь спрашиваем ДВУМЯ командами, потому что одна врёт.
//
// `git diff --name-only HEAD` сравнивает HEAD с рабочим деревом ПОСЛЕ нормализации
// переводов строк, поэтому файл, отличающийся от индекса только CRLF/LF, для него
// чистый — а `git pull` в него всё равно упирается. Живой случай: дашборд
// перезаписывает тир-карту из Node (`JSON.stringify(...) + '\n'`, то есть LF), а
// `.gitattributes` (`*.json text`) с `core.autocrlf=true` требуют в рабочей копии
// CRLF. Итог для человека — тупик без выхода: `git diff` по файлу ПУСТ (откатывать
// нечего), `git pull` встаёт на «local changes would be overwritten», наш dirty
// оказывался пустым, `resettable` тоже, и наружу уходил сырой текст git'а. Починка
// же доезжает только тем самым обновлением, которое и встало.
//
// `git diff-files` сравнивает индекс с деревом и такое расхождение видит. Берём
// объединение: diff-files не покажет то, что уже добавлено в индекс (`git add`),
// diff HEAD — покажет.
function dirtyFiles() {
    const out = new Set();
    for (const args of [['diff', '--name-only', 'HEAD'], ['diff-files', '--name-only']]) {
        let raw = '';
        try { raw = git(...args); } catch { continue; }
        for (const line of raw.split('\n')) {
            const f = line.trim();
            if (f) out.add(f);
        }
    }
    return [...out];
}

// Untracked-файлы `git diff --name-only HEAD` не видит В ПРИНЦИПЕ: он сравнивает
// индекс и дерево с коммитом, а неотслеживаемого файла ни там, ни там нет. Поэтому
// когда апстрим завёл файл, который у человека уже лежит своей копией, pull падает
// на «The following untracked working tree files would be overwritten by merge»,
// наш dirty оказывается пустым и наружу уходил сырой текст git'а.
// Список путей забираем из самого сообщения — git печатает их построчно с отступом.
function parseUntracked(msg) {
    const out = [];
    let inside = false;
    for (const raw of msg.split(/\r?\n/)) {
        if (/untracked working tree files would be overwritten/i.test(raw)) { inside = true; continue; }
        if (!inside) continue;
        if (/^\s+\S/.test(raw)) { out.push(raw.trim()); continue; }
        break;  // первая строка без отступа = конец списка («Please move or remove them…»)
    }
    return out;
}

// «fatal: Not possible to fast-forward» — у человека свои коммиты, разошедшиеся с
// master. Починить это автоматически нельзя: `reset --hard` выбросил бы именно их.
// Но и сырая строчка git'а не говорит человеку ни что случилось, ни что делать.
function divergedMessage(raw) {
    let ahead = '?', behind = '?';
    try {
        const c = git('rev-list', '--left-right', '--count', 'HEAD...@{u}').split(/\s+/);
        if (c.length >= 2) { ahead = c[0]; behind = c[1]; }
    } catch { }
    return [
        `История разошлась: у тебя ${ahead} своих коммит(ов), в апстриме ${behind} новых — fast-forward невозможен.`,
        'Сами не сливаем: это решение человека, а reset --hard выбросил бы твои коммиты.',
        'Разрулить:  git pull --rebase     (посмотреть своё:  git log --oneline @{u}..HEAD)',
        raw.trim(),
    ].filter(Boolean).join('\n');
}

function isDiverged(msg) {
    return /not possible to fast-forward|divergent branches/i.test(msg);
}

// Спрятать ИМЕННО мешающие файлы, а не всё дерево: `git stash push -- <пути>`.
// Без ограничения путями stash уносит и то, что pull'у не мешало (в т.ч. файлы
// состояния, которые мы бережём отдельно) — человек потом ищет, куда делись
// настройки. Возвращает { ok, ref, error }: ref нужен, чтобы сказать «лежит вот тут».
//
// includeUntracked → добавляем -u: без него `stash push` неотслеживаемые файлы не
// заберёт, они останутся в дереве и pull упрётся в них повторно.
function stashPaths(paths, label, includeUntracked) {
    try {
        const args = ['stash', 'push', '-m', label];
        if (includeUntracked) args.push('-u');
        git(...args, '--', ...paths);
        // Ссылка на только что созданную запись. Пусто = git решил, что прятать
        // нечего (например файл вернулся к HEAD между проверкой и стэшем).
        let ref = '';
        try { ref = git('stash', 'list', '--format=%gd %gs', '-1'); } catch { }
        return { ok: true, ref };
    } catch (e) {
        return { ok: false, ref: '', error: (e.stderr || e.stdout || e.message || '').toString().trim() };
    }
}

// Возвращает { ok, output, preserved, blocking, stashed, stashRef, error }.
// blocking непустой → pull не делали, мешают правки кода.
//
// opts.stashBlocking = true → правки кода не блокируют обновление: они уходят в
// `git stash` (по путям), pull проходит, в ответе стоят `stashed` и `stashRef`.
// Это то, что раньше умел ТОЛЬКО update.sh, из-за чего кнопка в дашборде
// оказывалась глупее батника и запирала человека (21.08, разбор в
// docs/ + Debug Reference). Теперь умеет один код на всех вызывающих.
//
// Почему stash, а НЕ `reset --hard`: stash обратим и мы про него говорим, а reset
// выбрасывает и незапушенные коммиты. Автоматически такое делать нельзя — остаётся
// последним средством в CLI (update.sh), из UI не предлагается.
function pullSafe(opts = {}) {
    const stashBlocking = !!opts.stashBlocking;
    const pull = () => git('pull', '--ff-only', '--no-edit');
    const empty = { ok: false, output: '', preserved: [], blocking: [], stashed: [] };
    try {
        return { ok: true, output: pull(), preserved: [], blocking: [], stashed: [] };
    } catch (e1) {
        const msg = (e1.stderr || e1.stdout || e1.message || '').toString();
        // Свои коммиты — не «грязное дерево», ниже их лечить нечем.
        if (isDiverged(msg)) return { ...empty, diverged: true, error: divergedMessage(msg) };
        if (!/would be overwritten|local changes/i.test(msg)) {
            return { ...empty, error: msg.trim() };
        }
        const dirty = dirtyFiles();
        const untracked = parseUntracked(msg);
        const resettable = dirty.filter(isStateFile);
        // Апстрим завёл тир-карту, а у человека уже лежит своя (её создал дашборд, пока
        // файла не было в репо). Это ровно тот же случай, что грязная трекаемая карта:
        // содержимое в память → убрать с пути → pull → вписать назад.
        const untrackedState = untracked.filter(isStateFile);
        const blocking = dirty.filter(f => !isStateFile(f))
            .concat(untracked.filter(f => !isStateFile(f)));
        const blockingUntracked = untracked.filter(f => !isStateFile(f));

        let stashed = [], stashRef = '';
        if (blocking.length) {
            if (!stashBlocking) {
                return { ...empty, blocking, untracked: blockingUntracked, error: msg.trim() };
            }
            const label = `git-pull-safe auto-stash ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`;
            const st = stashPaths(blocking, label, blockingUntracked.length > 0);
            if (!st.ok) {
                return { ...empty, blocking, error: st.error || 'git stash не удался' };
            }
            stashed = blocking.slice();
            stashRef = st.ref;
        }
        if (!resettable.length && !untrackedState.length && !stashed.length) {
            return { ...empty, error: msg.trim() };
        }

        const backup = new Map();
        for (const f of resettable.concat(untrackedState)) {
            try { backup.set(f, fs.readFileSync(path.join(REPO, f), 'utf8')); } catch { }
        }
        let output;
        try {
            if (resettable.length) git('checkout', '--', ...resettable);
            // Untracked git'у не откатить — файла нет ни в индексе, ни в HEAD. Убираем
            // сами, только уже сняв копию в память (строчкой выше), иначе это потеря.
            for (const f of untrackedState) {
                if (backup.has(f)) { try { fs.unlinkSync(path.join(REPO, f)); } catch { } }
            }
            output = pull();
        } catch (e2) {
            const m2 = (e2.stderr || e2.stdout || e2.message || '').toString().trim();
            // Настройки уже сняты с пути — вернуть их обязаны в любом случае, иначе
            // упавший pull выглядит как «дашборд сбросил мои тиры».
            const restored = [];
            for (const [f, content] of backup) {
                try { fs.writeFileSync(path.join(REPO, f), content, 'utf8'); restored.push(f); } catch { }
            }
            // Правки уже в стэше — обязаны сказать, где они, иначе выглядит как потеря.
            return {
                ...empty, preserved: restored, stashed, stashRef,
                diverged: isDiverged(m2) || undefined,
                error: isDiverged(m2) ? divergedMessage(m2) : m2,
            };
        }
        const preserved = [];
        for (const [f, content] of backup) {
            try { fs.writeFileSync(path.join(REPO, f), content, 'utf8'); preserved.push(f); } catch { }
        }
        return { ok: true, output, preserved, blocking: [], stashed, stashRef };
    }
}

module.exports = { REPO, LOCAL_STATE_FILES, isStateFile, pullSafe };

if (require.main === module) {
    // --stash: правки кода не блокируют, а уходят в git stash. Тот же режим, что
    // жмёт кнопка в дашборде после подтверждения — одна реализация на всех.
    const wantStash = process.argv.includes('--stash');
    const r = pullSafe({ stashBlocking: wantStash });
    if (r.ok) {
        if (r.output) console.log(r.output);
        if (r.preserved.length) console.log(`локальные настройки сохранены: ${r.preserved.join(', ')}`);
        if (r.stashed.length) {
            console.log(`правки кода спрятаны в git stash: ${r.stashed.join(', ')}`);
            if (r.stashRef) console.log(`  ${r.stashRef}`);
            console.log('  вернуть: git stash pop  (если апстрим менял тот же файл — будет конфликт, разрешить руками)');
        }
        process.exit(0);
    }
    if (r.stashed && r.stashed.length) {
        console.error(`ВНИМАНИЕ: правки уже в git stash (${r.stashed.join(', ')}), но pull не прошёл.`);
        if (r.stashRef) console.error(`  ${r.stashRef}`);
        console.error('  вернуть: git stash pop');
    }
    if (r.preserved && r.preserved.length) {
        console.error(`локальные настройки возвращены на место: ${r.preserved.join(', ')}`);
    }
    if (r.blocking.length) {
        const newFiles = new Set(r.untracked || []);
        console.error('Обновлению мешает локальное состояние рабочей копии:');
        for (const f of r.blocking) console.error(`  ${f}${newFiles.has(f) ? '   (новый файл, не в git — апстрим завёл такой же)' : ''}`);
        console.error('Откати их (git checkout -- <файл>), сохрани (git stash)');
        console.error('или запусти с --stash, чтобы спрятать их автоматически.');
        process.exit(3);
    }
    console.error(r.error || 'git pull не удался');
    // Отдельный код для разошедшихся историй: вызывающим скриптам (update.sh/fix.sh)
    // нельзя в этом случае доезжать до `reset --hard origin/master` — он выбросит
    // именно те коммиты, из-за которых pull и не прошёл. По коду 1 они имеют право
    // на грубую починку (нет сети/конфликт), по 4 — обязаны остановиться.
    process.exit(r.diverged ? 4 : 1);
}
