// tools/rec-newapi-flow.js
//
// РЕКОРДЕР живого прохода по панели New API. Одноразовый диагностический инструмент:
// человек проходит сценарий руками, скрипт пишет, ЧТО именно он нажал и что на это
// ответил бэкенд — из трейса потом собирается автоматика (auto-логин + снятие ключа).
//
// Зачем не `playwright codegen`: codegen пишет только клики и не умеет персистентный
// профиль, а тут важнее половина, которой у него нет — сетевой разговор с панелью
// (какой роут отдаёт ключ, что приходит на OAuth-колбэк) и попап GitHub-входа.
//
// Использование:
//   node tools/rec-newapi-flow.js [label] [ghId|ghNick] [startUrl]
//     label      — папка профиля justwoker/profiles/<label>/ (по умолчанию `_rec`)
//     ghId|ghNick — какой GitHub заселить в чистый профиль из кеша github/sessions/.
//                  Ровно то, что делает кнопка 🐙 в дашборде: пароль и 2FA не нужны.
//     startUrl   — куда открыть (по умолчанию регистрация по рефке владельца)
//
// Заселение идёт МИМО пула: запись в justwoker-sessions.json не создаётся, реальный
// путь дашборда от этого не меняется (open-session.js читает тот же снимок), а
// демонстрационный проход не оставляет за собой аккаунт-полуфабрикат.
//
// Трейс: logs/rec-<label>-<ts>.jsonl (папка в .gitignore). Живая сводка — в stdout.
//
// 🔒 Значения полей НЕ пишутся: только имя поля и длина ввода. Пароль и 2FA в трейс
//    не попадают. Ключи вида sk-… в телах ответов заменяются на sk-…(len=N) — для
//    сборки автоматики важно, КАКОЙ роут отдаёт ключ, а не сам ключ.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const label = (process.argv[2] || '_rec').replace(/[^\w-]/g, '_');
const profileDir = path.join(ROOT, 'justwoker', 'profiles', label);

// Рефка владельца — та же, что в justwoker/open-session.js:41. Захардкожена намеренно:
// демонстрационный проход тоже может закончиться живой регистрацией, и терять на нём
// реф-кредит незачем.
const REGISTER_URL = 'https://api.justwoker.icu/sign-up?aff=IFYf';
const ghArg = String(process.argv[3] || '').trim();
const startUrl = process.argv[4] || REGISTER_URL;

const PANEL_HOST = 'api.justwoker.icu';

const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const tracePath = path.join(LOG_DIR, `rec-${label}-${stamp}.jsonl`);

let seq = 0;
const t0 = Date.now();
function rec(kind, data) {
  const row = { n: ++seq, ms: Date.now() - t0, kind, ...data };
  fs.appendFileSync(tracePath, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

// Ключи в трейс не пишем. Заодно ловим bearer/куки в телах.
function redact(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, m => `sk-…(len=${m.length})`)
    .replace(/"(access_token|refresh_token|token|password)"\s*:\s*"[^"]{6,}"/g,
      (m, k) => `"${k}":"…redacted…"`);
}
function clip(s, n = 1200) {
  const r = redact(String(s == null ? '' : s));
  return r.length > n ? r.slice(0, n) + `…(+${r.length - n})` : r;
}

// ───────────────────────── что вешаем в страницу ─────────────────────────
// Один слушатель на capture-фазе документа: клики и правки полей. Селектор собираем
// на месте — после ухода SPA восстановить его по постфактум-снимку уже нельзя.
const PROBE = `(() => {
  const desc = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const attr = (n) => { try { return el.getAttribute(n) || null; } catch { return null; } };
    const txt = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    // Путь строим коротким: id/name/data-testid обрывают подъём, дальше tag:nth-child.
    const path = [];
    let cur = el;
    for (let i = 0; cur && cur.nodeType === 1 && i < 6; i++) {
      const id = cur.id && !/^[0-9]/.test(cur.id) ? '#' + cur.id : null;
      if (id) { path.unshift(id); break; }
      const tn = cur.tagName.toLowerCase();
      const par = cur.parentElement;
      if (!par) { path.unshift(tn); break; }
      const same = Array.from(par.children).filter(c => c.tagName === cur.tagName);
      path.unshift(same.length > 1 ? tn + ':nth-of-type(' + (same.indexOf(cur) + 1) + ')' : tn);
      cur = par;
    }
    return {
      tag: el.tagName.toLowerCase(),
      type: attr('type'), id: el.id || null, name: attr('name'),
      role: attr('role'), ariaLabel: attr('aria-label'), testid: attr('data-testid'),
      placeholder: attr('placeholder'), href: attr('href'),
      cls: (attr('class') || '').split(/\\s+/).filter(Boolean).slice(0, 4).join(' ') || null,
      text: txt || null,
      css: path.join(' > '),
    };
  };
  const secret = (el) => {
    const t = (el.getAttribute('type') || '').toLowerCase();
    const n = ((el.getAttribute('name') || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('autocomplete') || '')).toLowerCase();
    return t === 'password' || /pass|otp|totp|2fa|code|secret/.test(n);
  };
  const send = (ev, el, extra) => {
    try { window.__rec({ ev, el: desc(el), url: location.href, extra: extra || null }); } catch {}
  };
  document.addEventListener('click', (e) => {
    // Кнопка часто внутри — поднимаемся до кликабельного предка.
    let el = e.target;
    for (let i = 0; el && i < 4; i++) {
      const t = el.tagName;
      if (t === 'BUTTON' || t === 'A' || el.getAttribute('role') === 'button' || t === 'INPUT') break;
      el = el.parentElement;
    }
    send('click', el || e.target);
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
    // ЗНАЧЕНИЕ НЕ ПИШЕМ — только длина. Селекты исключение: там значение не секрет.
    send('fill', el, el.tagName === 'SELECT'
      ? { value: String(el.value).slice(0, 40) }
      : { len: String(el.value || '').length, secret: secret(el) });
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send('enter', e.target);
  }, true);
  // Копирование — ровно то, что человек сейчас делает руками с ключом.
  document.addEventListener('copy', () => {
    try {
      const s = String(window.getSelection() || '');
      window.__rec({ ev: 'copy', el: null, url: location.href,
        extra: { len: s.length, looksLikeKey: /^sk-[A-Za-z0-9_-]{8,}$/.test(s.trim()) } });
    } catch {}
  }, true);
})()`;

