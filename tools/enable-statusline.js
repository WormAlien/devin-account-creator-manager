// Подключает статуслайн (routing/statusline-autoreger.sh) в ~/.claude/settings.json.
// Запуск из корня репо:  node tools/enable-statusline.js
const fs = require('fs'), os = require('os'), path = require('path');

const script = path.resolve(__dirname, '..', 'routing', 'statusline-autoreger.sh');
if (!fs.existsSync(script)) {
  console.error('Не найден ' + script + ' — запускай из репо (git pull сначала).');
  process.exit(1);
}

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const raw = fs.readFileSync(settingsPath, 'utf8');
const s = JSON.parse(raw);

fs.writeFileSync(path.join(os.homedir(), '.claude', 'settings.backup.json'), raw);

s.statusLine = {
  type: 'command',
  command: 'bash "' + script.split('\\').join('/') + '"',
};
fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
console.log('OK, statusLine → ' + s.statusLine.command);
console.log('Перезапусти Claude Code — снизу появится статусбар.');
