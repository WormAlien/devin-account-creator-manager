// tools/check-gh-live-capture.js
//
// Регресс на routing/lib/gh-live-capture.js: ручной вход в GitHub, случившийся ПОСЛЕ
// открытия окна, обязан попасть в копию сессии. До 2026-08-22 копия снималась один раз
// (при открытии) — и профиль жил на заселённой сессии, хотя человек логинился позже.
//
// Сети здесь нет: куки кладём в контекст руками, ротацию user_session изображаем сами.
// Запуск: node tools/check-gh-live-capture.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const { makeCapture, POLL_MS } = require('../routing/lib/gh-live-capture.js');

const FUTURE = Math.floor(Date.now() / 1000) + 14 * 24 * 3600;
let failed = 0;

function ok(cond, msg) {
    console.log(`${cond ? '✅' : '❌'} ${msg}`);
    if (!cond) failed++;
}

function ghCookies(userSession) {
    return [
        { name: 'user_session', value: userSession, domain: 'github.com', path: '/', expires: FUTURE, httpOnly: true, secure: true, sameSite: 'Lax' },
        { name: 'dotcom_user', value: 'WormAlien', domain: '.github.com', path: '/', expires: FUTURE, secure: true, sameSite: 'Lax' },
        // сессионная (expires ≤ 0) — в копию попадать не должна: умрёт вместе с браузером
        { name: '_gh_sess', value: 'ephemeral', domain: 'github.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
    ];
}

function savedSession(file) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c = j.cookies.find(x => x.name === 'user_session');
    return { value: c ? c.value : null, names: j.cookies.map(x => x.name).sort() };
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcap-'));
    const moduleDir = path.join(root, 'provider');
    const label = 'acct_test_1';
    fs.mkdirSync(path.join(moduleDir, 'profiles', label), { recursive: true });

    // Пул провайдера с привязкой gh_… — проверяем и обновление общего снимка.
    const poolFile = path.join(root, 'pool.json');
    fs.writeFileSync(poolFile, JSON.stringify([{ id: 'test_1', ghId: 'gh_probe_1' }]), 'utf8');

    const cap = makeCapture({ label, moduleDir, poolFile });
    const shared = path.join(moduleDir, '..', 'github', 'sessions', 'gh_probe_1.json');

    const context = await chromium.launchPersistentContext(path.join(moduleDir, 'profiles', label), { headless: true });
    try {
        ok(await cap.captureOnce(context, { quiet: true }) === false, 'пустой профиль: копию не пишем (нечего сохранять)');
        ok(!fs.existsSync(cap.backupFile), 'файла копии нет, пока нет user_session');

        await context.addCookies(ghCookies('SESSION-A'));
        ok(await cap.captureOnce(context, { quiet: true }) === true, 'первая сессия сохранена');
        const a = savedSession(cap.backupFile);
        ok(a.value === 'SESSION-A', 'в копии лежит именно живой user_session');
        ok(!a.names.includes('_gh_sess'), 'сессионная кука в копию не попала');
        ok(fs.existsSync(shared), 'общий снимок gh_probe_1 создан (заселение новых профилей)');
        const sh = JSON.parse(fs.readFileSync(shared, 'utf8'));
        ok(sh.seed === 'github' && sh.ghLogin === 'WormAlien', 'снимок в формате seed:github, логин распознан');

        ok(await cap.captureOnce(context, { quiet: true }) === false, 'повторный замер без входа копию не трогает');

        // Ручной вход: GitHub выдал новую куку поверх старой.
        await context.addCookies(ghCookies('SESSION-B'));
        ok(await cap.captureOnce(context, { quiet: true }) === true, 'ротация user_session замечена');
        ok(savedSession(cap.backupFile).value === 'SESSION-B', 'копия перезаписана свежей сессией');

        // holdOpen: тот же захват, но по таймеру, пока окно открыто.
        await context.addCookies(ghCookies('SESSION-C'));
        cap.holdOpen(context).catch(() => {});
        await new Promise(r => setTimeout(r, POLL_MS + 2500));
        ok(savedSession(cap.backupFile).value === 'SESSION-C', `holdOpen подхватил вход сам за ${(POLL_MS / 1000) | 0}+ с`);
    } finally {
        await context.close().catch(() => {});
        fs.rmSync(root, { recursive: true, force: true });
    }

    console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ всё сошлось');
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('❌ Ошибка теста:', e.message); process.exit(1); });
