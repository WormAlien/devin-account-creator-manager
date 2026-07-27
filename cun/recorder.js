const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const RECORD_DIR = path.join(__dirname, "recordings", `rec_${Date.now()}`);
fs.mkdirSync(RECORD_DIR, { recursive: true });
const RECORD_FILE = path.join(RECORD_DIR, "actions.jsonl");
const SHOTS_DIR = path.join(RECORD_DIR, "shots");
fs.mkdirSync(SHOTS_DIR, { recursive: true });

let shotCounter = 0;
async function takeShot(page, label) {
  shotCounter++;
  const fn = path.join(SHOTS_DIR, `${String(shotCounter).padStart(2, "0")}_${label}.png`);
  await page.screenshot({ path: fn, fullPage: true });
  console.log(`[shot] ${fn}`);
}

function log(kind, payload) {
  const entry = JSON.stringify({ t: Date.now(), kind, payload });
  fs.appendFileSync(RECORD_FILE, entry + "\n");
  console.log(`[${kind}]`, JSON.stringify(payload).slice(0, 200));
}

(async () => {
  console.log("=== CUN.AI Action Recorder ===");
  console.log(`Recording to: ${RECORD_DIR}\n`);

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });

  // Inject recording script
  await context.addInitScript(() => {
    window.__REC = [];

    document.addEventListener("click", (e) => {
      const el = e.target;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : {};
      window.__REC.push({
        type: "click",
        time: Date.now(),
        x: e.clientX,
        y: e.clientY,
        tag: el.tagName,
        id: el.id,
        class: el.className,
        text: (el.textContent || "").trim().slice(0, 100),
        href: el.href || null,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      });
    }, true);

    document.addEventListener("input", (e) => {
      const el = e.target;
      window.__REC.push({
        type: "input",
        time: Date.now(),
        tag: el.tagName,
        id: el.id,
        name: el.name,
        placeholder: el.placeholder,
        value: el.value ? el.value.slice(0, 50) : "",
      });
    }, true);

    // Track URL changes
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        window.__REC.push({ type: "url_change", time: Date.now(), from: lastUrl, to: location.href });
        lastUrl = location.href;
      }
    }, 500);
  });

  const page = await context.newPage();

  // Network logging
  page.on("request", (req) => {
    log("request", { method: req.method(), url: req.url() });
  });

  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("cun.ai")) {
      try {
        const body = await res.text().catch(() => "<unreadable>");
        log("response", { url, status: res.status(), body: body.slice(0, 500) });
      } catch {}
    }
  });

  // Console logging
  page.on("console", (msg) => {
    log("console", { type: msg.type(), text: msg.text() });
  });

  page.on("pageerror", (err) => {
    log("pageerror", { msg: err.message });
  });

  // Open page
  console.log("Opening https://www.cun.ai/sign-up ...");
  await page.goto("https://www.cun.ai/sign-up", { waitUntil: "networkidle", timeout: 60000 });
  await takeShot(page, "initial");
  log("navigate", { url: page.url(), title: await page.title() });

  console.log("\n=== Browser is open. Do your actions now! ===");
  console.log("When done, press ENTER in this terminal to save recording.\n");

  // Wait for user input
  await new Promise((resolve) => {
    process.stdin.once("data", async () => {
      // Collect recorded actions from page
      const actions = await page.evaluate(() => window.__REC || []);
      fs.writeFileSync(path.join(RECORD_DIR, "actions.json"), JSON.stringify(actions, null, 2));
      log("actions_collected", { count: actions.length });
      console.log(`\nSaved ${actions.length} actions to ${RECORD_DIR}`);
      resolve();
    });
  });

  await takeShot(page, "final");
  await browser.close();
  console.log(`\nRecording complete! Files in: ${RECORD_DIR}`);
  process.exit(0);
})();
