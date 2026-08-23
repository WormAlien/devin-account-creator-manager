// tools/jw-self-probe.js
//
// Читает `/api/user/self` у аккаунта JustWoker ИЗ ЕГО ЖЕ ПРОФИЛЯ БРАУЗЕРА и печатает
// сырые поля квоты. Нужен, чтобы отличать «баланс прикидкой» от настоящего остатка.
//
// Почему не как дашборд: тот расшифровывает банку кук с диска через DPAPI и стучится к
// панели своим fetch'ем — на этой машине из неэлевированной консоли расшифровка падает
// («ключ профиля не расшифровался»), а по Bearer от sk-ключа панель отвечает 401.
// Рабочий путь найден 2026-08-22: поднять профиль в Playwright, попросить
// `POST /api/user/auth/refresh` (кука профиля жива) и сходить за self с этим access-токеном
// из контекста самой страницы.
//
// Использование: node tools/jw-self-probe.js <label> [--headed]

const { chromium } = require('playwright');
const path = require('path');
const nac = require('../routing/lib/newapi-account.js');

const HOST = 'api.justwoker.icu';
const label = String(process.argv[2] || '').replace(/[^\w-]/g, '_');
if (!label) { console.error('использование: node tools/jw-self-probe.js <label>'); process.exit(1); }
const profileDir = path.join(__dirname, '..', 'justwoker', 'profiles', label);

(async () => {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !process.argv.includes('--headed'),
    viewport: { width: 1200, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`https://${HOST}/dashboard/overview`, { waitUntil: 'domcontentloaded' });
    const out = await page.evaluate(async () => {
      const rt = await fetch('/api/user/auth/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}', credentials: 'include',
      }).then(r => r.json()).catch(e => ({ error: String(e) }));
      const tok = rt && rt.data && rt.data.access_token;
      if (!tok) return { error: 'access-токен не выдан', refresh: rt };
      const self = await fetch('/api/user/self', {
        headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' },
      }).then(r => r.json()).catch(e => ({ error: String(e) }));
      return { self: self && self.data ? self.data : self };
    });
    if (out.error) { console.log('❌', out.error, JSON.stringify(out.refresh || {}).slice(0, 300)); return; }
    const d = out.self || {};
    // 🪤 nac.quotaPerUnit асинхронна (спрашивает `/api/status` и кеширует) — без await
    // в знаменатель уезжает [object Promise] и все суммы становятся NaN.
    const per = Number(await nac.quotaPerUnit(HOST)) || 500000;
    const usd = (q) => (Number(q || 0) / per).toFixed(2);
    console.log(`label=${label} user=${d.id} ${d.display_name || ''}`);
    console.log(`  quota      = ${d.quota}      → $${usd(d.quota)}   (остаток)`);
    console.log(`  used_quota = ${d.used_quota} → $${usd(d.used_quota)} (потрачено)`);
    console.log(`  выдача     = $${usd(Number(d.quota || 0) + Number(d.used_quota || 0))}`);
    console.log(`  group=${d.group} inviter_id=${d.inviter_id} aff_code=${d.aff_code} aff_quota=${d.aff_quota}`);
    console.log(`  quotaPerUnit(${HOST}) = ${per}`);
  } finally {
    await context.close().catch(() => {});
  }
})().catch(e => { console.error('❌', e.message); process.exit(1); });
