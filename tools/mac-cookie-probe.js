#!/usr/bin/env node
// Диагностика: почему на macOS точный баланс (self) деградирует в «~ прикидку».
//
// v3 — перебор МАТРИЦЫ схем. Предыдущие прогоны на живом маке (Chrome for Testing
// 148, Intel) показали: БД лежит в Default/Cookies, префикс значений 'v10', но
// стандартная macOS-схема (Keychain «Chromium/Chrome Safe Storage» + PBKDF2-SHA1
// 1003 + AES-128-CBC) НЕ расшифровывает. Значит либо пароль из другой Keychain-
// записи (у Chrome for Testing своя), либо это mock-keychain с константой, либо
// вовсе Linux-схема (1 итерация), либо шифр другой.
//
// Поэтому здесь: пароли × итерации × шифры, плюс печать формы данных — по
// кратности длины 16 сразу видно, CBC это вообще или нет.
//
// Значения куки НЕ печатаются: только длины, флаги и вердикт.
// Запуск:  node tools/mac-cookie-probe.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// Третий элемент — по какому куску имени искать куки в БД профиля. По умолчанию это
// первая метка хоста, но у JustWoker она `api` (панель и API на `api.justwoker.icu`):
// фильтр по ней притянул бы куки любого домена со словом «api». Голый `justwoker.icu`
// в первую колонку писать нельзя — он не резолвится.
const POOLS = [
    ['agentrouter.org', 'agentrouter/profiles'],
    ['gorouter.app', 'gorouter/profiles'],
    ['tabitoken.com', 'tabi/profiles'],
    ['xpeach.codes', 'xpeach/profiles'],
    ['api.justwoker.icu', 'justwoker/profiles', 'justwoker'],
    ['github.com', 'github/profiles'],
];
const COOKIE_RELS = [['Default', 'Network', 'Cookies'], ['Default', 'Cookies']];

const b = s => `\x1b[1m${s}\x1b[0m`;
const ok = s => console.log(`\x1b[32m  + ${s}\x1b[0m`);
const no = s => console.log(`\x1b[31m  - ${s}\x1b[0m`);
const dim = s => console.log(`\x1b[90m    ${s}\x1b[0m`);

console.log(b('\n== mac-cookie-probe v3 =='));
console.log(`platform: ${process.platform} · arch: ${process.arch}\n`);

let Database = null;
try { Database = require('better-sqlite3'); ok('better-sqlite3 загрузился'); }
catch (e) { no(`better-sqlite3 не загрузился: ${e.message}`); process.exit(1); }

