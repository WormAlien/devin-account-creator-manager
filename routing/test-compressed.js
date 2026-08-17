/*
 * test-compressed.js — сжатые ответы шлюза не должны биться о MODEL_ECHO.
 *
 * Баг (2026-08-17): свежий Claude Code/happy шлёт `accept-encoding: zstd`; шлюз
 * (tabi) отвечал zstd, а keepalive для эха имени модели гонял тело через
 * toString('utf8') → невалидные байты становились U+FFFD → клиент падал с
 * `ZstdDecompressionError fetching http://localhost:20155/v1/messages?beta=true`
 * и /model не переключался. Плюс hasEnc-проверка не знала слова zstd.
 *
 * Запуск: node test-compressed.js [имя-скрипта-прокси]
 */
'use strict';

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const PROXY_SCRIPT = process.argv[2] || 'keepalive-proxy.js';
const UP_PORT = 20971;
const PX_PORT = 20972;
const CLIENT_MODEL = 'claude-opus-5[1m]';
const UPSTREAM_MODEL = 'tabi/claude-opus-5-real';
const PAYLOAD = Buffer.from(JSON.stringify({
  id: 'msg_1', type: 'message', role: 'assistant', model: UPSTREAM_MODEL,
  content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 },
}), 'utf8');

let mode = 'identity';          // identity | zstd | gzip
let sawAcceptEncoding = null;   // что шлюз увидел в запросе от прокси

// Шлюз: в режимах zstd/gzip игнорирует accept-encoding: identity (так делают
// реальные шлюзы — под это и написан guard в прокси).
const upstream = http.createServer((req, res) => {
  sawAcceptEncoding = req.headers['accept-encoding'] || '';
  req.resume();
  req.on('end', () => {
    if (mode === 'identity') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': PAYLOAD.length });
      return res.end(PAYLOAD);
    }
    const enc = mode === 'zstd' ? 'zstd' : 'gzip';
    const body = mode === 'zstd' ? zlib.zstdCompressSync(PAYLOAD) : zlib.gzipSync(PAYLOAD);
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': enc,
      'content-length': body.length,
    });
    res.end(body);
  });
});

// Клиент как happy: не-stream /v1/messages?beta=true, accept-encoding с zstd.
function ask() {
  const body = JSON.stringify({ model: CLIENT_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  return new Promise((resolve, reject) => {
    const r = http.request({
      port: PX_PORT, method: 'POST', path: '/v1/messages?beta=true',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'accept-encoding': 'zstd, gzip, deflate',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitProxy() {
  for (let i = 0; i < 60; i += 1) {
    try {
      await new Promise((resolve, reject) => {
        const r = http.get({ port: PX_PORT, path: '/__keepalive/api/status' }, (res) => { res.resume(); res.on('end', resolve); });
        r.on('error', reject);
      });
      return;
    } catch { await wait(200); }
  }
  throw new Error('прокси не поднялся');
}

(async () => {
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));
  const nope = (n) => path.join(os.tmpdir(), `warp-keepalive-nonexistent-${n}`);
  const proxy = spawn(process.execPath, [PROXY_SCRIPT], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PX_PORT),
      UPSTREAM: `http://127.0.0.1:${UP_PORT}`,
      HAIKU_REMAP: '0',
      MODELMAP_FILE: nope('modelmap.json'),
      KEY_FILE: nope('key.txt'),          // не подмешивать реальный ключ
      CONFIG_FILE: path.join(os.tmpdir(), `warp-keepalive-test-cfg-${PX_PORT}.json`),
      LOG_FILE: '',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let plog = '';
  proxy.stderr.on('data', (c) => { plog += c; });

  try {
    await waitProxy();

    // --- A: шлюз уважает identity → эхо модели работает, тело читаемое ---
    mode = 'identity';
    const a = await ask();
    assert.strictEqual(a.status, 200, 'A: должен быть 200');
    assert.ok(/identity/.test(sawAcceptEncoding), `A: прокси должен просить identity, шлюз увидел "${sawAcceptEncoding}"`);
    assert.ok(!a.headers['content-encoding'], 'A: несжатый ответ клиенту');
    assert.strictEqual(JSON.parse(a.raw.toString('utf8')).model, CLIENT_MODEL, 'A: имя модели должно быть эхом клиентского');
    console.log('A ok: identity → эхо модели на месте');

    // --- B: шлюз всё равно отдал zstd → байт-в-байт, без U+FFFD ---
    mode = 'zstd';
    const b = await ask();
    assert.strictEqual(b.status, 200, 'B: должен быть 200');
    assert.strictEqual(String(b.headers['content-encoding']).toLowerCase(), 'zstd', 'B: заголовок кодировки должен дойти');
    const bPlain = zlib.zstdDecompressSync(b.raw);       // именно здесь падал клиент
    assert.strictEqual(bPlain.toString('utf8'), PAYLOAD.toString('utf8'), 'B: тело должно дойти неповреждённым');
    assert.strictEqual(JSON.parse(bPlain.toString('utf8')).model, UPSTREAM_MODEL, 'B: сжатое тело не переписываем');
    console.log('B ok: zstd → тело распаковалось');

    // --- C: то же для gzip (старый guard знал только его) ---
    mode = 'gzip';
    const c = await ask();
    assert.strictEqual(c.status, 200, 'C: должен быть 200');
    assert.strictEqual(zlib.gunzipSync(c.raw).toString('utf8'), PAYLOAD.toString('utf8'), 'C: gzip-тело неповреждённое');
    console.log('C ok: gzip → тело распаковалось');

    console.log('test-compressed OK');
  } catch (e) {
    console.error(`ПРОВАЛ: ${e.message}`);
    if (plog) console.error(`--- лог прокси ---\n${plog}`);
    process.exitCode = 1;
  } finally {
    proxy.kill();
    upstream.close();
  }
})();
