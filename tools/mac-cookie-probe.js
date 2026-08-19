#!/usr/bin/env node
// Диагностика: почему на macOS точный баланс (self) деградирует в «~ прикидку».
//
// Точный баланс берётся куками профиля Chromium (lib/newapi-account.js →
// accountSelf). На Windows ключ лежит в Local State под DPAPI, значение —
// AES-256-GCM. На macOS: пароль в Keychain (или константа 'peanuts', если
// Chromium запущен с --use-mock-keychain, как делает Playwright) →
// PBKDF2-SHA1('saltysalt', 1003, 16) → 'v10' + AES-128-CBC, IV = 16 пробелов.
//
// Keychain дёргаем ТОЛЬКО если mock-пароль не подошёл: `security` поднимает
// системный диалог ввода пароля на каждый процесс.
//
// Пробник НЕ печатает значения куки — только имена, длины и вердикт.
// Запуск:  node tools/mac-cookie-probe.js
'use strict';
const fs = require('fs');
const os = require('os');
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
const COOKIE_RELS = [['Default', 'Network', 'Cookies'], ['Default', 'Cookies']];

const b = s => `\x1b[1m${s}\x1b[0m`;
const ok = s => console.log(`\x1b[32m  + ${s}\x1b[0m`);
const no = s => console.log(`\x1b[31m  - ${s}\x1b[0m`);
const dim = s => console.log(`\x1b[90m    ${s}\x1b[0m`);

console.log(b('\n== mac-cookie-probe =='));
console.log(`platform: ${process.platform} · arch: ${process.arch}\n`);

let Database = null;
try { Database = require('better-sqlite3'); ok('better-sqlite3 загрузился'); }
catch (e) { no(`better-sqlite3 не загрузился: ${e.message}`); }

const kf = pw => crypto.pbkdf2Sync(String(pw), 'saltysalt', 1003, 16, 'sha1');
const MAC_IV = Buffer.alloc(16, 0x20);

// Дешёвые кандидаты — без диалога пароля.
const cheap = [
    { label: "mock keychain ('peanuts')", key: kf('peanuts') },
    { label: 'пустой пароль', key: kf('') },
];
let keychain = null;
function keychainCandidates() {
    if (keychain) return keychain;
    keychain = [];
    console.log('\n  (mock-пароль не подошёл — спрашиваю Keychain, будет диалог пароля;');
    console.log('   в нём жми «Разрешить всегда», чтобы больше не спрашивал)');
    for (const svc of ['Chromium Safe Storage', 'Chrome Safe Storage']) {
        try {
            const pw = execFileSync('security', ['find-generic-password', '-w', '-s', svc, '-a', svc.split(' ')[0]], {
                encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            if (pw) { keychain.push({ label: `Keychain «${svc}»`, key: kf(pw) }); ok(`Keychain: «${svc}» (${pw.length} симв.)`); }
        } catch { dim(`Keychain: «${svc}» нет`); }
    }
    return keychain;
}

function decryptCbc(enc, key) {
    try {
        if (!Buffer.isBuffer(enc) || enc.length < 19) return null;
        if (enc.slice(0, 3).toString('latin1') !== 'v10') return null;
        const d = crypto.createDecipheriv('aes-128-cbc', key, MAC_IV);
        d.setAutoPadding(false);
        let out = Buffer.concat([d.update(enc.slice(3)), d.final()]);
        const pad = out[out.length - 1];
        if (pad >= 1 && pad <= 16 && pad <= out.length) out = out.slice(0, out.length - pad);
        if (out.length > 32 && /[\x00-\x08\x0e-\x1f]/.test(out.toString('latin1').slice(0, 32))) out = out.slice(32);
        const s = out.toString('utf8');
        return /^[\x20-\x7e]*$/.test(s) && s.length ? s : null;
    } catch { return null; }
}

// Рекурсивный поиск чего угодно похожего на БД куки — на случай иного layout'а.
function findCookieish(dir, depth = 0, acc = []) {
    if (depth > 3 || acc.length >= 8) return acc;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) findCookieish(p, depth + 1, acc);
        else if (/ookie/i.test(e.name)) acc.push(p);
        if (acc.length >= 8) break;
    }
    return acc;
}

let profiles = 0, dbs = 0, rows = 0, cracked = 0;
const winners = new Map(), prefixes = new Map();

