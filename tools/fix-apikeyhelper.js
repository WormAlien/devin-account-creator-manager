// Фикс apiKeyHelper для Windows: заменяет "cat ~/..." на node-вариант,
// который не зависит от PATH, HOME и кириллицы в имени пользователя.
// Запуск:  node fix-apikeyhelper.js
const fs = require('fs'), os = require('os'), path = require('path');

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const backupPath = path.join(os.homedir(), '.claude', 'settings.backup.json');

const raw = fs.readFileSync(settingsPath, 'utf8');
const s = JSON.parse(raw);

// определяем key-файл из текущего helper (fm/al/cdt/ev/ot), дефолт fm
const m = (s.apiKeyHelper || '').match(/([a-z]+-active-key\.txt)/);
const keyFile = m ? m[1] : 'fm-active-key.txt';

fs.writeFileSync(backupPath, raw);
console.log('Бэкап: ' + backupPath);

s.apiKeyHelper =
  'node -e "process.stdout.write(require(\'fs\').readFileSync(' +
  'require(\'os\').homedir()+\'/.claude/' + keyFile + '\',\'utf8\').trim())"';

fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
console.log('OK, apiKeyHelper заменён (key-файл: ' + keyFile + ')');

// самопроверка: читаем ключ так же, как будет читать helper
try {
  const key = fs.readFileSync(path.join(os.homedir(), '.claude', keyFile), 'utf8').trim();
  console.log('Ключ читается: ' + key.slice(0, 10) + '... (' + key.length + ' симв.)');
  console.log('Теперь ПОЛНОСТЬЮ перезапусти терминал и Claude Code.');
} catch (e) {
  console.error('ВНИМАНИЕ: не смог прочитать ' + keyFile + ' — ' + e.message);
  console.error('Запиши туда рабочий ключ и повтори проверку.');
}
