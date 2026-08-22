#!/usr/bin/env node
/**
 * render-readme-shots.js — кадры дашборда и графические ассеты для README.
 *
 * Почему свой Playwright, а не MCP-браузер: на промо-картах MCP уже врал масштабом
 * (просишь deviceScaleFactor 2 — получаешь 1.8) и резал холст по ширине окна.
 * Здесь вьюпорт, dpr и тема заданы явно, результат повторяем от прогона к прогону.
 *
 * Запуск (из корня репо; дашборд :8200 должен быть поднят):
 *   node tools/render-readme-shots.js                    # все кадры + ассеты
 *   node tools/render-readme-shots.js --only=claude,tabi  # выборочно, по slug
 *   node tools/render-readme-shots.js --assets            # только hero/themes/statusline
 *   node tools/render-readme-shots.js --no-mask           # без блюра, для себя
 *   DPR=1.5 node tools/render-readme-shots.js             # если png выходят тяжёлыми
 *
 * Куда пишет: docs/*.png — ПЛОСКО. В .gitignore лежат `*.png` и `!docs/*.png`,
 * а звёздочка не переходит через `/`, поэтому файл в docs/shots/ остался бы
 * игнорируемым и молча не попал бы в коммит (проверено `git check-ignore -v`).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const ASSETS = process.env.ASSETS_DIR || path.join(OUT, 'assets');
const DASH = process.env.DASH || 'http://127.0.0.1:8200/__switch';
const THEME = process.env.THEME || 'zen';
const DPR = Number(process.env.DPR || 2);
const VIEW = {
  width: Number(process.env.W || 2000),   // чуть шире Full HD: таблицы шлюзов
  height: Number(process.env.H || 1180),  // влезают целиком, справа нет пустоты
};

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const only = (argv.find(a => a.startsWith('--only=')) || '').replace('--only=', '')
  .split(',').map(s => s.trim()).filter(Boolean);

/** Кадры вкладок. slug — для --only, file — имя в docs/. */
const SHOTS = [
  { slug: 'claude', file: 'dashboard.png', tab: 'claude', h: 820 },
  { slug: 'agentrouter', file: 'agentrouter.png', tab: 'agentrouter' },
  { slug: 'keepalive', file: 'keepalive.png', tab: 'agentrouter', el: '#ar-keepalive', pad: 18 },
  { slug: 'sidebar', file: 'sidebar.png', tab: 'claude', el: 'aside', pad: 0 },
  { slug: 'ar-pool', file: 'agentrouter-pool.png', tab: 'agentrouter', scroll: '#ar-list', offset: 115, h: 1000 },
  { slug: 'gorouter', file: 'gorouter.png', tab: 'gorouter', scroll: '#go-list', offset: 300 },
  { slug: 'tabi', file: 'tabi.png', tab: 'tabi', h: 1000 },
  { slug: 'justwoker', file: 'justwoker.png', tab: 'justwoker', h: 1000 },
  { slug: 'github', file: 'github-accounts.png', tab: 'github' },
  { slug: 'health', file: 'health.png', tab: 'health' },
  { slug: 'plugins', file: 'plugins-mcp.png', tab: 'plugins' },
  { slug: 'settings', file: 'settings.png', tab: 'settings' },
  {
    slug: 'themes', file: 'themes.png', tab: 'settings',
    // Список 22 тем в «Настройках» свёрнут по умолчанию — раскрываем его штатной
    // функцией дашборда, а не правкой класса: так же, как это делает кнопка.
    before: 'typeof setThemeListOpen === "function" && setThemeListOpen(true)',
    scroll: '#theme-picker', offset: 240,
  },
  {
    slug: 'tabs-manager', file: 'tabs-manager.png', tab: 'claude',
    before: 'openTabsManager()', after: 'closeTabsManager()', h: 1000,
  },
];

/** Графические ассеты: исходники в docs/assets/*.html, снимаются как элемент .canvas. */
const ASSET_SHOTS = [
  { slug: 'hero', file: 'hero.png', html: 'hero.html' },
  { slug: 'statusline', file: 'statusline.png', html: 'statusline.html' },
];

/**
 * Что затирается. Правило владельца: репо публичный, поэтому персональное —
 * метки и email аккаунтов, ники GitHub, любые суммы — под блюр, а каркас
 * интерфейса (колонки, статусы, кнопки, цвета) остаётся читаемым.
 *
 * `css` — точные селекторы, доказанные по разметке routing/proxy-dashboard.html.
 * `patterns` — сеть безопасности: листовой элемент, чей собственный текст совпал
 * с шаблоном, затирается даже если селектор для него не выписан. Так новая
 * колонка с деньгами не утечёт молча при следующей правке дашборда.
 */
