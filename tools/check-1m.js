#!/usr/bin/env node
/**
 * check-1m.js — регресс-тест инварианта окна 1M.
 *
 * Инвариант одной строкой: после любой операции дашборда settings.model —
 * непустая строка, и если она claude-(opus|sonnet)-*, в ней есть [1m].
 * Без суффикса Claude Code считает окно 200k и режет историю втрое раньше.
 *
 * Почему файл существует: у записи модели в settings.json раньше не было единой
 * точки входа — 24 прямые записи, суффикс дотягивали 4 места. Каждый агент чинил
 * свой путь, симптом возвращался (см. docs/HANDOFF-model-1m.md).
 *
 * Запуск:  node tools/check-1m.js        (exit 1 = инвариант нарушен)
 * Токены не печатаем: из settings.json берём только поле model.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROXY = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
// Единственная разрешённая прямая запись: восстановление сырого текста из бэкапа
// (JSON.stringify его сломает — там строка, а не объект).
const ALLOWED_DIRECT_WRITE = "fs.writeFileSync(SETTINGS_FILE, raw, 'utf8');";

const fails = [];
const warns = [];
const ok = [];

function needsSuffix(m) {
    return /^claude-(opus|sonnet)-/.test(String(m || '')) && !String(m).includes('[');
}

// ---- 1. Живой settings.json -------------------------------------------------
let src = '';
try {
    const raw = fs.readFileSync(SETTINGS, 'utf8');
    const s = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    const m = s.model;
    if (typeof m !== 'string' || !m.trim()) {
        fails.push('settings.json: поля model нет → Claude Code возьмёт свой дефолт, а он без [1m] = 200k');
    } else if (needsSuffix(m)) {
        fails.push(`settings.json: model = "${m}" без [1m] → окно 200k`);
    } else {
        ok.push(`settings.json: model = "${m}"`);
    }
    const em = s.env && s.env.ANTHROPIC_MODEL;
    if (typeof em === 'string' && needsSuffix(em)) {
        fails.push(`settings.json: env.ANTHROPIC_MODEL = "${em}" без [1m] (перебьёт top-level model)`);
    }
} catch (e) {
    warns.push(`settings.json не прочитан (${e.message}) — проверка живого файла пропущена`);
}

// ---- 2. Прямые записи мимо writeSettings() ---------------------------------
try {
    src = fs.readFileSync(PROXY, 'utf8');
} catch (e) {
    fails.push(`не прочитан ${PROXY}: ${e.message}`);
}
if (src) {
    src.split('\n').forEach((line, i) => {
        if (!line.includes('writeFileSync(SETTINGS_FILE')) return;
        if (line.trim() === ALLOWED_DIRECT_WRITE) return;
        fails.push(`transparent-proxy.js:${i + 1}: settings.json пишется напрямую, мимо writeSettings() → суффикс [1m] не дотянется\n    ${line.trim()}`);
    });

    // ---- 3. Чокпоинт на месте ---------------------------------------------
    const ws = src.match(/function writeSettings\(obj\) \{[\s\S]*?\n\}/);
    if (!ws) fails.push('transparent-proxy.js: функция writeSettings(obj) не найдена');
    else {
        if (!/obj\.model\s*=\s*normalizeCcModel\(/.test(ws[0])) {
            fails.push('writeSettings(): нет нормализации obj.model через normalizeCcModel() — чокпоинт разобран');
        }
        if (!/ANTHROPIC_MODEL\s*=\s*normalizeCcModel\(/.test(ws[0])) {
            fails.push('writeSettings(): нет нормализации env.ANTHROPIC_MODEL (cun/conduit пишут его рядом с model)');
        }
    }

    // ---- 4. Сам нормализатор: гоняем боевой код, не копию ------------------
    const fn = src.match(/function normalizeCcModel\(m\) \{[\s\S]*?\n\}/);
    if (!fn) fails.push('transparent-proxy.js: функция normalizeCcModel(m) не найдена');
    else {
        let normalize;
        try {
            normalize = new Function(`${fn[0]}; return normalizeCcModel;`)();
        } catch (e) {
            fails.push(`normalizeCcModel не исполняется: ${e.message}`);
        }
        if (normalize) {
            const cases = [
                ['claude-opus-5', 'claude-opus-5[1m]'],
                ['claude-sonnet-5', 'claude-sonnet-5[1m]'],
                ['claude-opus-5[1m]', 'claude-opus-5[1m]'],   // идемпотентность
                ['claude-opus-4-8[200k]', 'claude-opus-4-8[200k]'],   // чужой суффикс не трогаем
                ['ComboWombo', 'ComboWombo'],                 // виртуальная модель шлюза
                ['opus-4.8', 'opus-4.8'],                     // notion: не claude-*
                ['opus[1m]', 'opus[1m]'],
                ['gpt-5.6-sol', 'gpt-5.6-sol'],               // у gpt своё окно
                ['claude-haiku-4-5', 'claude-haiku-4-5'],     // у haiku 200k штатно
                ['', ''],
                [null, ''],
            ];
            for (const [input, want] of cases) {
                const got = normalize(input);
                if (got !== want) fails.push(`normalizeCcModel(${JSON.stringify(input)}) = ${JSON.stringify(got)}, ожидалось ${JSON.stringify(want)}`);
            }
            if (!fails.length) ok.push(`normalizeCcModel: ${cases.length} кейсов`);
        }
    }
}

// ---- вывод ------------------------------------------------------------------

// ---- 5. Окно для незнакомых CC моделей (gpt-*) ------------------------------
// Инвариант: модель есть в routing/model-windows.json → env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
// равен её окну; модель claude-* → ключа нет вовсе (залипшее значение = переполнение).
if (src) {
    const ws = src.match(/function writeSettings\(obj\) \{[\s\S]*?\n\}/);
    if (ws && !/ccContextTokensFor\(obj\.model\)/.test(ws[0])) {
        fails.push('writeSettings(): нет ccContextTokensFor() — окно gpt-моделей снова не доедет до статуслайна');
    }
    if (ws && !/delete .*CLAUDE_CODE_MAX_CONTEXT_TOKENS/.test(ws[0])) {
        fails.push('writeSettings(): ключ CLAUDE_CODE_MAX_CONTEXT_TOKENS не снимается для claude-* — залипнет и даст переполнение');
    }
    const i = src.indexOf('const MODEL_WINDOWS_FILE');
    const e = src.indexOf('\n}', src.indexOf('function ccContextTokensFor'));
    if (i < 0 || e < 0) fails.push('transparent-proxy.js: блок modelWindows()/ccContextTokensFor() не найден');
    else {
        let ctxFor;
        try {
            ctxFor = new Function('fs', 'path', '__dirname',
                src.slice(i, e + 2) + '; return ccContextTokensFor;',
            )(fs, path, path.join(__dirname, '..', 'routing'));
        } catch (e2) { fails.push(`ccContextTokensFor не исполняется: ${e2.message}`); }
        if (ctxFor) {
            const cases = [
                ['gpt-5.6-sol', 1050000],
                ['claude-opus-5', null],
                ['claude-opus-5[1m]', null],   // claude любой формы — не переопределяем
                ['ComboWombo', null],          // виртуальная модель шлюза
                ['модели-нет-в-таблице', null],
                ['', null],
            ];
            for (const [input, want] of cases) {
                const got = ctxFor(input);
                if (got !== want) fails.push(`ccContextTokensFor(${JSON.stringify(input)}) = ${got}, ожидалось ${want}`);
            }
            ok.push(`ccContextTokensFor: ${cases.length} кейсов`);
        }
        // живой settings.json против таблицы
        try {
            const raw = fs.readFileSync(SETTINGS, 'utf8');
            const s = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            const want = ctxFor ? ctxFor(s.model) : null;
            const got = s.env && s.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
            if (want && String(want) !== String(got || '')) {
                fails.push(`settings.json: model="${s.model}" → окно ${want}, а CLAUDE_CODE_MAX_CONTEXT_TOKENS=${got || '(нет)'}`);
            } else if (!want && got) {
                fails.push(`settings.json: model="${s.model}" не требует override, а CLAUDE_CODE_MAX_CONTEXT_TOKENS=${got} залип`);
            } else if (want) {
                ok.push(`settings.json: окно ${want} заявлено для "${s.model}"`);
            }
        } catch { /* уже предупредили выше */ }
    }
}


for (const s of ok) console.log(`  ok   ${s}`);
for (const s of warns) console.log(`  warn ${s}`);
for (const s of fails) console.log(`  FAIL ${s}`);
if (fails.length) {
    console.log(`\n[X] инвариант 1M нарушен: ${fails.length} проблем(ы). Как чинить — docs/HANDOFF-model-1m.md`);
    process.exit(1);
}
console.log('\n[OK] инвариант 1M держится');
