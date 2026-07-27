const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto("https://www.emailnator.com/", { timeout: 60000, waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const html = await page.content();
  console.log("=== PAGE TITLE ===");
  console.log(await page.title());
  console.log("\n=== BODY TEXT (first 1000 chars) ===");
  console.log((await page.locator("body").innerText()).slice(0, 1000));
  console.log("\n=== INPUT FIELDS ===");
  const inputs = await page.locator("input").all();
  for (let i = 0; i < inputs.length; i++) {
    const type = await inputs[i].getAttribute("type").catch(() => "text");
    const val = await inputs[i].inputValue().catch(() => "");
    const placeholder = await inputs[i].getAttribute("placeholder").catch(() => "");
    console.log(`input[${i}] type=${type} val="${val}" placeholder="${placeholder}"`);
  }
  console.log("\nClose browser manually when done.");
  await new Promise(() => {});
})();
