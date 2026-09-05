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
const os = require('os');
const path = require('path');

const LOG_FILE = process.env.TOKEN_USAGE_FILE || path.join(__dirname, 'token-usage.jsonl');
const JSON_CAP = 512 * 1024;              // не-SSE ответ крупнее этого не разбираем
const SSE_TAIL_CAP = 64 * 1024;           // защита от строки без перевода

// ── Потолок журнала: ротация ЦЕЛЫМИ СУТКАМИ и в архив ────────────────────────
// Было: на 8 МБ выбрасывалась половина строк ПО СЧЁТУ и стиралась навсегда
// (`writeFileSync` хвостом, без копии). Два дефекта, оба измеримы:
//   1. Резалось по номеру строки, то есть посреди суток. Сутки на границе теряли
//      случайную часть записей, и цифра за них врала, оставаясь правдоподобной.
//   2. Потребитель (`leagueSelf` в transparent-proxy.js) сшивает журнал со
//      `~/.claude/stats-cache.json` по границе `cut = первый_день_журнала + 1`:
//      дни ДО границы берутся из stats-cache, от границы — из журнала. Обрезка
//      двигает первый день журнала вперёд, а stats-cache отстаёт (замер 05.09:
//      журнал 25.08…05.09, stats-cache посчитан до 01.09) — и сутки, попавшие
//      между концом stats-cache и новой границей, обнуляются молча. Замер 05.09
//      на живом файле (6 132 820 Б / 36 374 строки): обрезка оставила бы хвост с
//      03.09, граница уехала бы на 04.09, а 02.09 и 03.09 — 1 826 345 223 токена,
//      3.1% метрики «всё время» — стали бы нулями без единого запроса.
// Стало: выбрасываются только ЦЕЛЫЕ прошедшие сутки, и не удаляются, а уезжают в
// `archive/token-usage-<ГГГГ-ММ-ДД>.jsonl` рядом с журналом.
//
// Числа, все с замеров на этой машине 05.09:
//   • KEEP_DAYS = 30 — сколько суток держим живыми. 30, потому что это самое
//     широкое окно, которое витрина рисует по суткам (`timeKeys(30)`), и потому
//     что в stats-cache уже была дыра в 27 суток подряд (02.07–28.07): за такие
//     дни журнал остаётся единственным источником. Цена — измеренные 0.37 МБ в
//     сутки (4 110 388 Б за 11 полных суток 25.08…04.09), то есть ≈ 11 МБ.
//   • MIN_KEEP_DAYS = 7 — пол, ниже которого не режем НИКОГДА, даже ради потолка.
//     Это отставание stats-cache (4 суток на 05.09) с запасом почти вдвое.
//   • Пол сам растягивается до конца stats-cache, если тот отстал сильнее (см.
//     `statsCacheLastDay`): журнал видит все харнессы, а stats-cache пишет только
//     Claude Code, и месяц без Claude Code сделал бы константу 30 недостаточной.
//   • MAX_BYTES = 32 МБ — потолок диска, вчетверо больше прежнего. 30 суток по
//     измеренным 0.37 МБ = 11 МБ, то есть запас ×3 к темпу; при этом холодное
//     чтение 32 МБ ≈ 300 мс (замер: 9 мс/МБ на JSON.parse + Date), а разобранный
//     список у потребителя ≈ 23 МБ heap (его замер: 123 Б на запись). Потолок
//     тоже режет целыми сутками и тоже в архив.
// Приоритет задан осознанно: ПОЛ ВЫШЕ ПОТОЛКА. Если минимум суток не влезает в
// 32 МБ, файл перерастёт потолок и останется целым — потерянные сутки стоят
// дороже места на диске.
const MAX_BYTES = 32 * 1024 * 1024;
const KEEP_DAYS = 30;
const MIN_KEEP_DAYS = 7;
const ROTATE_COOLDOWN_MS = 60 * 1000;     // пол не даёт резать — не проверять чаще
const CC_STATS_CACHE_FILE = path.join(os.homedir(), '.claude', 'stats-cache.json');

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

const pad2 = n => String(n).padStart(2, '0');
// День — ЛОКАЛЬНЫЙ, ровно как `dayKey` у потребителя (transparent-proxy.js). По UTC
// граница суток сдвинута на три часа, и «целые сутки» разъехались бы с теми, что
// считает витрина: в архив уезжал бы кусок дня, который витрина считает текущим.
const dayKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
// Полдень, а не полночь: сдвиг через полночь спотыкается о переход времени.
const dayShift = (key, n) => {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() + n);
  return dayKey(d);
};
const daysApart = (a, b) => Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 864e5);
const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function archiveDirFor(file) { return path.join(path.dirname(file), 'archive'); }