for (const [host, rel] of POOLS) {
    const base = path.join(ROOT, rel);
    let dirs = [];
    try { dirs = fs.readdirSync(base).filter(d => fs.statSync(path.join(base, d)).isDirectory()); } catch { continue; }
    if (!dirs.length) continue;
    console.log(b(`\n${host}  (${rel}, профилей: ${dirs.length})`));

    for (const d of dirs) {
        profiles++;
        const dir = path.join(base, d);
        let src = null;
        for (const r of COOKIE_RELS) {
            const p = path.join(dir, ...r);
            if (fs.existsSync(p)) { src = p; break; }
        }
        if (!src) {
            no(`${d}: БД куки нет ни в Default/Network/Cookies, ни в Default/Cookies`);
            // Что вообще лежит в профиле — так видно, дошёл ли браузер до записи данных.
            const def = path.join(dir, 'Default');
            let names = [];
            try { names = fs.readdirSync(def).slice(0, 24); } catch {}
            dim(names.length ? `Default (${names.length}+): ${names.join(', ')}` : 'папки Default нет вообще');
            const found = findCookieish(dir);
            if (found.length) dim(`похожее на куки: ${found.map(f => path.relative(dir, f)).join(' · ')}`);
            continue;
        }
        dbs++;
        if (!Database) continue;
        dim(`${d}: БД → ${path.relative(dir, src)}`);

        const tmp = path.join(os.tmpdir(), `probe_${process.pid}_${d}.db`);
        const copied = [tmp];
        try {
            fs.copyFileSync(src, tmp);
            for (const suf of ['-wal', '-shm']) {
                if (fs.existsSync(src + suf)) { fs.copyFileSync(src + suf, tmp + suf); copied.push(tmp + suf); }
            }
        } catch (e) { no(`${d}: не скопировать БД: ${e.message}`); continue; }
        try {
            const db = new Database(tmp, { readonly: true });
            let got;
            try {
                got = db.prepare('SELECT host_key, name, encrypted_value FROM cookies LIMIT 40').all();
            } finally { db.close(); }
            const mine = got.filter(r => new RegExp(host.split('.')[0], 'i').test(String(r.host_key || '')));
            if (!got.length) { no(`${d}: БД есть, но пустая (0 записей)`); continue; }

            let localOk = 0, tag = '?';
            const sample = (mine.length ? mine : got).slice(0, 10);
            for (const r of sample) {
                rows++;
                const enc = Buffer.isBuffer(r.encrypted_value) ? r.encrypted_value : Buffer.from(r.encrypted_value || '');
                if (enc.length < 4) continue;
                tag = enc.slice(0, 3).toString('latin1');
                prefixes.set(tag, (prefixes.get(tag) || 0) + 1);
                let hit = null;
                for (const c of cheap) if (decryptCbc(enc, c.key)) { hit = c.label; break; }
                if (!hit) for (const c of keychainCandidates()) if (decryptCbc(enc, c.key)) { hit = c.label; break; }
                if (hit) { localOk++; cracked++; winners.set(hit, (winners.get(hit) || 0) + 1); }
            }
            const names = mine.map(r => r.name).slice(0, 6).join(',') || '—';
            if (localOk) ok(`${d}: '${tag}', расшифровано ${localOk}/${sample.length} · записей всего ${got.length}, для ${host}: ${mine.length} (${names})`);
            else no(`${d}: '${tag}', НИ ОДНА из ${sample.length} не поддалась · всего ${got.length}, для ${host}: ${mine.length} (${names})`);
        } catch (e) { no(`${d}: чтение БД упало: ${e.message}`); }
        finally { for (const f of copied) { try { fs.unlinkSync(f); } catch {} } }
    }
}

console.log(b('\n== вердикт =='));
console.log(`профилей: ${profiles} · с БД куки: ${dbs} · записей проверено: ${rows} · расшифровано: ${cracked}`);
if (prefixes.size) console.log(`префиксы значений: ${[...prefixes].map(([k, v]) => `'${k}'×${v}`).join(', ')}`);
if (winners.size) {
    for (const [label, n] of winners) ok(`сработало: ${label} → AES-128-CBC (${n} куки)`);
    console.log('\nЗначит ветка darwin в lib/newapi-account.js рабочая — жми «Проверить баланс».');
} else if (rows) {
    no('ни один кандидат не подошёл — пришли вывод целиком, схема нестандартная');
} else if (dbs) {
    no('БД куки есть, но записей нет — сессия не села на диск');
} else {
    no('БД куки не нашлось ни у одного профиля — смотри строки Default выше');
}
console.log('');
