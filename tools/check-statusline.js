#!/usr/bin/env node
/**
 * check-statusline.js — сторож сегментов статус-бара Claude Code.
 *
 * Почему файл существует. Ночь 31.08 добавила в бар три вещи — уровень
 * `/effort`, имя git-воркtree и цветовые пороги на контекст — и все три пропали
 * из рабочего дерева: правки не были закоммичены, а `git reset --hard` 04.09 их
 * стёр. Восстановлено из транскриптов; чтобы пропажа второй раз не прошла молча,
 * здесь живой прогон бара, а не grep по исходнику.
 *
 * Проверяем не «строка есть в файле», а что скрипт ЧИТАЕТ поле payload и ВЫВОДИТ
 * сегмент: подкладываем настоящий payload Claude Code в stdin и смотрим на
 * собранную строку вместе с escape-последовательностями. Цвета в ожиданиях
 * прописаны цифрами намеренно — они сняты из бандла CC, чтобы бар и слайдер
 * `/effort` говорили одно и то же, и «поправил оттенок на глаз» обязан краснеть.
 *
 * Изоляция: HOME подменяется на пустой профиль с `{}` в settings.json —
 * провайдер тогда `unknown`, шкала баланса не строится, сети и кешей нет.
 * Деньги, 🎁 и 💸 сюда не входят намеренно: они зависят от живого пула, а этот
 * сторож должен быть зелёным на любой машине. Из тех же соображений сравниваются
 * подстроки и разница двух прогонов, а не строка целиком.
 *
 * 🪤 STATUSLINE_PAYLOAD в env обнуляем: он старше stdin по приоритету, и в
 * сессии, запущенной обёрткой из settings.json, тест мерил бы чужой payload.
 *
 * Запуск: node tools/check-statusline.js   (exit 1 = сегмент потерян)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'routing', 'statusline-autoreger.sh').replace(/\\/g, '/');

const ESC = '\u001b';
const RESET = `${ESC}[0m`;
const SEP = `${ESC}[38;5;240m`;
const DIM = `${ESC}[2m`;
// уровень → цвет темы CC: warning / success / permission / autoAccept
const LEVEL = {
    low: `${ESC}[38;2;255;193;7m`,
    medium: `${ESC}[38;2;78;186;101m`,
    high: `${ESC}[38;2;177;185;249m`,
    xhigh: `${ESC}[1;38;2;175;135;255m`,
};
const TEAL = `${ESC}[38;2;72;150;140m`;      // planMode: воркtree
const CTX_WARN = `${ESC}[38;2;255;193;7m`;   // ≥70%
const CTX_ERR = `${ESC}[1;38;2;255;107;128m`; // ≥85%, жирный

let failed = 0;
function ok(cond, msg) {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
    if (!cond) failed++;
}
const show = (s) => JSON.stringify(s).replace(/\\u001b/g, 'ESC');

// ---- изолированный профиль: провайдер unknown, денег нет, сети нет ----------
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-check-'));
fs.mkdirSync(path.join(FAKE, '.claude'));
fs.writeFileSync(path.join(FAKE, '.claude', 'settings.json'), '{}\n');

// Payload ровно той формы, в какой его присылает Claude Code 2.1.220: effort и
// git_worktree — необязательные поля, и вся суть сегментов в том, что их может
// не быть. tokens: null = payload без total_input_tokens (старый CC/шлюз).
function payload({ effort, worktree, tokens = 110000, pct = 11, max = 1000000 } = {}) {
    const cw = { context_window_size: max, used_percentage: pct };
    if (tokens !== null) cw.total_input_tokens = tokens;
    const ws = { current_dir: 'D:\\repo', project_dir: 'D:\\repo', added_dirs: [] };
    if (worktree) ws.git_worktree = worktree;
    const p = {
        model: { id: 'claude-opus-5[1m]', display_name: 'Opus 5 (1M context)' },
        workspace: ws,
        context_window: cw,
        version: '2.1.220',
    };
    if (effort) p.effort = { level: effort };
    return JSON.stringify(p) + '\n';
}

function bar(opts) {
    return execFileSync('bash', [SCRIPT], {
        input: payload(opts),
        env: { ...process.env, HOME: FAKE, STATUSLINE_PAYLOAD: '' },
        encoding: 'utf8',
        timeout: 20000,
    });
}

try {
    // ---- 0. скрипт вообще исполняется ---------------------------------------
    ok(fs.existsSync(SCRIPT), `бар на месте: ${SCRIPT}`);
    execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    ok(true, 'bash -n чистый');

    const plain = bar();
    ok(plain.includes(`${DIM}⧉ 110k/1M${RESET}`), `контекст точными токенами: ${show(plain.slice(-40))}`);

    // ---- 1. /effort: поле читается, цвет тот же, что у слайдера CC ----------
    for (const [level, col] of Object.entries(LEVEL)) {
        const seg = ` ${SEP}·${RESET} ${col}${level}${RESET}`;
        const out = bar({ effort: level });
        ok(out.includes(seg), `effort=${level} рисуется своим цветом CC (${col.replace(/\u001b/, 'ESC')})`);
        // 🪤 Инвариант из лога 31.08: без поля effort строка обязана совпадать с
        // прежней БАЙТ В БАЙТ. Проверяем вычитанием сегмента, а не глазами.
        ok(out.replace(seg, '') === plain, `без effort строка та же байт в байт (${level})`);
    }
    // max — радуга по буквам: шаг 2 по кольцу из 7 цветов, поэтому три буквы
    // обязаны получить три РАЗНЫХ оттенка (соседние дали бы «оранжевый»).
    const mx = bar({ effort: 'max' });
    const rb = [...mx.matchAll(/\[1;38;2;(\d+;\d+;\d+)m(.)/g)].filter((m) => 'max'.includes(m[2]));
    ok(rb.map((m) => m[2]).join('') === 'max', `effort=max печатается побуквенно: ${rb.map((m) => m[2]).join('')}`);
    ok(new Set(rb.map((m) => m[1])).size === 3, `три буквы — три разных оттенка (${rb.map((m) => m[1]).join(' ')})`);

    // Незнакомый уровень (CC добавит шестой) не теряется, а печатается тускло.
    ok(bar({ effort: 'turbo' }).includes(` ${SEP}·${RESET} ${DIM}turbo${RESET}`),
        'незнакомый уровень не проглатывается, а показывается тускло');

    // ---- 2. ⑂ воркtree: workspace.git_worktree, а не верхний `worktree` -----
    const wt = bar({ worktree: 'hatchetfish' });
    ok(wt.includes(`${TEAL}⑂hatchetfish${RESET}`), 'имя воркtree читается из workspace.git_worktree');
    ok(!plain.includes('⑂'), 'в основном дереве поля нет — лишнего символа в баре не появляется');
    ok(wt.replace(` ${TEAL}⑂hatchetfish${RESET}`, '') === plain, 'без воркtree строка та же байт в байт');

    // ---- 3. цветовые пороги на контекст (70 / 85) ---------------------------
    // Их не было вовсе: до 31.08 стоял безусловный $DIM, и бар одинаково тускл
    // и на 17%, и за минуту до автокомпакта. Пороги отмерены от места, где CC
    // режет историю (~90%), поэтому проверяем и границы, и «на 1% ниже».
    const ctx = (tokens, pct) => bar({ tokens, pct });
    ok(ctx(110000, 11).includes(`${DIM}⧉ 110k/1M`), '11% — тускло, как было');
    ok(ctx(690000, 69).includes(`${DIM}⧉ 690k/1M`), '69% — ещё тускло, порог не съезжает вниз');
    ok(ctx(700000, 70).includes(`${CTX_WARN}⧉ 700k/1M`), '70% — жёлтый: автокомпакт близко');
    ok(ctx(840000, 84).includes(`${CTX_WARN}⧉ 840k/1M`), '84% — всё ещё жёлтый');
    ok(ctx(850000, 85).includes(`${CTX_ERR}⧉ 850k/1M`), '85% — жирный красный, пора /compact');
    // Ветка без total_input_tokens (старый payload): цвет обязан работать и там,
    // иначе порог живёт только на новых версиях CC.
    ok(bar({ tokens: null, pct: 88 }).includes(`${CTX_ERR}⧉ 88%`), 'процентная ветка красится тем же порогом');
    ok(bar({ tokens: null, pct: 12 }).includes(`${DIM}⧉ 12%`), 'процентная ветка на 12% — тускло');

    // ---- 4. бар всегда успешен ----------------------------------------------
    // Последняя условная команда при пустом значении даёт exit 1, а Claude Code
    // считает ненулевой код сбоем и гасит бар целиком.
    const code = execFileSync('bash', ['-c', `printf '%s' '${payload({ effort: 'high' }).trim()}' | bash "${SCRIPT}" >/dev/null; echo $?`],
        { env: { ...process.env, HOME: FAKE, STATUSLINE_PAYLOAD: '' }, encoding: 'utf8' }).trim();
    ok(code === '0', `exit code бара = ${code}`);
} finally {
    try { fs.rmSync(FAKE, { recursive: true, force: true }); } catch { /* temp */ }
}

if (failed) {
    console.log(`\n[X] сегментов потеряно: ${failed}. Разбор — docs/STATUSLINE.md, восстановление правок — из транскриптов CC`);
    process.exit(1);
}
console.log('\n[OK] бар собирается целиком: effort, воркtree, точные токены, пороги контекста');


