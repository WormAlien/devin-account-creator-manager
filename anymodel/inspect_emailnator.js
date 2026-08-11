/**
 * Инспектор emailnator — смотрим структуру inbox и как открывается письмо.
 * Запуск: node anymodel/inspect_emailnator.js <email>
 * Пример: node anymodel/inspect_emailnator.js test@gmail.com
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const email = process.argv[2];
if (!email) { console.error("Usage: node inspect_emailnator.js <email>"); process.exit(1); }

const OUT = path.join(__dirname, "logs");
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  console.log(`[inspect] открываю mailbox для ${email}...`);
  await page.goto(`https://emailnator.com/mailbox#${email}`, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Соглашаемся если есть кнопка Consent
  try { await page.click('button:has-text("Consent")', { timeout: 3000 }); } catch {}

  console.log("[inspect] ждём письма 60с... отправь письмо на этот адрес сейчас");

  let dumped = false;
  const dumpState = async (label) => {
    const text = await page.evaluate("() => document.body ? document.body.innerText : ''").catch(() => "");
    const html = await page.evaluate("() => document.documentElement.outerHTML").catch(() => "");
    fs.writeFileSync(path.join(OUT, `emailnator_${label}.txt`), text);
    fs.writeFileSync(path.join(OUT, `emailnator_${label}.html`), html);
    await page.screenshot({ path: path.join(OUT, `emailnator_${label}.png`), fullPage: true });

    const probe = await page.evaluate(() => {
      const pick = el => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: typeof el.className === "string" ? el.className.slice(0, 80) : null,
        text: (el.innerText || "").trim().slice(0, 100),
        attrs: Array.from(el.attributes || [])
          .map(a => `${a.name}="${a.value.slice(0,60)}"`)
          .join(" ").slice(0, 200),
      });
      return {
        url: location.href,
        frames: window.frames.length,
        // Кандидаты на строки писем в инбоксе
        messageRows: Array.from(
          document.querySelectorAll("tr, [class*=message i], [class*=mail i], [class*=inbox i], [class*=item i], [class*=row i]")
        ).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 100 && r.height > 10 && r.height < 200;
        }).slice(0, 20).map(pick),
        // Все кликабельные элементы
        clickable: Array.from(
          document.querySelectorAll("a, button, [onclick], [role=button], [role=link]")
        ).filter(el => {
          const t = (el.innerText || "").trim();
          return t.length > 3 && t.length < 200;
        }).slice(0, 30).map(pick),
      };
    });
    fs.writeFileSync(path.join(OUT, `emailnator_${label}_probe.json`), JSON.stringify(probe, null, 2));
    console.log(`[inspect] dump '${label}' → logs/emailnator_${label}.*`);
    console.log(`  messageRows: ${probe.messageRows.length}, clickable: ${probe.clickable.length}`);
    if (probe.messageRows.length) {
      console.log("  Первые messageRows:");
      probe.messageRows.slice(0, 5).forEach(r => console.log(`    [${r.tag}] cls="${r.cls}" text="${r.text}"`));
    }
  };

  // Поллим каждые 5с, дампим когда контент вырастает
  let lastLen = 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(5000);
    try {
      const loc = page.getByRole("button", { name: "Reload" });
      if (await loc.count()) await loc.first().click({ timeout: 2000 });
      else await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    } catch {}
    await page.waitForTimeout(2000);

    const bodyLen = await page.evaluate("() => document.body.innerText.length");
    if (bodyLen > lastLen + 100) {
      lastLen = bodyLen;
      console.log(`[inspect] inbox обновился (${bodyLen} символов)`);
      await dumpState("inbox_updated");
      dumped = true;

      // Теперь пробуем кликнуть первое письмо и дампим результат
      console.log("[inspect] пробую кликнуть первое письмо...");
      const clicked = await page.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll("tr, [class*=message i], [class*=mail i], [class*=item i]")
        ).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 100 && r.height > 10 && r.height < 200;
        });
        if (rows[0]) { rows[0].click(); return rows[0].outerHTML.slice(0, 200); }
        return null;
      });
      console.log(`[inspect] clicked: ${clicked}`);
      await page.waitForTimeout(3000);
      await dumpState("after_click");
      break;
    }
  }

  if (!dumped) await dumpState("no_email");
  console.log("[inspect] держу окно ещё 30с");
  await page.waitForTimeout(30000);
  await browser.close();
})();
