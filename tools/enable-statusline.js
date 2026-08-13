// Робастный лаунчер: на этой машине `bash` = WSL (C:\Windows\system32\bash.exe),
// он не открывает Windows-пути C:/... — конвертируем wslpath/cygpath,
// а payload от CC уезжает через env STATUSLINE_PAYLOAD (stdin-пайп могут съесть
// wslpath/cygpath/cmd.exe, порождаемые в процессе запуска).
const script = path.resolve(__dirname, '..', 'routing', 'statusline-autoreger.sh');
if (!fs.existsSync(script)) {
  console.error('Не найден ' + script + ' — запускай из репо (git pull сначала).');
  process.exit(1);
}

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const raw = fs.readFileSync(settingsPath, 'utf8');
const s = JSON.parse(raw);

fs.writeFileSync(path.join(os.homedir(), '.claude', 'settings.backup.json'), raw);

const win = script.split('\\').join('/');
const cmd =
  "bash -c 'pl=\"$(cat 2>/dev/null)\"; " +
  's="' + win + '"; ' +
  'if command -v wslpath >/dev/null 2>&1; then s=$(wslpath -u "$s"); ' +
  'elif command -v cygpath >/dev/null 2>&1; then s=$(cygpath -u "$s"); fi; ' +
  'exec env STATUSLINE_PAYLOAD="$pl" bash "$s"\'';
s.statusLine = { type: 'command', command: cmd };
fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
console.log('OK, statusLine → ' + s.statusLine.command);
console.log('Перезапусти Claude Code — снизу появится статусбар.');
