'use strict';
/**
 * Мутационная проверка: ломаем ОДНУ несущую строку в копии transparent-proxy.js и смотрим,
 * покраснеет ли регресс. Живой файл не трогается — тесту источник подсовывается через
 * LEAGUE_SRC. Свой временный файл, удаляется после прогона.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'routing', 'transparent-proxy.js');
const TEST = path.join(ROOT, 'tools', 'check-league-chat.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hubatt-mut-'));
const src = fs.readFileSync(SRC, 'utf8');

const MUTANTS = [
    ['снят Content-Disposition: attachment у файла',
        "            'Content-Disposition': leagueAttDisp(leagueAttDispName(r.headers, `${seq}.${ext}`)),\r\n", ''],
    ['снята проверка белого списка расширений',
        "const leagueAttExtOk = e => typeof e === 'string' && /^[a-z0-9]{1,8}$/.test(e);",
        'const leagueAttExtOk = e => true;'],
    ['не пробрасывается name при отправке',
        '            if (nm) out.att.name = nm;', '            if (false) out.att.name = nm;'],
    ['не пробрасывается gseq при чтении',
        '`/chat?since=${since}&gseq=${gseq}`', '`/chat?since=${since}`'],
];

const run = file => {
    try {
        const out = execFileSync(process.execPath, [TEST],
            { env: { ...process.env, LEAGUE_SRC: file }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return out;
    } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); }
};
const tail = out => {
    const m = /итог: (\d+) прошло, (\d+) упало/.exec(out);
    const reds = (out.match(/  ❌ [^\n]*/g) || []).map(s => s.replace(/^  ❌ /, '').split(' — ')[0]);
    return { ok: m ? Number(m[1]) : -1, bad: m ? Number(m[2]) : -1, reds };
};

const base = tail(run(SRC));
console.log(`база: ${base.ok} прошло, ${base.bad} упало`);
for (const [why, from, to] of MUTANTS) {
    if (!src.includes(from)) { console.log(`\n[${why}] ЯКОРЬ НЕ НАЙДЕН — мутация не применена`); continue; }
    const f = path.join(DIR, 'mut-' + Buffer.from(why).toString('hex').slice(0, 12) + '.js');
    fs.writeFileSync(f, src.replace(from, to));
    const r = tail(run(f));
    console.log(`\n[${why}] ${r.ok} прошло, ${r.bad} упало`);
    for (const t of r.reds.slice(0, 6)) console.log('   ❌ ' + t);
    if (r.reds.length > 6) console.log(`   … и ещё ${r.reds.length - 6}`);
}
fs.rmSync(DIR, { recursive: true, force: true });
