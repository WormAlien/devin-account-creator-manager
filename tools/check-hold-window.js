// check-hold-window.js — удерживает ли keepalive запрос, пока лежит путь до шлюза.
//
// Регресс на баг 03.09: бюджет восстановления задавался числом попыток (3 × 1.5с/3с ≈ 5с),
// а переключение VPN на станции роняет путь на 5–30с. Попытки кончались раньше простоя, и
// запрос умирал в момент, когда чинить было ещё нечего: подагенты Claude Code от одной
// ошибки API умирают целиком (замер: 246 ошибок на 3376 запросов, 7.3%).
// Плюс второй регресс: `model_not_found` («No available channel») считался транзиентным и
// жёг три попытки в канал, которого нет — 179 смертей из 220 за сутки.
//
// Живой стек НЕ трогает: поднимает свои keepalive на подставных портах, а вместо шлюза —
// заглушку, которая рвёт соединение по счётчику. Логи и конфиги пишет в temp.
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const KP = path.join(__dirname, '..', 'routing', 'keepalive-proxy.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-hold-'));
const SSE_BODY = 'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5"}}\n\n'
  + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"ХОЛД-ОК"}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const ROUTE_MISS = JSON.stringify({ error: { code: 'model_not_found', message: 'No available channel for model claude-opus-4-8 under group g' } });

// 🪤 Убирать детей ТОЛЬКО в finally недостаточно: необработанное отклонение промиса
// убивает процесс мгновенно, finally не выполняется, и подставные keepalive остаются
// слушать порты. Поймано на себе — «провал» регресса оказался залётным процессом от
// упавшего прогона двадцатью минутами раньше.
const spawned = [];
const reap = () => { for (const p of spawned) { try { p.kill(); } catch (e) { /* уже мёртв */ } } };
process.on('exit', reap);
process.on('unhandledRejection', (e) => {
  console.error('НЕОБРАБОТАННОЕ ОТКЛОНЕНИЕ: ' + (e && e.message));
  reap();
  process.exit(1);
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

// Заглушка шлюза. mode: 'reset-then-ok' — первые resets запросов рвёт сокет посреди
// ожидания (ровно то, что делает флап туннеля), дальше отдаёт нормальный SSE;
// 'route-miss' — всегда 503 с телом New API;
// 'only-opus5' — 200 только на `claude-opus-5`, на остальное 503 model_not_found
//                (живой случай justwoker 03.09: `claude-opus-4-8` сняли с каналов).
// GET /v1/models отдаёт каталог и в счётчик hits НЕ идёт: это служебный запрос прокси,
// а сцены считают именно обращения за генерацией.
function stubGateway(port, mode, resets, silenceMs) {
  const state = { hits: 0, models: 0, modelsFail: false, seen: [] };
  const quiet = Number(silenceMs || 300);
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      state.models += 1;
      if (state.modelsFail) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'claude-opus-5' }, { id: 'claude-opus-5-thinking' }] }));
    }
    state.hits += 1;
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      let asked = '';
      try { asked = JSON.parse(Buffer.concat(body).toString('utf8') || '{}').model || ''; } catch { /* не json */ }
      state.seen.push(asked);
      if (mode === 'route-miss' || (mode === 'only-opus5' && asked !== 'claude-opus-5')) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(ROUTE_MISS);
      }
      if (mode === 'reset-then-ok' && state.hits <= resets) {
        // Молчим, как молчит живой шлюз, и рвём — это не отказ, а обрыв пути.
        return setTimeout(() => { try { req.socket.destroy(); } catch { /* уже мёртв */ } }, quiet);
      }
      // Поток открылся и не дал ни байта содержимого: живой случай kktoken 03.09 в 21:13 —
      // заголовки есть, 60 пингов, ноль контента, потом обрыв.
      if ((mode === 'open-then-die' || mode === 'open-forever') && state.hits <= resets) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.flushHeaders();
        if (mode === 'open-then-die') {
          setTimeout(() => { try { req.socket.destroy(); } catch { /* уже мёртв */ } }, quiet);
        }
        return;   // 'open-forever' — держим открытым и молчим, пусть сработает страховка
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end(SSE_BODY);
    });
  });
  return { srv, state, listen: () => new Promise((r) => srv.listen(port, '127.0.0.1', r)) };
}

