#!/usr/bin/env node
/*
 * check-drain.js — регресс на мягкую остановку прокси (`POST /__drain`).
 *
 * Зачем файл существует: рестарт хаба гасил прокси мгновенно, и КАЖДЫЙ запрос в полёте
 * превращался для Claude Code в `Connection closed mid-response` или `ECONNRESET`. 05.09
 * дашборд поднимался по четыре раза в час, и владелец сказал прямо: «прокси не должна
 * рвать соединение, она должна ловить и не ложить клиента».
 *
 * 🪤 Мягко погасить чужой процесс на Windows нельзя: SIGTERM не доставляется, `taskkill`
 * без `/F` для node бесполезен. Поэтому сигнал внутриполосный, и цена ошибки в нём ровно
 * та же, что у любого пути остановки: не дожмёт — рвём клиента, не выйдет — рестарт висит.
 *
 * Живой стек НЕ трогает: свои экземпляры на подставных портах, заглушка вместо шлюза.
 *
 * Запуск: node tools/check-drain.js      (exit 1 = мягкая остановка сломана)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-drain-'));
const SSE = 'event: message_start\ndata: {"type":"message_start"}\n\n'
  + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"ДРЕНАЖ-ОК"}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

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

// Заглушка шлюза: отвечает МЕДЛЕННО, чтобы запрос гарантированно был «в полёте»,
// когда мы попросим дренаж.
function stubGateway(port, delayMs) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'claude-opus-5' }] }));
    }
    req.resume();
    req.on('end', () => setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end(SSE);
    }, delayMs));
  });
  return { srv, listen: () => new Promise((r) => srv.listen(port, '127.0.0.1', r)) };
}

function spawnKeepalive(port, upPort) {
  const logFile = path.join(TMP, `kp-${port}.log`);
  const kp = spawn(process.execPath, [path.join(__dirname, '..', 'routing', 'keepalive-proxy.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      UPSTREAM: `http://127.0.0.1:${upPort}`,
      KEEPALIVE_LOG_FILE: logFile,
      CONFIG_FILE: path.join(TMP, `cfg-${port}.json`),
      LATENCY_FILE: path.join(TMP, `lat-${port}.json`),
      EVENTS_FILE: path.join(TMP, `ev-${port}.json`),
      KEY_FILE: path.join(TMP, 'no-key.txt'),
      AUTOROTATE: '0', HAIKU_REMAP: '0', HEDGE_MS: '0', PRE_COMMIT_MS: '0',
      DRAIN_MAX_MS: '8000',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const box = { proc: kp, log: '', exited: false, code: null };
  kp.stdout.on('data', (c) => { box.log += c; });
  kp.stderr.on('data', (c) => { box.log += c; });
  kp.on('exit', (code) => { box.exited = true; box.code = code; });
  return box;
}

function ask(port) {
  const body = JSON.stringify({ model: 'claude-opus-5', stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const post = (port, p) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, timeout: 3000 }, (r) => {
    let s = ''; r.on('data', (c) => { s += c; }); r.on('end', () => resolve({ status: r.statusCode, body: s }));
  });
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  req.on('error', () => resolve({ status: 0, body: '' }));
  req.end();
});

(async () => {
  const open = [];
  let checks = 0;
  try {
    // ── Сцена 1: запрос в полёте дожимается, а не рвётся ────────────────────────
    // Главное свойство: просим дренаж ПОСРЕДИ запроса и ждём, что клиент получит
    // полный ответ, а процесс выйдет сам — уже после этого.
    {
      const [P, U] = [28371, 28372];
      const gw = stubGateway(U, 4000);
      await gw.listen();
      const kp = spawnKeepalive(P, U);
      open.push(gw.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 8000, 'старт keepalive');

      const answer = ask(P);                       // запрос ушёл и висит 4с
      answer.catch(() => {});                      // страховка: провал ассерта ниже не должен валить регресс
      await new Promise((r) => setTimeout(r, 800));
      const d = await post(P, '/__drain');
      assert.strictEqual(d.status, 200, `дренаж принят (было ${d.status})`);
      assert.ok(/"draining":true/.test(d.body), 'ответ дренажа говорит о себе честно');
      assert.ok(/"inflight":1/.test(d.body), `дренаж видит запрос в полёте: ${d.body}`);
      checks += 3;

      // Новые СОЕДИНЕНИЯ после дренажа не принимаются (уже открытые — дожимаются,
      // в этом и смысл). Проверяем сырым connect: по HTTP через keep-alive сокет
      // запрос доедет и различать нечего.
      const refused = await new Promise((resolve) => {
        const c = net.connect({ host: '127.0.0.1', port: P });
        c.once('connect', () => { c.destroy(); resolve(false); });
        c.once('error', () => resolve(true));
      });
      assert.ok(refused, 'новое соединение после дренажа отвергнуто');
      checks += 1;

      const r = await answer;
      assert.strictEqual(r.status, 200, `начатый запрос дожат, а не оборван (было ${r.status})`);
      assert.ok(r.body.includes('ДРЕНАЖ-ОК'), 'клиент получил ответ целиком');
      checks += 2;

      await waitFor(() => kp.exited, 6000, 'процесс вышел сам после дренажа');
      assert.strictEqual(kp.code, 0, `вышел кодом 0 (было ${kp.code})`);
      assert.ok(/дренаж закончен: запросов в полёте нет/.test(kp.log), 'причина выхода в логе');
      checks += 2;
    }

    // ── Сцена 2: потолок ожидания. Один вечный запрос не должен держать рестарт ──
    // DRAIN_MAX_MS в спавне = 8с, шлюз молчит дольше — процесс обязан выйти сам.
    {
      const [P, U] = [28373, 28374];
      const gw = stubGateway(U, 60000);
      await gw.listen();
      const kp = spawnKeepalive(P, U);
      open.push(gw.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 8000, 'старт keepalive (сцена 2)');

      ask(P).catch(() => {});                      // этот запрос обречён, и это нормально
      await new Promise((r) => setTimeout(r, 800));
      await post(P, '/__drain');
      const t0 = Date.now();
      await waitFor(() => kp.exited, 20000, 'процесс вышел по потолку дренажа');
      const took = Date.now() - t0;
      assert.ok(took >= 5000, `ждал начатое, а не вышел сразу (${took}мс)`);
      assert.ok(took < 15000, `но и не висел дольше потолка (${took}мс)`);
      assert.ok(/потолок 8000мс истёк/.test(kp.log), 'в логе видно, что кончился именно потолок');
      checks += 3;
    }

    // ── Сцена 3: дренаж идемпотентен — второй запрос не ломает выход ────────────
    {
      const [P, U] = [28375, 28376];
      const gw = stubGateway(U, 1500);
      await gw.listen();
      const kp = spawnKeepalive(P, U);
      open.push(gw.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 8000, 'старт keepalive (сцена 3)');
      const a = ask(P);
      a.catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      const d1 = await post(P, '/__drain');
      const d2 = await post(P, '/__drain');
      assert.strictEqual(d1.status, 200, 'первый дренаж принят');
      // 🪤 Второй доезжает по УЖЕ открытому keep-alive соединению и тоже получает 200 —
      // и это правильно: `server.close()` рвёт только приём новых соединений. Важно не
      // то, что он отказал, а что повторный дренаж не сломал выход.
      assert.strictEqual(d2.status, 200, 'повторный дренаж по живому соединению отвечает, а не рвёт');
      const r = await a;
      assert.strictEqual(r.status, 200, 'ответ всё равно дожат');
      await waitFor(() => kp.exited, 6000, 'вышел');
      checks += 3;
    }

    console.log(`check-drain OK (${checks} проверок): начатый запрос дожимается, новые не принимаются, `
      + 'процесс выходит сам, потолок ожидания работает');
    process.exitCode = 0;
  } catch (e) {
    console.error('ПРОВАЛ: ' + e.message);
    process.exitCode = 1;
  } finally {
    for (const x of open) {
      try { x.kill ? x.kill() : x.close(); } catch (e) { /* уже мёртв */ }
    }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* не критично */ }
  }
})();
