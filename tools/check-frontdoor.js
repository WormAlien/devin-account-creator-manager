#!/usr/bin/env node
/**
 * check-frontdoor.js — регресс-тест чокпоинта front-door.
 *
 * Зачем файл существует: front-door — единая точка отказа. Лёг :20100 или
 * соврал active-backend.json — лёг Claude Code целиком. При этом всё правило
 * живёт в ОДНОМ месте (writeSettings → applyFrontdoor в transparent-proxy.js),
 * и проверить его дешевле, чем ловить последствия.
 *
 * Как: поднимает ИЗОЛИРОВАННУЮ копию дашборда — свой USERPROFILE (песочница в
 * %TEMP%), свой порт, свой frontdoor.json — и дёргает POST /api/settings/apply,
 * повторяя формы записи, которые делают реальные обработчики активации.
 * Живой ~/.claude/settings.json и рабочий дашборд :8200 не задеты.
 *
 * Запуск: node tools/check-frontdoor.js     (exit 1 = чокпоинт сломан)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const PROXY = path.join(REPO, 'routing', 'transparent-proxy.js');
const PORT = Number(process.env.CHECK_PORT || 20191);
// Порт front-door для песочницы — НЕ боевой 20100: дашборд-песочница спавнит прокси
// сама (detached), и на боевом порту он бы остался жить с указателем на удалённый
// временный HOME. Свой порт + kill в teardown.
const FD_PORT = Number(process.env.CHECK_FD_PORT || 20192);
const SANDBOX = path.join(os.tmpdir(), 'fd-check-' + process.pid);
const CLAUDE = path.join(SANDBOX, '.claude');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const STATE = path.join(CLAUDE, 'active-backend.json');
const FD_CFG = path.join(SANDBOX, 'frontdoor.json');

const fails = [];
const ok = [];
function check(cond, msg) { (cond ? ok : fails).push(msg); }

const HELPER = (f) => `node -e "process.stdout.write(require('fs').readFileSync(require('os').homedir()+'/.claude/${f}','utf8').trim())"`;

function req(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({
            host: '127.0.0.1', port: PORT, path: urlPath, method,
            headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
            timeout: 15000,
        }, (res) => {
            let b = '';
            res.on('data', c => b += c);
            res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b || '{}') }); } catch { resolve({ status: res.statusCode, json: null, raw: b }); } });
        });
        r.on('error', reject);
        r.on('timeout', () => r.destroy(new Error('timeout')));
        if (data) r.write(data);
        r.end();
    });
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const apply = (patch) => req('POST', '/__switch/api/settings/apply', { settings: patch });

async function main() {
    fs.mkdirSync(CLAUDE, { recursive: true });
    fs.writeFileSync(SETTINGS, JSON.stringify({ model: 'claude-opus-5[1m]', env: {} }, null, 4), 'utf8');
    fs.writeFileSync(FD_CFG, JSON.stringify({ enabled: true, port: FD_PORT }), 'utf8');

    const child = spawn(process.execPath, [PROXY], {
        env: {
            ...process.env,
            USERPROFILE: SANDBOX, HOME: SANDBOX,      // os.homedir() → песочница
            SWITCHER_PORT: String(PORT),
            FRONTDOOR_CONFIG: FD_CFG,
            LOG_FILE: path.join(SANDBOX, 'frontdoor.log'),        // не пишем в боевой лог прокси
            PROXY_LOG_INGEST_URL: 'http://127.0.0.1:1/none',   // не шумим в живой дашборд
            // Порты keepalive (:20133/:20155/:20156/:20157/:20158) захардкожены, своих у
            // песочницы нет, а boot-подъём теперь УБИВАЕТ не отвечающего держателя
            // порта — без этого флага тест мог снести боевой keepalive владельца.
            SWITCHER_NO_BOOT_KEEPALIVE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let boot = '';
    child.stdout.on('data', d => boot += d);
    child.stderr.on('data', d => boot += d);

    try {
        for (let i = 0; i < 40; i++) {                 // ждём listen
            try { await req('GET', '/__switch/api/status'); break; } catch { await new Promise(r => setTimeout(r, 250)); }
        }

        // 1. Helper-режим (conduit): ключ переезжает в состояние, helper исчезает.
        await apply({ apiKeyHelper: HELPER('cdt-active-key.txt'), env: { ANTHROPIC_BASE_URL: 'https://conduit.ozdoev.net/v1', CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '0' } });
        let s = readJson(SETTINGS), st = readJson(STATE);
        check(s.env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${FD_PORT}`, 'helper-режим: base URL переписан на front-door');
        check(s.env.ANTHROPIC_AUTH_TOKEN === 'dummy', 'helper-режим: AUTH_TOKEN = dummy');
        check(!s.apiKeyHelper, 'helper-режим: apiKeyHelper снят');
        check(!s.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS, 'helper-режим: TTL снят');
        check(st && st.backend === 'conduit', `состояние: backend = conduit (было ${st && st.backend})`);
        check(st && st.upstream === 'https://conduit.ozdoev.net/v1', 'состояние: upstream = адрес шлюза как есть');
        check(st && st.keyFile === 'cdt-active-key.txt', 'состояние: ключ из helper-команды');
        check(st && st.modelmap === 'cdt-modelmap.json', 'состояние: карта тиров по префиксу ключа');

        // 2. Повторная запись, когда base уже наш: состояние НЕ трогаем.
        const before = fs.readFileSync(STATE, 'utf8');
        await apply({ model: 'claude-opus-5[1m]' });
        check(fs.readFileSync(STATE, 'utf8') === before, 'запись не про бэкенд не затирает active-backend.json');

        // 3. Локальный апстрим (gorouter keepalive): ключ front-door НЕ инжектит.
        await apply({ env: { ANTHROPIC_BASE_URL: 'http://localhost:20156', ANTHROPIC_AUTH_TOKEN: 'dummy' } });
        st = readJson(STATE);
        check(st && st.backend === 'gorouter', `локальный: backend = gorouter (было ${st && st.backend})`);
        check(st && st.upstream === 'http://localhost:20156', 'локальный: upstream = порт keepalive');
        check(st && st.keyFile === null, 'локальный: keyFile null — ключ ставит keepalive');

        // 3b. Пятый шлюз (:20158, JustWoker). Детект локального апстрима идёт по таблице
        //     BACKENDS, поэтому забытая там запись даёт не ошибку, а `backend: unknown` —
        //     front-door принимает запрос и не знает, куда его вести: 502 на каждый вызов CC.
        await apply({ env: { ANTHROPIC_BASE_URL: 'http://localhost:20158', ANTHROPIC_AUTH_TOKEN: 'dummy' } });
        st = readJson(STATE);
        check(st && st.backend === 'justwoker', `локальный :20158: backend = justwoker (было ${st && st.backend})`);
        check(st && st.upstream === 'http://localhost:20158', 'локальный :20158: upstream = порт keepalive JustWoker');
        check(st && st.keyFile === null, 'локальный :20158: keyFile null — ключ инжектит keepalive из justwoker-active-key.txt');

        // 4. Удалённый шлюз с ключом литералом (freemodel_rotator): литерал уходит в файл.
        await apply({ apiKeyHelper: null, env: { ANTHROPIC_BASE_URL: 'https://cc.freemodel.dev', ANTHROPIC_API_KEY: 'sk-test-literal-key' } });
        st = readJson(STATE);
        s = readJson(SETTINGS);
        check(st && st.keyFile === 'fd-active-key.txt', `литерал: ключ переехал в файл (keyFile=${st && st.keyFile})`);
        check(fs.readFileSync(path.join(CLAUDE, 'fd-active-key.txt'), 'utf8') === 'sk-test-literal-key', 'литерал: файл содержит ключ');
        check(!s.env.ANTHROPIC_API_KEY, 'литерал: ANTHROPIC_API_KEY из settings.json убран');

        // 5. Официальный Claude (OAuth): не вмешиваемся вообще.
        const stBefore = fs.readFileSync(STATE, 'utf8');
        await apply({ env: { ANTHROPIC_BASE_URL: null, ANTHROPIC_AUTH_TOKEN: null, ANTHROPIC_API_KEY: null } });
        s = readJson(SETTINGS);
        check(!s.env.ANTHROPIC_BASE_URL, 'official: base URL остался пустым (front-door не навязывается)');
        check(fs.readFileSync(STATE, 'utf8') === stBefore, 'official: состояние не перезаписано');

        // 6. Детект режима: currentTarget читает состояние, пока base смотрит в :20100.
        await apply({ env: { ANTHROPIC_BASE_URL: 'http://localhost:20155', ANTHROPIC_AUTH_TOKEN: 'dummy' } });
        const status = await req('GET', '/__switch/api/status');
        check(status.json && status.json.current === 'tabi', `currentTarget по состоянию = tabi (было ${status.json && status.json.current})`);

        // 7. Инвариант [1m] не пострадал (writeSettings делает и то, и другое).
        check(readJson(SETTINGS).model === 'claude-opus-5[1m]', 'модель с суффиксом [1m] на месте');

        // 8. Выключённый тумблер = поведение как раньше.
        fs.writeFileSync(FD_CFG, JSON.stringify({ enabled: false, port: FD_PORT }), 'utf8');
        await new Promise(r => setTimeout(r, 50));
        await apply({ env: { ANTHROPIC_BASE_URL: 'http://localhost:20157', ANTHROPIC_AUTH_TOKEN: 'dummy' } });
        s = readJson(SETTINGS);
        check(s.env.ANTHROPIC_BASE_URL === 'http://localhost:20157', 'тумблер off: base URL пишется по-старому');
        const st8 = await req('GET', '/__switch/api/status');
        check(st8.json && st8.json.current === 'xpeach', `тумблер off: детект по settings.json (было ${st8.json && st8.json.current})`);
    } finally {
        try { child.kill(); } catch {}
        // Дашборд-песочница спавнит front-door detached — прибиваем, иначе он
        // останется жить с HOME на удалённой временной папке.
        try {
            const cp = require('child_process');
            const out = cp.execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
            const re = new RegExp(`:${FD_PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'g');
            let m;
            while ((m = re.exec(out))) {
                try { cp.execFileSync('taskkill', ['/F', '/PID', m[1]]); } catch {}
            }
        } catch {}
        try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
    }

    if (!ok.length && !fails.length) fails.push(`дашборд-песочница не поднялась на :${PORT}`);
    for (const m of ok) console.log(`  ok   ${m}`);
    for (const m of fails) console.log(`  FAIL ${m}`);
    console.log(fails.length ? `\ncheck-frontdoor: ${fails.length} провал(ов) из ${ok.length + fails.length}` : `\ncheck-frontdoor OK (${ok.length} проверок)`);
    process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error('check-frontdoor упал:', e.message); process.exit(1); });