// ── пароли ──
// Keychain-записи ищем БЕЗ -a: account у Chrome for Testing отличается от имени
// сервиса, и фильтр по нему давал «нет записи» там, где она есть.
const KEYCHAIN_SERVICES = [
    'Chrome for Testing Safe Storage',
    'Chromium Safe Storage',
    'Chrome Safe Storage',
    'Chrome Canary Safe Storage',
];
const passwords = [
    { label: "'peanuts' (mock/Linux)", pw: 'peanuts' },
    { label: "'mock_password' (--use-mock-keychain)", pw: 'mock_password' },
    { label: 'пустой', pw: '' },
];
let keychainAsked = false;
function addKeychainPasswords() {
    if (keychainAsked) return;
    keychainAsked = true;
    console.log('\n  спрашиваю Keychain (может быть окно пароля — жми «Разрешить всегда»)');
    for (const svc of KEYCHAIN_SERVICES) {
        try {
            const pw = execFileSync('security', ['find-generic-password', '-w', '-s', svc], {
                encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            if (pw) { passwords.push({ label: `Keychain «${svc}»`, pw }); ok(`Keychain: «${svc}» (${pw.length} симв.)`); }
        } catch { dim(`Keychain: «${svc}» нет`); }
    }
}

// ── схемы: (итерации, длина ключа, шифр) ──
const SCHEMES = [
    { label: 'PBKDF2×1003 · aes-128-cbc', iter: 1003, len: 16, mode: 'cbc' },
    { label: 'PBKDF2×1 · aes-128-cbc (Linux)', iter: 1, len: 16, mode: 'cbc' },
    { label: 'PBKDF2×1003 · aes-256-cbc', iter: 1003, len: 32, mode: 'cbc' },
    { label: 'PBKDF2×1003 · aes-256-gcm', iter: 1003, len: 32, mode: 'gcm' },
];
const IV16 = Buffer.alloc(16, 0x20);
const keyCache = new Map();
function derive(pw, iter, len) {
    const k = `${pw}|${iter}|${len}`;
    if (!keyCache.has(k)) keyCache.set(k, crypto.pbkdf2Sync(String(pw), 'saltysalt', iter, len, 'sha1'));
    return keyCache.get(k);
}

function plausible(buf) {
    let out = buf;
    if (out.length > 32 && /[\x00-\x08\x0e-\x1f]/.test(out.toString('latin1').slice(0, 32))) out = out.slice(32);
    const s = out.toString('utf8');
    return (/^[\x20-\x7e]+$/.test(s) && s.length >= 1) ? s : null;
}

function tryDecrypt(enc, pw, scheme) {
    try {
        const key = derive(pw, scheme.iter, scheme.len);
        if (scheme.mode === 'cbc') {
            const body = enc.slice(3);
            if (body.length % 16 !== 0 || !body.length) return null;
            const d = crypto.createDecipheriv(`aes-${scheme.len * 8}-cbc`, key, IV16);
            d.setAutoPadding(false);
            let out = Buffer.concat([d.update(body), d.final()]);
            const pad = out[out.length - 1];
            if (pad >= 1 && pad <= 16 && pad <= out.length) out = out.slice(0, out.length - pad);
            return plausible(out);
        }
        if (enc.length < 3 + 12 + 16) return null;
        const d = crypto.createDecipheriv('aes-256-gcm', key, enc.slice(3, 15));
        d.setAuthTag(enc.slice(enc.length - 16));
        return plausible(Buffer.concat([d.update(enc.slice(15, enc.length - 16)), d.final()]));
    } catch { return null; }
}

// ── сбор образцов ──
const samples = [];   // { profile, host, name, enc }
for (const [host, rel, tokenArg] of POOLS) {
    const base = path.join(ROOT, rel);
    let dirs = [];
    try { dirs = fs.readdirSync(base).filter(d => fs.statSync(path.join(base, d)).isDirectory()); } catch { continue; }
    for (const d of dirs) {
        const dir = path.join(base, d);
        let src = null;
        for (const r of COOKIE_RELS) { const p = path.join(dir, ...r); if (fs.existsSync(p)) { src = p; break; } }
        if (!src) continue;
        const tmp = path.join(os.tmpdir(), `probe_${process.pid}_${d}.db`);
        const copied = [tmp];
        try {
            fs.copyFileSync(src, tmp);
            for (const suf of ['-wal', '-shm']) {
                if (fs.existsSync(src + suf)) { fs.copyFileSync(src + suf, tmp + suf); copied.push(tmp + suf); }
            }
            const db = new Database(tmp, { readonly: true });
            let rows;
            try { rows = db.prepare('SELECT host_key, name, encrypted_value FROM cookies LIMIT 60').all(); }
            finally { db.close(); }
            const key = tokenArg || host.split('.')[0];
            for (const r of rows) {
                const enc = Buffer.isBuffer(r.encrypted_value) ? r.encrypted_value : Buffer.from(r.encrypted_value || '');
                if (enc.length > 3 && new RegExp(key, 'i').test(String(r.host_key || ''))) {
                    samples.push({ profile: d, host, name: r.name, enc });
                }
            }
        } catch {} finally { for (const f of copied) { try { fs.unlinkSync(f); } catch {} } }
    }
}

if (!samples.length) { no('образцов куки не нашлось — открой ЛК (🌐), войди, закрой браузер и повтори'); process.exit(0); }

// ── форма данных: она одна уже отвечает, CBC это или нет ──
console.log(b(`\nформа данных (образцов: ${samples.length})`));
const shape = new Map();
for (const s of samples) {
    const tag = s.enc.slice(0, 3).toString('latin1');
    const body = s.enc.length - 3;
    const k = `'${tag}' · len-3=${body} · %16=${body % 16}`;
    shape.set(k, (shape.get(k) || 0) + 1);
}
for (const [k, v] of [...shape].slice(0, 12)) dim(`${k}  ×${v}`);
const allDiv16 = samples.every(s => (s.enc.length - 3) % 16 === 0);
console.log(allDiv16
    ? '  → длины кратны 16: это блочный CBC, дело в пароле/итерациях'
    : '  → длины НЕ кратны 16: это не CBC (значит поточный/GCM или app-bound)');

// ── перебор ──
console.log(b('\nперебор схем'));
const winner = [];
for (const pass of [() => null, addKeychainPasswords]) {
    pass();
    for (const p of passwords) {
        for (const sc of SCHEMES) {
            const hits = samples.filter(s => tryDecrypt(s.enc, p.pw, sc));
            if (hits.length) {
                winner.push({ pw: p.label, scheme: sc.label, hits: hits.length, names: [...new Set(hits.map(h => h.name))].slice(0, 5) });
            }
        }
    }
    if (winner.length) break;
}

console.log(b('\n== вердикт =='));
if (winner.length) {
    for (const w of winner) ok(`${w.pw} + ${w.scheme} → ${w.hits}/${samples.length} куки (${w.names.join(',')})`);
    console.log('\nПришли эту строку — впишу схему в lib/newapi-account.js.');
} else {
    no(`ни одна из ${passwords.length}×${SCHEMES.length} комбинаций не подошла`);
    console.log('  Пришли вывод целиком — включая блок «форма данных».');
    console.log('  Если длины НЕ кратны 16 — это app-bound шифрование, куки с диска не читаются');
    console.log('  в принципе, и точный баланс на маке придётся брать иначе (через браузер).');
}
console.log('');