// Последние сутки, которые умеет закрыть ВТОРОЙ источник токенов. Журнал обязан
// дотягиваться до них, иначе на стыке появится дыра. Файл маленький (23.9 КБ на
// 05.09) и читается только в момент ротации; нет файла или битый — вернём null, и
// пол останется на константе.
function statsCacheLastDay(file = CC_STATS_CACHE_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    let last = isDay(doc.lastComputedDate) ? doc.lastComputedDate : null;
    for (const rec of (doc.dailyModelTokens || [])) {
      if (rec && isDay(rec.date) && (!last || rec.date > last)) last = rec.date;
    }
    return last;
  } catch (e) { return null; }
}

// Первые сутки файла — по первой строке, без чтения целиком: 512 Б с запасом
// накрывают строку журнала (измеренное среднее — 169 Б). Это делает ежедневную
// проверку почти бесплатной, а не «прочитать 6 МБ на каждую запись».
function firstDayOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.allocUnsafe(512);
    const n = fs.readSync(fd, b, 0, 512, 0);
    const s = b.subarray(0, n).toString('utf8');
    const nl = s.indexOf('\n');
    const d = new Date(JSON.parse((nl >= 0 ? s.slice(0, nl) : s).trim()).t);
    return isNaN(d.getTime()) ? null : dayKey(d);
  } catch (e) { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } } }
}
// Архив ДОПИСЫВАЕТСЯ, а не перезаписывается: перезапись архива — то же удаление
// истории, из-за которого всё и переделано. Дубль на случай падения между записью
// архива и перезаписью журнала отсекается сверкой последней строки.
function tailIs(file, want) {
  try {
    const need = Buffer.byteLength(want, 'utf8');
    const st = fs.statSync(file);
    if (st.size < need) return false;
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.allocUnsafe(need);
      fs.readSync(fd, b, 0, need, st.size - need);
      return b.toString('utf8') === want;
    } finally { fs.closeSync(fd); }
  } catch (e) { return false; }
}
function archiveAppend(dir, day, lines) {
  fs.mkdirSync(dir, { recursive: true });
  // Расход — локальные данные, в публичный репозиторий им нельзя (для живого
  // журнала это `.gitignore:149`). Маркер ставим сами: иначе архив первым же
  // `git add -A` уедет в историю.
  const ignore = path.join(dir, '.gitignore');
  try { if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n'); } catch (e) { /* не смертельно */ }
  const file = path.join(dir, `token-usage-${day}.jsonl`);
  if (tailIs(file, lines[lines.length - 1] + '\n')) return file;
  const fd = fs.openSync(file, 'a');
  try { fs.writeFileSync(fd, lines.join('\n') + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return file;
}

// Ротация. Ничего не бросает, возвращает отчёт — по нему же проверяют тесты.
// opts: { now, statsLast, maxBytes, keepDays, minKeepDays, archiveDir }.
function rotateJournal(file = LOG_FILE, opts = {}) {
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const keepDays = opts.keepDays || KEEP_DAYS;
  const minDays = opts.minKeepDays || MIN_KEEP_DAYS;
  const today = dayKey(opts.now ? new Date(opts.now) : new Date());
  const scLast = opts.statsLast !== undefined ? opts.statsLast : statsCacheLastDay();
  // Жёсткий минимум суток: константа ИЛИ «дотянуться до последнего дня
  // stats-cache» — что больше. Ровно этот запас и обязан быть в журнале.
  let need = minDays;
  if (isDay(scLast)) need = Math.max(need, daysApart(scLast, today) + 1);
  const target = Math.max(keepDays, need);
  const windowCut = dayShift(today, -(target - 1));   // норма: держим target суток
  const floorCut = dayShift(today, -(need - 1));      // глубже не режем никогда

  let st;
  try { st = fs.statSync(file); } catch (e) { return { rotated: false, reason: 'no-file' }; }
  const first = firstDayOf(file);
  // Дешёвые отказы: ничего выбросить нельзя (всё внутри пола) или нечего и незачем.
  if (first && first >= floorCut) return { rotated: false, reason: 'floor', size: st.size, first, floorCut };
  if (first && first >= windowCut && st.size <= maxBytes)
    return { rotated: false, reason: 'in-window', size: st.size, first, windowCut };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { rotated: false, reason: 'read-failed' }; }
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length < 2) return { rotated: false, reason: 'too-short', size: st.size };

  // Сутки каждой строки. Нераспознанную строку приписываем к суткам предыдущей —
  // по времени она стоит там же, и так она не теряется и не уезжает в чужой архив.
  // Строки до первой распознанной получают первые известные сутки файла.
  const dayOf = new Array(lines.length).fill(null);
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    try {
      const t = new Date(JSON.parse(lines[i]).t);
      if (!isNaN(t.getTime())) cur = dayKey(t);
    } catch (e) { /* мусорная строка — остаётся с предыдущими сутками */ }
    dayOf[i] = cur;
  }
  const firstKnown = dayOf.find(Boolean) || today;
  const bytes = new Map();
  const order = [];
  for (let i = 0; i < lines.length; i++) {
    const d = dayOf[i] || firstKnown;
    dayOf[i] = d;
    if (!bytes.has(d)) { bytes.set(d, 0); order.push(d); }
    bytes.set(d, bytes.get(d) + Buffer.byteLength(lines[i], 'utf8') + 1);
  }
  order.sort();                                  // ключ ISO-подобный: строка = хронология

  const drop = new Set();
  let kept = 0;
  for (const d of order) { if (d < windowCut) drop.add(d); else kept += bytes.get(d); }
  // Потолок добирает ЦЕЛЫЕ сутки, пока не влезем: но не глубже пола и никогда до
  // пустого файла. `order` отсортирован, поэтому первый же день от пола — стоп.
  for (const d of order) {
    if (drop.has(d)) continue;
    if (kept <= maxBytes) break;
    if (d >= floorCut) break;
    if (order.length - drop.size <= 1) break;
    drop.add(d); kept -= bytes.get(d);
  }
  if (!drop.size)
    return { rotated: false, reason: st.size > maxBytes ? 'over-cap-but-floor' : 'nothing-to-drop',
      size: st.size, first, floorCut, windowCut };

  const keepLines = [];
  const perDay = new Map();
  for (let i = 0; i < lines.length; i++) {
    const d = dayOf[i];
    if (!drop.has(d)) { keepLines.push(lines[i]); continue; }
    if (!perDay.has(d)) perDay.set(d, []);
    perDay.get(d).push(lines[i]);
  }
  if (!keepLines.length) return { rotated: false, reason: 'would-empty', size: st.size };
  const dir = opts.archiveDir || archiveDirFor(file);
  const droppedDays = [...perDay.keys()].sort();
  const archives = [];
  // Архив ПЕРВЫМ, живой файл вторым. Падение между шагами оставляет журнал целым:
  // лишний архив безвреден, потерянные сутки — нет.
  for (const d of droppedDays) archives.push(archiveAppend(dir, d, perDay.get(d)));
  // Перезапись НА МЕСТЕ, а не tmp+rename. Файл становится КОРОЧЕ, и потребитель
  // ловит это штатно: `tailRead` требует строго растущий размер, иначе читает
  // файл целиком и сбрасывает накопленное (transparent-proxy.js). А `rename` на
  // Windows умеет упасть, если файл в этот момент открыт читателем.
  fs.writeFileSync(file, keepLines.join('\n') + '\n');
  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) { /* отчёт не критичен */ }
  return { rotated: true, reason: 'ok', size, archives, droppedDays,
    droppedLines: lines.length - keepLines.length, keptLines: keepLines.length,
    keptDays: order.filter(d => !drop.has(d)), windowCut, floorCut, need, target };
}

