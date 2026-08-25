// check-frontdoor-abort.js — ловит ли front-door уход клиента.
//
// Регресс на баг 25.08: стоял только `req.on('aborted')`, сломанный на Node 17+, и
// front-door держал запрос к апстриму до своего таймаута 600с. За день 349 висяков,
// каждый из которых ещё и платный — шлюз продолжает генерировать.
//
// Живой стек НЕ трогает: поднимает свой front-door на подставном порту, а вместо
// шлюза — заглушку, которая молчит и сообщает, порвали ли с ней соединение.
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const FD_PORT = 28311;          // подставные порты, вне всех рабочих диапазонов
const UP_PORT = 28312;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-abort-'));
const STATE = path.join(TMP, 'active-backend.json');

let upstreamDestroyed = false;
let upstreamGotRequest = false;

// Заглушка «шлюза»: принимает запрос и МОЛЧИТ. Нам интересно одно — придёт ли
// закрытие соединения, когда клиент front-door'а уйдёт.
const upstream = http.createServer((req, res) => {
    upstreamGotRequest = true;
    req.on('close', () => { upstreamDestroyed = true; });
    // намеренно ничего не отвечаем
});

function waitFor(pred, ms, what) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
            if (pred()) return resolve();
            if (Date.now() - t0 > ms) return reject(new Error('не дождались: ' + what));
            setTimeout(tick, 50);
        };
        tick();
    });
}

(async () => {
    fs.writeFileSync(STATE, JSON.stringify({
        backend: 'stub', upstream: `http://127.0.0.1:${UP_PORT}`, keyFile: null, modelmap: null,
    }), 'utf8');

    await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

    const fd = spawn(process.execPath, [path.join(__dirname, '..', 'routing', 'frontdoor-proxy.js')], {
        env: Object.assign({}, process.env, {
            PORT: String(FD_PORT), ACTIVE_BACKEND_FILE: STATE,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let fdLog = '';
    fd.stdout.on('data', (c) => { fdLog += c; });
    fd.stderr.on('data', (c) => { fdLog += c; });

    try {
        await waitFor(() => /front-door на http/.test(fdLog), 8000, 'старт front-door');

        // 1. Посылаем запрос и БРОСАЕМ его, как это делает Claude Code по своему
        //    таймауту стрима. Заглушка обязана увидеть закрытие.
        const body = JSON.stringify({ model: 'claude-opus-5', stream: true, messages: [{ role: 'user', content: 'x' }] });
        const req = http.request({
            hostname: '127.0.0.1', port: FD_PORT, method: 'POST', path: '/v1/messages',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        }, () => {});
        req.on('error', () => { /* сами порвали, это ожидаемо */ });
        req.end(body);

        await waitFor(() => upstreamGotRequest, 5000, 'запрос доехал до апстрима');
        assert.ok(!upstreamDestroyed, 'до ухода клиента апстрим жив');

        req.destroy();                        // клиент ушёл

        await waitFor(() => upstreamDestroyed, 5000,
            'front-door порвал апстрим после ухода клиента (БАГ: держал до таймаута)');
        assert.ok(/клиент ушёл/.test(fdLog), 'уход клиента попал в лог');

        console.log('check-frontdoor-abort OK (2 проверки): уход клиента рвёт апстрим, есть запись в логе');
        process.exitCode = 0;
    } catch (e) {
        console.error('ПРОВАЛ: ' + e.message);
        console.error('--- лог front-door ---\n' + fdLog.slice(-800));
        process.exitCode = 1;
    } finally {
        fd.kill();
        upstream.close();
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* не критично */ }
    }
})();
