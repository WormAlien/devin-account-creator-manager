// freemodel/lib/fm-tg-bind.js
//
// Привязка Telegram-аккаунта из пула к FreeModel-сессии.
// Алгоритм (портировано из legacy-autoregers/test-fm-full-tg-bind.js):
//   1. Открыть https://freemodel.dev/dashboard с сохранённой сессией.
//   2. Кликнуть "Verify now" / "Bind Telegram" (JS click, чтобы модалка не ловила backdrop).
//   3. Извлечь magic link t.me/<bot>?start=<token>.
//   4. Через gramjs-клиент из tg-client отправить боту /start <token>.
//   5. Подождать, пока FreeModel покажет verified / telegram connected.
//   6. Создать API-ключ (через internal/freemodel-manager.js extractFreemodelApiKey).
//
// Возвращает { ok, apiKey, tgPhone, usedEntry } или { ok:false, error }.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const tgPool = require('./tg-pool');
const tgClient = require('./tg-client');
const tgHealth = require('./tg-health');
const dashApi = require('../../internal/dashboard-api');

const DASHBOARD_URL = 'https://freemodel.dev/dashboard';
const MAGIC_RE = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})\?start=([A-Za-z0-9_\-=.]+)/i;

const EN_CONTEXT_OPTS = {
  locale: 'en-US',
  extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(logger, msg) { logger(`[fm-tg] ${msg}`); }

// Извлечь magic link из страницы.
async function extractMagicLink(page) {
  return page.evaluate(() => {
    const re = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})\?start=([A-Za-z0-9_\-=.]+)/i;
    for (const a of document.querySelectorAll('a[href], [data-href], [data-url]')) {
      for (const attr of ['href', 'data-href', 'data-url']) {
        const v = a.getAttribute && a.getAttribute(attr);
        if (!v) continue;
        const m = v.match(re);
        if (m) return { bot: m[1], token: m[2], raw: v };
      }
    }
    const m = (document.body?.innerText || '').match(re);
    if (m) return { bot: m[1], token: m[2] };
    return null;
  });
}

// Открыть модалку привязки и вытащить magic link (t.me/<bot>?start=<token>).
//
// Токен ОДНОРАЗОВЫЙ: любой /start его сжигает — в том числе неудачный, когда бот
// отвечает "already bound". Дальше сервер на него отвечает "expired". При этом
// повторный клик по "Bind Telegram" новый токен НЕ выпускает: модалка рендерит
// уже выданный, и мы бесконечно шлём боту один и тот же мёртвый токен (ровно
// это ловилось как "binding link keeps expiring").
//
// Поэтому: если что-то уже жгли, сначала перезагружаем дашборд — только так
// фронт минтит новый токен. И сверяем результат со ВСЕМИ сожжёнными за прогон,
// а не только с последним: страница вполне может вернуть токен позапрошлой
// попытки, и сравнение с одним предыдущим его пропустит.
async function openBindLink(page, logger, burned = null) {
  const seen = burned instanceof Set ? burned : new Set(burned ? [burned] : []);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (seen.size || attempt > 0) {
      log(logger, 'reload дашборда за новым токеном...');
      await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(2500);
    }

    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (!/Bind Telegram/i.test(bodyText)) {
      log(logger, 'Opening verification modal via JS click...');
      await page.evaluate(() => {
        for (const b of document.querySelectorAll('button')) { if (/Verify now/i.test(b.textContent)) { b.click(); return; } }
      });
      await sleep(2000);
    }
    log(logger, 'Clicking Bind Telegram via JS...');
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('button, a')) { if (/Bind Telegram/i.test(b.textContent)) { b.click(); return; } }
    });
    await sleep(3500);

    const link = await extractMagicLink(page);
    if (!link) continue;
    if (seen.has(link.token)) {
      log(logger, `токен ${link.token.slice(0, 12)}… уже сжигали — страница не обновила линк, перезагружаю`);
      continue;
    }
    return link;
  }
  return null;
}

