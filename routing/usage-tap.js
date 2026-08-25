// usage-tap.js — пассивный счётчик токенов на front-door :20100.
//
// Зачем: на вкладке «Финансы» объём работы был ОЦЕНКОЙ — расход шлюза делился на
// зашитые $25 за 1M. Замер 25.08 показал, что ставка шлюзов ≈ $2.05 за 1M, то есть
// оценка занижала работу примерно в 12 раз. Настоящие цифры лежат в ответах моделей
// (`usage`), и через front-door проходят ВСЕ харнессы — Claude Code, opencode и
// прочие, — поэтому считать надо здесь, а не в транскриптах одного клиента.
//
// Принципы:
//   • тело ответа НЕ трогаем и НЕ буферизуем целиком. Для SSE держим только хвост
//     последней строки; для JSON — до JSON_CAP байт, дальше сдаёмся молча;
//   • ответ клиенту не задерживаем: слушатель `data` висит рядом с `pipe`;
//   • сжатый ответ не разбираем (замер 25.08: шлюзы отдают SSE открытым текстом
//     даже на `accept-encoding: gzip, br, zstd`). Признак — заголовок
//     `content-encoding`; такие ответы просто не считаем;
//   • ошибка счётчика не должна ронять запрос — всё под try/catch.
//
// 🪤 Считать usage надо ПОСЛЕДНИЙ, а не суммировать. В SSE он приходит дважды:
// в `message_start` (предварительный, у шлюза это часто заниженный вход) и в
// `message_delta` перед `message_stop` (итоговый). Замер: 374/1 против 7304/40 на
// одном и том же запросе.
'use strict';

const fs = require('fs');
const path = require('path');

const LOG_FILE = process.env.TOKEN_USAGE_FILE || path.join(__dirname, 'token-usage.jsonl');
const MAX_BYTES = 8 * 1024 * 1024;        // как у finance-history: дальше режем половину
const JSON_CAP = 512 * 1024;              // не-SSE ответ крупнее этого не разбираем
const SSE_TAIL_CAP = 64 * 1024;           // защита от строки без перевода

// Харнесс по user-agent. Нужен, чтобы видеть, кто именно жжёт: у владельца
// одновременно Claude Code, opencode и разовые скрипты через тот же front-door.
function harnessOf(ua) {
  const s = String(ua || '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('claude-cli')) return 'claude-code';
  if (s.includes('opencode')) return 'opencode';
  if (s.includes('cline')) return 'cline';
  if (s.includes('roo')) return 'roo';
  if (s.includes('node-fetch') || s.includes('undici') || s.includes('axios')) return 'script';
  if (s.includes('curl')) return 'curl';
  if (s.includes('python') || s.includes('httpx') || s.includes('anthropic')) return 'sdk';
  return s.split(/[\s/]/)[0].slice(0, 24) || 'unknown';
}

// Из объекта usage делаем плоскую запись. Имена полей у шлюзов разъезжаются:
// Anthropic отдаёт cache_read_input_tokens, часть шлюзов — cache_read или ничего.
function pickUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const n = v => (typeof v === 'number' && isFinite(v) ? v : 0);
  const out = {
    in: n(u.input_tokens ?? u.prompt_tokens),
    out: n(u.output_tokens ?? u.completion_tokens),
    cr: n(u.cache_read_input_tokens ?? u.cache_read ?? u.cache_read_tokens),
    cw: n(u.cache_creation_input_tokens ?? u.cache_creation ?? u.cache_write_tokens),
  };
  // `cost` шлюзы отдают в долларах (замер на JustWoker: 0.00131 за запрос). Это
  // единственный источник, по которому видно НАСТОЯЩУЮ ставку за 1M — сохраняем.
  if (typeof u.cost === 'number' && isFinite(u.cost)) out.cost = u.cost;
  if (!out.in && !out.out && !out.cr && !out.cw) return null;
  return out;
}

function appendRecord(rec) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n');
    const st = fs.statSync(LOG_FILE);
    if (st.size > MAX_BYTES) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(LOG_FILE, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
    }
  } catch (e) { /* счётчик не имеет права ронять прокси */ }
}

// Разбор SSE по строкам. Возвращает { model, usage } — последнее, что встретилось.
function scanSse(text, state) {
  state.buf += text;
  if (state.buf.length > SSE_TAIL_CAP) state.buf = state.buf.slice(-SSE_TAIL_CAP);
  let nl;
  while ((nl = state.buf.indexOf('\n')) >= 0) {
    const line = state.buf.slice(0, nl).trim();
    state.buf = state.buf.slice(nl + 1);
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    if (!payload.includes('"usage"') && !payload.includes('"model"')) continue;
    let o; try { o = JSON.parse(payload); } catch (_) { continue; }
    const m = o.model || (o.message && o.message.model);
    if (m) state.model = m;
    const u = pickUsage(o.usage || (o.message && o.message.usage));
    if (u) state.usage = u;                    // последний выигрывает, см. 🪤 в шапке
  }
}

// Фабрика тапа. Возвращает null, если этот ответ считать нельзя или незачем.
// meta: { method, url, backend, ua, status, headers }
function createTap(meta, write = appendRecord) {
  try {
    if (meta.method !== 'POST') return null;
    const p = String(meta.url || '').split('?')[0];
    if (!/\/messages$|\/chat\/completions$/.test(p)) return null;      // токены есть только тут
    if (!meta.status || meta.status >= 300) return null;                // ошибки не считаем
    const h = meta.headers || {};
    if (h['content-encoding']) return null;                            // сжатое не разбираем
    const ct = String(h['content-type'] || '');
    const sse = ct.includes('event-stream');
    const state = { buf: '', model: '', usage: null, bytes: 0, started: Date.now() };

    return {
      chunk(c) {
        try {
          if (sse) return scanSse(c.toString('utf8'), state);
          if (state.bytes > JSON_CAP) return;                          // слишком крупный JSON
          state.bytes += c.length;
          state.buf += c.toString('utf8');
        } catch (e) { /* молча: счётчик */ }
      },
      end() {
        try {
          if (!sse && state.buf) {
            let o; try { o = JSON.parse(state.buf); } catch (_) { o = null; }
            if (o) {
              if (o.model) state.model = o.model;
              const u = pickUsage(o.usage);
              if (u) state.usage = u;
            }
          }
          if (!state.usage) return;                                     // нечего писать
          write({
            t: new Date().toISOString(),
            m: state.model || '',
            bk: meta.backend || '',
            h: harnessOf(meta.ua),
            st: sse ? 1 : 0,
            ms: Date.now() - state.started,
            ...state.usage,
          });
        } catch (e) { /* молча: счётчик */ }
      },
    };
  } catch (e) { return null; }
}

module.exports = { createTap, harnessOf, pickUsage, scanSse, LOG_FILE };
