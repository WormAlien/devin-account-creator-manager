// tgbot/stt.js
//
// Node-клиент к Python STT-демону (stt_server.py, faster-whisper). Демон держит
// модель в RAM; мы шлём путь к аудиофайлу строкой в stdin и читаем JSON из stdout.
// Whisper однопоточный → запросы сериализуем в очередь (один в полёте).
//
// Ленивый старт: демон поднимается при первом голосовом, не на старте бота
// (чтобы бот без голосовых не тратил RAM на модель). Падение демона —
// автоперезапуск на следующем запросе.

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const PY = process.env.STT_PYTHON ||
  path.resolve(__dirname, '..', 'tools', 'tg-venv', 'Scripts', 'python.exe');
const SCRIPT = path.join(__dirname, 'stt_server.py');

let proc = null;       // дочерний python
let rl = null;         // построчное чтение stdout
let ready = false;     // демон догрузил модель
let starting = null;   // Promise старта (чтобы параллельные первые запросы не плодили процессы)
const queue = [];      // [{ resolve, reject }] — ожидающие ответа, FIFO

function start() {
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    proc = spawn(PY, [SCRIPT], { env: process.env, windowsHide: true });
    rl = readline.createInterface({ input: proc.stdout });

    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; } // не-JSON → игнор (диагностика идёт в stderr)
      if (msg.ready) { ready = true; resolve(); return; }
      // обычный ответ транскрипции → отдать первому в очереди
      const job = queue.shift();
      if (job) job.resolve(msg);
    });

    proc.stderr.on('data', d => { if (process.env.STT_DEBUG) process.stderr.write('[stt] ' + d); });

    proc.on('exit', (code) => {
      // демон умер: сбрасываем состояние, отклоняем висящие запросы
      ready = false; proc = null; rl = null; starting = null;
      const err = new Error(`STT-демон завершился (код ${code})`);
      while (queue.length) queue.shift().reject(err);
    });

    proc.on('error', (e) => { starting = null; reject(new Error('не удалось запустить STT: ' + e.message)); });

    // страховка: модель не загрузилась за 120с
    setTimeout(() => { if (!ready) reject(new Error('STT-демон не готов за 120с')); }, 120000);
  });
  return starting;
}

/**
 * Распознать аудиофайл (любой формат, что понимает ffmpeg: .oga/.opus/.mp3/.wav).
 * Возвращает { ok, text, lang, dur } или { ok:false, error }.
 */
async function transcribe(filePath) {
  try { await start(); }
  catch (e) { return { ok: false, error: e.message }; }
  return new Promise((resolve) => {
    queue.push({ resolve, reject: (e) => resolve({ ok: false, error: e.message }) });
    proc.stdin.write(filePath + '\n');
  });
}

function shutdown() {
  if (proc) { try { proc.stdin.write('__quit__\n'); } catch {} }
}

module.exports = { transcribe, shutdown, isReady: () => ready };
