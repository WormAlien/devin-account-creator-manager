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
 * 1 — прочая ошибка git (нет сети, конфликт, не репо).
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

// Спрятать ИМЕННО мешающие файлы, а не всё дерево: `git stash push -- <пути>`.
// Без ограничения путями stash уносит и то, что pull'у не мешало (в т.ч. файлы
// состояния, которые мы бережём отдельно) — человек потом ищет, куда делись
// настройки. Возвращает { ok, ref, error }: ref нужен, чтобы сказать «лежит вот тут».
function stashPaths(paths, label) {
    try {
        git('stash', 'push', '-m', label, '--', ...paths);
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
    try {
        return { ok: true, output: pull(), preserved: [], blocking: [], stashed: [] };
    } catch (e1) {
        const msg = (e1.stderr || e1.stdout || e1.message || '').toString();
        if (!/would be overwritten|local changes/i.test(msg)) {
            return { ok: false, output: '', preserved: [], blocking: [], stashed: [], error: msg.trim() };
        }
        const dirty = git('diff', '--name-only', 'HEAD').split('\n').map(s => s.trim()).filter(Boolean);
        const resettable = dirty.filter(isStateFile);
        const blocking = dirty.filter(f => !isStateFile(f));

        let stashed = [], stashRef = '';
        if (blocking.length) {
            if (!stashBlocking) {
                return { ok: false, output: '', preserved: [], blocking, stashed: [], error: msg.trim() };
            }
            const label = `git-pull-safe auto-stash ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`;
            const st = stashPaths(blocking, label);
            if (!st.ok) {
                return { ok: false, output: '', preserved: [], blocking, stashed: [], error: st.error || 'git stash не удался' };
            }
            stashed = blocking.slice();
            stashRef = st.ref;
        }
        if (!resettable.length && !stashed.length) {
            return { ok: false, output: '', preserved: [], blocking: [], stashed: [], error: msg.trim() };
        }

        const backup = new Map();
        for (const f of resettable) {
            try { backup.set(f, fs.readFileSync(path.join(REPO, f), 'utf8')); } catch { }
        }
        let output;
        try {
            if (resettable.length) git('checkout', '--', ...resettable);
            output = pull();
        } catch (e2) {
            const m2 = (e2.stderr || e2.stdout || e2.message || '').toString().trim();
            // Правки уже в стэше — обязаны сказать, где они, иначе выглядит как потеря.
            return { ok: false, output: '', preserved: [], blocking: [], stashed, stashRef, error: m2 };
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
    if (r.blocking.length) {
        console.error('Обновлению мешают локальные правки в коде:');
        for (const f of r.blocking) console.error(`  ${f}`);
        console.error('Откати их (git checkout -- <файл>), сохрани (git stash)');
        console.error('или запусти с --stash, чтобы спрятать их автоматически.');
        process.exit(3);
    }
    console.error(r.error || 'git pull не удался');
    process.exit(1);
}