async function bindTelegram(sessionDir, phone, opts = {}) {
  const logger = opts.log || (() => {});
  const headless = opts.headless !== false;
  const skipApiKey = opts.skipApiKey === true;
  const timeoutMs = opts.timeoutMs || 120000;

  const sessionFile = path.join(sessionDir, 'session.json');
  if (!fs.existsSync(sessionFile)) {
    return { ok: false, error: 'session.json not found' };
  }
  // Куда писать обновлённый storageState. По умолчанию — та же папка; авторега
  // передаёт свой рабочий файл, иначе привязка осела бы во временной копии,
  // а экспорт аккаунта забрал бы куки без TG.
  const stateOut = opts.sessionFile || sessionFile;

  // Пул проверяем ДО запуска браузера. Раньше reserve() звался уже после
  // извлечения magic link — при пустом пуле впустую тратились запуск Chromium,
  // логин по сессии и одноразовый (короткоживущий) токен привязки.
  if (phone) {
    const target = tgPool.list().find(e => e.phone === String(phone).replace(/^\+/, ''));
    if (!target) return { ok: false, error: `TG ${phone} not found` };
    if (tgPool.isDead(target.phone, tgPool.loadHealthCache())) {
      return { ok: false, error: `TG +${target.phone} мёртв (health=dead, ключ отозван) — привязка невозможна` };
    }
  } else if (tgPool.stats().usable === 0) {
    return { ok: false, error: 'No free TG account in pool' };
  }

  let browser = null;
  let context = null;
  let page = null;
  let ownsBrowser = false;   // false, когда работаем в чужом opts.context
  let tg = null;
  let entry = null;
  let tgPhone = null;

  // Браузер поднимаем ЛЕНИВО — только когда на руках уже есть живой TG.
  // В плохой партии перебор мёртвых ключей занимает десятки секунд, и всё это
  // время Chromium с открытым дашбордом просто ждал впустую; а если годных в
  // пуле не осталось вовсе — он поднимался и закрывался зря.
  const ensurePage = async () => {
    if (page) return page;
    // opts.context — живой контекст вызывающего (авторега уже держит браузер с
    // этой же сессией). Переиспользуем вместо второго Chromium; закрывать его
    // нельзя, владелец тот, кто создал (см. ownsBrowser).
    if (opts.context) {
      context = opts.context;
      page = await context.newPage();
    } else {
      ownsBrowser = true;
      browser = await chromium.launch({ headless, args: ['--mute-audio'] });
      context = await browser.newContext({
        storageState: sessionFile,
        ...EN_CONTEXT_OPTS,
      });
      page = await context.newPage();
    }
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => {
      log(logger, 'goto warn: ' + e.message);
    });
    await sleep(3000);
    return page;
  };

  try {
    // Линк НЕ берём заранее. Токен живёт считанные секунды, а перебор мёртвых
    // TG (в плохой партии их 80%+) съедал его время жизни: пока находился живой
    // аккаунт, ссылка успевала протухнуть, и бот отвечал "expired" на каждую
    // попытку. Теперь сначала добываем рабочий TG, линк просим уже под него —
    // между генерацией и /start проходит меньше секунды.
    let magicLink = null;
    let linkRegens = 0;
    // Живёт через ВСЕ попытки: токены, сожжённые предыдущими /start. Нужны и
    // после "already bound" — там токен тоже сгорает, и следующему TG нельзя
    // отдавать его же. Множество, а не последний: страница может вернуть токен
    // позапрошлой попытки.
    const burnedTokens = new Set();
    // Мёртвые ключи (отозванные/удалённые аккаунты) не тратят попытку привязки:
    // это брак пула, а не отказ бота. Считаем их отдельно, иначе одна плохая
    // партия из магазина съедала бы maxTries и валила регистрацию целиком.
    let deadSkips = 0;
    const maxDeadSkips = opts.maxDeadSkips || 12;

    // Перебираем TG из пула. Токен привязки тут принадлежит FreeModel-аккаунту,
    // поэтому его можно слать с разных TG. Если бот отвечает "already bound to a
    // different account" — этот TG уже занят на стороне FreeModel (в пуле мог
    // числиться free): помечаем used и берём следующий свободный.
    const maxTries = phone ? 1 : 6;
    let verified = false;
    for (let tryNo = 0; tryNo < maxTries && !verified; tryNo++) {
      // ── Фаза 1: достать из пула ЖИВОЙ TG ──────────────────────────────
      // Ключ мог быть отозван магазином уже после заливки в пул. Мёртвые баним
      // и берём следующий, не тратя попытку привязки: это брак партии, а не
      // отказ бота. Раньше такая ошибка улетала в общий catch и убивала всю
      // регистрацию.
      let created = null;
      while (!created) {
        entry = phone
          ? tgPool.list().find(e => e.phone === String(phone).replace(/^\+/, ''))
          : tgPool.reserve(sessionDir);
        if (!entry) {
          throw new Error(phone ? `TG ${phone} not found` : 'No free TG account in pool');
        }
        if (phone) tgPool.markUsed(entry.phone, sessionDir);
        tgPhone = entry.phone;
        log(logger, `reserved TG +${tgPhone} (попытка ${tryNo + 1}/${maxTries})`);

        try {
          created = await tgClient.createClient(entry, { logger });
        } catch (e) {
          const msg = (e && e.message) || String(e);
          if (tgHealth.classify(msg) !== 'dead') throw e;   // сеть/таймаут — наверх, TG вернётся в free
          log(logger, `TG +${tgPhone} мёртв (${msg.slice(0, 60)}) → banned, беру следующий`);
          tgPool.markBanned(tgPhone, msg);
          const skipped = tgPhone;
          entry = null; tgPhone = null;
          if (phone) {
            // Явно указан номер — перебирать нечего. Браузер закрываем руками:
            // в этой функции нет finally, а ранний return минует catch.
            try { if (browser) await browser.close(); } catch {}
            browser = null;
            return { ok: false, error: msg, tgPhone: skipped };
          }
          if (++deadSkips >= maxDeadSkips) {
            throw new Error(`${deadSkips} мёртвых TG подряд — пул протух, прерываю привязку`);
          }
        }
      }
      tg = created.client;
      // ── Фаза 2: свежий линк + /start ──────────────────────────────────
      // TG уже подключён, так что токен уходит боту практически сразу. Если он
      // всё-таки протух — регенерим ссылку тем же клиентом, не возвращая TG в
      // пул: виноват токен, а не аккаунт.
      //
      // Именно здесь впервые нужен браузер — TG на руках и точно живой.
      await ensurePage();
      let reply = '';
      for (;;) {
        // Передаём все сожжённые токены, чтобы openBindLink не вернул ни один
        // из них повторно.
        magicLink = await openBindLink(page, logger, burnedTokens);
        if (!magicLink) {
          throw new Error(burnedTokens.size
            ? 'не удалось получить свежий binding-токен (страница отдаёт уже сожжённые)'
            : 'Magic link not found');
        }
        log(logger, `magic link: bot=${magicLink.bot} token=${magicLink.token.slice(0, 20)}...`);

        const sent = await tgClient.sendStartWithToken(tg, magicLink.bot, magicLink.token, {
          timeoutMs: 15000,
          logger,
        });
        burnedTokens.add(magicLink.token);   // сожжён в любом случае — успешно или нет
        reply = sent?.reply || '';
        log(logger, 'Sent /start to bot, reply: ' + (reply || '(none)'));

        if (!/expired|generate a new one|please generate/i.test(reply)) break;
        if (++linkRegens > 3) throw new Error('binding link keeps expiring');
        log(logger, `binding link протух → регенерю (TG +${tgPhone} остаётся подключён)`);
      }

      // TG уже привязан к другому FreeModel-аккаунту → used, берём следующий.
      if (/already bound to a different account|already (?:bound|linked)/i.test(reply)) {
        log(logger, `TG +${tgPhone} уже привязан к другому аккаунту → used, беру следующий`);
        tgPool.markUsed(tgPhone, 'bound-elsewhere');
        await tgClient.disconnect(tg).catch(() => {});
        tg = null;
        const skipped = tgPhone;
        entry = null; tgPhone = null;
        if (phone) return { ok: false, error: 'TG already bound to a different account', tgPhone: skipped };
        continue;
      }

      // Ждём подтверждения на странице — ТОЛЬКО по позитивным сигналам.
      // Раньше срабатывала эвристика "нет слова waiting → verified", из-за чего
      // протухший/ошибочный QR давал ложный успех. Теперь верим navigation на
      // dashboard/usage или явному тексту успеха; ошибки на странице = провал.
      log(logger, 'Waiting for verification...');
      const deadline = Date.now() + timeoutMs;
      let failedOnPage = false;
      while (Date.now() < deadline) {
        await sleep(3000);
        const txt = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
        const curUrl = page.url();
        // Ошибка на странице (протухший/невалидный QR) — провал, НЕ ложный успех.
        if (/expired|invalid|generate a new one|something went wrong/i.test(txt)) {
          log(logger, `страница показывает ошибку привязки: ${txt.slice(0, 80).replace(/\n/g, ' ')}`);
          failedOnPage = true;
          break;
        }
        // Явный успех.
        if (/verified|подтвержден|telegram connected|successfully|success|complete/i.test(txt)) {
          verified = true;
          break;
        }
        // Модалка привязки закрылась (нет waiting/bind-текста) и ошибок нет → успех.
        if (!/(waiting for telegram|bind telegram|verify your account)/i.test(txt)) {
          verified = true;
          break;
        }
        log(logger, `poll url=${curUrl} text=${txt.slice(0, 100).replace(/\n/g, ' ')}`);
      }
      await tgClient.disconnect(tg).catch(() => {});
      tg = null;
      if (failedOnPage) throw new Error('Bind failed: страница показала ошибку/expired');
      if (!verified) throw new Error('Verification timeout');
    }
    if (!verified) throw new Error('Не нашёл свободный непривязанный TG в пуле (все already bound?)');
    log(logger, 'Verification confirmed!');

    await context.storageState({ path: stateOut });
    await tgClient.disconnect(tg);
    tg = null;
    if (ownsBrowser) {
      await browser.close();
      browser = null;
    } else {
      await page.close().catch(() => {});   // чужой контекст живёт дальше
      page = null;
    }

    // Обновляем метаданные.
    const sessionName = path.basename(sessionDir);
    // Финализация пула: reserve() пометил номер 'reserved', и без этого он
    // навсегда там и застревал — не free (не переиспользуется) и не used.
    // Ветка `if (phone)` выше зовёт markUsed только для явно указанного номера.
    tgPool.markUsed(tgPhone, sessionDir);
    dashApi.setFreemodelTgPhone(sessionName, tgPhone);

    let apiKey = null;
    if (!skipApiKey) {
      try {
        const { extractFreemodelApiKey } = require('../../internal/freemodel-manager');
        const session = { name: sessionName, path: sessionDir };
        // Свой браузер к этому моменту уже закрыт (выше) — тогда extract
        // поднимет собственный, как и раньше. Чужой контекст жив, переиспользуем.
        const keyRes = await extractFreemodelApiKey(session, ownsBrowser ? {} : { context });
        if (keyRes.ok) {
          apiKey = keyRes.apiKey;
          log(logger, `API key: ${apiKey.slice(0, 12)}...`);
          dashApi.setFreemodelApiKey(sessionName, apiKey);
        } else {
          log(logger, `API key extraction: ${keyRes.error}`);
        }
      } catch (e) {
        log(logger, `API key extraction failed: ${e.message} — продолжаем без ключа`);
      }
    }

    return { ok: true, apiKey, tgPhone, usedEntry: entry };
  } catch (e) {
    log(logger, 'ERROR: ' + e.message);
    const msg = e.message || '';
    if (/SESSION_REVOKED|AUTH_KEY_UNREGISTERED|USER_DEACTIVATED| deactivated/i.test(msg)) {
      tgPool.markBanned(tgPhone, msg);
      log(logger, `TG +${tgPhone} marked as banned`);
    } else if (tgPhone) {
      // Иначе номер остаётся 'reserved' навсегда: не выдаётся снова и числится
      // занятым. Ошибка тут — про аккаунт/сеть, сам TG живой → обратно в пул.
      const cur = tgPool.list().find(x => x.phone === String(tgPhone));
      if (cur && cur.status === 'reserved') {
        tgPool.markFree(tgPhone);
        log(logger, `TG +${tgPhone} возвращён в пул (free)`);
      }
    }
    try { if (tg) await tgClient.disconnect(tg); } catch {}
    try {
      if (ownsBrowser && browser) await browser.close();
      else if (page) await page.close();
    } catch {}
    return { ok: false, error: e.message, tgPhone };
  }
}

module.exports = { bindTelegram };
