// routing/tokenrouter/rebrowser/test-turnstile.js
// Quick test: does rebrowser-playwright bypass Cloudflare Turnstile on tokenrouter.me?
// Run with Node 20:  $env:TEMP\node20\node-v20.19.0-win-x64\node.exe test-turnstile.js

const { chromium } = require('rebrowser-playwright');
const path = require('path');

const PROFILE = path.join(__dirname, '..', 'chrome-profile');

(async () => {
    console.log('Launching rebrowser-playwright...');
    
    const context = await chromium.launchPersistentContext(PROFILE, {
        headless: false,
        viewport: { width: 1920, height: 1080 },
        args: ['--no-first-run', '--no-default-browser-check'],
    });

    console.log('Browser open. Navigate and check if Turnstile passes...');
    const page = context.pages()[0] || await context.newPage();
    
    // Check navigator.webdriver
    const webdriver = await page.evaluate(() => navigator.webdriver);
    console.log('navigator.webdriver:', webdriver); // Should be false/undefined
    
    // Check plugins
    const plugins = await page.evaluate(() => navigator.plugins.length);
    console.log('navigator.plugins.length:', plugins); // Should be > 0
    
    // Check chrome.runtime
    const hasChrome = await page.evaluate(() => typeof window.chrome !== 'undefined');
    console.log('window.chrome exists:', hasChrome);
    
    console.log('\nNow go to tokenrouter.me and try to register.');
    console.log('The browser will stay open. Close the browser window when done.');
    console.log('Press Ctrl+C to exit.\n');
    
    // Keep alive
    await new Promise(() => {});
})().catch(e => { console.error(e); process.exit(1); });
