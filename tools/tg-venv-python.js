// Путь до интерпретатора внутри tools/tg-venv.
//
// `python -m venv` раскладывает venv по-разному: Scripts/python.exe на Windows,
// bin/python на macOS и Linux. Раньше путь был захардкожен виндовым вариантом в
// routing/transparent-proxy.js и tgbot/stt.js — на маке «✈ Открыть TG» и STT
// отдавали «venv не создан» при полностью живом venv. Один резолвер на всех.
//
// Переопределение: env TG_VENV_PYTHON (у STT исторически ещё и STT_PYTHON).
//
// Использование:
//   const tgVenvPython = require('../tools/tg-venv-python.js');
//   const py = tgVenvPython();          // существующий путь, иначе ожидаемый
//   node tools/tg-venv-python.js        // печатает путь (для bash-скриптов)
'use strict';

const fs = require('fs');
const path = require('path');

const VENV = path.join(__dirname, 'tg-venv');

// Порядок важен: сначала виндовый layout, потом юниксовый. python3 перед python —
// на маке в venv лежат оба (python это симлинк), но python3 надёжнее.
const CANDIDATES = [
    path.join(VENV, 'Scripts', 'python.exe'),
    path.join(VENV, 'bin', 'python3'),
    path.join(VENV, 'bin', 'python'),
];

function tgVenvPython() {
    if (process.env.TG_VENV_PYTHON) return process.env.TG_VENV_PYTHON;
    for (const p of CANDIDATES) {
        if (fs.existsSync(p)) return p;
    }
    // venv нет. Возвращаем путь, ОЖИДАЕМЫЙ на этой платформе, а не пустоту:
    // вызывающий делает existsSync и печатает его в ошибке — юзеру нужно видеть,
    // чего именно не хватает.
    return CANDIDATES[process.platform === 'win32' ? 0 : 1];
}

module.exports = tgVenvPython;
module.exports.candidates = CANDIDATES;

if (require.main === module) process.stdout.write(tgVenvPython());