const MASK = {
  css: [
    // Пулы шлюзов, строка = tr[data-acct-id] (renderAr и близнецы):
    // 1-я колонка — метка/email аккаунта, 2-я — кнопка с хвостом API-ключа.
    'tr[data-acct-id] > td:nth-child(1)',
    'tr[data-acct-id] > td:nth-child(2)',
    // Чип привязки GitHub в строке пула — в нём ник купленного аккаунта.
    'tr[data-acct-id] button[onclick^="newapiPickGithub"]',
    // Менеджер гитхабов: ник в шапке карточки, живой TOTP и все значения,
    // помеченные select-all (логин, пароль, API-токен, recovery-коды).
    '#gh-grid [data-gh-id] .font-semibold',
    '#gh-grid [data-gh-code]',
    '#gh-grid .select-all',
    // Всплывающее окно кредов над строкой пула, если открыто.
    '#gh-cred-pop',
  ],
  patterns: [
    { re: '\\$\\s*-?\\d', why: 'деньги' },
    { re: '[\\w.+-]+@[\\w-]+\\.[a-z]{2,}', why: 'email' },
  ],
};

const MASK_CSS = `
  .rm-mask { filter: blur(6px) !important; }
  /* Блюр не должен менять геометрию: размеры и переносы остаются как были. */
  .rm-mask, .rm-mask * { text-shadow: none !important; }
  /* Тосты всплывают по своим делам (авторотация, обновление баланса) и попадают
     в кадр случайной надписью поверх интерфейса — на съёмке они не нужны. */
  #toasts { display: none !important; }
`;
const log = (...a) => console.log('[shots]', ...a);

/** Ждём, пока Tailwind из CDN скомпилирует CSS и приедут шрифты Geist. */
async function waitReady(page) {
  await page.waitForFunction(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    return bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'rgb(255, 255, 255)';
  }, null, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

/** Навешивает .rm-mask на всё персональное. Возвращает счётчик по причинам. */
async function applyMask(page) {
  await page.evaluate(css => {
    if (document.getElementById('rm-mask-style')) return;
    const st = document.createElement('style');
    st.id = 'rm-mask-style';
    st.textContent = css;
    document.head.appendChild(st);
  }, MASK_CSS);
  return page.evaluate(cfg => {
    const stat = {};
    const bump = why => { stat[why] = (stat[why] || 0) + 1; };
    const mark = (el, why) => {
      if (!el || el.classList.contains('rm-mask')) return;
      el.classList.add('rm-mask');
      bump(why);
    };
    for (const sel of cfg.css) {
      document.querySelectorAll(sel).forEach(el => mark(el, 'селектор'));
    }
    const res = cfg.patterns.map(p => ({ re: new RegExp(p.re, 'i'), why: p.why }));
    document.querySelectorAll('body *').forEach(el => {
      if (el.children.length) return;               // только листья, иначе смажет блок целиком
      if (el.closest('.rm-mask')) return;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 120) return;
      for (const { re, why } of res) if (re.test(t)) { mark(el, why); break; }
    });
    return stat;
  }, MASK);
}

/** Открывает дашборд в нужной теме. Тема ставится ДО скриптов страницы. */
async function openDash(browser) {
  const ctx = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: DPR,
    colorScheme: 'dark',
    locale: 'ru-RU',
  });
  await ctx.addInitScript(theme => {
    try { localStorage.setItem('dashboard-theme', theme); } catch (e) { /* нет хранилища */ }
  }, THEME);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.goto(DASH, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitReady(page);
  const applied = await page.evaluate(() => document.documentElement.dataset.theme);
  if (applied !== THEME) throw new Error(`тема не применилась: ${applied} вместо ${THEME}`);
  if (errors.length) log('⚠ ошибки страницы:', errors.slice(0, 3).join(' | '));
  // Тосты всплывают по своим делам (авторотация, обновление баланса) и попадают
  // в кадр случайной надписью поверх интерфейса — на съёмке они не нужны.
  await page.addStyleTag({ content: '#toasts { display: none !important; }' });
  return { ctx, page };
}

