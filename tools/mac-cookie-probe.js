#!/usr/bin/env node
// Диагностика: почему на macOS точный баланс (self) деградирует в «~ прикидку».
//
// Точный баланс берётся куками профиля Chromium (lib/newapi-account.js →
// accountSelf), а расшифровка куки в этом коде Windows-специфична:
//   ключ    — Local State: os_crypt.encrypted_key → PowerShell + DPAPI Unprotect
//   значение— AES-256-GCM, 'v10' + 12б nonce + ct + 16б tag
// На macOS ключа в Local State нет вообще (он в Keychain), шифр другой
// (AES-128-CBC, IV = 16 пробелов), а powershell отсутствует → ключ null →
// selfError → фолбэк в guess.
//
// Пробник НЕ печатает значения куки — только имена, длины и вердикт.
// Запуск:  node tools/mac-cookie-probe.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const POOLS = [
    ['agentrouter.org', 'agentrouter/profiles'],
    ['gorouter.app', 'gorouter/profiles'],
    ['tabitoken.com', 'tabi/profiles'],
    ['xpeach.codes', 'xpeach/profiles'],
    ['github.com', 'github/profiles'],
];

const b = s => `\x1b[1m${s}\x1b[0m`;
const ok = s => console.log(`\x1b[32m  + ${s}\x1b[0m`);
const no = s => console.log(`\x1b[31m  - ${s}\x1b[0m`);
const dim = s => console.log(`\x1b[90m    ${s}\x1b[0m`);

console.log(b('\n== mac-cookie-probe =='));
console.log(`platform: ${process.platform} · arch: ${process.arch}\n`);

// ── 1. better-sqlite3 (им читается БД Cookies) ──
let Database = null;
try { Database = require('better-sqlite3'); ok('better-sqlite3 загрузился'); }
catch (e) { no(`better-sqlite3 не загрузился: ${e.message}`); }