// Заглушка для НЕ-стримового запроса: молчит quiet мс, потом отдаёт готовый JSON —
// ровно то, что делает шлюз на `/compact`, только быстрее.
function stubJsonGateway(port, quiet) {
  const state = { hits: 0 };
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'claude-opus-5' }] }));
    }
    state.hits += 1;
    req.on('data', () => {});
    req.on('end', () => {
      setTimeout(() => {
        const body = JSON.stringify({ type: 'message', model: 'claude-opus-5', content: [{ type: 'text', text: 'JSON-ОК' }] });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      }, quiet);
    });
  });
  return { srv, state, listen: () => new Promise((r) => srv.listen(port, '127.0.0.1', r)) };
}

// Не-стримовый запрос: возвращаем сырое тело и заголовки — нам важно и то, и другое.
function askJson(port) {
  const body = JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] });
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw, ms: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Экземпляр keepalive на подставном порту. Все файлы — в temp: рабочие
// keepalive-<порт>.log / -config / -latency не трогаем.
function spawnKeepalive(port, upPort, env) {
  const logFile = path.join(TMP, `kp-${port}.log`);
  const kp = spawn(process.execPath, [KP], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      UPSTREAM: `http://127.0.0.1:${upPort}`,
      KEEPALIVE_LOG_FILE: logFile,
      CONFIG_FILE: path.join(TMP, `cfg-${port}.json`),
      LATENCY_FILE: path.join(TMP, `lat-${port}.json`),
      EVENTS_FILE: path.join(TMP, `ev-${port}.json`),
      KEY_FILE: path.join(TMP, 'no-such-key.txt'),
      AUTOROTATE: '0',
      HAIKU_REMAP: '0',
      HEDGE_MS: '0',
      PRE_COMMIT_MS: '0',
      IDLE_MS: '5000',
    }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(kp);
  const box = { proc: kp, log: '' };
  kp.stdout.on('data', (c) => { box.log += c; });
  kp.stderr.on('data', (c) => { box.log += c; });
  return box;
}

