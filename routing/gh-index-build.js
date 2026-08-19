// routing/gh-index-build.js
//
// Строит индекс GitHub-сессий по профилям Chromium и пишет его в
// github/sessions/_profile-index.json. Запускается ОТДЕЛЬНЫМ процессом.
//
// Зачем отдельный процесс, а не функция в дашборде: расшифровка ключа профиля идёт через
// DPAPI, то есть через `execFileSync('powershell')`. Это СИНХРОННЫЙ вызов — он блокирует
// единственный поток Node, и пока он не вернётся, дашборд не отвечает НИ НА ЧТО. На живой
// машине (дашборд поднят из restart-dashboard.bat, то есть с правами администратора) такой
// вызов однажды не вернулся вообще: :8200 слушал, соединения копились в CLOSE_WAIT, модалка
// висела минутами. Диагностировать было нечем — элевированный процесс и его дочерний
// powershell из обычной консоли даже не видны в tasklist.
//
// Теперь так: тяжёлую работу делает этот скрипт, дашборд только читает готовый JSON. Если
// здесь что-то повиснет — повиснет фоновый процесс, который никто не ждёт, а дашборд
// останется живым и просто покажет «индекс ещё строится».
//
// Использование:
//   node routing/gh-index-build.js            # обновить изменившиеся профили
//   node routing/gh-index-build.js --force    # перечитать все, игнорируя индекс
//
// Код возврата: 0 = индекс записан, 1 = ошибка.

const gs = require('./lib/github-session.js');

const force = process.argv.includes('--force');

try {
    if (force) gs.dropIndex();
    const t0 = Date.now();
    const profiles = gs.scanProfiles();
    const s = gs.scanStats() || {};
    console.log(`индекс собран за ${Date.now() - t0}мс: профилей ${s.profiles}, из индекса ${s.fromIndex}, `
        + `расшифровано ${s.decrypted}, с GitHub-сессией ${profiles.length}`);
    if (s.warmError) console.error(`⚠️ DPAPI-батч упал: ${s.warmError}`);
    else if (s.warmFailed) console.error(`⚠️ ключей не расшифровалось: ${s.warmFailed}`);
    process.exit(0);
} catch (e) {
    console.error('❌ индекс не собрался:', e.message);
    process.exit(1);
}