// Шум, который в трейсе только мешает.
const SKIP_RE = /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|css|js|map)(\?|$)/i;

// ───────────────── заселение готовой GitHub-сессии (как кнопка 🐙) ─────────────────
// Снимок storageState лежит в github/sessions/<ghId>.json — его снял харвест из профиля
// другого провайдера. Формат и разбор — один в один justwoker/open-session.js:69-112,
// чтобы браузер стартовал в ТОМ ЖЕ состоянии, что по кнопке 🌐 в дашборде.
const GH_SESSIONS_DIR = path.join(ROOT, 'github', 'sessions');

function findGhSnapshot(arg) {
  if (!arg) return null;
  const direct = path.join(GH_SESSIONS_DIR, arg + '.json');
  if (fs.existsSync(direct)) return { file: direct, ghId: arg };
  // Не id, а ник: ищем по ghLogin внутри снимков. Ник в трейсе читается, id — нет.
  for (const f of fs.readdirSync(GH_SESSIONS_DIR)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(GH_SESSIONS_DIR, f), 'utf8'));
      if (String(j.ghLogin || '').toLowerCase() === arg.toLowerCase()) {
        return { file: path.join(GH_SESSIONS_DIR, f), ghId: f.replace(/\.json$/, '') };
      }
    } catch { /* битый снимок — не наша забота, просто пропускаем */ }
  }
  return null;
}

async function seedGithub(context, arg) {
  const found = findGhSnapshot(arg);
  if (!found) {
    console.log(`⚠️  снимка GitHub «${arg}» в ${GH_SESSIONS_DIR} нет — вход попросит пароль и 2FA`);
    rec('seed', { ok: false, arg });
    return null;
  }
  const snap = JSON.parse(fs.readFileSync(found.file, 'utf8'));
  const cookies = Array.isArray(snap.cookies) ? snap.cookies : [];
  if (!cookies.length) {
    console.log(`⚠️  снимок ${found.ghId} пустой`);
    rec('seed', { ok: false, ghId: found.ghId });
    return null;
  }
  try { await context.addCookies(cookies); }
  catch (e) { console.log(`⚠️  часть кук не применилась: ${e.message}`); }

  for (const o of (snap.origins || []).filter(o => o.localStorage && o.localStorage.length)) {
    try {
      await context.addInitScript(
        (entries) => { for (const { name, value } of entries) { try { localStorage.setItem(name, value); } catch {} } },
        o.localStorage.map(({ name, value }) => ({ name, value })),
      );
    } catch { /* невалидный origin — пропускаем */ }
  }
  // Живость смотрим ПО КУКЕ, а не пробником на github.com: фейковый заход GitHub
  // считает угоном и гасит сессию (три уже так потеряли — routing/lib/github-session.js).
  const alive = cookies.some(c => c.name === 'user_session' && c.value);
  const nick = snap.ghLogin || arg;
  console.log(`🐙 заселён GitHub ${nick} (${found.ghId}): кук ${cookies.length}`
    + (alive ? ' — user_session на месте, вход одним кликом' : ' — ⚠️ user_session нет, попросит пароль/2FA'));
  rec('seed', { ok: true, ghId: found.ghId, ghLogin: nick, cookies: cookies.length, alive });
  return nick;
}

