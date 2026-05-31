// Devin session manager — extracted from menu.js for reuse in the :8200
// dashboard. Pure data: dir scanning + parseSessionDir + checkQuota via Playwright.
// Sources combined (deduped by orgName, ✅ wins over ❌):
//   manual_sessions/  · ready_to_sell/  · errors/

const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const MANUAL_DIR   = path.join(PROJECT_ROOT, 'manual_sessions');
const READY_DIR    = path.join(PROJECT_ROOT, 'ready_to_sell');
const ERRORS_DIR   = path.join(PROJECT_ROOT, 'errors');

// FreeModel sessions live in manual_sessions/ too — skip them here so the
// Devin section doesn't shadow the FreeModel section in the dashboard.
function isFreemodelSession(itemPath) {
    try {
        const infoPath = path.join(itemPath, 'session_info.txt');
        if (!fs.existsSync(infoPath)) return false;
        const info = fs.readFileSync(infoPath, 'utf-8');
        return /^URL:.*freemodel\.dev/im.test(info);
    } catch { return false; }
}

function parseSessionDir(item, itemPath, source, defaultStatus) {
    const sessionFile = path.join(itemPath, 'session.json');
    if (!fs.existsSync(sessionFile)) return null;

    const s = {
        name: item, path: itemPath, source,
        orgName: 'Неизвестно', email: 'Неизвестно',
        date: 'Неизвестно', status: defaultStatus,
    };

    const userMatch = item.match(/user-([a-z0-9]+)/);
    const orgMatch  = item.match(/org-([a-f0-9]+)/);
    if (userMatch) s.orgName = `user-${userMatch[1]}`;
    if (orgMatch)  s.orgName = `org-${orgMatch[1]}`;

    const dtFull  = item.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    const dtShort = item.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})[^-\d]/);
    const dtOld   = item.match(/(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})/);
    const dtSpace = item.match(/(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})/);
    const dtOnly  = item.match(/(\d{4}-\d{2}-\d{2})/);

    if (dtFull)       s.date = `${dtFull[1]} ${dtFull[2]}:${dtFull[3]}`;
    else if (dtShort) s.date = `${dtShort[1]} ${dtShort[2]}:${dtShort[3]}`;
    else if (dtOld)   s.date = `${dtOld[1]} ${dtOld[2]}:${dtOld[3]}`;
    else if (dtSpace) s.date = `${dtSpace[1]} ${dtSpace[2]}:${dtSpace[3]}`;
    else if (dtOnly)  s.date = dtOnly[1];

    const infoFile = path.join(itemPath, 'session_info.txt');
    if (fs.existsSync(infoFile)) {
        try {
            for (const line of fs.readFileSync(infoFile, 'utf-8').split('\n')) {
                const after = (l) => l.slice(l.indexOf(':') + 1).trim();
                if (line.startsWith('Email:'))   s.email   = after(line) || s.email;
                if (line.startsWith('Org:'))     s.orgName = after(line) || s.orgName;
                if (line.startsWith('Статус:'))  s.status  = after(line) || s.status;
            }
        } catch {}
    }

    const instrFile = path.join(itemPath, 'Инструкция_входа.txt');
    if (fs.existsSync(instrFile)) {
        try {
            for (const line of fs.readFileSync(instrFile, 'utf-8').split('\n')) {
                if (line.trim().startsWith('Email:')) {
                    s.email = line.slice(line.indexOf(':') + 1).trim() || s.email;
                }
            }
        } catch {}
    }

    if (item.includes('success') || item.includes('Pro'))           s.status = '✅';
    else if (item.includes('error') || item.includes('Error'))      s.status = '❌';

    return s;
}

function getDevinSessions() {
    const sessions = [];
    const seenOrg  = new Map();

    const addSession = (item, itemPath, source, defaultStatus) => {
        try {
            if (!fs.statSync(itemPath).isDirectory()) return;
        } catch { return; }
        if (isFreemodelSession(itemPath)) return;
        const s = parseSessionDir(item, itemPath, source, defaultStatus);
        if (!s) return;
        const existing = seenOrg.get(s.orgName);
        if (existing !== undefined) {
            if (s.status === '✅' && sessions[existing].status === '❌') {
                sessions[existing] = s;
            }
            return;
        }
        seenOrg.set(s.orgName, sessions.length);
        sessions.push(s);
    };

    if (fs.existsSync(MANUAL_DIR)) {
        for (const item of fs.readdirSync(MANUAL_DIR)) {
            addSession(item, path.join(MANUAL_DIR, item), 'manual', '✅');
        }
    }
    if (fs.existsSync(READY_DIR)) {
        for (const item of fs.readdirSync(READY_DIR)) {
            addSession(item, path.join(READY_DIR, item), 'ready', '✅');
        }
    }
    if (fs.existsSync(ERRORS_DIR)) {
        for (const item of fs.readdirSync(ERRORS_DIR)) {
            addSession(item, path.join(ERRORS_DIR, item), 'errors', '❌');
        }
    }

    return sessions.sort((a, b) =>
        (b.date || '').localeCompare(a.date || '') || b.name.localeCompare(a.name));
}

// Headless Playwright: open /settings/usage, parse plan + Daily/Weekly quota.
async function checkDevinQuota(session) {
    let browser = null;
    try {
        const sessionFile = path.join(session.path, 'session.json');
        if (!fs.existsSync(sessionFile)) return null;
        if (!session.orgName || session.orgName === 'Неизвестно') return null;

        const { chromium } = require('playwright');
        const usageUrl = `https://app.devin.ai/org/${session.orgName}/settings/usage`;

        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ storageState: sessionFile });
        const page = await context.newPage();
        await page.goto(usageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

        await page.waitForFunction(
            () => {
                const t = document.body?.innerText || '';
                return (t.includes('Daily quota') || t.includes('Weekly quota')) && t.includes('Current plan');
            },
            { timeout: 12000 }
        ).catch(() => {});
        await page.waitForTimeout(300);

        const data = await page.evaluate(() => {
            const result = {};
            const text = document.body?.innerText || '';
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
            let plan = 'free';
            for (let i = 0; i < lines.length - 1; i++) {
                if (lines[i] === 'Current plan' || lines[i].includes('Current plan')) {
                    const next = lines[i + 1].toLowerCase();
                    if (next === 'pro' || next.startsWith('pro') ||
                        next === 'teams' || next.startsWith('teams')) { plan = 'paid'; break; }
                    if (next === 'free' || next.startsWith('free')) { plan = 'free'; break; }
                }
            }
            if (plan === 'free' && text.includes('Trial'))         plan = 'paid';
            if (plan === 'free' && text.includes('Manage billing')) plan = 'paid';
            result.plan = plan;

            for (const el of document.querySelectorAll('*')) {
                const t = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
                    ? el.textContent.trim() : '';
                if (t === 'Daily quota' || t === 'Weekly quota') {
                    const parts = el.parentElement?.parentElement?.innerText
                        ?.split('\n').map(s => s.trim()).filter(Boolean) || [];
                    result[t] = { used: parts[1] || '?', resets: parts[2] || '' };
                }
            }
            return result;
        });

        await browser.close();
        browser = null;

        const daily  = data['Daily quota'];
        const weekly = data['Weekly quota'];
        if (!daily && !weekly) return null;

        return {
            daily:    daily  ? daily.used  : '?',
            weekly:   weekly ? weekly.used : '?',
            resetsIn: daily?.resets || '',
            plan:     data.plan || 'free',
        };
    } catch {
        return null;
    } finally {
        if (browser) { try { await browser.close(); } catch {} }
    }
}

module.exports = { getDevinSessions, checkDevinQuota };
