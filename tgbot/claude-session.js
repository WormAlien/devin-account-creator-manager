// tgbot/claude-session.js
//
// Обёртка над headless Claude Code: каждое сообщение = `claude -p <текст>
// --output-format json` в выбранной папке. Контекст между сообщениями держит
// сам claude через `--continue` (продолжает последний разговор в этом cwd).
//
// Почему не node-pty/TUI: интерактивный claude рисует полноэкранный ANSI-TUI,
// стрип которого даёт мусор. Headless-режим отдаёт чистый JSON {result,...} —
// проще и надёжнее. «Живость» = непрерывный контекст через --continue.
//
// apiKeyHelper не трогаем: `claude` сам читает активный ключ из settings.json
// на каждый запрос (TTL=0). Меняешь бэкенд в ТГ → следующий вызов едет на новом.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Путь к claude. ВАЖНО: зовём нативный claude.exe напрямую, БЕЗ shell:true.
// Иначе (shell:true + массив args) Windows склеивает аргументы в одну строку и
// переразбирает шеллом → промпт с `--flag`/кавычками/`|&>` ломает запуск
// (claude видит чужой флаг: «unknown option '--short'»). exe запускается через
// spawn напрямую, и Node сам экранирует каждый аргумент.
function resolveClaude() {
  const cands = [
    process.env.CLAUDE_BIN, // явный оверрайд из .env
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return { bin: c, shell: false }; } catch {} }
  // фолбэк: PATH-шим через shell (теряем безопасное экранирование, но хоть запустится)
  return { bin: 'claude', shell: true };
}
const CLAUDE = resolveClaude();

// Разрешённые корни для cwd — бот не должен лазить куда попало.
const ALLOWED_ROOTS = [
  path.resolve('C:/Users/WormAlien/Desktop/Autoreger_Clean'),
  path.resolve('D:/WORMALIENAIGIGANT'),
];

function isAllowedCwd(dir) {
  const r = path.resolve(dir);
  return ALLOWED_ROOTS.some(root => r === root || r.startsWith(root + path.sep));
}

// chatId → { cwd, busy, started }  (один контекст-«разговор» на чат)
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { cwd: process.env.DEFAULT_CWD || ALLOWED_ROOTS[0], busy: false, fresh: true });
  }
  return sessions.get(chatId);
}

function setCwd(chatId, dir) {
  if (!isAllowedCwd(dir)) {
    throw new Error(`папка вне разрешённых корней:\n${ALLOWED_ROOTS.join('\n')}`);
  }
  const s = getSession(chatId);
  s.cwd = path.resolve(dir);
  s.fresh = true; // новая папка → новый разговор (не --continue чужой контекст)
}

// Сбросить разговор: следующий ask стартует без --continue.
function reset(chatId) {
  const s = getSession(chatId);
  s.fresh = true;
}

const ALLOWED_ROOTS_EXPORT = ALLOWED_ROOTS;

// Короткое описание использования инструмента для прогресс-ленты.
function toolLine(name, input) {
  const i = input || {};
  switch (name) {
    case 'Bash': return '⚙️ bash: `' + String(i.command || '').slice(0, 60) + '`';
    case 'Read': return '📖 читаю ' + (i.file_path || '');
    case 'Edit': case 'Write': return '✏️ правлю ' + (i.file_path || '');
    case 'Glob': return '🔍 ищу ' + (i.pattern || '');
    case 'Grep': return '🔍 grep ' + (i.pattern || '');
    case 'TodoWrite': return '📝 план';
    default: return '🔧 ' + name;
  }
}

/**
 * Отправить запрос в claude (stream-json — живой прогресс).
 * onEvent(state) вызывается по мере поступления событий; state = {steps:[...], text}.
 * Возвращает { ok, text, cost, error }.
 */
function ask(chatId, prompt, onEvent) {
  const s = getSession(chatId);
  if (s.busy) return Promise.resolve({ ok: false, error: 'занят предыдущим запросом — подожди или /stop' });
  s.busy = true;

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
  ];
  if (!s.fresh) args.push('--continue');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CLAUDE.bin, args, { cwd: s.cwd, env: process.env, shell: CLAUDE.shell, windowsHide: true });
    } catch (e) {
      s.busy = false;
      return resolve({ ok: false, error: `не удалось запустить claude: ${e.message}` });
    }
    s.child = child;

    // Богатое состояние для терминал-рендера:
    //   steps: [{id, label, status:'run'|'ok'|'err'}]  — лента инструментов
    //   text: текущий текст ассистента
    //   model: имя модели (из init)
    const steps = [];           // {id, label, status}
    const stepById = new Map();  // tool_use_id → step (для проставления ✓/✗)
    let lastText = '';
    let model = '';
    let finalResult = null;
    let errBuf = '', tail = '';

    const emit = () => { if (onEvent) onEvent({ steps: steps.map(x => ({ ...x })), text: lastText, model }); };

    function handleEvent(ev) {
      if (!ev || !ev.type) return;

      if (ev.type === 'system' && ev.subtype === 'init') {
        if (ev.model) model = ev.model;
        emit();
        return;
      }

      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        if (ev.message.model) model = ev.message.model;
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text && block.text.trim()) {
            lastText = block.text;
          } else if (block.type === 'tool_use') {
            const step = { id: block.id, label: toolLine(block.name, block.input), status: 'run' };
            steps.push(step);
            if (block.id) stepById.set(block.id, step);
          }
        }
        emit();
        return;
      }

      // Результаты инструментов прилетают как type:user с tool_result.
      if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const step = stepById.get(block.tool_use_id);
            if (step) step.status = block.is_error ? 'err' : 'ok';
          }
        }
        emit();
        return;
      }

      if (ev.type === 'result') finalResult = ev;
    }

    child.stdout.on('data', chunk => {
      tail += chunk;
      const lines = tail.split('\n');
      tail = lines.pop(); // незавершённый хвост
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try { handleEvent(JSON.parse(t)); } catch {}
      }
    });
    child.stderr.on('data', d => { errBuf += d; });

    const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 600000);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      s.busy = false;
      s.child = null;
      if (tail.trim().startsWith('{')) { try { handleEvent(JSON.parse(tail.trim())); } catch {} }

      if (finalResult && typeof finalResult.result === 'string') {
        s.fresh = false;
        return resolve({
          ok: !finalResult.is_error,
          text: finalResult.result || lastText,
          cost: finalResult.total_cost_usd,
          model,
          error: finalResult.is_error ? (finalResult.result || 'claude error') : null,
        });
      }
      if (lastText) { s.fresh = false; return resolve({ ok: true, text: lastText, model }); }
      if (code !== 0) return resolve({ ok: false, error: `claude вышел с кодом ${code}:\n${errBuf.slice(-1500)}` });
      return resolve({ ok: false, error: 'не разобрал ответ claude (stream-json)' });
    });
  });
}

function stop(chatId) {
  const s = sessions.get(chatId);
  if (s && s.child) { try { s.child.kill(); } catch {} s.busy = false; s.child = null; return true; }
  return false;
}

module.exports = { getSession, setCwd, reset, ask, stop, isAllowedCwd, ALLOWED_ROOTS: ALLOWED_ROOTS_EXPORT };
