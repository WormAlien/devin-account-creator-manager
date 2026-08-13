// proxy-logger.js — доставка логов прокси в серверный лог (transparent-proxy.js).
//
// Прокси живут отдельными процессами: bat-стартуемые (freemodel-rotator,
// freemodel-openai-proxy, vyceai-openai-proxy) пишут в свой консольный буфер,
// спавнимые detached (agentrouter-, keepalive-, custom-openai-proxy) вообще с
// stdio:'ignore' — stdout никто не читает. Из-за этого в дашборде ("Server Logs")
// видно только старт/стоп прокси, а не запросы.
//
// Этот модуль дублирует каждую строку лога батчем (дебаунс ~500мс) на
// POST /__switch/api/logs/ingest главного сервера (:8200), откуда она попадает
// в общий LOG_BUFFER и вкладку "Server Logs" дашборда.
//
//   const { createLogger } = require('./proxy-logger.js');
//   const { logLine } = createLogger('fm-oa');
//   logLine('hello'); // -> консоль прокси + LOG_BUFFER сервера

'use strict';

const http = require('http');

const INGEST_URL = process.env.PROXY_LOG_INGEST_URL || 'http://127.0.0.1:8200/__switch/api/logs/ingest';
const BATCH_DELAY_MS = 500;
const MAX_BATCH = 50;

function createLogger(name) {
    const src = name || 'proxy';
    let pending = [];
    let timer = null;

    function flush() {
        timer = null;
        if (!pending.length) return;
        const batch = pending;
        pending = [];
        let u;
        try { u = new URL(INGEST_URL); } catch { return; }
        const body = JSON.stringify({ name: src, lines: batch });
        const req = http.request({
            hostname: u.hostname,
            port: u.port,
            path: u.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 2000,
        });
        req.on('error', () => {});          // сервер лежит/перезапущен — теряем батч, не падаем
        req.on('timeout', () => req.destroy());
        req.end(body);
    }

    function logLine(s) {
        const t = new Date().toISOString().substring(11, 23);
        const line = s.startsWith('[') ? s : `[${t}] ${s}`;
        console.log(`${line}`);
        pending.push(line);
        if (timer) return;
        if (pending.length >= MAX_BATCH) return flush();
        timer = setTimeout(flush, BATCH_DELAY_MS);
    }

    return { logLine, flush };
}

module.exports = { createLogger };