// Состояние ротации на процесс: путь → { day, size, next }. Размер держим в памяти,
// чтобы не звать statSync на КАЖДУЮ запись, как звал прежний код; решение всё равно
// принимается по свежему statSync внутри rotateJournal, в памяти только подсказка
// «пора проверить». Единственный писатель — front-door (порт один), поэтому расхождение
// подсказки с диском может только отложить проверку, но не подменить решение.
const ROT = new Map();
function maybeRotate(file, added) {
  const key = path.resolve(file);
  let s = ROT.get(key);
  if (!s) { s = { day: '', size: -1, next: 0 }; ROT.set(key, s); }
  if (s.size < 0) { try { s.size = fs.statSync(file).size; } catch (e) { s.size = added; } }
  else s.size += added;
  const today = dayKey(new Date());
  // Проверяем на смене суток — в том числе на ПЕРВОЙ записи процесса, поэтому правка
  // вступает в силу с перезапуском хаба, — и когда перевалили потолок.
  if (s.day === today && s.size <= MAX_BYTES) return null;
  if (Date.now() < s.next) return null;
  s.day = today;
  const r = rotateJournal(file);
  s.size = r && typeof r.size === 'number' ? r.size : -1;
  if (!r || !r.rotated) s.next = Date.now() + ROTATE_COOLDOWN_MS;
  return r;
}
function appendRecord(rec, file = LOG_FILE) {
  try {
    const line = JSON.stringify(rec) + '\n';
    fs.appendFileSync(file, line);
    maybeRotate(file, Buffer.byteLength(line, 'utf8'));
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

module.exports = { createTap, harnessOf, pickUsage, scanSse, appendRecord, rotateJournal,
  statsCacheLastDay, archiveDirFor, dayKey, LOG_FILE, MAX_BYTES, KEEP_DAYS, MIN_KEEP_DAYS };
