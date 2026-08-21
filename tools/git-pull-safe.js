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
    // Чек-ин AgentRouter: дашборд пишет его сам (AR_CHECKIN_FILE в
    // transparent-proxy.js), а паттерн тир-карт его не ловит — без строчки тут
    // упирались бы в то же самое обновление.
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

// Возвращает { ok, output, preserved, blocking, error }.
// blocking непустой → pull не делали, мешают правки кода.
function pullSafe() {
    const pull = () => git('pull', '--ff-only', '--no-edit');
    try {
        return { ok: true, output: pull(), preserved: [], blocking: [] };
    } catch (e1) {
        const msg = (e1.stderr || e1.stdout || e1.message || '').toString();
        if (!/would be overwritten|local changes/i.test(msg)) {
            return { ok: false, output: '', preserved: [], blocking: [], error: msg.trim() };
        }
        const dirty = [...new Set([
            // Файл, грязный ТОЛЬКО переводами строк, `git diff` НЕ показывает: с
            // core.autocrlf=true git ждёт в рабочей копии CRLF, дашборд пишет через
            // Node (LF), контент байт-в-байт тот же — diff пуст, а pull падает.
            // Живой случай: список грязи выходил пустым, pullSafe сдавался и печатал
            // сырую ошибку git. diff-files сравнивает рабочую копию с индексом и
            // такую грязь видит.
            ...git('diff', '--name-only', 'HEAD').split('\n'),
            ...git('diff-files', '--name-only').split('\n'),
        ])].map(s => s.trim()).filter(Boolean);
        const resettable = dirty.filter(isStateFile);
        const blocking = dirty.filter(f => !isStateFile(f));
        if (blocking.length) return { ok: false, output: '', preserved: [], blocking, error: msg.trim() };
        if (!resettable.length) return { ok: false, output: '', preserved: [], blocking: [], error: msg.trim() };

        const backup = new Map();
        for (const f of resettable) {
            try { backup.set(f, fs.readFileSync(path.join(REPO, f), 'utf8')); } catch { }
        }
        let output;
        try {
            git('checkout', '--', ...resettable);
            output = pull();
        } catch (e2) {
            const m2 = (e2.stderr || e2.stdout || e2.message || '').toString().trim();
            return { ok: false, output: '', preserved: [], blocking: [], error: m2 };
        }
        const preserved = [];
        for (const [f, content] of backup) {
            try { fs.writeFileSync(path.join(REPO, f), content, 'utf8'); preserved.push(f); } catch { }
        }
        return { ok: true, output, preserved, blocking: [] };
    }
}

module.exports = { REPO, LOCAL_STATE_FILES, isStateFile, pullSafe };

if (require.main === module) {
    const r = pullSafe();
    if (r.ok) {
        if (r.output) console.log(r.output);
        if (r.preserved.length) console.log(`локальные настройки сохранены: ${r.preserved.join(', ')}`);
        process.exit(0);
    }
    if (r.blocking.length) {
        console.error('Обновлению мешают локальные правки в коде:');
        for (const f of r.blocking) console.error(`  ${f}`);
        console.error('Откати их (git checkout -- <файл>) или сохрани (git stash) и повтори.');
        process.exit(3);
    }
    console.error(r.error || 'git pull не удался');
    process.exit(1);
}
