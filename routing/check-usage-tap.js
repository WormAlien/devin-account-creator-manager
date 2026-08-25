#!/usr/bin/env node
// check-usage-tap.js — тесты счётчика токенов front-door. Порт не занимают,
// прокси не трогают, в token-usage.jsonl не пишут (запись подменена).
//
//   node routing/check-usage-tap.js
'use strict';

const assert = require('assert');
const { createTap, harnessOf, pickUsage } = require('./usage-tap.js');

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); process.exitCode = 1; }
};

// Ответ из живого замера 25.08 через :20100 (JustWoker). Важное: usage приходит
// ДВАЖДЫ и первый — заниженный.
const SSE = [
  'event: message_start',
  'data: {"message":{"id":"msg_1","model":"claude-opus-5","type":"message","usage":{"input_tokens":374,"output_tokens":1}},"type":"message_start"}',
  '',
  'event: content_block_delta',
  'data: {"delta":{"text":"Hi","type":"text_delta"},"index":0,"type":"content_block_delta"}',
  '',
  'event: message_delta',
  'data: {"delta":{"stop_reason":"end_turn"},"type":"message_delta","usage":{"cost":0.0013162506673300167,"input_tokens":7304,"kiro_credits":0.0658,"output_tokens":40}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '', '',
].join('\n');

const META = {
  method: 'POST', url: '/v1/messages?beta=true', backend: 'justwoker',
  ua: 'claude-cli/2.1.220 (external, cli)', status: 200,
  headers: { 'content-type': 'text/event-stream' },
};

function run(meta, body, chunkSize = 4096) {
  const written = [];
  const tap = createTap(meta, r => written.push(r));
  if (!tap) return { tap: null, written };
  for (let i = 0; i < body.length; i += chunkSize) {
    tap.chunk(Buffer.from(body.slice(i, i + chunkSize), 'utf8'));
  }
  tap.end();
  return { tap, written };
}

console.log('разбор SSE');
ok('берётся ПОСЛЕДНИЙ usage, а не первый и не сумма', () => {
  const { written } = run(META, SSE);
  assert.strictEqual(written.length, 1, 'одна запись на ответ');
  assert.strictEqual(written[0].in, 7304, 'вход из message_delta');
  assert.strictEqual(written[0].out, 40, 'выход из message_delta');
});
ok('модель, бэкенд и харнесс попадают в запись', () => {
  const { written } = run(META, SSE);
  assert.strictEqual(written[0].m, 'claude-opus-5');
  assert.strictEqual(written[0].bk, 'justwoker');
  assert.strictEqual(written[0].h, 'claude-code');
  assert.strictEqual(written[0].st, 1);
});
ok('цена запроса от шлюза сохраняется — по ней считается настоящая ставка', () => {
  const { written } = run(META, SSE);
  assert.ok(Math.abs(written[0].cost - 0.0013162506673300167) < 1e-12);
});
ok('разрыв чанков посреди JSON-строки ничего не теряет', () => {
  for (const size of [1, 7, 13, 64, 200, 999]) {
    const { written } = run(META, SSE, size);
    assert.strictEqual(written.length, 1, 'чанк ' + size + ': запись есть');
    assert.strictEqual(written[0].in, 7304, 'чанк ' + size + ': вход целый');
  }
});
ok('кеш-поля забираются, когда шлюз их отдаёт', () => {
  const body = 'data: {"type":"message_delta","usage":{"input_tokens":10,"output_tokens":2,'
    + '"cache_read_input_tokens":900,"cache_creation_input_tokens":100}}\n\n';
  const { written } = run(META, body);
  assert.strictEqual(written[0].cr, 900);
  assert.strictEqual(written[0].cw, 100);
});
ok('обрыв соединения пишет то, что успело прийти', () => {
  const written = [];
  const tap = createTap(META, r => written.push(r));
  tap.chunk(Buffer.from(SSE.slice(0, SSE.indexOf('message_stop')), 'utf8'));
  tap.end();                                   // как on('aborted')
  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0].in, 7304);
});

console.log('не-SSE и отказы');
ok('обычный JSON-ответ разбирается целиком', () => {
  const meta = Object.assign({}, META, { headers: { 'content-type': 'application/json' } });
  const body = JSON.stringify({ model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 3 } });
  const { written } = run(meta, body);
  assert.strictEqual(written[0].in, 5);
  assert.strictEqual(written[0].st, 0);
});
ok('сжатый ответ не считается вовсе', () => {
  const meta = Object.assign({}, META, {
    headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
  });
  assert.strictEqual(createTap(meta, () => {}), null);
});
ok('не-POST, чужие пути и ошибки мимо', () => {
  assert.strictEqual(createTap(Object.assign({}, META, { method: 'GET' }), () => {}), null);
  assert.strictEqual(createTap(Object.assign({}, META, { url: '/v1/models' }), () => {}), null);
  assert.strictEqual(createTap(Object.assign({}, META, { url: '/v1/messages/count_tokens' }), () => {}), null);
  assert.strictEqual(createTap(Object.assign({}, META, { status: 429 }), () => {}), null);
});
ok('ответ без usage записи не создаёт', () => {
  const { written } = run(META, 'data: {"type":"ping"}\n\n');
  assert.strictEqual(written.length, 0);
});
ok('битый JSON в SSE не ломает разбор соседних строк', () => {
  const body = 'data: {ломаный\n\ndata: {"type":"message_delta","usage":{"input_tokens":11,"output_tokens":1}}\n\n';
  const { written } = run(META, body);
  assert.strictEqual(written[0].in, 11);
});
ok('огромный не-SSE ответ не буферизуется целиком', () => {
  const meta = Object.assign({}, META, { headers: { 'content-type': 'application/json' } });
  const { written } = run(meta, 'x'.repeat(2 * 1024 * 1024));
  assert.strictEqual(written.length, 0, 'мусор на 2 МБ просто не считается');
});

console.log('харнессы');
ok('user-agent → имя харнесса', () => {
  assert.strictEqual(harnessOf('claude-cli/2.1.220 (external, cli)'), 'claude-code');
  assert.strictEqual(harnessOf('opencode/0.4.1'), 'opencode');
  assert.strictEqual(harnessOf('curl/8.5.0'), 'curl');
  assert.strictEqual(harnessOf(''), 'unknown');
  assert.strictEqual(harnessOf('MyBot/1.0'), 'mybot');
});
ok('usage без токенов не считается за usage', () => {
  assert.strictEqual(pickUsage({ cost: 0.1 }), null);
  assert.strictEqual(pickUsage(null), null);
});

console.log(`\n${pass} проверок зелёные`);
