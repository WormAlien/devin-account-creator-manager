// tgbot/bot.js
//
// ТГ-пульт авторегера: живая claude-сессия (headless --continue) + управление
// бэкендами/ключами как на дашборде :8200. Тонкий слой — вся логика ротации
// живёт в routing/transparent-proxy.js, бот её только дёргает по HTTP.
//
// Запуск:  node tgbot/bot.js   (нужен tgbot/.env с BOT_TOKEN + ALLOWED_USERS)

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Telegraf, Markup } = require('telegraf');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const cc = require('./claude-session');
const dash = require('./dashboard-api');
const stt = require('./stt');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('BOT_TOKEN не задан в tgbot/.env'); process.exit(1); }

const ALLOWED = String(process.env.ALLOWED_USERS || '')
  .split(',').map(s => s.trim()).filter(Boolean).map(Number);
if (!ALLOWED.length) { console.error('ALLOWED_USERS пуст — бот выполняет произвольный код, whitelist обязателен'); process.exit(1); }

const bot = new Telegraf(TOKEN);

// --- Whitelist (жёсткий: бот = удалённый терминал) -----------------------
bot.use(async (ctx, next) => {
  const uid = ctx.from && ctx.from.id;
  if (!ALLOWED.includes(uid)) {
    if (ctx.chat) await ctx.reply(`⛔ Доступ запрещён. Твой ID: ${uid}`).catch(() => {});
    return;
  }
  return next();
});

// --- Утилиты -------------------------------------------------------------
const MAXLEN = 4000; // запас под Telegram 4096
function chunks(text) {
  const out = [];
  for (let i = 0; i < text.length; i += MAXLEN) out.push(text.slice(i, i + MAXLEN));
  return out.length ? out : [''];
}
async function replyLong(ctx, text) {
  for (const c of chunks(text)) await ctx.reply(c).catch(() => {});
}

// editMessageText, который не падает на «not modified» и прочем шуме.
async function safeEditText(ctx, text, extra) {
  try { await ctx.editMessageText(text, extra); }
  catch (e) {
    const m = (e && e.description) || (e && e.message) || '';
    if (!/not modified|message to edit not found|query is too old/i.test(m)) throw e;
  }
}

// Мёртвые абузы из «Чтим память» — не показываем кнопками переключения.
// (на дашборде они в архиве, тут просто скрываем из status.backends)
const DEAD_BACKENDS = new Set(['notion', 'freemodel_rotator', 'devin']);

function backendKeyboard(status) {
  const cur = status.current;
  const rows = Object.entries(status.backends)
    .filter(([name]) => !DEAD_BACKENDS.has(name))
    .map(([name, b]) =>
      [Markup.button.callback(`${name === cur ? '✅ ' : ''}${b.label || name}`, `sw:${name}`)]
    );
  // пулы → открывают ИНТЕРАКТИВНЫЙ список аккаунтов (как вкладка на дашборде)
  rows.push([
    Markup.button.callback('🆓 FreeModel', 'poollist:fm'),
    Markup.button.callback('🟣 Aerolink', 'poollist:al'),
    Markup.button.callback('🔵 Conduit', 'poollist:cdt'),
  ]);
  rows.push([Markup.button.callback('🔄 авто-ротация FM', 'auto:toggle')]);
  rows.push([Markup.button.callback('‹ в меню', 'menu:home')]);
  return Markup.inlineKeyboard(rows);
}

// === Пулы аккаунтов: единый интерфейс над тремя разными формами /sessions ===
// Каждый пул отдаёт {id, title, badge (квота), active (РЕАЛЬНО активный по
// active-key), health ('✅'/'❌'/'')}.  ВАЖНО: status==='✅' у FreeModel/Conduit
// значит «здоров», а не «активный» — активный определяем по active-key дашборда.
const POOLS = {
  fm: {
    title: '🆓 FreeModel',
    list: async () => {
      const [r, ak] = await Promise.all([
        dash.freemodelSessions(),
        dash.freemodelActiveKey().catch(() => ({})),
      ]);
      const activeName = ak.activeName || '';
      return (r.sessions || []).map(s => ({
        id: s.name,
        title: s.email || s.name,
        badge: fmBadge(s.quota),
        health: s.status || '',
        active: s.name === activeName,
      }));
    },
    activate: (id) => dash.freemodelActivate(id),
    refresh: (id) => dash.freemodelRefreshQuota(id),
  },
  al: {
    title: '🟣 Aerolink',
    list: async () => {
      const r = await dash.alSessions();
      const arr = Array.isArray(r) ? r : (r.sessions || []);
      return arr.map(s => ({ id: s.api_key, title: s.email || s.api_key.slice(0, 16), badge: '', health: '', active: !!s.active }));
    },
    activate: (id) => dash.alActivate(id),
    refresh: null, // у Aerolink квот в /sessions нет
  },
  cdt: {
    title: '🔵 Conduit',
    list: async () => {
      const [r, ak] = await Promise.all([
        dash.conduitSessions(),
        dash.conduitActiveKey().catch(() => ({})),
      ]);
      const activeKey = ak.key || '';
      const arr = Array.isArray(r) ? r : (r.sessions || []);
      return arr.map(s => ({
        id: s.name,
        title: (s.username && s.username !== '(?)' ? s.username : s.tgPhone) || s.name,
        badge: cdtBadge(s.quota),
        health: s.status || '',
        active: !!activeKey && s.apiKey === activeKey,
      }));
    },
    activate: (id) => dash.conduitActivate(id),
    refresh: (id) => dash.conduitRefreshQuota(id),
  },
};

