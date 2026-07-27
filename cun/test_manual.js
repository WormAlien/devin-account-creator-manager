const { chromium } = require("playwright");
const { createEmail } = require("../freemodel/lib/emailnator");

(async () => {
  const browser = await chromium.launch({ headless: false, args: ["--disable-blink-features=AutomationControlled"] });
  const context = await browser.newContext({ viewport: { width: 900, height: 900 }, locale: "en-US" });

  // Page 1 — emailnator
  const pEmail = await context.newPage();
  const email = await createEmail(pEmail);
  console.log(`\n📧 Email: ${email}\n`);

  // Page 2 — cun.ai signup
  const pCun = await context.newPage();
  await pCun.goto("https://www.cun.ai/sign-up", { waitUntil: "domcontentloaded", timeout: 60000 });
  await pCun.waitForTimeout(1500);

  // Fill only email so user can see if it accepts the alias
  await pCun.locator('input[type="email"], input[placeholder*="email" i]').first().fill(email);
  console.log("✅ Email filled on cun.ai sign-up page");
  console.log("🔍 Check if the site accepts it (no red validation error).\n");
  console.log("Close browser when done.");

  // Keep browser open
  await new Promise(() => {});
})();