async function main() {
  fs.mkdirSync(path.dirname(profileDir), { recursive: true });
  const fresh = !fs.existsSync(path.join(profileDir, 'Default', 'Preferences'));

  console.log(`🎬 РЕКОРДЕР. Профиль: ${profileDir} · ${fresh ? 'чистый' : 'уже есть'}`);
  console.log(`📝 трейс: ${tracePath}`);
  console.log('🔒 значения полей не пишутся (только длина), ключи sk-… в телах маскируются\n');

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // Биндинг и init-скрипт — на КОНТЕКСТ: GitHub-вход уезжает в попап, которого сейчас нет.
  await context.exposeBinding('__rec', (source, payload) => {
    const r = rec('ui', { host: safeHost(payload.url), ...payload });
    const el = payload.el || {};
    const who = el.text || el.ariaLabel || el.placeholder || el.name || el.id || el.tag || '?';
    const detail = payload.extra
      ? ' ' + JSON.stringify(payload.extra)
      : '';
    console.log(`#${r.n} ${payload.ev.toUpperCase().padEnd(5)} [${safeHost(payload.url)}] «${String(who).slice(0, 48)}»${detail}`);
    if (el.css) console.log(`        css: ${el.css}`);
  });
  await context.addInitScript(PROBE);

  const wire = (page, tag) => {
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame()) return;
      rec('nav', { page: tag, url: f.url() });
      console.log(`#${seq} NAV   [${tag}] ${f.url().slice(0, 140)}`);
    });
    page.on('console', (m) => {
      if (m.type() === 'error') rec('pageerror', { page: tag, text: clip(m.text(), 300) });
    });
    page.on('close', () => rec('pageclose', { page: tag }));
  };

  context.on('response', async (resp) => {
    const url = resp.url();
    if (SKIP_RE.test(url)) return;
    let host;
    try { host = new URL(url).hostname; } catch { return; }
    const req = resp.request();
    const isApi = /\/api\//.test(url) || req.method() !== 'GET';
    // Держим то, что объясняет сценарий: весь разговор с панелью + любые POST/PUT.
    if (!isApi && host !== PANEL_HOST) return;
    let body = null;
    // Тело читаем только у json/text и только у панели: у GitHub это гигабайты HTML.
    const ct = (resp.headers()['content-type'] || '');
    if (host === PANEL_HOST && /json|text\/plain/.test(ct)) {
      body = await resp.text().then(t => clip(t, 900)).catch(() => null);
    }
    const row = rec('http', {
      method: req.method(), status: resp.status(), url: redact(url),
      resourceType: req.resourceType(),
      reqBody: req.method() !== 'GET' ? clip(req.postData() || '', 400) : null,
      body,
    });
    if (host === PANEL_HOST || req.method() !== 'GET') {
      console.log(`#${row.n} HTTP  ${req.method()} ${resp.status()} ${redact(url).slice(0, 130)}`);
      if (body) console.log(`        ← ${body.slice(0, 300)}`);
    }
  });

  context.on('page', (p) => {
    const tag = 'popup' + (context.pages().length - 1);
    rec('newpage', { page: tag, url: p.url() });
    console.log(`\n🪟 НОВОЕ ОКНО (${tag}) — GitHub-вход обычно тут\n`);
    wire(p, tag);
  });

  const page = context.pages()[0] || await context.newPage();
  wire(page, 'main');

  // Куки — ДО первой навигации, иначе панель успеет отдать страницу разлогиненной.
  if (ghArg) await seedGithub(context, ghArg);

  console.log(`➡️  открываю ${startUrl}`);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(e => {
    console.log(`⚠️  goto: ${e.message}`);
  });

  // Реф-код панель кладёт в localStorage — как в justwoker/open-session.js:220.
  // Не осел → перезаход по рефке, иначе регистрация не зачтётся.
  if (startUrl === REGISTER_URL) {
    const readAff = () => page.evaluate(() => { try { return localStorage.getItem('aff'); } catch { return null; } }).catch(() => null);
    let aff = await readAff();
    if (!aff) {
      await page.goto(REGISTER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      aff = await readAff();
    }
    console.log(aff ? `🤝 реф-код в профиле: aff=${aff}` : '⚠️  реф-код не осел в localStorage');
    rec('aff', { aff: aff || null });
  }

  console.log('\n────────────────────────────────────────────────────────');
  console.log('Проходи сценарий руками. Я пишу всё: клики, поля, ответы API.');
  console.log('Закончил — просто закрой окно браузера, я сложу сводку.');
  console.log('────────────────────────────────────────────────────────\n');

  await new Promise((resolve) => context.on('close', resolve));
  rec('end', {});
  console.log(`\n🏁 Браузер закрыт. Записей: ${seq}. Трейс: ${tracePath}`);
}

function safeHost(u) {
  try { return new URL(u).hostname; } catch { return '?'; }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
