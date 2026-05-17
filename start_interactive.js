/**
 * Интерактивный лаунчер (альтернатива menu.js)
 * Запуск: node start_interactive.js
 * 
 * Использует start.js из autoreger_data (интерактивная настройка из Autoreger_Release1)
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Запуск интерактивного лаунчера...\n');

const startJs = path.join(__dirname, 'autoreger_data', 'start.js');

const child = spawn(process.execPath, [startJs], {
    stdio: 'inherit',
    cwd: __dirname
});

child.on('close', (code) => {
    process.exit(code || 0);
});