const PAGE_SIZE = 8; // аккаунтов на страницу (FreeModel — десятки)

// Квота FreeModel → короткий бейдж со светофором по недельному расходу.
function fmBadge(q) {
  if (!q) return '';
  const avail = q.available || '';
  // d7pct может быть null — тогда светофор по доступному баллансу не строим
  let dot = '';
  const pct = num(q.d7) != null && num(q.d7max) ? Math.round(100 * num(q.d7) / num(q.d7max)) : null;
  if (pct != null) dot = pct < 40 ? '🟢' : pct < 70 ? '🟡' : '🔴';
  return [dot, avail].filter(Boolean).join(' ');
}
// Квота Conduit → план + баланс.
function cdtBadge(q) {
  if (!q) return '';
  const plan = q.plan || '';
  const bal = typeof q.balance === 'number' ? `${q.balance}` : '';
  return [plan, bal].filter(Boolean).join(' ');
}
// "$29.88" → 29.88 ; null если не число.
function num(v) {
  if (typeof v === 'number') return v;
  const m = String(v == null ? '' : v).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// Иконка слева от имени: активный → ✅, иначе показываем здоровье (❌ для битых).
function accIcon(a) {
  if (a.active) return '✅ ';
  if (a.health === '❌') return '❌ ';
  return '○ ';
}

// Клавиатура списка аккаунтов пула (страница page): аккаунты + пагинация +
// ⏭ следующий / 🔄 квоты / ‹ назад.
function poolKeyboard(pool, accounts, page) {
  const pages = Math.max(1, Math.ceil(accounts.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = accounts.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const rows = slice.map((a, j) => {
    const i = page * PAGE_SIZE + j; // глобальный индекс в accounts (для pick)
    const badge = a.badge ? `  ${a.badge}` : '';
    return [Markup.button.callback(`${accIcon(a)}${a.title}${badge}`, `pick:${pool}:${i}`)];
  });
  if (pages > 1) {
    rows.push([
      Markup.button.callback('‹', `page:${pool}:${page - 1}`),
      Markup.button.callback(`${page + 1}/${pages}`, 'noop'),
      Markup.button.callback('›', `page:${pool}:${page + 1}`),
    ]);
  }
  const foot = [Markup.button.callback('⏭ следующий', `next:${pool}`)];
  if (POOLS[pool].refresh) foot.push(Markup.button.callback('🔄 квоты', `qref:${pool}`));
  rows.push(foot);
  rows.push([Markup.button.callback('‹ назад', 'menu:backends')]);
  return Markup.inlineKeyboard(rows);
}

// Кэш последнего показанного списка на чат+пул — чтобы pick:idx ссылался
// на тот же порядок, что юзер видит (между рендерами список не пересортировался).
const poolCache = new Map(); // `${chatId}:${pool}` → { accounts, page }

async function showPool(ctx, pool, opts = {}) {
  const p = POOLS[pool];
  if (!p) return;
  let accounts;
  const backRow = [[Markup.button.callback('‹ назад', 'menu:backends')]];
  try { accounts = await p.list(); }
  catch (e) { return safeEditText(ctx, `⚠️ ${p.title}: ${e.message}`, Markup.inlineKeyboard(backRow)); }
  if (!accounts.length) {
    return safeEditText(ctx, `${p.title}: нет аккаунтов`, Markup.inlineKeyboard(backRow));
  }
  // Активный — наверх, чтобы был виден сразу; остальной порядок сохраняем.
  accounts.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  const prev = poolCache.get(`${ctx.chat.id}:${pool}`);
  const page = opts.page != null ? opts.page : (prev ? prev.page : 0);
  poolCache.set(`${ctx.chat.id}:${pool}`, { accounts, page });
  const active = accounts.find(a => a.active);
  const head =
    `${p.title} — выбери аккаунт (${accounts.length}):` +
    (active ? `\nактивен: ${active.title}` : '') +
    (opts.note ? `\n${opts.note}` : '');
  await safeEditText(ctx, head, poolKeyboard(pool, accounts, page));
}

async function statusText() {
  const st = await dash.status();
  let extra = '';
  try {
    const a = await dash.autoStatus();
    extra = `\nАвто-ротация FM: ${a.running ? '🟢 вкл' : '⚪ выкл'}`;
  } catch {}
  return { st, text: `🔀 Активный бэкенд: *${st.current}*${extra}` };
}

// Понятное имя бэкенда вместо технического apihelper/...
const BACKEND_LABEL = {
  apihelper: '🆓 FreeModel (helper)',
  aerolink: '🟣 Aerolink',
  conduit: '🔵 Conduit',
  freemodel_rotator: '🆓 FreeModel (rotator)',
  omniroute: '🟠 OmniRoute',
  notion: '📓 Notion',
};

// --- Главное меню (шапка + сетка кнопок, в стиле XGATE) -------------------
async function buildMainMenu(chatId) {
  const s = cc.getSession(chatId);
  let cur = '—', autoOn = false, acct = '';
  try {
    const st = await dash.status();
    cur = BACKEND_LABEL[st.current] || st.current;
  } catch (e) { cur = '⚠️ дашборд :8200 недоступен'; }
  try { const a = await dash.autoStatus(); autoOn = !!a.enabled; acct = a.activeName || ''; } catch {}

  const header =
    '🤖 *Claude Code — пульт*\n\n' +
    `🔌 Бэкенд: ${cur}\n` +
    (acct ? `👤 Аккаунт: \`${acct.split('_')[0]}…\`\n` : '') +
    `🔄 Авто-ротация: ${autoOn ? '🟢 вкл' : '⚪ выкл'}\n` +
    `📁 Папка: \`${path.basename(s.cwd)}\`\n` +
    `💬 Разговор: ${s.fresh ? 'новый' : 'продолжается'}\n\n` +
    '_Напиши текст — он уйдёт в claude. Или жми кнопки:_';

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔌 Сменить бэкенд', 'menu:backends')],
    [Markup.button.callback('📁 Папка', 'menu:cd'), Markup.button.callback('🆕 Новый чат', 'do:new')],
    [Markup.button.callback('🔄 Авто-ротация', 'auto:toggle'), Markup.button.callback('🛑 Стоп', 'do:stop')],
    [Markup.button.callback('🔃 Обновить', 'menu:home')],
  ]);
  return { header, kb };
}

async function sendMenu(ctx, edit) {
  try {
    const { header, kb } = await buildMainMenu(ctx.chat.id);
    if (edit) await safeEditText(ctx, header, { parse_mode: 'Markdown', ...kb });
    else await ctx.replyWithMarkdown(header, kb);
  } catch (e) { await ctx.reply('⚠️ ' + e.message).catch(() => {}); }
}

// --- Команды -------------------------------------------------------------
bot.start(ctx => sendMenu(ctx, false));
bot.command('menu', ctx => sendMenu(ctx, false));

bot.command('status', async ctx => {
  try { const { text } = await statusText(); await ctx.replyWithMarkdown(text); }
  catch (e) { await ctx.reply('⚠️ ' + e.message); }
});

bot.command('backends', async ctx => {
  try {
    const { st, text } = await statusText();
    await ctx.replyWithMarkdown(text, backendKeyboard(st));
  } catch (e) { await ctx.reply('⚠️ ' + e.message); }
});

// --- Кнопки главного меню ------------------------------------------------
bot.action('menu:home', async ctx => { await ctx.answerCbQuery(); await sendMenu(ctx, true); });

bot.action('menu:backends', async ctx => {
  await ctx.answerCbQuery();
  try {
    const st = await dash.status();
    await safeEditText(ctx, '🔌 *Выбери бэкенд / пул:*', { parse_mode: 'Markdown', ...backendKeyboard(st) });
  } catch (e) { await ctx.answerCbQuery('⚠️ ' + e.message, { show_alert: true }); }
});

bot.action('menu:cd', async ctx => {
  await ctx.answerCbQuery();
  const rows = cc.ALLOWED_ROOTS.map((r, i) =>
    [Markup.button.callback('📁 ' + path.basename(r), 'cd:' + i)]
  );
  rows.push([Markup.button.callback('‹ назад', 'menu:home')]);
  await safeEditText(ctx, '📁 *Рабочая папка:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
});

bot.action(/^cd:(\d+)$/, async ctx => {
  const i = Number(ctx.match[1]);
  const dir = cc.ALLOWED_ROOTS[i];
  if (dir) { cc.setCwd(ctx.chat.id, dir); await ctx.answerCbQuery('папка: ' + path.basename(dir)); }
  await sendMenu(ctx, true);
});

bot.action('do:new', async ctx => { cc.reset(ctx.chat.id); await ctx.answerCbQuery('новый разговор'); await sendMenu(ctx, true); });
bot.action('do:stop', async ctx => { const k = cc.stop(ctx.chat.id); await ctx.answerCbQuery(k ? 'прервано' : 'нечего прерывать'); });

bot.command('pwd', ctx => {
  const s = cc.getSession(ctx.chat.id);
  ctx.reply(`📁 ${s.cwd}\nразговор: ${s.fresh ? 'новый' : 'продолжается'}`);
});

bot.command('cd', async ctx => {
  const arg = ctx.message.text.replace(/^\/cd(@\S+)?\s*/, '').trim();
  if (!arg) return ctx.reply('Использование: /cd <path>\nРазрешено:\n' + cc.ALLOWED_ROOTS.join('\n'));
  try { cc.setCwd(ctx.chat.id, arg); ctx.reply('📁 → ' + cc.getSession(ctx.chat.id).cwd); }
  catch (e) { ctx.reply('⛔ ' + e.message); }
});

bot.command('new', ctx => { cc.reset(ctx.chat.id); ctx.reply('🆕 Новый разговор. Папка: ' + cc.getSession(ctx.chat.id).cwd); });
bot.command('stop', ctx => ctx.reply(cc.stop(ctx.chat.id) ? '🛑 Прервано.' : 'Нечего прерывать.'));

// --- Inline-кнопки переключения ------------------------------------------
bot.action(/^sw:(.+)$/, async ctx => {
  const target = ctx.match[1];
  await ctx.answerCbQuery('переключаю…');
  try {
    await dash.switchBackend(target);
    const { st, text } = await statusText();
    await safeEditText(ctx, text, { parse_mode: 'Markdown', ...backendKeyboard(st) });
  } catch (e) { await ctx.answerCbQuery('⚠️ ' + e.message, { show_alert: true }); }
});

// --- Пулы: интерактивный список аккаунтов (как вкладка на дашборде) -------

// Открыть список аккаунтов пула (со страницы 0).
bot.action(/^poollist:(fm|al|cdt)$/, async ctx => {
  await ctx.answerCbQuery();
  await showPool(ctx, ctx.match[1], { page: 0 });
});

// Листать страницы списка.
bot.action(/^page:(fm|al|cdt):(-?\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const pool = ctx.match[1];
  const cached = poolCache.get(`${ctx.chat.id}:${pool}`);
  if (!cached) return showPool(ctx, pool, { page: 0 });
  // перерисовываем БЕЗ повторного запроса /sessions — листание мгновенное
  const page = Number(ctx.match[2]);
  cached.page = page;
  const active = cached.accounts.find(a => a.active);
  const head = `${POOLS[pool].title} — выбери аккаунт (${cached.accounts.length}):` + (active ? `\nактивен: ${active.title}` : '');
  await safeEditText(ctx, head, poolKeyboard(pool, cached.accounts, page));
});

bot.action('noop', ctx => ctx.answerCbQuery());

// Выбрать конкретный аккаунт по индексу из показанного списка → активировать.
bot.action(/^pick:(fm|al|cdt):(\d+)$/, async ctx => {
  const pool = ctx.match[1], idx = Number(ctx.match[2]);
  const cached = poolCache.get(`${ctx.chat.id}:${pool}`);
  const acc = cached && cached.accounts[idx];
  if (!acc) { await ctx.answerCbQuery('список устарел, открой заново'); return showPool(ctx, pool, { page: 0 }); }
  await ctx.answerCbQuery(`активирую ${acc.title}…`);
  try {
    await POOLS[pool].activate(acc.id);
    await showPool(ctx, pool, { note: `✅ активирован: ${acc.title}` });
  } catch (e) { await ctx.answerCbQuery('⚠️ ' + e.message, { show_alert: true }); }
});

// Следующий аккаунт по кругу: от активного активируем следующего за ним.
// Берём порядок из кэша (тот, что видит юзер); если кэша нет — тянем список.
bot.action(/^next:(fm|al|cdt)$/, async ctx => {
  const pool = ctx.match[1];
  await ctx.answerCbQuery('следующий…');
  try {
    let accounts = (poolCache.get(`${ctx.chat.id}:${pool}`) || {}).accounts;
    if (!accounts) accounts = await POOLS[pool].list();
    if (!accounts.length) throw new Error('нет аккаунтов');
    const curIdx = accounts.findIndex(a => a.active);
    const nextIdx = (curIdx + 1) % accounts.length; // -1 → 0 (первый)
    const acc = accounts[nextIdx];
    await POOLS[pool].activate(acc.id);
    await showPool(ctx, pool, { note: `⏭ → ${acc.title}` });
  } catch (e) { await ctx.answerCbQuery('⚠️ ' + e.message, { show_alert: true }); }
});

// Обновить квоты пула: форс-рефреш аккаунтов ТЕКУЩЕЙ СТРАНИЦЫ (FreeModel — это
// headless-Chrome на аккаунт, рефрешить все десятки нельзя). Conduit — быстрый fetch.
bot.action(/^qref:(fm|cdt)$/, async ctx => {
  const pool = ctx.match[1];
  const cached = poolCache.get(`${ctx.chat.id}:${pool}`);
  if (!cached) { await ctx.answerCbQuery(); return showPool(ctx, pool, { page: 0 }); }
  await ctx.answerCbQuery('обновляю квоты страницы… (до минуты)');
  const page = cached.page || 0;
  const slice = cached.accounts.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  for (const a of slice) { try { await POOLS[pool].refresh(a.id); } catch {} }
  await showPool(ctx, pool, { note: `🔄 квоты обновлены (стр. ${page + 1})` });
});

bot.action('auto:toggle', async ctx => {
  try {
    const a = await dash.autoStatus().catch(() => ({ running: false }));
    if (a.running) { await dash.autoStop(); await ctx.answerCbQuery('авто-ротация выкл'); }
    else { await dash.autoStart(); await ctx.answerCbQuery('авто-ротация вкл'); }
    const { st, text } = await statusText();
    await safeEditText(ctx, text, { parse_mode: 'Markdown', ...backendKeyboard(st) });
  } catch (e) { await ctx.answerCbQuery('⚠️ ' + e.message, { show_alert: true }); }
});

// --- Свободный текст → claude (живой стриминг) ----------------------------
// Telegram режет частоту editMessageText (~1 ред/сек на чат). Троттлим до 1.6с
// и редактируем «прогресс»-сообщение: лента шагов + хвост текущего текста.

// «Как в Клоде»: брайл-спиннер + дышащее слово + таймер. Анимация в Telegram —
// это смена кадров при каждом edit, поэтому крутим ОТДЕЛЬНЫМ тикером (не ждём
// событий claude): пока модель «думает» вслепую, кадр всё равно меняется.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const VERBS = ['думаю', 'размышляю', 'кручу шестерёнки', 'собираю мысли', 'прикидываю', 'копаю'];

// Иконку текущего шага превращаем в глагол для шапки (пишу/читаю/выполняю…).
function verbForStep(label) {
  if (label.includes('bash')) return 'выполняю';
  if (label.includes('читаю')) return 'читаю';
  if (label.includes('правлю')) return 'пишу';
  if (label.includes('ищу') || label.includes('grep')) return 'ищу';
  return null;
}

function renderProgress(state, frame, startedAt) {
  const spin = SPINNER[frame % SPINNER.length];
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const steps = state.steps.slice(-8); // последние шаги, чтоб не упереться в 4096

  // глагол шапки: по последнему запущенному шагу, иначе «дышащее» слово по кадру
  const running = [...state.steps].reverse().find(x => x.status === 'run');
  const verb = (running && verbForStep(running.label)) || VERBS[Math.floor(frame / 3) % VERBS.length];

  let body = `${spin} claude ${verb}…  ${secs}s\n`;
  if (steps.length) body += '\n' + steps.map(stepLine).join('\n') + '\n';
  if (state.text) body += '\n' + state.text.slice(-1500);
  return body.slice(0, 4000);
}

// Строка шага со статус-иконкой: ⏳ выполняется / ✓ ок / ✗ ошибка.
function stepLine(x) {
  const icon = x.status === 'ok' ? '✓' : x.status === 'err' ? '✗' : '⋯';
  return `${icon} ${x.label}`;
}

// Общий pipeline: prompt → claude с живым прогрессом → чистый ответ.
// Используется и для текста, и для распознанных голосовых.
async function runClaude(ctx, prompt) {
  const note = await ctx.reply(`⠋ claude думаю…  0s`);
  const chatId = ctx.chat.id, msgId = note.message_id;
  const startedAt = Date.now();

  // Прогресс/ответ claude шлём PLAIN (без parse_mode): текст модели почти никогда
  // не валидный Telegram-Markdown → иначе 400 «can't parse entities».
  let lastShown = '', frame = 0, latest = { steps: [], text: '' };
  const pushEdit = async (text) => {
    if (text === lastShown) return; // Telegram ругается 400 на «not modified»
    lastShown = text;
    try { await ctx.telegram.editMessageText(chatId, msgId, undefined, text); } catch {}
  };
  // onEvent лишь копит свежее состояние — рисует его ТИКЕР (ниже).
  const onEvent = (state) => { latest = state; };

  // Анимационный тикер: крутит кадр каждые 1.6с независимо от событий claude.
  // 1.6с — потолок Telegram на edit одного сообщения (~1/сек + запас).
  const TICK = 1600;
  const ticker = setInterval(() => { frame++; pushEdit(renderProgress(latest, frame, startedAt)); }, TICK);

  const r = await cc.ask(chatId, prompt, onEvent);
  clearInterval(ticker);

  // финал: удаляем прогресс, шлём чистый ответ
  await ctx.telegram.deleteMessage(chatId, msgId).catch(() => {});
  if (!r.ok) return replyLong(ctx, '⚠️ ' + (r.error || 'ошибка'));
  await replyLong(ctx, r.text || '(пусто)');
  if (typeof r.cost === 'number') await ctx.reply(`💰 $${r.cost.toFixed(4)}`).catch(() => {});
}

bot.on('text', async ctx => {
  const prompt = ctx.message.text;
  if (prompt.startsWith('/')) return;
  await runClaude(ctx, prompt);
});

// --- Голосовые: скачать .oga → faster-whisper → текст → claude ------------
bot.on('voice', async ctx => {
  const v = ctx.message.voice;
  const status = await ctx.reply('🎙 распознаю…');
  let tmp;
  try {
    // скачиваем голосовой во временный .oga (Telegram отдаёт opus в ogg-контейнере)
    const link = await ctx.telegram.getFileLink(v.file_id);
    tmp = path.join(os.tmpdir(), `tgvoice_${ctx.chat.id}_${v.file_id.slice(-8)}.oga`);
    await downloadTo(String(link), tmp);

    const r = await stt.transcribe(tmp);
    if (!r.ok) { await safeEditText(ctx, '⚠️ STT: ' + (r.error || 'ошибка'), {}); return; }
    const text = (r.text || '').trim();
    if (!text) { await safeEditText(ctx, '🤷 ничего не распознал', {}); return; }

    // показываем распознанное (чтобы видеть, что услышал бот), затем — в claude
    await safeEditText(ctx, `🎙 «${text}»`, {});
    await runClaude(ctx, text);
  } catch (e) {
    await safeEditText(ctx, '💥 ' + e.message, {}).catch(() => {});
  } finally {
    if (tmp) fs.unlink(tmp, () => {});
  }
});

// Скачать URL в файл (Telegram file link → локальный путь).
function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode !== 200) { file.close(); fs.unlink(dest, () => {}); return reject(new Error(`скачивание: HTTP ${res.statusCode}`)); }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (e) => { file.close(); fs.unlink(dest, () => {}); reject(e); });
  });
}

bot.catch((err, ctx) => {
  const msg = (err && err.description) || (err && err.message) || String(err);
  // «message is not modified» / «query is too old» — безобидный шум от edit/answerCbQuery
  if (/message is not modified|query is too old|message to edit not found/i.test(msg)) {
    console.warn('ignored tg error:', msg);
    return;
  }
  console.error('bot error', err);
  if (ctx && ctx.reply) ctx.reply('💥 ' + msg).catch(() => {});
});

bot.launch().then(() => console.log(`tgbot запущен. whitelist: ${ALLOWED.join(', ')} | dashboard: ${dash.BASE}`));
process.once('SIGINT', () => { stt.shutdown(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { stt.shutdown(); bot.stop('SIGTERM'); });
