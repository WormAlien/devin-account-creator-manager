// freemodel/lib/diagnose-signup.js
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const INVITE = process.argv[2] || "FRE-154e3db0";
const URL = `https://freemodel.dev/invite/${INVITE}`;
const OUT = path.join(__dirname, "..", "accounts", "diagnose-signup");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const network = [];
  page.on("request", (req) => {
    network.push({ type: "req", url: req.url(), method: req.method(), headers: req.headers() });
  });
  page.on("response", async (res) => {
    try {
      const text = await res.text().catch(() => "");
      network.push({ type: "res", url: res.url(), status: res.status(), body: text.slice(0, 500) });
    } catch {}
  });
  page.on("console", (msg) => network.push({ type: "console", text: msg.text(), kind: msg.type }));

  await page.goto(URL, { wait_until: "domcontentloaded", timeout: 60000 });
  await sleep(2000);

  const email = "test@example.com";

  // Заполняем email через JS
  await page.evaluate((val) => {
    const el = document.querySelector('input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="email" i]');
    if (el) {
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, email);

  await sleep(500);

  // Снимаем состояние формы
  const formInfo = await page.evaluate(() => {
    const emailInput = document.querySelector('input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="email" i]');
    const form = emailInput ? emailInput.closest("form") : null;
    const allInputs = form ? Array.from(form.querySelectorAll("input, textarea, select, checkbox")) : [];
    const allButtons = form ? Array.from(form.querySelectorAll("button, input[type='submit']")) : [];
    return {
      url: location.href,
      emailValue: emailInput ? emailInput.value : null,
      emailOuter: emailInput ? emailInput.outerHTML.slice(0, 500) : null,
      formHTML: form ? form.outerHTML.slice(0, 3000) : "no form",
      inputs: allInputs.map((i) => ({
        type: i.type,
        name: i.name,
        id: i.id,
        value: i.value ? i.value.slice(0, 100) : "",
        required: i.required,
        hidden: i.hidden,
        outer: i.outerHTML.slice(0, 200),
      })),
      buttons: allButtons.map((b) => ({
        tag: b.tagName,
        type: b.type,
        text: (b.textContent || b.value || "").trim().slice(0, 100),
        disabled: b.disabled,
        outer: b.outerHTML.slice(0, 300),
        rect: b.getBoundingClientRect ? { x: b.getBoundingClientRect().x, y: b.getBoundingClientRect().y, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height } : null,
      })),
      bodyText: document.body ? document.body.innerText.slice(0, 800) : "",
    };
  });

  fs.writeFileSync(path.join(OUT, "form_info.json"), JSON.stringify(formInfo, null, 2));
  await page.screenshot({ path: path.join(OUT, "before_click.png") });

  // Пробуем кликнуть кнопку и сразу сохранить состояние
  await page.evaluate(() => {
    const emailInput = document.querySelector('input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="email" i]');
    const form = emailInput ? emailInput.closest("form") : null;
    if (form) {
      const candidates = Array.from(form.querySelectorAll("button, input[type='submit']"));
      const btn = candidates.find((b) => /send|verify|continue|sign|submit/i.test((b.textContent || b.value || "")));
      if (btn) btn.click();
    }
  });

  await sleep(2000);

  const afterClick = await page.evaluate(() => ({
    url: location.href,
    bodyText: document.body ? document.body.innerText.slice(0, 1000) : "",
  }));
  fs.writeFileSync(path.join(OUT, "after_click.json"), JSON.stringify(afterClick, null, 2));
  await page.screenshot({ path: path.join(OUT, "after_click.png") });
  fs.writeFileSync(path.join(OUT, "network.json"), JSON.stringify(network, null, 2));

  await browser.close();
  console.log("Diagnostic saved to:", OUT);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