// ── 2. Keychain: пароль, из которого Chromium выводит AES-ключ ──
// Playwright обычно стартует Chromium с --use-mock-keychain, и тогда пароль
// не из Keychain, а константа 'peanuts'. Проверяем оба варианта.
const passwords = [];
for (const svc of ['Chromium Safe Storage', 'Chrome Safe Storage']) {
    try {
        const pw = execFileSync('security', ['find-generic-password', '-w', '-s', svc, '-a', svc.split(' ')[0]], {
            encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (pw) { passwords.push({ label: `Keychain «${svc}»`, pw }); ok(`Keychain: «${svc}» найден (${pw.length} симв.)`); }
    } catch { dim(`Keychain: «${svc}» нет`); }
}
passwords.push({ label: "mock keychain ('peanuts')", pw: 'peanuts' });
passwords.push({ label: 'пустой пароль', pw: '' });

// ── 3. Кандидаты ключей: PBKDF2-SHA1(pw, 'saltysalt', 1003, 16) — схема macOS ──
const keys = passwords.map(p => ({
    label: p.label,
    key: crypto.pbkdf2Sync(p.pw, 'saltysalt', 1003, 16, 'sha1'),
}));

// AES-128-CBC, IV = 16 пробелов. На свежих сборках плейнтекст префиксован
// 32 байтами SHA-256(host_key) — срезаем, если начало не текст.
function decryptCbc(enc, key) {
    try {
        const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
        d.setAutoPadding(false);
        let out = Buffer.concat([d.update(enc.slice(3)), d.final()]);
        const pad = out[out.length - 1];
        if (pad >= 1 && pad <= 16) out = out.slice(0, out.length - pad);
        if (out.length > 32 && /[\x00-\x08\x0e-\x1f]/.test(out.toString('latin1').slice(0, 32))) out = out.slice(32);
        const s = out.toString('utf8');
        return /^[\x20-\x7e]+$/.test(s) && s.length ? s : null;
    } catch { return null; }
}

// ── 4. Профили ──
let profiles = 0, dbs = 0, rows = 0, cracked = 0;
const winners = new Map();
const prefixes = new Map();

for (const [host, rel] of POOLS) {
    const base = path.join(ROOT, rel);
    let dirs = [];
    try { dirs = fs.readdirSync(base).filter(d => fs.statSync(path.join(base, d)).isDirectory()); } catch { continue; }
    if (!dirs.length) continue;
    console.log(b(`\n${host}  (${rel}, профилей: ${dirs.length})`));

    for (const d of dirs) {
        profiles++;
        const dir = path.join(base, d);
        const ls = path.join(dir, 'Local State');
        let hasEncKey = false;
        try {
            const j = JSON.parse(fs.readFileSync(ls, 'utf8'));
            hasEncKey = !!(j.os_crypt && j.os_crypt.encrypted_key);
        } catch {}
        const cookies = path.join(dir, 'Default', 'Network', 'Cookies');
        if (!fs.existsSync(cookies)) { no(`${d}: БД Cookies нет`); continue; }
        dbs++;
        if (!Database) continue;

        // Копия: живую БД профиля трогать нельзя (может быть залочена браузером).
        const tmp = path.join(require('os').tmpdir(), `probe_${process.pid}_${d}.db`);
        try { fs.copyFileSync(cookies, tmp); } catch (e) { no(`${d}: не скопировать БД: ${e.message}`); continue; }
        try {
            const db = new Database(tmp, { readonly: true });
            const q = db.prepare("SELECT host_key, name, encrypted_value FROM cookies WHERE host_key LIKE ? LIMIT 8");
            const got = q.all(`%${host.split('.')[0]}%`);
            db.close();
            if (!got.length) { dim(`${d}: куки для ${host} в БД нет (encrypted_key в Local State: ${hasEncKey})`); continue; }

            let localOk = 0, tag = '?';
            for (const r of got) {
                rows++;
                const enc = Buffer.isBuffer(r.encrypted_value) ? r.encrypted_value : Buffer.from(r.encrypted_value || '');
                if (enc.length < 4) continue;
                tag = enc.slice(0, 3).toString('latin1');
                prefixes.set(tag, (prefixes.get(tag) || 0) + 1);
                for (const k of keys) {
                    if (decryptCbc(enc, k.key)) {
                        localOk++; cracked++;
                        winners.set(k.label, (winners.get(k.label) || 0) + 1);
                        break;
                    }
                }
            }
            if (localOk) ok(`${d}: префикс '${tag}', расшифровано ${localOk}/${got.length} куки`);
            else no(`${d}: префикс '${tag}', НИ ОДНА из ${got.length} куки не поддалась (encrypted_key: ${hasEncKey})`);
        } catch (e) { no(`${d}: чтение БД упало: ${e.message}`); }
        finally { try { fs.unlinkSync(tmp); } catch {} }
    }
}

// ── 5. Вердикт ──
console.log(b('\n== вердикт =='));
console.log(`профилей: ${profiles} · с БД Cookies: ${dbs} · записей проверено: ${rows} · расшифровано: ${cracked}`);
if (prefixes.size) console.log(`префиксы значений: ${[...prefixes].map(([k, v]) => `'${k}'×${v}`).join(', ')}`);
if (winners.size) {
    for (const [label, n] of winners) ok(`сработало: ${label} → AES-128-CBC (${n} куки)`);
    console.log('\nЗначит фикс — ветка darwin в lib/newapi-account.js:');
    console.log("  profileAesKey → PBKDF2-SHA1(пароль, 'saltysalt', 1003, 16)");
    console.log('  decryptCookieValue → aes-128-cbc, IV = 16 пробелов, PKCS#7');
} else if (rows) {
    no('ни один кандидат не подошёл — пришли этот вывод целиком, схема нестандартная');
} else {
    no('куки не нашлись: ни один ЛК на этом маке ещё не открывали (кнопка 🌐) либо профили пустые');
}
console.log('');