function ask(port, model) {
  const body = JSON.stringify({ model: model || 'claude-opus-5', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'x' }] });
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out, ms: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  const open = [];
  let checks = 0;
  try {
    // ── Сцена 1: обрыв посреди ожидания, бюджет попыток исчерпан — спасает удержание ──
    {
      const [P, U] = [28341, 28342];
      const gw = stubGateway(U, 'reset-then-ok', 1);
      await gw.listen();
      const kp = spawnKeepalive(P, U, { MAX_ATTEMPTS: '1', HOLD_MS: '30000' });
      open.push(gw.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 8000, 'старт keepalive (сцена 1)');

      const r = await ask(P);
      assert.strictEqual(r.status, 200, `после обрыва клиент получил 200, а не ошибку (было ${r.status})`);
      assert.ok(r.body.includes('ХОЛД-ОК'), 'ответ шлюза доехал до клиента целиком');
      assert.ok(!/event: error/.test(r.body), 'в потоке нет in-band ошибки');
      assert.strictEqual(gw.state.hits, 2, `шлюз спрошен дважды: обрыв + повтор (было ${gw.state.hits})`);
      assert.ok(/удержание #1/.test(kp.log), 'удержание отработало и записано в лог');
      assert.ok(/путь до 127\.0\.0\.1 жив/.test(kp.log), 'перед повтором проверен путь');
      checks += 6;
    }

    // ── Сцена 2: промах маршрута — отказ сразу, попытки не жжём ──────────────────
    {
      const [P, U] = [28343, 28344];
      const gw = stubGateway(U, 'route-miss', 0);
      await gw.listen();
      const kp = spawnKeepalive(P, U, { MAX_ATTEMPTS: '3', HOLD_MS: '30000' });
      open.push(gw.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 8000, 'старт keepalive (сцена 2)');

      const r = await ask(P);
      assert.strictEqual(r.status, 503, `промах маршрута отдан как есть, 503 (было ${r.status})`);
      assert.ok(/model_not_found/.test(r.body), 'клиент видит настоящую причину от шлюза');
      assert.strictEqual(gw.state.hits, 1, `шлюз спрошен ОДИН раз, без ретраев в мёртвый канал (было ${gw.state.hits})`);
      assert.ok(!/повтор\/копия/.test(kp.log), 'ни одной попытки не потрачено');
      assert.ok(r.ms < 2000, `отказ пришёл быстро, до пре-коммита (${r.ms}мс)`);
      checks += 5;
    }

    // ── Сцена 3: путь мёртв целиком — держим окно, потом сдаёмся повторяемой формой ──
    // Шлюза на порту нет вовсе: проба соединения падает, удержание ждёт, окно кончается.
    {
      const [P, U] = [28345, 28346];
      const kp = spawnKeepalive(P, U, { MAX_ATTEMPTS: '1', HOLD_MS: '6000' });
      open.push(kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 8000, 'старт keepalive (сцена 3)');

      const r = await ask(P);
      assert.strictEqual(r.status, 529, `сдаёмся как «шлюз занят», 529 — эту форму клиент повторяет сам (было ${r.status})`);
      assert.ok(/overloaded_error/.test(r.body), 'тело отказа — overloaded_error, а не proxy_error');
      assert.ok(r.ms >= 3000, `держали клиента, а не убили за пять секунд бюджета попыток (${r.ms}мс)`);
      assert.ok(/удержание #1/.test(kp.log), 'удержание пыталось спасти запрос');
      assert.ok(/не ожил за 6000мс/.test(kp.log), 'в логе видно, что именно кончилось — окно, а не попытки');
      checks += 5;
    }

    // ── Сцена 4: главная. Пре-коммит уже открыл поток — обрыв всё равно невидим ────
    // Именно эта комбинация и убивала подагентов: к 10-й секунде тишины срабатывает
    // пре-коммит, дальше `writeHead` нельзя, и сдача уходит `event: error` ВНУТРЬ уже
    // начатого потока. Начатый поток Claude Code повторить не умеет. Проверяем, что
    // после пре-коммита обрыв переигрывается молча и клиент получает нормальный ответ.
    {
      const [P, U] = [28347, 28348];
      const gw = stubGateway(U, 'reset-then-ok', 1, 4000);
      await gw.listen();
      const kp = spawnKeepalive(P, U, { MAX_ATTEMPTS: '1', HOLD_MS: '30000', PRE_COMMIT_MS: '2000', IDLE_MS: '800' });
      open.push(gw.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 8000, 'старт keepalive (сцена 4)');

      const r = await ask(P);
      assert.ok(/пре-коммит SSE/.test(kp.log), 'пре-коммит успел открыть поток — сцена воспроизведена');
      assert.strictEqual(r.status, 200, `клиент получил 200 (было ${r.status})`);
      assert.ok(!/event: error/.test(r.body), 'in-band ошибки нет — подагент бы выжил');
      assert.ok(r.body.includes('ХОЛД-ОК'), 'настоящий ответ шлюза доехал в тот же поток');
      assert.ok(/event: ping/.test(r.body), 'пока держали, клиента кормили пингами');
      assert.strictEqual(gw.state.hits, 2, `шлюз спрошен дважды (было ${gw.state.hits})`);
      checks += 6;
    }

    // ── Сцена 5: карта тира указывает на модель, которой у шлюза уже нет ─────────
    // Живой случай 03.09: justwoker снял `claude-opus-4-8`, тиры sonnet/haiku смотрели
    // на него, и КАЖДЫЙ запрос сабагента умирал. Каталог шлюза прогрет на старте, поэтому
    // подмена должна случиться ДО первого обращения — мёртвую модель шлюз не увидит вовсе.
    {
      const [P, U] = [28351, 28352];
      const map = path.join(TMP, 'map-dead.json');
      fs.writeFileSync(map, JSON.stringify({ opus: 'claude-opus-5', sonnet: 'claude-opus-4-8', haiku: 'claude-opus-4-8' }), 'utf8');
      const gw = stubGateway(U, 'only-opus5', 0);
      await gw.listen();
      const kp = spawnKeepalive(P, U, { MAX_ATTEMPTS: '3', HOLD_MS: '30000', HAIKU_REMAP: '1', MODELMAP_FILE: map });
      open.push(gw.srv, kp.proc);
      await waitFor(() => /каталог 127\.0\.0\.1/.test(kp.log), 8000, 'каталог шлюза прочитан на старте');

      const r = await ask(P, 'claude-sonnet-5[1m]');
      assert.strictEqual(r.status, 200, `сабагент получил ответ, а не 503 (было ${r.status})`);
      assert.ok(/ПОДМЕНА: claude-opus-4-8 нет у шлюза/.test(kp.log), 'подмена видна в логе с причиной');
      assert.deepStrictEqual(gw.state.seen, ['claude-opus-5'], `шлюз спрошен живой моделью сразу (видел ${JSON.stringify(gw.state.seen)})`);
      assert.ok(r.body.includes('ХОЛД-ОК'), 'ответ доехал до клиента');
      checks += 4;
    }

    // ── Сцена 6: модель сняли ПОСЛЕ прогрева каталога — лечимся на живом запросе ──
    // Каталог на старте недоступен (404), поэтому первая попытка уезжает мёртвой моделью.
    // Прокси обязан по ответу `model_not_found` обновить каталог, подменить модель и
    // повторить — клиент видит только успех.
    {
      const [P, U] = [28353, 28354];
      const map = path.join(TMP, 'map-dead2.json');
      fs.writeFileSync(map, JSON.stringify({ opus: 'claude-opus-5', sonnet: 'claude-opus-4-8', haiku: 'claude-opus-4-8' }), 'utf8');
      const gw = stubGateway(U, 'only-opus5', 0);
      gw.state.modelsFail = true;             // каталога на старте нет
      await gw.listen();
      const kp = spawnKeepalive(P, U, { MAX_ATTEMPTS: '3', HOLD_MS: '30000', HAIKU_REMAP: '1', MODELMAP_FILE: map });
      open.push(gw.srv, kp.proc);
      await waitFor(() => /каталог 127\.0\.0\.1[^\n]*недоступен/.test(kp.log), 8000, 'каталог на старте недоступен');
      gw.state.modelsFail = false;            // шлюз «починился» — список снова отдаётся

      const r = await ask(P, 'claude-sonnet-5[1m]');
      assert.strictEqual(r.status, 200, `запрос вылечен на лету (было ${r.status})`);
      assert.deepStrictEqual(gw.state.seen, ['claude-opus-4-8', 'claude-opus-5'],
        `сначала мёртвая модель, потом живая (видел ${JSON.stringify(gw.state.seen)})`);
      assert.ok(/подмена модели: claude-opus-4-8 → claude-opus-5, повторяю/.test(kp.log), 'подмена по ответу шлюза записана');
      assert.ok(!/повтор\/копия/.test(kp.log), 'бюджет ретраев не тронут — подмена идёт бонусной попыткой');
      checks += 4;
    }

    // ── Сцена 7: поток открылся, содержимого не дал и умер ──────────────────────
    // Живой случай kktoken 03.09 21:13: заголовки пришли, прокси кормил клиента пингами
    // пять минут (60 пингов, ноль контента), потом шлюз оборвал соединение. Клиент увидел
    // `Stream idle timeout - no chunks received`. Пинги для него не содержимое.
    {
      const [P, U] = [28355, 28356];
      const gw = stubGateway(U, 'open-then-die', 1, 800);
      await gw.listen();
      const kp = spawnKeepalive(P, U, { MAX_ATTEMPTS: '1', HOLD_MS: '30000', EMPTY_STREAM_MS: '30000' });
      open.push(gw.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 8000, 'старт keepalive (сцена 7)');

      const r = await ask(P);
      assert.strictEqual(r.status, 200, `пустой поток переигран, клиент получил 200 (было ${r.status})`);
      assert.ok(r.body.includes('ХОЛД-ОК'), 'содержимое доехало со второй попытки');
      assert.ok(!/event: error/.test(r.body), 'in-band ошибки нет');
      assert.ok(/пустой поток #1: обрыв до первого байта содержимого/.test(kp.log), 'причина переигровки в логе');
      assert.strictEqual(gw.state.hits, 2, `шлюз спрошен дважды (было ${gw.state.hits})`);
      checks += 5;
    }

    // ── Сцена 8: поток открылся и молчит — срабатывает страховка по времени ──────
    // Здесь пре-коммит включён: проверяем вторую SSE-ветку, где заголовки клиенту ушли
    // раньше ответа шлюза. Наш таймаут сокета в этой сцене бесполезен по устройству
    // (после заголовков стоит finished), поэтому страховка обязана быть своя.
    {
      const [P, U] = [28357, 28358];
      const gw = stubGateway(U, 'open-forever', 1);
      await gw.listen();
      const kp = spawnKeepalive(P, U, { MAX_ATTEMPTS: '1', HOLD_MS: '30000', EMPTY_STREAM_MS: '3000', PRE_COMMIT_MS: '2000', IDLE_MS: '800' });
      open.push(gw.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 8000, 'старт keepalive (сцена 8)');

      const r = await ask(P);
      assert.strictEqual(r.status, 200, `молчащий поток брошен и переигран (было ${r.status})`);
      assert.ok(r.body.includes('ХОЛД-ОК'), 'содержимое пришло со второй попытки в тот же поток');
      assert.ok(/пустой поток #1: 3000мс без единого байта содержимого/.test(kp.log), 'страховка по времени сработала');
      assert.ok(/event: ping/.test(r.body), 'пока переигрывали, клиента держали пингами');
      assert.ok(!/event: error/.test(r.body), 'клиент не увидел ошибки');
      checks += 5;
    }

    // ── Сцена 10: шлюз молчит ДО заголовков — страж обязан тикать с пре-коммита ──
    // Тот самый живой отказ 05.09: клиент висел на пингах 275 с и сдался сам, а страж
    // пустого потока в логе не появился ни разу — он взводился только по заголовкам
    // шлюза, которых ещё не было. Здесь заглушка не отвечает вовсе на первый запрос.
    {
      const [P, U] = [28361, 28362];
      const gw = stubGateway(U, 'open-forever', 1);
      // Заглушка режима 'open-forever' на первом запросе даже заголовков не отдаёт:
      // подменяем ей поведение — просто держим сокет молча.
      gw.srv.removeAllListeners('request');
      let hits = 0;
      gw.srv.on('request', (req, res) => {
        if (req.url.startsWith('/v1/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ data: [{ id: 'claude-opus-5' }] }));
        }
        hits += 1;
        const mine = hits;
        req.on('data', () => {});
        req.on('end', () => {
          if (mine === 1) return;                 // молчим совсем: ни заголовков, ни тела
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          res.end(SSE_BODY);
        });
      });
      await gw.listen();
      const kp = spawnKeepalive(P, U, {
        MAX_ATTEMPTS: '1', HOLD_MS: '30000', EMPTY_STREAM_MS: '4000',
        PRE_COMMIT_MS: '1500', IDLE_MS: '700',
      });
      open.push(gw.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 8000, 'старт keepalive (сцена 10)');

      const r = await ask(P);
      assert.ok(/пре-коммит SSE/.test(kp.log), 'клиент был взят на пинги');
      assert.ok(/пустой поток #1: 4000мс без единого байта содержимого/.test(kp.log),
        'страж сработал ДО прихода заголовков — это и был пропущенный случай');
      assert.strictEqual(r.status, 200, `клиент получил ответ со второй попытки (было ${r.status})`);
      assert.ok(r.body.includes('ХОЛД-ОК'), 'содержимое доехало');
      assert.ok(!/event: error/.test(r.body), 'ошибки клиент не увидел');
      assert.strictEqual(hits, 2, `шлюз спрошен дважды (было ${hits})`);
      checks += 6;
    }

    // ── Сцена 9: НЕ-стримовый запрос (`/compact`) держится пробелами ─────────────
    // Пинг — событие SSE, в JSON его не вставить, поэтому такой запрос не получал ни
    // байта, пока шлюз не досчитает, и Claude Code сдавался на ~20 с:
    // `Stream idle timeout - no chunks received`. Ведущие пробелы в JSON легальны —
    // на этом и стоит приём.
    {
      const [P, U] = [28359, 28360];
      const gw = stubJsonGateway(U, 6500);
      await gw.listen();
      const kp = spawnKeepalive(P, U, { MAX_ATTEMPTS: '1', JSON_HOLD_MS: '3000', IDLE_MS: '800' });
      open.push(gw.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 8000, 'старт keepalive (сцена 9)');

      const r = await askJson(P);
      assert.strictEqual(r.status, 200, `не-стримовый запрос дошёл (было ${r.status})`);
      assert.ok(/пре-коммит JSON/.test(kp.log), 'JSON-удержание сработало');
      assert.strictEqual(r.headers['content-length'], undefined,
        'content-length не выставлен — тело дописывалось по частям');
      assert.ok(r.raw.startsWith(' '), 'тело начинается с капель-пробелов');
      assert.ok(r.raw.length - r.raw.trimStart().length >= 3,
        `капель было несколько (${r.raw.length - r.raw.trimStart().length})`);
      const parsed = JSON.parse(r.raw);   // главное: клиент разберёт это как обычный JSON
      assert.strictEqual(parsed.content[0].text, 'JSON-ОК', 'настоящее тело дописано и читается');
      assert.ok(/дописываю тело в открытый JSON/.test(kp.log), 'дозапись тела записана в лог');
      checks += 7;
    }

    console.log(`check-hold-window OK (${checks} проверок): обрыв посреди ожидания переигран незаметно, `
      + 'промах маршрута отдан без ретраев, мёртвый путь удержан и сдан повторяемой формой, '
      + 'мёртвая модель тира подменена живой, пустой поток переигран — и по обрыву, и по времени, '
      + 'не-стримовый запрос удержан пробелами и разобран клиентом как обычный JSON, '
      + 'молчание шлюза ДО заголовков тоже ограничено — страж тикает с пре-коммита');
    process.exitCode = 0;
  } catch (e) {
    console.error('ПРОВАЛ: ' + e.message);
    process.exitCode = 1;
  } finally {
    for (const x of open) {
      try { x.kill ? x.kill() : x.close(); } catch { /* уже мёртв */ }
    }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* не критично */ }
  }
})();
