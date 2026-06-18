// test-dashboard-tg-click.js
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  page.on("console", (msg) => console.log(`[console ${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));

  await page.goto("http://localhost:8200/__switch", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);

  await page.click('button[data-tab="freemodel"]');
  await page.waitForTimeout(2000);

  const btn = page.locator('button[title*="TG не привязан"]').first();
  if ((await btn.count()) === 0) {
    console.log("No TG not-bound buttons found");
    await browser.close();
    return;
  }

  const outerHTML = await btn.evaluate((el) => el.outerHTML);
  console.log("Button HTML:", outerHTML);

  // Check if any TG list API error
  const tgList = await page.evaluate(async () => {
    try {
      const res = await fetch('/__switch/api/tg/list');
      const text = await res.text();
      return { ok: res.ok, text: text.slice(0, 200) };
    } catch (e) {
      return { error: e.message };
    }
  });
  console.log("TG list API:", tgList);

  // Call the function directly from the page and see result
  const result = await page.evaluate(async () => {
    const btns = document.querySelectorAll('button[title*="TG не привязан"]');
    if (btns.length === 0) return { error: 'no button' };
    const first = btns[0];
    const onclick = first.getAttribute('onclick');
    return { onclick, title: first.getAttribute('title') };
  });
  console.log("Button attrs:", result);

  console.log("Clicking...");
  await btn.click();
  await page.waitForTimeout(1500);

  const modal = page.locator('#tg-bind-modal');
  const isVisible = await modal.isVisible().catch(() => false);
  console.log(`Modal visible: ${isVisible}`);

  await page.waitForTimeout(2000);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