/** Снимает вкладку дашборда. Кадр = вьюпорт, чтобы картинка читалась как окно. */
async function shootTab(page, shot) {
  await page.click(`.nav-btn[data-tab="${shot.tab}"]`);
  await page.waitForSelector(`[data-tab-content="${shot.tab}"].active`, { timeout: 20000 });
  await page.waitForLoadState('networkidle').catch(() => { /* тик обновления не даёт простоя */ });
  // Списки моделей тянутся у самого шлюза и приезжают позже вкладки. Кадр со
  // словом «загрузка…» вместо каталога — брак, поэтому ждём его исчезновения.
  await page.waitForFunction(tab => {
    const box = document.querySelector(`[data-tab-content="${tab}"]`);
    return box && !/загрузка…|загрузка\.\.\./.test(box.textContent || '');
  }, shot.tab, { timeout: 25000 }).catch(() => log(`${shot.file}: «загрузка…» не ушла`));
  if (shot.wait) await page.waitForSelector(shot.wait, { timeout: 20000 }).catch(() => log('не дождался', shot.wait));
  // Своя высота под вкладку: у коротких (Claude Code) полный Full HD оставляет
  // полкадра пустоты, у длинных таблиц наоборот режет хвост.
  if (shot.h && shot.h !== VIEW.height) {
    await page.setViewportSize({ width: VIEW.width, height: shot.h });
    await page.waitForTimeout(350);
  }
  if (shot.before) {
    await page.evaluate(js => { // eslint-disable-next-line no-eval
      window.eval(js);
    }, shot.before).catch(e => log(`${shot.file}: before упал — ${e.message}`));
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  // Таблица пула у шлюзов уходит далеко под сгиб: подводим её в кадр, оставляя
  // сверху полосу с органами управления — иначе непонятно, что это за экран.
  if (shot.scroll) {
    await page.evaluate(({ sel, off }) => {
      const el = document.querySelector(sel);
      if (el) window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - (off || 260)));
    }, { sel: shot.scroll, off: shot.offset });
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(shot.settle || 900);
  const stat = has('--no-mask') ? {} : await applyMask(page);
  const file = path.join(OUT, shot.file);
  if (shot.el) {
    // Кадр одного блока (сайдбар, карточка keepalive). element-screenshot сам
    // доводит элемент до видимой области и режет ровно по его рамке — clip тут
    // не годится: его координаты считаются от вьюпорта, а блок бывает под сгибом.
    const el = await page.$(shot.el);
    if (!el) throw new Error(`нет элемента ${shot.el}`);
    await el.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file, fullPage: !!shot.full });
  }
  await page.evaluate(() => document.querySelectorAll('.rm-mask')
    .forEach(el => el.classList.remove('rm-mask')));
  if (shot.h && shot.h !== VIEW.height) {
    await page.setViewportSize(VIEW);
    await page.waitForTimeout(250);
  }
  const kb = Math.round(fs.statSync(file).size / 1024);
  log(`${shot.file} — ${kb} КБ, затёрто:`, JSON.stringify(stat));
  if (shot.after) {
    await page.evaluate(js => { window.eval(js); }, shot.after)
      .catch(e => log(`${shot.file}: after упал — ${e.message}`));
    await page.waitForTimeout(300);
  }
}

/** Снимает ассет: вьюпорт подгоняется под холст, иначе Chrome срежет лишнее по ширине. */
async function shootAsset(browser, a) {
  const src = path.join(ASSETS, a.html);
  if (!fs.existsSync(src)) return log(`нет исходника ${a.html} — пропуск`);
  const ctx = await browser.newContext({ deviceScaleFactor: DPR, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto('file:///' + src.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const el = await page.$('.canvas');
  if (!el) { await ctx.close(); return log(`в ${a.html} нет элемента .canvas — пропуск`); }
  const box = await el.boundingBox();
  await page.setViewportSize({
    width: Math.ceil(box.width) + 48,
    height: Math.ceil(box.height) + 48,
  });
  await page.waitForTimeout(300);
  const file = path.join(OUT, a.file);
  await el.screenshot({ path: file });
  const kb = Math.round(fs.statSync(file).size / 1024);
  log(`${a.file} — ${kb} КБ, холст ${Math.round(box.width)}×${Math.round(box.height)} × dpr ${DPR}`);
  await ctx.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  log(`тема ${THEME}, вьюпорт ${VIEW.width}×${VIEW.height}, dpr ${DPR} → ${OUT}`);
  const browser = await chromium.launch({ headless: true });
  try {
    if (!has('--assets')) {
      const picked = SHOTS.filter(s => !only.length || only.includes(s.slug));
      if (picked.length) {
        const { ctx, page } = await openDash(browser);
        for (const s of picked) {
          try { await shootTab(page, s); }
          catch (e) { log(`✗ ${s.file}: ${e.message}`); }
        }
        await ctx.close();
      }
    }
    if (!has('--tabs')) {
      for (const a of ASSET_SHOTS) {
        if (only.length && !only.includes(a.slug)) continue;
        try { await shootAsset(browser, a); }
        catch (e) { log(`✗ ${a.file}: ${e.message}`); }
      }
    }
  } finally {
    await browser.close();
  }
  log('готово');
})().catch(e => { console.error('[shots] упал:', e); process.exit(1); });
