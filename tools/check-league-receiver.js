#!/usr/bin/env node
'use strict';
/**
 * check-league-receiver.js — регресс на приёмник срезов и чата «Лиги».
 *
 * Зачем: приёмник — единственное место, где чужие цифры попадают в наш рейтинг.
 * Всё, что он принимает, будет показано как правда, поэтому проверяются не «ручки
 * отвечают», а именно отказы: чужой ключ, повтор в минуту, убывший счётчик,
 * невозможный рост, раздутое тело. И подмена клиентского времени серверным —
 * иначе «срез 1 мин назад» подделывается одним полем.
 *
 * С чатом добавился второй класс требований — целостность нумерации. `seq` для
 * клиента это «что я уже видел», поэтому повторный или откатившийся номер тише и
 * хуже любого отказа: он не ломает ручку, а прячет сообщения. Отсюда проверки на
 * одновременные POST, на перезапуск приёмника и на потерянный файл счётчика. Плюс
 * граница «чужая строка → наша правда» для вложений: тип решают БАЙТЫ, а имя файла
 * собирается из числа, иначе `/chat/att/` становится обходом каталога.
 *
 * Как: поднимает НАСТОЯЩИЙ league-receiver.js отдельным процессом на свободном порту
 * со своим временным каталогом данных. Живой приёмник и живые срезы не задеты.
 *
 * Запуск: node tools/check-league-receiver.js      (exit 1 = приёмник дырявый)
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Источник приёмника берётся из окружения, если он задан: так мутационная проверка
// подсовывает сюда сломанную КОПИЮ файла, не трогая живой.
const RECEIVER = process.env.LEAGUE_RECEIVER_SRC
    || path.join(__dirname, '..', 'routing', 'league-receiver.js');
const PORT = 8000 + Math.floor(Math.random() * 900);
const DATA = path.join(os.tmpdir(), 'league-recv-test-' + Date.now());
const BASE = `http://127.0.0.1:${PORT}`;

let ok = 0, bad = 0;
const check = (name, cond, got) => {
  if (cond) { ok++; console.log(`  ✅ ${name}`); }
  else { bad++; console.log(`  ❌ ${name}${got === undefined ? '' : ` — получено ${JSON.stringify(got)}`}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Минимальный правдоподобный срез: ровно те поля, на которые смотрит приёмник.
const mkSlice = (id, nick, over = {}) => ({
  installId: id, nick, ver: '2.0.0', stamp: '2020-01-01T00:00:00.000Z',
  keys: { d7: ['2026-08-30'] }, tok: { d7: [1] }, sp: { d7: [1] }, act: { d7: [1] }, acc: { d7: [1] },
  tot: { tokW: 5e9, tokA: 1e10, promptsAll: 17000, spentAll: 18000, bought: 32, reg: 142,
    streak: 52, ppd: 200, bal: 21000, ...over },
  src: {},
});

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  let out = '';
  // Приёмник поднимаем функцией, а не одной строкой: чат обязан переживать
  // перезапуск (seq не имеет права начаться заново), и ниже мы его перезапускаем.
  const spawnRecv = () => {
    const c = spawn(process.execPath, [RECEIVER, String(PORT), DATA], { stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { out += d; });
    return c;
  };
  // Ждём /health, а не спим наугад.
  const waitUp = async () => {
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* ещё не поднялся */ }
    }
    return false;
  };
  let child = spawnRecv();
  const restart = async () => {
    child.kill();
    // Ждём, пока порт освободится: иначе новый процесс упадёт на EADDRINUSE.
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      try { await fetch(`${BASE}/health`); } catch { break; }
    }
    child = spawnRecv();
    return waitUp();
  };

  const up = await waitUp();
  if (!up) { console.log('приёмник не поднялся:\n' + out); child.kill(); process.exit(1); }

  const SECRET = fs.readFileSync(path.join(DATA, 'secret'), 'utf8').trim();
  const post = (body, key = SECRET) => fetch(`${BASE}/slice`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-League-Key': key },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
  const peers = (id, key = SECRET) => fetch(`${BASE}/peers?installId=${id}`, { headers: { 'X-League-Key': key } });

  const A = 'a'.repeat(16), B = 'b'.repeat(16);

  console.log('\nсекрет и доступ:');
  check('секрет создан файлом с правами на владельца', SECRET.length >= 20, SECRET.length);
  check('секрет напечатан один раз при создании', /СЕКРЕТ ЛИГИ СОЗДАН/.test(out));
  check('/health открыт без ключа', (await fetch(`${BASE}/health`)).status === 200);
  check('срез без ключа отвергнут', (await post(mkSlice(A, 'worm'), 'wrong-key-0000')).status === 401);
  check('соседи без ключа отвергнуты', (await peers(A, '')).status === 401);

  console.log('\nприём:');
  const r1 = await post(mkSlice(A, 'worm alien'));
  const j1 = await r1.json();
  check('нормальный срез принят', r1.status === 200, j1);
  check('ник санирован приёмником, а не принят на веру', j1.nick === 'worm_alien', j1.nick);
  const stored = JSON.parse(fs.readFileSync(path.join(DATA, 'slices', A + '.json'), 'utf8'));
  check('клиентское время выброшено, стоит серверное',
    !stored.stamp && Date.parse(stored.recvAt) > Date.now() - 60000, { stamp: stored.stamp, recvAt: stored.recvAt });
  check('повтор в ту же минуту отвергнут', (await post(mkSlice(A, 'worm'))).status === 429);
  check('битый installId отвергнут', (await post(mkSlice('ЗЛО', 'worm'))).status === 400);
  check('односимвольный ник отвергнут', (await post(mkSlice(B, 'x'))).status === 400);
  check('тело больше 64 КБ отвергнуто',
    [413, 0].includes(await post('{"pad":"' + 'x'.repeat(70000) + '"}').then(r => r.status, () => 0)));

  console.log('\nантинакрутка:');
  // Тому же installId подсовываем «прошлое»: всего токенов стало вдвое меньше.
  fs.writeFileSync(path.join(DATA, 'slices', A + '.json'), JSON.stringify({
    ...stored, recvAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }));
  const rDown = await post(mkSlice(A, 'worm', { tokA: 5e9 }));
  check('убывший счётчик всего отвергнут', rDown.status === 409, await rDown.json());
  const rFast = await post(mkSlice(A, 'worm', { tokA: 1e10 + 9e9 }));
  check('невозможный рост за два часа отвергнут', rFast.status === 409, await rFast.json());
  const rFine = await post(mkSlice(A, 'worm', { tokA: 1.02e10 }));
  check('честный рост принят', rFine.status === 200, await rFine.json());

  console.log('\nвыдача соседей:');
  await post(mkSlice(B, 'monty'));
  const pa = await (await peers(A)).json();
  const pb = await (await peers(B)).json();
  check('свой срез себе не возвращается', pa.peers.every(p => p.installId !== A), pa.peers.map(p => p.installId));
  check('чужой срез виден', pa.peers.length === 1 && pa.peers[0].nick === 'monty', pa.peers.map(p => p.nick));
  check('вторая установка видит первую', pb.peers.length === 1 && pb.peers[0].installId === A);
  check('в выдаче есть серверное время приёма', !!pa.peers[0].recvAt, pa.peers[0].recvAt);
  const health = await (await fetch(`${BASE}/health`)).json();
  check('/health считает установки', health.installs === 2, health);

  // ── Белый список полей ─────────────────────────────────────────────────────
  // До правки приёмник клал на диск присланный объект ЦЕЛИКОМ и отдавал его
  // соседям: проверялись три поля, остальное проходило дословно. Через реле так
  // передаётся что угодно, и сосед это отрисует. Проверяется поэтому не «поля
  // доехали», а что НЕ доехало ничего лишнего.
  console.log('\nбелый список полей среза:');
  const sliceOf = id => JSON.parse(fs.readFileSync(path.join(DATA, 'slices', id + '.json'), 'utf8'));
  // Сдвигаем прошлый срез на два часа назад: иначе сработает «один срез в минуту».
  const backdate = id => {
    const s = sliceOf(id);
    s.recvAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(DATA, 'slices', id + '.json'), JSON.stringify(s));
  };
  backdate(A);
  const rWl = await post({ ...mkSlice(A, 'worm', { tokA: 1.02e10, streak: '<img src=x onerror=alert(1)>' }),
    evil: '<script>alert(1)</script>', nested: { deep: { worse: 'x' } }, src: { journalFirst: '<b>' },
    tzOffsetMin: 180 });
  const wl = sliceOf(A);
  check('срез со строкой в tot принят: одно негодное поле не отменяет цифры',
    rWl.status === 200, await rWl.json());
  check('строки в tot нет — поле выброшено', wl.tot.streak === undefined, wl.tot.streak);
  check('остальные счётчики tot на месте и остались числами',
    wl.tot.tokA === 1.02e10 && Object.values(wl.tot).every(v => typeof v === 'number'),
    Object.entries(wl.tot).filter(([, v]) => typeof v !== 'number'));
  check('неизвестные поля на диск не попали',
    !('evil' in wl) && !('nested' in wl) && !('src' in wl) && !('stamp' in wl), Object.keys(wl));
  const pWl = await (await peers(B)).json();
  const peerA = pWl.peers.find(p => p.installId === A) || {};
  check('неизвестные поля не появились и в /peers',
    !('evil' in peerA) && !('nested' in peerA) && !('src' in peerA), Object.keys(peerA));
  check('подписи keys остались СТРОКАМИ, а не превратились в числа',
    Array.isArray(wl.keys.d7) && wl.keys.d7.every(k => typeof k === 'string'), wl.keys);
  check('tzOffsetMin сохранён числом', wl.tzOffsetMin === 180, wl.tzOffsetMin);
  backdate(A);
  const rVer = await post({ ...mkSlice(A, 'worm', { tokA: 1.02e10 }),
    ver: '2.0.0<script>', sha: '../../etc/passwd' });
  const wlVer = sliceOf(A);
  check('ver и sha вычищены до безопасных символов',
    rVer.status === 200 && !/[<>/]/.test(wlVer.ver + wlVer.sha), { ver: wlVer.ver, sha: wlVer.sha });
  // Ряд на 20 000 точек в тело влезает (40 КБ), поэтому его режет уже белый список.
  backdate(A);
  const rFatSeries = await post({ ...mkSlice(A, 'worm', { tokA: 1.02e10 }),
    tok: { d7: new Array(20000).fill(0) } });
  const wlFat = sliceOf(A);
  check('ряд, влезший в тело, обрезан по потолку точек',
    rFatSeries.status === 200 && wlFat.tok.d7.length === 1500, wlFat.tok.d7.length);
  // А 100 000 точек не доходят даже до разбора: это 200 КБ тела.
  check('ряд на 100 000 точек отвергнут телом',
    [413, 0].includes(await post({ ...mkSlice(A, 'worm'), tok: { d7: new Array(100000).fill(0) } })
      .then(r => r.status, () => 0)));

  // ── Потолки правдоподобия ──────────────────────────────────────────────────
  // Потолок РОСТА считает от предыдущего среза, а у первого предыдущего нет:
  // `checkMonotone` возвращал null, и новая установка первым же срезом ставила любые
  // конечные числа и садилась на вершину рейтинга навсегда. Проверяется поэтому именно
  // первый срез незнакомой установки, и с двух сторон: невозможное отвергнуто, а
  // большое-но-возможное принято. Ложное отклонение честного участника хуже
  // пропущенного жулика, поэтому запас у потолков — порядки (см. ABS_MAX).
  console.log('\nпотолки правдоподобия (первый срез):');
  const F = n => (n.toString(16).padStart(2, '0') + 'ce').repeat(4);    // 16 hex-символов
  const rmSlice = id => { try { fs.rmSync(path.join(DATA, 'slices', id + '.json')); } catch {} };
  const firstJ = async (id, over) => {
    const r = await post(mkSlice(id, 'новичок', over));
    return { st: r.status, j: await r.json() };
  };
  const top = await firstJ(F(1), { tokA: 1e308 });
  check('первый срез с 1e308 токенов отвергнут, а не садится на вершину навсегда',
    top.st === 409 && /потолка правдоподобия/.test(top.j.reason || ''), top);
  const pr = await firstJ(F(2), { promptsAll: 1e7 });
  check('первый срез с 10 млн промптов отвергнут', pr.st === 409 && /promptsAll/.test(pr.j.reason || ''), pr);
  const sp = await firstJ(F(3), { spentAll: 5e7 });
  check('первый срез с расходом $50 млн отвергнут', sp.st === 409 && /spentAll/.test(sp.j.reason || ''), sp);
  const ac = await firstJ(F(4), { bought: 1e6 });
  check('первый срез с миллионом аккаунтов отвергнут', ac.st === 409 && /acc/.test(ac.j.reason || ''), ac);
  // Живой срез владельца на 05.09 — 18,0 млрд токенов, 17 923 промпта, $20,3 тыс. и 174
  // аккаунта. Здесь числа на порядки выше его и всё равно должны пройти.
  const okBig = await firstJ(F(5),
    { tokA: 4.9e13, promptsAll: 4.9e6, spentAll: 1.9e7, bought: 99000, reg: 900 });
  check('первый срез с большими, но физически возможными числами принят',
    okBig.st === 200, okBig);
  rmSlice(F(5));
  backdate(A);
  const hardA = await post(mkSlice(A, 'worm', { tokA: 1e308 }));
  const hardAj = await hardA.json();
  check('потолок действует и на установку с прошлым срезом, и это именно потолок',
    hardA.status === 409 && /потолка правдоподобия/.test(hardAj.reason || '') && !hardAj.drop, hardAj);

  // ── Ряды ───────────────────────────────────────────────────────────────────
  // Ряды не проверялись ничем: смотрели только суммарные пары в `tot`. А часть плиток
  // клиент считает СУММОЙ ряда — то есть график и цифры рисовались любыми, не задев ни
  // одной проверки. Проверяем и точку, и сумму, и сходимость с парой; и обязательно то,
  // что законные формы рядов при этом проходят.
  console.log('\nряды среза:');
  const rPeak = await firstJ(F(6), {});
  check('готовый срез без подвоха принят (контроль для проверок ниже)', rPeak.st === 200, rPeak);
  rmSlice(F(6));
  const spike = await post({ ...mkSlice(F(7), 'новичок'), tok: { d7: [1e300, -1e300] } });
  const spikeJ = await spike.json();
  check('точка ряда в 1e300 отвергнута, хотя сумма ряда почти ноль',
    spike.status === 409 && /точка/.test(spikeJ.reason || ''), spikeJ);
  const fatSum = await post({ ...mkSlice(F(8), 'новичок', { tokA: 4.9e13 }),
    tok: { all: new Array(6).fill(1e13) } });
  const fatSumJ = await fatSum.json();
  check('сумма ряда выше потолка отвергнута', fatSum.status === 409 && /сумма/.test(fatSumJ.reason || ''), fatSumJ);
  const mism = await post({ ...mkSlice(F(9), 'новичок', { tokA: 1e6 }), tok: { d7: [1e9] } });
  const mismJ = await mism.json();
  check('ряд, который не сходится со своей суммарной парой, отвергнут',
    mism.status === 409 && /не сходится с tokA/.test(mismJ.reason || ''), mismJ);
  const mismAct = await post({ ...mkSlice(F(10), 'новичок', { promptsAll: 100 }), act: { d7: [1e6] } });
  check('то же для промптов: ряд против promptsAll',
    mismAct.status === 409 && /не сходится с promptsAll/.test((await mismAct.json()).reason || ''));
  // `acc` — ряд НАКОПИТЕЛЬНЫЙ: в `h24` это 24 раза одно и то же число, и его сумма
  // ничего не значит (174 аккаунта владельца дают «4176 за сутки»). Наивное правило «сумма
  // ряда не больше потолка пары» отвергало бы здесь честный срез — вот проверка на это.
  const lvl = await post({ ...mkSlice(F(11), 'новичок'), acc: { h24: new Array(24).fill(174) } });
  check('накопительный ряд acc принят: его сумма не сравнивается с уровнем', lvl.status === 200,
    await lvl.json());
  rmSlice(F(11));
  // Отрицательные бакеты у денег законны: откат выданной квоты вычитается, и часовые
  // бакеты бывают минусовыми (замер 05.09: 6 часов из 24 на −$10.78).
  const neg = await post({ ...mkSlice(F(12), 'новичок'), sp: { h24: [-10.78, 413, -2] },
    tu: { h24: [-10.78, 4572] } });
  check('отрицательные часовые бакеты денег приняты, а не приняты за подвох',
    neg.status === 200, await neg.json());
  rmSlice(F(12));

  // ── Потолок роста: дробные часы ────────────────────────────────────────────
  // Промежуток считался как `Math.max(1, Δчасов)`, то есть при сдаче раз в минуту
  // разрешался прирост на ЦЕЛЫЙ часовой потолок каждую минуту — потолок был слабее
  // заявленного в 60 раз. И одновременно нельзя сломать законный случай: машина могла
  // стоять сутки и прислать большой честный прирост.
  console.log('\nпотолок роста: дробные часы:');
  const backdateBy = (id, ms) => {
    const s = sliceOf(id);
    s.recvAt = new Date(Date.now() - ms).toISOString();
    fs.writeFileSync(path.join(DATA, 'slices', id + '.json'), JSON.stringify(s));
  };
  const GAP = F(13);
  check('база для проверки промежутка принята', (await post(mkSlice(GAP, 'минутник'))).status === 200);
  backdateBy(GAP, 61_000);
  // Часовой потолок токенов 3,3 млрд → за 61 секунду законны ~56 млн, а не 3,3 млрд.
  const rMin = await post(mkSlice(GAP, 'минутник', { tokA: 1e10 + 6e8 }));
  const rMinJ = await rMin.json();
  check('прирост 600 млн токенов за минуту отвергнут (до правки проходил часовой потолок)',
    rMin.status === 409 && / за 0\.0\d ч/.test(rMinJ.reason || ''), rMinJ);
  const rMinOk = await post(mkSlice(GAP, 'минутник', { tokA: 1e10 + 2e7 }));
  check('прирост 20 млн за ту же минуту принят: потолок дробный, а не нулевой',
    rMinOk.status === 200, await rMinOk.json());
  backdateBy(GAP, 24 * 3600 * 1000);
  const rDay = await post(mkSlice(GAP, 'минутник', { tokA: 1e10 + 2e7 + 2e9 }));
  check('машина стояла сутки: большой законный прирост принят', rDay.status === 200, await rDay.json());
  rmSlice(GAP);

  // ── Просадка: выход из вечного 409 ─────────────────────────────────────────
  // Отказ по просадке САМ НИКОГДА НЕ ИСТЕКАЛ: сохранённый срез выше нового, и каждый
  // следующий тик получал те же 409 — участник молча выпадал из рейтинга, а вылечить это
  // мог только владелец, удалив файл на ноде руками. При том что законных причин просесть
  // хватает: журнал токенов хаба режется по 8 МБ, переустановка, чистка кеша, переезд.
  // Проверяется сквозной сценарий: просело → отказы → принято новой базой → следующий
  // обычный срез снова проходит. И отдельно — что скачок ВВЕРХ поблажки не получил.
  console.log('\nпросадка накопительных счётчиков → новая база:');
  const DROP = F(14), DROPF = path.join(DATA, 'slice-drops.json');
  check('высокая база принята', (await post(mkSlice(DROP, 'просадка'))).status === 200);
  backdateBy(DROP, 2 * 3600 * 1000);
  const d1 = await post(mkSlice(DROP, 'просадка', { tokA: 5e9 }));
  const d1j = await d1.json();
  check('просадка вдвое отвергнута, и в ответе видно серию и что делать дальше',
    d1.status === 409 && d1j.drop && d1j.drop.n === 1 && d1j.drop.need === 5
    && /базой сам/.test(d1j.error || '') && !!d1j.hint, d1j);
  const d2j = await (await post(mkSlice(DROP, 'просадка', { tokA: 5e9 }))).json();
  check('второй отказ подряд посчитан', d2j.drop && d2j.drop.n === 2, d2j.drop);
  check('серия живёт в файле, а не только в памяти: перезапуск её не обнулит',
    fs.existsSync(DROPF) && !!JSON.parse(fs.readFileSync(DROPF, 'utf8'))[DROP],
    fs.existsSync(DROPF) && Object.keys(JSON.parse(fs.readFileSync(DROPF, 'utf8'))));
  // Дальше серию подкручиваем в файле, а не ждём час живьём: MIN_GAP_MS разрешает срез
  // в минуту, так что честные пять отказов — это ~50 минут работы хаба.
  const dPatch = (n, spanMs) => {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(DROPF, 'utf8')); } catch { /* нет файла — будет виден отказ ниже */ }
    d[DROP] = { ...(d[DROP] || {}), n, first: Date.now() - spanMs, last: Date.now() };
    fs.writeFileSync(DROPF, JSON.stringify(d));
  };
  dPatch(4, 0);
  if (!await restart()) console.log('приёмник не поднялся после подкрутки серии:\n' + out);
  const dFast = await post(mkSlice(DROP, 'просадка', { tokA: 5e9 }));
  check('пятый отказ, но серия младше получаса — всё ещё 409 (циклом базу не сбросить)',
    dFast.status === 409, await dFast.json());
  dPatch(4, 31 * 60_000);
  if (!await restart()) console.log('приёмник не поднялся после подкрутки серии:\n' + out);
  const dOk = await post(mkSlice(DROP, 'просадка', { tokA: 5e9 }));
  const dOkJ = await dOk.json();
  check('пять отказов за полчаса — просадка принята НОВОЙ БАЗОЙ', dOk.status === 200 && !!dOkJ.rebased, dOkJ);
  check('событие в ответе: сколько отказов, за сколько минут, тот ли адрес, по какой причине',
    dOkJ.rebased && dOkJ.rebased.afterRejects >= 5 && dOkJ.rebased.spanMin >= 30
    && dOkJ.rebased.sameAddr === true && / убыл: /.test(dOkJ.rebased.reason || ''), dOkJ.rebased);
  check('на диске новая база и событие рядом с ней, а не только в логе',
    sliceOf(DROP).tot.tokA === 5e9 && !!sliceOf(DROP).rebased, sliceOf(DROP).rebased);
  const pDrop = (await (await peers(B)).json()).peers.find(p => p.installId === DROP) || {};
  check('событие просадки уехало соседям в /peers', !!pDrop.rebased, pDrop.rebased);
  check('серия сброшена: файл больше не помнит эту установку',
    !JSON.parse(fs.readFileSync(DROPF, 'utf8'))[DROP]);
  backdateBy(DROP, 2 * 3600 * 1000);
  const dAfter = await post(mkSlice(DROP, 'просадка', { tokA: 5.05e9 }));
  check('заклинивания больше нет: следующий обычный срез от новой базы проходит',
    dAfter.status === 200, await dAfter.json());
  backdateBy(DROP, 2 * 3600 * 1000);
  const dUp = await post(mkSlice(DROP, 'просадка', { tokA: 5.05e9 + 9e9 }));
  const dUpJ = await dUp.json();
  check('резкий скачок ВВЕРХ по-прежнему отвергнут и в серию просадок не складывается',
    dUp.status === 409 && !dUpJ.drop, dUpJ);
  rmSlice(DROP);

  // ── Срез-файлы: чистка по возрасту ─────────────────────────────────────────
  // Срез-файлы не удалялись никогда: устаревшие только скрывались из /peers. Порог
  // щедрый намеренно — участник мог не включать машину месяц, и выкидывать его нельзя.
  console.log('\nсрез-файлы: чистка по возрасту:');
  const ghost = (id, ageMs) => fs.writeFileSync(path.join(DATA, 'slices', id + '.json'),
    JSON.stringify({ installId: id, nick: 'ушёл', recvAt: new Date(Date.now() - ageMs).toISOString(), tot: {} }));
  const OLD = F(15), MID = F(16);
  ghost(OLD, 200 * 864e5);
  ghost(MID, 40 * 864e5);
  if (!await restart()) console.log('приёмник не поднялся перед чисткой срезов:\n' + out);
  check('срез-файл без обновлений полгода убран', !fs.existsSync(path.join(DATA, 'slices', OLD + '.json')));
  check('срез-файл 40-дневной давности НЕ тронут: машина могла не включаться месяц',
    fs.existsSync(path.join(DATA, 'slices', MID + '.json')));
  check('в журнале ноды сказано, сколько срез-файлов убрано', /убрано срез-файлов/.test(out));
  rmSlice(MID);

  // ── /health из кеша ────────────────────────────────────────────────────────
  // `/health` отвечает без ключа (так надо: на него смотрят приёмка выката и дашборд), а
  // считал ответ обходом каталога с разбором JSON каждого среза — то есть самый дешёвый
  // неавторизованный запрос заставлял перечитать все срезы, и повторять это можно было
  // сколько угодно. Формат ответа при этом менять нельзя.
  console.log('\n/health из кеша:');
  const onDisk = () => fs.readdirSync(path.join(DATA, 'slices')).filter(f => f.endsWith('.json')).length;
  // Сначала сводим кеш с диском заведомо: приём среза его сбрасывает.
  backdate(A);
  check('срез для сброса кеша принят', (await post(mkSlice(A, 'worm', { tokA: 1.02e10 }))).status === 200);
  const hWarm = await (await fetch(`${BASE}/health`)).json();
  check('после приёма среза /health сходится с диском',
    hWarm.installs === onDisk(), { health: hWarm.installs, диск: onDisk() });
  const HG = F(17);
  ghost(HG, 0);
  const hCached = await (await fetch(`${BASE}/health`)).json();
  check('/health не обходит каталог на каждый запрос: файл добавился, ответ тот же',
    hCached.installs === hWarm.installs && hCached.installs !== onDisk(),
    { кеш: hCached.installs, диск: onDisk() });
  check('формат /health прежний: ok, installs, last',
    hCached.ok === true && typeof hCached.installs === 'number' && 'last' in hCached,
    Object.keys(hCached));
  backdate(A);
  const rInv = await post(mkSlice(A, 'worm', { tokA: 1.02e10 }));
  const hAfter = await (await fetch(`${BASE}/health`)).json();
  check('приём среза сбрасывает кеш — installs не отстаёт от факта',
    rInv.status === 200 && hAfter.installs === onDisk(),
    { health: hAfter.installs, диск: onDisk() });
  rmSlice(HG);

  // ── Чат ────────────────────────────────────────────────────────────────────
  // Правило то же, что и для срезов: приёмник — единственная граница, за которой
  // чужая строка становится нашей правдой. Поэтому проверяются не «сообщения
  // ходят», а отказы и подмены: пустое, не-webp, больше 2 МБ, флуд, обход
  // каталога, присланные `seq` и `recvAt`. Плюс то, чего нет у срезов: номер
  // сообщения обязан быть уникальным при одновременных запросах и не сбрасываться
  // при перезапуске — иначе клиент либо покажет старое как новое, либо потеряет.
  console.log('\nчат:');
  const CHAT = path.join(DATA, 'chat.ndjson');
  const chat = (body, key = SECRET) => fetch(`${BASE}/chat`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-League-Key': key },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
  const feed = (since = 0, key = SECRET) => fetch(`${BASE}/chat?since=${since}`,
    { headers: { 'X-League-Key': key } });
  const cj = async (body) => (await chat(body)).json();
  // Удаление объявлено здесь, вместе с остальными помощниками чата: им пользуются и
  // проверки надгробий, и проверки частоты ниже, а второй `const del` в той же области
  // видимости — это SyntaxError, а не дубль.
  const del = q => fetch(`${BASE}${q}`, { method: 'DELETE', headers: { 'X-League-Key': SECRET } });
  const delJ = async q => { const r = await del(q); return { st: r.status, j: await r.json() }; };
  const feedJ = async (since = 0) => (await feed(since)).json();
  // Сырой GET нужен для обхода каталога: fetch сворачивает `..` в пути ещё на
  // клиенте, то есть проверял бы наш же URL-парсер, а не приёмник. Заодно им проверяется
  // условный запрос: в fetch заголовок If-None-Match браузерная семантика может съесть.
  const rawGet = (p, key = SECRET, extra = {}) => new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET',
      headers: { 'X-League-Key': key, ...extra } }, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on('error', e => resolve({ status: 0, body: String(e.message), headers: {} }));
    r.end();
  });
  // Настоящий контейнер webp: `RIFF`, размер, `WEBP`. Больше приёмнику и не надо —
  // он проверяет магию, а не декодирует картинку.
  const mkWebp = (bytes = 64) => {
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(Math.max(bytes - 8, 4), 4);
    head.write('WEBP', 8, 'latin1');
    return Buffer.concat([head, Buffer.alloc(Math.max(bytes - 12, 4), 0x77)]);
  };
  const notWebp = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    Buffer.alloc(200, 1)]);
  const CH = n => n.toString(16).padStart(4, '0').repeat(4);   // 16 hex-символов из числа

  check('чат без ключа отвергнут',
    (await chat({ installId: CH(1), nick: 'worm', text: 'привет' }, 'wrong-key-0000')).status === 401);
  check('лента без ключа отвергнута', (await feed(0, '')).status === 401);
  // Пустой чат — первое, что увидит хаб в проде: журнала на диске ещё нет.
  const virgin = await feed(0);
  const virginJ = await virgin.json();
  check('пустая лента отдаётся, а не падает',
    virgin.status === 200 && Array.isArray(virginJ.messages) && virginJ.messages.length === 0
    && !fs.existsSync(CHAT), virginJ);
  // Поле надгробий есть с самого начала и пустым. Это не формальность: по нему клиент
  // отличает «удалений не было» от «на ноде сборка без надгробий», а второе значит, что
  // инкрементальному чтению после удаления доверять нельзя.
  check('в пустой ленте поле gone есть и оно пустое, признака resync нет',
    Array.isArray(virginJ.gone) && virginJ.gone.length === 0 && !virginJ.resync, virginJ);

  const c1 = await chat({ installId: CH(1), nick: 'worm alien', text: '  привет, лига  ' });
  const j1c = await c1.json();
  check('сообщение принято, seq присвоил сервер',
    c1.status === 200 && j1c.ok === true && Number.isInteger(j1c.seq) && j1c.seq >= 1, j1c);
  const m1 = (await (await feed(j1c.seq - 1)).json()).messages[0];
  check('ник в чате санирован приёмником', m1 && m1.nick === 'worm_alien', m1 && m1.nick);
  check('текст обрезан по краям, но не потерян', m1 && m1.text === 'привет, лига', m1 && m1.text);
  check('в ленте серверное время приёма',
    m1 && Date.parse(m1.recvAt) > Date.now() - 60000, m1 && m1.recvAt);

  // Клиент присылает свои seq и recvAt — оба обязаны быть выброшены. Иначе одним
  // полем подделывается и порядок сообщений, и «когда написано».
  const spoof = await cj({ installId: CH(1), nick: 'worm', text: 'подмена',
    seq: 999999, recvAt: '2020-01-01T00:00:00.000Z' });
  check('присланный seq выброшен, номер выдал сервер', spoof.seq === j1c.seq + 1, spoof);
  const ms = (await (await feed(spoof.seq - 1)).json()).messages[0];
  check('присланный recvAt выброшен, стоит серверный',
    Date.parse(ms.recvAt) > Date.now() - 60000, ms.recvAt);

  check('пустое сообщение без вложения отвергнуто',
    (await chat({ installId: CH(1), nick: 'worm', text: '   ' })).status === 400);
  check('сообщение без текста и без att отвергнуто',
    (await chat({ installId: CH(1), nick: 'worm' })).status === 400);
  check('битый installId в чате отвергнут',
    (await chat({ installId: 'ЗЛО', nick: 'worm', text: 'x' })).status === 400);
  check('не-JSON в чате отвергнут', (await chat('{сломано')).status === 400);
  // Ник, который не проходит санацию, берём из уже принятого среза этой установки:
  // он тоже проверен нами, и сообщение не теряется из-за кривого поля.
  const nk = await chat({ installId: A, nick: 'x', text: 'ник из среза' });
  const nkj = await nk.json();
  const mnk = (await (await feed(nkj.seq - 1)).json()).messages[0];
  check('негодный ник заменён тем, под которым установка сдаёт срезы',
    nk.status === 200 && mnk.nick === 'worm', mnk && mnk.nick);

  const LONG = CH(2);
  const lj = await cj({ installId: LONG, nick: 'long', text: 'я'.repeat(2500) });
  const ml = (await (await feed(lj.seq - 1)).json()).messages[0];
  check('текст обрезан до 2000 символов', ml.text.length === 2000, ml.text.length);
  const NUL = String.fromCharCode(0), ESC = String.fromCharCode(27);
  const kj = await cj({ installId: LONG, nick: 'long', text: 'а' + NUL + ESC + 'б\r\nв' });
  const mk = (await (await feed(kj.seq - 1)).json()).messages[0];
  check('управляющие символы вырезаны, CRLF сведён к LF',
    mk.text === 'аб\nв', JSON.stringify(mk.text));

  console.log('\nвложения:');
  const PIC = CH(3);
  const img = mkWebp(3000);
  const aj = await cj({ installId: PIC, nick: 'pic', text: 'скрин',
    att: { mime: 'image/webp', b64: img.toString('base64') } });
  const ma = (await (await feed(aj.seq - 1)).json()).messages[0];
  check('вложение принято, ссылка в ленте собрана из seq и относительна',
    ma.att && ma.att.url === `/chat/att/${aj.seq}.webp` && ma.att.bytes === img.length, ma.att);
  check('вложение лежит отдельным файлом по номеру сообщения',
    fs.existsSync(path.join(DATA, 'att', aj.seq + '.webp')));
  const shot = await fetch(`${BASE}${ma.att.url}`, { headers: { 'X-League-Key': SECRET } });
  const shotBuf = Buffer.from(await shot.arrayBuffer());
  // Кеш здесь `no-store`, а не сутки, и это не экономия наоборот: с `max-age=86400`
  // картинка СНЯТОГО сообщения открывалась ещё сутки из дискового кеша — удаление
  // выглядело сделанным, а байты оставались доступны. Взамен ETag: номер не
  // переиспользуется, файл пишется один раз, значит отпечаток точный, и повторное чтение
  // стоит 304 вместо полной перекачки.
  check('байты отдаются как webp, без кеша на диске, с ETag, и совпадают с отправленными',
    shot.status === 200 && shot.headers.get('content-type') === 'image/webp'
    && shot.headers.get('cache-control') === 'no-store'
    && /^"\d+-\d+"$/.test(shot.headers.get('etag') || '') && shotBuf.equals(img),
    { st: shot.status, ct: shot.headers.get('content-type'), cc: shot.headers.get('cache-control'),
      etag: shot.headers.get('etag'), len: shotBuf.length });
  const cond = await rawGet(ma.att.url, SECRET, { 'If-None-Match': shot.headers.get('etag') });
  check('условный запрос с тем же ETag — 304 и пустое тело, а не мегабайт заново',
    cond.status === 304 && cond.body === '' && cond.headers.etag === shot.headers.get('etag'),
    { st: cond.status, len: cond.body.length, etag: cond.headers.etag });
  const condOld = await rawGet(ma.att.url, SECRET, { 'If-None-Match': '"1-1"' });
  check('чужой ETag не считается совпадением: байты отдаются',
    condOld.status === 200 && condOld.body.length > 0, condOld.status);
  check('вложения с несуществующим номером нет', (await rawGet('/chat/att/987654321.webp')).status === 404);

  // Тип решают БАЙТЫ: mime в теле заявлен правильный, а картинка — png. Раньше это был
  // отказ 415; теперь любой небольшой файл принимается, но png, не подтверждённый
  // сигнатурой, отдаётся НЕ как картинка, а байтами на скачивание. Правило то же —
  // заявленному типу не верим, — а последствие честнее: файл не теряется.
  const pngJ = await cj({ installId: PIC, nick: 'pic', text: 'png под видом webp',
    att: { mime: 'image/webp', b64: notWebp.toString('base64') } });
  const pngFeed = ((await feedJ(pngJ.seq - 1)).messages || [])[0];
  const pngGot = await rawGet(pngFeed.att.url);
  check('png с заявленным image/webp не стал картинкой: kind=file и байты на скачивание',
    pngFeed.att.kind === 'file' && pngFeed.att.mime === 'application/octet-stream'
    && pngGot.headers['content-type'] === 'application/octet-stream'
    && /^attachment;/.test(pngGot.headers['content-disposition'] || '')
    && pngGot.headers['x-content-type-options'] === 'nosniff',
    { att: pngFeed.att, ct: pngGot.headers['content-type'],
      cd: pngGot.headers['content-disposition'] });
  check('вложение без b64 отвергнуто',
    (await chat({ installId: PIC, nick: 'pic', text: 'пусто', att: { mime: 'image/webp' } })).status === 400);
  const big = mkWebp(2 * 1024 * 1024 + 64);
  check('вложение больше 2 МБ отвергнуто',
    (await chat({ installId: PIC, nick: 'pic', text: 'жирно', att: { b64: big.toString('base64') } })).status === 413);
  // Граница: ровно 2 МБ должны пройти, иначе лимит на самом деле меньше заявленного.
  const edge = mkWebp(2 * 1024 * 1024);
  check('вложение ровно 2 МБ принято',
    (await chat({ installId: PIC, nick: 'pic', text: 'ровно 2 МБ', att: { b64: edge.toString('base64') } })).status === 200);
  check('пустой текст С вложением принят',
    (await chat({ installId: PIC, nick: 'pic', text: '', att: { b64: img.toString('base64') } })).status === 200);
  // Тело сверх лимита рвётся на входе: до разбора вложения дело не доходит. Ноль в
  // допустимых ответах — это оборванный сокет, и он тут такой же законный отказ.
  check('тело чата больше 3 МБ отвергнуто',
    [413, 0].includes(await chat({ installId: PIC, nick: 'pic', text: 'x',
      att: { b64: mkWebp(3 * 1024 * 1024).toString('base64') } }).then(r => r.status, () => 0)));

  // Обход каталога. fetch тут не годится (см. rawGet): пути нужны ненормализованные.
  const trav = ['/chat/att/../../secret', '/chat/att/..%2f..%2fsecret', '/chat/att/%2e%2e%2fsecret',
    `/chat/att/${aj.seq}.webp/../../secret`, '/chat/att/-1.webp', '/chat/att/1e3.webp',
    '/chat/att/' + aj.seq + '.webp%00.txt'];
  const travRes = [];
  for (const p of trav) travRes.push(await rawGet(p));
  check('обход каталога в /chat/att/ не работает',
    travRes.every(r => r.status === 404 || r.status === 400), travRes.map((r, i) => `${trav[i]}→${r.status}`).join(' '));
  check('секрет не утекает через /chat/att/', travRes.every(r => !r.body.includes(SECRET)));

  // ── Звук: голосовые сообщения ──────────────────────────────────────────────
  // Вложение умело быть только картинкой: магия проверялась одна (`RIFF....WEBP`), имя
  // файла собиралось с расширением .webp в трёх местах, отдача ставила image/webp. То
  // есть голосовое не просто «не поддерживалось» — оно получало 415 и физически не могло
  // уехать. Проверяется поэтому не «звук ходит», а границы: тип решают БАЙТЫ (mime в теле
  // заявлен верно у всех проб — и всё равно не читается), у звука СВОЙ предел веса, файл
  // лежит со своим расширением, отдаётся со своим типом и с запретом угадывания, а wav не
  // путается с webp, хотя начинается тем же словом RIFF.
  console.log('\nвложения: звук (голосовые):');
  // Сигнатуры настоящие, а не «похожие байты»: приёмник смотрит ровно на них.
  const pad = (head, bytes, fill) => Buffer.concat([head,
    Buffer.alloc(Math.max(bytes - head.length, 16), fill)]);
  const mkWebm = (b = 4096) => pad(Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), b, 0x33);  // EBML
  const mkOgg = (b = 4096) => pad(Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.from([0, 2])]), b, 0x44);
  const mkM4a = (b = 4096) => pad(Buffer.concat([Buffer.from([0, 0, 0, 0x20]),
    Buffer.from('ftypM4A ', 'latin1')]), b, 0x55);
  const mkMp3 = (b = 4096) => pad(Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0])]), b, 0x66);
  const mkMp3Raw = (b = 4096) => pad(Buffer.from([0xFF, 0xFB, 0x90, 0x00]), b, 0x77);
  const mkWav = (bytes = 4096) => {
    const b = Buffer.alloc(Math.max(bytes, 64), 0x11);
    b.write('RIFF', 0, 'latin1');
    b.writeUInt32LE(b.length - 8, 4);
    b.write('WAVEfmt ', 8, 'latin1');
    return b;
  };
  const AU = CH(9);
  const voice = mkWebm(30000);
  const vj = await cj({ installId: AU, nick: 'голос', text: '',
    att: { mime: 'image/webp', b64: voice.toString('base64') } });
  const mv = ((await feedJ(vj.seq - 1)).messages || [])[0];
  check('голосовое webm принято, хотя mime заявлен картинкой: тип решают байты',
    !!(mv && mv.att) && mv.att.kind === 'audio' && mv.att.mime === 'audio/webm'
    && mv.att.url === `/chat/att/${vj.seq}.webm` && mv.att.bytes === voice.length, mv && mv.att);
  check('файл звука лёг в ОТДЕЛЬНЫЙ каталог voice и с расширением .webm',
    fs.existsSync(path.join(DATA, 'voice', vj.seq + '.webm'))
    && !fs.existsSync(path.join(DATA, 'att', vj.seq + '.webm'))
    && !fs.existsSync(path.join(DATA, 'att', vj.seq + '.webp')),
    fs.readdirSync(path.join(DATA, 'voice')).slice(0, 5));
  const vGot = await fetch(`${BASE}${mv.att.url}`, { headers: { 'X-League-Key': SECRET } });
  const vBuf = Buffer.from(await vGot.arrayBuffer());
  check('звук отдан как audio/webm, с nosniff, без кеша на диске и с ETag; байты совпали',
    vGot.status === 200 && vGot.headers.get('content-type') === 'audio/webm'
    && vGot.headers.get('x-content-type-options') === 'nosniff'
    && vGot.headers.get('cache-control') === 'no-store'
    && /^"\d+-\d+"$/.test(vGot.headers.get('etag') || '') && vBuf.equals(voice),
    { st: vGot.status, ct: vGot.headers.get('content-type'),
      sniff: vGot.headers.get('x-content-type-options'), cc: vGot.headers.get('cache-control'),
      etag: vGot.headers.get('etag'), len: vBuf.length });
  check('расширение в адресе не декоративное: тот же номер с чужим расширением — 404',
    (await rawGet(`/chat/att/${vj.seq}.mp3`)).status === 404);
  check('картинка по-прежнему отдаётся как image/webp, а не как звук',
    (await fetch(`${BASE}/chat/att/${aj.seq}.webp`, { headers: { 'X-League-Key': SECRET } }))
      .headers.get('content-type') === 'image/webp');

  // Остальные форматы белого списка. Каждый — со своей сигнатурой и своим типом отдачи;
  // wav здесь главный: он начинается тем же `RIFF`, что и webp, и различает их только
  // слово на 8-м байте. Спутать их — значит отдать звук как картинку.
  const forms = [
    ['ogg (OggS) — Firefox и «телеграмный» голос', mkOgg(2048), 'ogg', 'audio/ogg'],
    ['m4a (ftyp) — Safari и iOS', mkM4a(2048), 'm4a', 'audio/mp4'],
    ['mp3 с тегом ID3', mkMp3(2048), 'mp3', 'audio/mpeg'],
    ['mp3 без тега, по кадровой синхронизации', mkMp3Raw(2048), 'mp3', 'audio/mpeg'],
    ['wav — тот же RIFF, что у webp, но слово WAVE', mkWav(2048), 'wav', 'audio/wav'],
  ];
  for (const [label, buf, ext, mime] of forms) {
    const j = await cj({ installId: AU, nick: 'голос', text: ext,
      att: { b64: buf.toString('base64') } });
    const mm = ((await feedJ(j.seq - 1)).messages || [])[0];
    const got = await rawGet(`/chat/att/${j.seq}.${ext}`);
    check(`принят ${label}`,
      !!(mm && mm.att) && mm.att.kind === 'audio' && mm.att.mime === mime
      && mm.att.url === `/chat/att/${j.seq}.${ext}`
      && got.status === 200 && got.headers['content-type'] === mime,
      { att: mm && mm.att, отдача: got.status, ct: got.headers['content-type'] });
  }
  // Пределы. У звука он СВОЙ и НИЖЕ картиночного: голос — это время, а не пиксели
  // (512 КБ ≈ 120 секунд Opus на 32 кбит/с), а худший случай кольца из 1000 сообщений
  // считается умножением: 500 МБ вместо 2 ГиБ. Проверяется с трёх сторон: граница ровно,
  // граница плюс байт, и что пределы у звука и картинки РАЗНЫЕ.
  const AU2 = CH(10), KB = 1024, MB = 1024 * 1024;
  check('звук ровно 512 КБ принят',
    (await chat({ installId: AU2, nick: 'голос', text: 'ровно 512 КБ',
      att: { b64: mkWebm(512 * KB).toString('base64') } })).status === 200);
  const vOver = await chat({ installId: AU2, nick: 'голос', text: 'жирно',
    att: { b64: mkWebm(512 * KB + 1).toString('base64') } });
  const vOverJ = await vOver.json();
  check('звук 512 КБ + 1 байт отвергнут 413, и в отказе сказано, что делать',
    vOver.status === 413 && /512 КБ/.test(vOverJ.error || '') && !!vOverJ.hint, vOverJ);
  const audio1M = await chat({ installId: AU2, nick: 'голос', text: '1 МБ звуком',
    att: { b64: mkWebm(MB).toString('base64') } });
  const pic1M = await chat({ installId: AU2, nick: 'голос', text: '1 МБ картинкой',
    att: { b64: mkWebp(MB).toString('base64') } });
  check('пределы РАЗНЫЕ: 1 МБ картинки проходит, 1 МБ звука — нет',
    pic1M.status === 200 && audio1M.status === 413,
    { картинка: pic1M.status, звук: audio1M.status });
  // Длительность — ПОДСКАЗКА отправителя: проверить её приёмнику нечем (webm от
  // MediaRecorder длительности в заголовке не несёт вовсе). Значит: разумный диапазон
  // сохраняем, вранье выбрасываем, и ни в один расчёт она не идёт.
  const msJ = await cj({ installId: AU2, nick: 'голос', text: 'с длительностью',
    att: { b64: mkWebm(4000).toString('base64'), dur: 74 } });
  const msFeed = ((await feedJ(msJ.seq - 1)).messages || [])[0];
  check('длительность (секунды) сохранена и отдана как подсказка', msFeed.att.dur === 74, msFeed.att);
  const msBad = await cj({ installId: AU2, nick: 'голос', text: 'врёт про длительность',
    att: { b64: mkWebm(4000).toString('base64'), dur: 9e9 } });
  const msBadFeed = ((await feedJ(msBad.seq - 1)).messages || [])[0];
  check('длительность вне разумного диапазона выброшена, а сообщение принято',
    msBadFeed.att && msBadFeed.att.dur === undefined, msBadFeed.att);
  const msPic = await cj({ installId: AU2, nick: 'голос', text: 'картинка с длительностью',
    att: { b64: mkWebp(3000).toString('base64'), dur: 50 } });
  const msPicFeed = ((await feedJ(msPic.seq - 1)).messages || [])[0];
  check('у картинки длительности нет вообще, чем бы её ни прислали',
    msPicFeed.att && msPicFeed.att.dur === undefined, msPicFeed.att);
  check('тело чата больше 3 МБ отвергнуто до разбора вложения',
    [413, 0].includes(await chat({ installId: AU2, nick: 'голос', text: 'x',
      att: { b64: mkWebm(4 * MB).toString('base64') } }).then(r => r.status, () => 0)));
  // Незнакомый формат больше не отказ — он файл. Но тип, который заявил отправитель, при
  // отдаче не используется НИКОГДА: ни pdf, ни «просто строка» не станут звуком.
  const pdf = pad(Buffer.from('%PDF-1.7\n', 'latin1'), 300, 0x20);
  const pdfJ = await cj({ installId: AU2, nick: 'голос', text: 'pdf',
    att: { mime: 'audio/webm', b64: pdf.toString('base64'), name: 'doc.pdf' } });
  const pdfFeed = ((await feedJ(pdfJ.seq - 1)).messages || [])[0];
  check('pdf с заявленным audio/webm не стал звуком: kind=file, отдача octet-stream',
    pdfFeed.att.kind === 'file' && pdfFeed.att.ext === 'pdf'
    && (await rawGet(pdfFeed.att.url)).headers['content-type'] === 'application/octet-stream',
    pdfFeed.att);
  const strJ = await cj({ installId: AU2, nick: 'голос', text: 'не звук',
    att: { mime: 'audio/ogg', b64: Buffer.from('это не звук, а строка').toString('base64') } });
  const strFeed = ((await feedJ(strJ.seq - 1)).messages || [])[0];
  check('строка под видом ogg тоже не звук, а файл с безопасным именем',
    strFeed.att.kind === 'file' && strFeed.att.ext === 'bin', strFeed.att);
  check('список вложением (два в одном) отвергнут: одно сообщение — одно вложение',
    (await chat({ installId: AU2, nick: 'голос', text: 'два',
      att: [{ b64: mkWebm(2048).toString('base64') }, { b64: mkWebp(2048).toString('base64') }] })).status === 400);
  // 🪤 Тот самый баг, который в этом файле уже был с webp: удаление собирало путь своей
  // строкой `${seq}.webp`. С приходом второго расширения сообщение уходило из журнала, а
  // файл оставался на ноде НАВСЕГДА — ссылки на него больше никто не отдаст.
  const AU3 = CH(11);
  const dv = await cj({ installId: AU3, nick: 'голос', text: 'удалить голосовое',
    att: { b64: mkWebm(5000).toString('base64') } });
  const dvFile = path.join(DATA, 'voice', dv.seq + '.webm');
  check('файл голосового на месте до удаления', fs.existsSync(dvFile), dv.seq);
  const dvDel = await delJ(`/chat/${dv.seq}?installId=${AU3}`);
  check('выпало голосовое → файла нет: путь удаления знает и расширение, и каталог',
    dvDel.st === 200 && dvDel.j.removed === 1 && !fs.existsSync(dvFile),
    { отказ: dvDel, файл: fs.existsSync(dvFile) });
  // Голосовых — 12 в час на установку. Минутный предел на сообщения от них не защищает:
  // 20 в минуту по 512 КБ это 10 МБ с одной установки за минуту.
  const AUH = CH(15);
  const hCodes = [];
  for (let i = 0; i < 13; i++) {
    hCodes.push((await chat({ installId: AUH, nick: 'болтун', text: 'голос ' + i,
      att: { b64: mkWebm(2048).toString('base64') } })).status);
  }
  const hLast = await chat({ installId: AUH, nick: 'болтун', text: 'ещё голос',
    att: { b64: mkWebm(2048).toString('base64') } });
  const hLastJ = await hLast.json();
  check('первые 12 голосовых в час прошли, 13-е — 429 с внятным текстом',
    hCodes.slice(0, 12).every(s => s === 200) && hCodes[12] === 429
    && /в час/.test(hLastJ.error || '') && !!hLastJ.hint, { коды: hCodes.join(','), отказ: hLastJ });
  check('квота голоса не задевает картинки: та же установка отправляет картинку',
    (await chat({ installId: AUH, nick: 'болтун', text: 'зато картинка',
      att: { b64: mkWebp(3000).toString('base64') } })).status === 200);
  check('и текст без вложения тоже проходит', (await chat({ installId: AUH, nick: 'болтун',
    text: 'и текстом можно' })).status === 200);

  // ── Произвольные файлы ─────────────────────────────────────────────────────
  // Владелец попросил «отправку не только картинок, а также markdown, скиллы — вообще
  // любые небольшие файлы». Сигнатуры у такого файла нет и быть не может, поэтому её место
  // занимает другая гарантия: заявленный тип НЕ ИСПОЛЬЗУЕТСЯ при отдаче вообще. Проверяется
  // именно это — байты на скачивание, безопасное имя, и что файл не может выдать себя за
  // проверяемое медиа. Дашборд живёт на том же источнике, что ручки денежных шлюзов.
  console.log('\nвложения: произвольные файлы:');
  const FL = CH(16);
  const md = Buffer.from('# Скилл\n\nтекст файла, а не картинка\n', 'utf8');
  const fj = await cj({ installId: FL, nick: 'файлы', text: 'вот скилл',
    att: { mime: 'text/markdown', b64: md.toString('base64'), name: 'skill.md' } });
  const fFeed = ((await feedJ(fj.seq - 1)).messages || [])[0];
  check('markdown принят: kind=file, расширение из имени, само имя в выдаче',
    fFeed.att && fFeed.att.kind === 'file' && fFeed.att.ext === 'md'
    && fFeed.att.name === 'skill.md' && fFeed.att.url === `/chat/att/${fj.seq}.md`, fFeed.att);
  check('файл лёг в свой каталог files, а не к картинкам и не к звуку',
    fs.existsSync(path.join(DATA, 'files', fj.seq + '.md'))
    && !fs.existsSync(path.join(DATA, 'att', fj.seq + '.md')), fs.readdirSync(path.join(DATA, 'files')));
  const fGot = await rawGet(fFeed.att.url);
  check('файл отдан байтами на скачивание: octet-stream, attachment, nosniff, no-store',
    fGot.status === 200 && fGot.headers['content-type'] === 'application/octet-stream'
    && /^attachment; filename="skill\.md"/.test(fGot.headers['content-disposition'] || '')
    && fGot.headers['x-content-type-options'] === 'nosniff'
    && fGot.headers['cache-control'] === 'no-store' && fGot.body === md.toString('utf8'),
    { ct: fGot.headers['content-type'], cd: fGot.headers['content-disposition'] });
  // Имя приходит от человека и уезжает в заголовок и в папку загрузок владельца (Windows).
  const named = async (name, text) => {
    const j = await cj({ installId: FL, nick: 'файлы', text,
      att: { b64: md.toString('base64'), name } });
    const f = ((await feedJ(j.seq - 1)).messages || [])[0];
    return { seq: j.seq, att: (f || {}).att || {} };
  };
  const upDir = await named('../../secret', 'обход каталога');
  check('слэши из имени вычищены, а сам файл лежит под номером сообщения — обход каталога'
    + ' именем не собрать',
    !/[\\/]/.test(upDir.att.name)
    && fs.existsSync(path.join(DATA, 'files', `${upDir.seq}.${upDir.att.ext}`)),
    { name: upDir.att.name, ext: upDir.att.ext });
  const nul = await named('nul.md', 'зарезервированное имя Windows');
  check('зарезервированное имя Windows (nul.md) обезврежено — в этом проекте такой файл'
    + ' уже ломал git', nul.att.name !== 'nul.md' && /nul\.md$/.test(nul.att.name), nul.att.name);
  const hdr = await named('и"вот;\r\nтак.md', 'кавычки и перевод строки');
  const hdrGot = await rawGet(hdr.att.url);
  check('кавычки, точка с запятой и перевод строки из имени убраны — заголовок цел',
    !/["\r\n;]/.test(hdr.att.name) && hdrGot.status === 200
    && /filename\*=UTF-8''/.test(hdrGot.headers['content-disposition'] || ''),
    { name: hdr.att.name, cd: hdrGot.headers['content-disposition'] });
  const long = await named('я'.repeat(400) + '.md', 'длинное имя');
  check('слишком длинное имя обрезано, расширение сохранено',
    long.att.name.length <= 120 && long.att.name.endsWith('.md'), long.att.name.length);
  const noName = await named('', 'без имени');
  check('без имени файл всё равно принят и получил своё',
    !!noName.att.name && noName.att.ext === 'bin', noName.att);
  // 🪤 Символы направления письма — именно ими подменяется ВИДИМОЕ имя файла: на экране
  // одно, на диске другое. Chromium вырезает их у себя не случайно.
  const bidi = await named('отчет' + String.fromCharCode(0x202E) + 'dm.md', 'подмена имени');
  check('символы направления письма из имени вырезаны',
    !/\p{Cf}/u.test(bidi.att.name), JSON.stringify(bidi.att.name));
  // 🪤 encodeURIComponent оставляет `'()*` как есть, а апостроф ломает саму рамку
  // `кодировка'язык'значение` — файл «it's mine.md» давал бы битый заголовок.
  const apos = await named("it's mine.md", 'апостроф в имени');
  const aposGot = await rawGet(apos.att.url);
  const cd = aposGot.headers['content-disposition'] || '';
  check('апостроф в имени уехал в процентной форме, рамка filename* цела',
    aposGot.status === 200 && /%27/.test(cd) && !/'/.test(cd.split("UTF-8''")[1] || ''), cd);
  // Главное правило: файл не может выдать себя за ПРОВЕРЯЕМОЕ медиа — иначе клиент
  // отрисует его картинкой или плеером, а байты мы не подтверждали.
  const fake = await chat({ installId: FL, nick: 'файлы', text: 'html под видом картинки',
    att: { b64: Buffer.from('<svg onload=alert(1)>').toString('base64'), name: 'evil.webp' } });
  const fakeJ = await fake.json();
  check('файл с расширением из белого списка, но без нужных байтов — 415',
    fake.status === 415 && /\.webp/.test(fakeJ.error || '') && !!fakeJ.hint, fakeJ);
  check('он же под своим расширением принимается и уезжает байтами',
    (await chat({ installId: FL, nick: 'файлы', text: 'svg как файл',
      att: { b64: Buffer.from('<svg onload=alert(1)>').toString('base64'),
        name: 'pic.svg' } })).status === 200);
  check('файл ровно 512 КБ принят, 512 КБ + 1 байт — 413',
    (await chat({ installId: FL, nick: 'файлы', text: 'ровно предел',
      att: { b64: Buffer.alloc(512 * 1024, 0x41).toString('base64'), name: 'big.txt' } })).status === 200
    && (await chat({ installId: FL, nick: 'файлы', text: 'через предел',
      att: { b64: Buffer.alloc(512 * 1024 + 1, 0x41).toString('base64'), name: 'big.txt' } })).status === 413);
  // Отдача вложений была единственной ручкой БЕЗ предела частоты, при том что читает файл
  // с диска. Предел на ключ, порог выше полной перерисовки страницы (200 запросов).
  // Проверка идёт ПОСЛЕДНЕЙ среди вложений: она выбирает минутную квоту целиком, и всё, что
  // стояло бы после неё, получало бы 429 вместо своего ответа.
  const attCodes = [];
  for (let i = 0; i < 14; i++) {
    const batch = await Promise.all(Array.from({ length: 50 }, () => rawGet(fFeed.att.url)));
    attCodes.push(...batch.map(r => r.status));
  }
  const att429 = attCodes.filter(c => c === 429).length;
  check('на отдаче вложений есть предел частоты, и он упирается',
    att429 > 0 && attCodes.filter(c => c === 200).length <= 600,
    { отдано: attCodes.filter(c => c === 200).length, отказов: att429 });

  console.log('\nфлуд, параллель, курсор:');
  const FLOOD = CH(4);
  const codes = [];
  for (let i = 0; i < 21; i++) codes.push((await chat({ installId: FLOOD, nick: 'flood', text: 'msg ' + i })).status);
  check(`первые 20 сообщений в минуту прошли, 21-е — 429`,
    codes.slice(0, 20).every(s => s === 200) && codes[20] === 429, codes.join(','));
  const seqAfterFlood = fs.readFileSync(CHAT, 'utf8').trim().split('\n')
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(m => m && m.installId === FLOOD).length;
  check('в журнал попали ровно 20 сообщений флудера, 21-е не записано', seqAfterFlood === 20, seqAfterFlood);

  // Одновременные POST: номер не имеет права повториться, сообщение — пропасть.
  const PAR = CH(5);
  const parBase = (await cj({ installId: PAR, nick: 'par', text: 'старт' })).seq;
  const many = await Promise.all(Array.from({ length: 15 }, (_, i) =>
    cj({ installId: PAR, nick: 'par', text: 'парал ' + i })));
  const seqs = many.map(x => x.seq);
  check('одновременные сообщения получили РАЗНЫЕ seq', new Set(seqs).size === 15, seqs.join(','));
  check('seq выданы подряд, без дыр и повторов',
    Math.min(...seqs) === parBase + 1 && Math.max(...seqs) === parBase + 15,
    `${Math.min(...seqs)}..${Math.max(...seqs)} от ${parBase}`);
  const parFeed = await (await feed(parBase)).json();
  check('ни одно одновременное сообщение не потеряно', parFeed.messages.length === 15, parFeed.messages.length);
  check('журнал не порвался: все строки читаемы',
    fs.readFileSync(CHAT, 'utf8').trim().split('\n').every(l => { try { JSON.parse(l); return true; } catch { return false; } }));

  // Курсор. Клиент опрашивает ленту по последнему виденному seq, и ему нельзя
  // отдавать ни уже прочитанное, ни «перескок» через неотданное.
  const SINCE = CH(6);
  const sBase = (await cj({ installId: SINCE, nick: 'since', text: 'до' })).seq;
  const emptyFeed = await (await feed(sBase)).json();
  check('since= не возвращает уже отданное, курсор не сбрасывается',
    emptyFeed.messages.length === 0 && emptyFeed.seq === sBase, emptyFeed);
  const sAfter = (await cj({ installId: SINCE, nick: 'since', text: 'после' })).seq;
  const oneFeed = await (await feed(sBase)).json();
  check('since= отдаёт только новое',
    oneFeed.messages.length === 1 && oneFeed.messages[0].seq === sAfter, oneFeed.messages.map(m => m.seq));
  check('мусор в since= не роняет ленту и читается как 0',
    (await (await feed('-5')).json()).messages.length > 0
    && (await (await feed('../etc')).json()).messages.length > 0);

  // Битый журнал. Усечённая строка — это наше собственное падение посреди записи,
  // и выдача не имеет права из-за неё умереть.
  const SPOIL = CH(7);
  const spBase = (await cj({ installId: SPOIL, nick: 'spoil', text: 'до порчи' })).seq;
  const beforeSpoil = (await (await feed(spBase - 3)).json()).messages.length;
  fs.writeFileSync(CHAT, fs.readFileSync(CHAT, 'utf8') + '{"seq":424242,"text":"обрез\nвообще не json\n');
  const spoiled = await feed(spBase - 3);
  const spoiledJ = await spoiled.json();
  check('битый и усечённый chat.ndjson не роняют выдачу',
    spoiled.status === 200 && spoiledJ.messages.length === beforeSpoil,
    { статус: spoiled.status, было: beforeSpoil, стало: spoiledJ.messages.length });
  const afterSpoil = await chat({ installId: SPOIL, nick: 'spoil', text: 'после порчи' });
  check('после битого журнала приём продолжается', afterSpoil.status === 200);
  check('битые строки при следующей записи выметены',
    !fs.readFileSync(CHAT, 'utf8').includes('вообще не json'));

  console.log('\nчат переживает перезапуск:');
  const REST = CH(8);
  const beforeRestart = (await cj({ installId: REST, nick: 'restart', text: 'перед рестартом' })).seq;
  if (!await restart()) { console.log('приёмник не поднялся после рестарта:\n' + out); }
  const afterRestart = await cj({ installId: REST, nick: 'restart', text: 'после рестарта' });
  check('seq не сбросился при перезапуске', afterRestart.seq === beforeRestart + 1,
    { было: beforeRestart, стало: afterRestart.seq });
  check('журнал перезапуск пережил',
    (await (await feed(beforeRestart - 1)).json()).messages.length === 2);
  // Файл счётчика может потеряться (перенос каталога, чистка) — номера всё равно
  // не имеют права пойти по второму кругу.
  fs.rmSync(path.join(DATA, 'chat-seq'));
  if (!await restart()) { console.log('приёмник не поднялся после рестарта без счётчика:\n' + out); }
  const recovered = await cj({ installId: REST, nick: 'restart', text: 'без файла счётчика' });
  check('потерянный файл счётчика восстановлен по журналу, номера не повторяются',
    recovered.seq === afterRestart.seq + 1, { было: afterRestart.seq, стало: recovered.seq });

  console.log('\nаватарка в срезе:');
  // Аватарка едет полем среза, отдельной ручки у неё нет. Правило: картинка не имеет
  // права утопить цифры — негодная выбрасывается, срез принимается. Предел мерится в
  // ДЕКОДИРОВАННЫХ байтах, и граница здесь проверяется с двух сторон намеренно: пока
  // приёмник сравнивал длину строки data-URL, фактический потолок был ~15 КБ байт.
  // Хаб принимал 20 КБ и клал себе, приёмник молча выбрасывал их из среза — «у себя
  // лицо есть, у соседей нет», и поймать это можно было только сквозняком.
  const avaBuf = mkWebp(4000);
  const edgeBuf = mkWebp(20 * 1024);          // ровно предел
  const overBuf = mkWebp(20 * 1024 + 1);      // предел плюс один байт
  const pngAva = 'data:image/webp;base64,' + notWebp.toString('base64');
  const dataUrl = b => 'data:image/webp;base64,' + b.toString('base64');
  const avaOf = p => Buffer.from(String(p.avatar || '').split(',')[1] || '', 'base64');
  const peerB = async () => ((await (await peers(A)).json()).peers.find(p => p.installId === B)) || {};
  backdate(B);
  const rAva = await post({ ...mkSlice(B, 'monty'), avatar: dataUrl(avaBuf) });
  check('срез с аватаркой принят', rAva.status === 200, await rAva.json());
  check('аватарка сохранена как webp data-URL',
    (sliceOf(B).avatar || '').startsWith('data:image/webp;base64,'), (sliceOf(B).avatar || '').slice(0, 32));
  const pB = await peerB();
  check('аватарка уехала соседям в /peers', pB.avatar === sliceOf(B).avatar);
  // Сравнением, а не на глаз: приёмник пересобирает base64 сам, и до соседа обязаны
  // доехать ТЕ ЖЕ байты, а не «похожая» картинка.
  check('байты аватарки у соседа совпадают с отправленными',
    avaOf(pB).equals(avaBuf), { отдано: avaBuf.length, доехало: avaOf(pB).length });

  backdate(B);
  const rEdge = await post({ ...mkSlice(B, 'monty'), avatar: dataUrl(edgeBuf) });
  const pEdge = await peerB();
  check('аватарка ровно 20 КБ ДЕКОДИРОВАННЫХ байт принята',
    rEdge.status === 200 && !!sliceOf(B).avatar,
    { статус: rEdge.status, байт: edgeBuf.length, строка: (sliceOf(B).avatar || '').length });
  check('её байты у соседа тоже совпадают с отправленными',
    avaOf(pEdge).equals(edgeBuf), { отдано: edgeBuf.length, доехало: avaOf(pEdge).length });
  backdate(B);
  const rOver = await post({ ...mkSlice(B, 'monty'), avatar: dataUrl(overBuf) });
  check('аватарка 20 КБ + 1 байт выброшена, а срез принят',
    rOver.status === 200 && !sliceOf(B).avatar,
    { статус: rOver.status, байт: overBuf.length, аватар: (sliceOf(B).avatar || '').length });
  backdate(B);
  const rFat = await post({ ...mkSlice(B, 'monty'), avatar: dataUrl(mkWebp(30 * 1024)) });
  check('аватарка 30 КБ отсечена ещё до декодирования, срез принят',
    rFat.status === 200 && !sliceOf(B).avatar, { статус: rFat.status });
  backdate(B);
  const rPng = await post({ ...mkSlice(B, 'monty'), avatar: pngAva });
  check('не-webp аватарка выброшена по байтам, срез принят',
    rPng.status === 200 && !sliceOf(B).avatar, { статус: rPng.status });
  backdate(B);
  const rJunk = await post({ ...mkSlice(B, 'monty'), avatar: 'https://example.com/lицо.webp' });
  check('аватарка не data-URL выброшена, срез принят', rJunk.status === 200 && !sliceOf(B).avatar);

  // ── Надгробия: удаление доезжает до соседей ────────────────────────────────
  // Протокол чтения умел только «добавилось»: клиент просит «новее номера N» и дописывает
  // полученное в конец. Значит удалённое сообщение оставалось на экране у ВСЕХ, кроме
  // того, кто удалял (он перечитывает ленту сам), и висело так до перезагрузки страницы —
  // то есть кнопка удаления для остальных пятерых не работала вообще.
  // Курсор надгробий — СВОЙ монотонный счётчик `gseq`: по времени фильтровать нельзя (ход
  // часов назад спрячет надгробие навсегда), по номеру сообщения тем более — удалённый
  // номер по определению НИЖЕ курсора клиента. Обрезка журнала надгробий не даёт, она
  // описывается одним числом `firstSeq`. А там, где перечислить пропавшее нельзя, приходит
  // `cold: true` — пустой список вместо признания читался бы как «ничего не пропало».
  console.log('\nнадгробия: удаление доезжает до соседей:');
  const T1 = CH(12), T2 = CH(13);
  const feedG = async (since, gseq) => (await fetch(`${BASE}/chat?since=${since}&gseq=${gseq}`,
    { headers: { 'X-League-Key': SECRET } })).json();
  const goneS = j => (j.gone || []).map(g => g.seq);
  const t0 = (await cj({ installId: T1, nick: 'надгробия', text: 'останется' })).seq;
  const t1 = (await cj({ installId: T1, nick: 'надгробия', text: 'уйдёт' })).seq;
  const base = await feedJ(t1);
  check('форма ответа: прежние поля не переименованы, рядом с ними gseq, firstSeq, cold, gone',
    typeof base.seq === 'number' && Array.isArray(base.messages) && base.seq === t1
    && Number.isInteger(base.gseq) && Number.isInteger(base.firstSeq)
    && base.cold === false && Array.isArray(base.gone),
    { seq: base.seq, gseq: base.gseq, firstSeq: base.firstSeq, cold: base.cold });
  check('firstSeq — дно журнала, а не единица и не курсор клиента',
    base.firstSeq === (await feedJ(0)).messages[0].seq,
    { firstSeq: base.firstSeq, дно: (await feedJ(0)).messages[0].seq });
  const g0 = base.gseq;
  const dOne = await delJ(`/chat/${t1}?installId=${T1}`);
  check('удаление отвечает, записалось ли надгробие: молчание тут = соседи не узнают никогда',
    dOne.st === 200 && dOne.j.tombs === true, dOne.j);
  const g1 = await feedG(t1, g0);
  check('одиночное удаление доезжает: номер, время и свой gseq',
    goneS(g1).includes(t1) && g1.gseq === g0 + 1
    && g1.gone.every(x => Number.isInteger(x.seq) && Number.isInteger(x.gseq)
      && Number.isFinite(Date.parse(x.at))), g1.gone);
  check('сообщения в ленте больше нет, а курсор клиенту не откатывают',
    !g1.messages.some(m => m.seq === t1) && g1.seq === t1, { seq: g1.seq });
  check('живое сообщение того же автора в надгробия не попало', !goneS(g1).includes(t0), g1.gone);
  const gAgain = await feedG(t1, g1.gseq);
  check('с обновлённым gseq то же надгробие второй раз не приезжает, и это НЕ cold',
    gAgain.gone.length === 0 && gAgain.cold === false, gAgain);
  const t2 = (await cj({ installId: T1, nick: 'надгробия', text: 'удалю сразу' })).seq;
  await del(`/chat/${t2}?installId=${T1}`);
  check('надгробие приезжает и когда его номер ВЫШЕ курсора сообщений: фильтр по gseq, а не'
    + ' по seq — иначе удалённое (оно всегда ниже курсора) не отдавалось бы никогда',
    goneS(await feedG(t2 - 2, g1.gseq)).includes(t2));
  if (!await restart()) console.log('приёмник не поднялся после надгробий:\n' + out);
  const gRestart = await feedG(t2, g0);
  check('надгробия лежат в ФАЙЛЕ и переживают перезапуск: удалённое не воскресает у соседей',
    goneS(gRestart).includes(t1) && goneS(gRestart).includes(t2)
    && fs.existsSync(path.join(DATA, 'chat-gone.json')), gRestart.gone);

  // Массовые пути. Их два, и оба обязаны оставлять след: «убрать мои» — это кнопка в
  // вкладке, `all=1` — необратимая чистка журнала целиком.
  const t3 = (await cj({ installId: T2, nick: 'надгробия', text: 'мои 1' })).seq;
  const t4 = (await cj({ installId: T2, nick: 'надгробия', text: 'мои 2' })).seq;
  const gBeforeMine = (await feedJ(t4)).gseq;
  const dMineT = await delJ(`/chat?installId=${T2}`);
  const gMine = await feedG(t4, gBeforeMine);
  check('«все свои» ставит надгробие на КАЖДОЕ снятое сообщение и подтверждает запись',
    dMineT.st === 200 && dMineT.j.tombs === true
    && goneS(gMine).includes(t3) && goneS(gMine).includes(t4), gMine.gone);
  check('счётчик надгробий монотонный: два снятых сообщения — два новых gseq',
    gMine.gseq === gBeforeMine + 2, { было: gBeforeMine, стало: gMine.gseq });
  const beforeAll = (await feedJ(0)).messages.map(m => m.seq);
  const gBeforeAll = (await feedJ(0)).gseq;
  const tAll = (await cj({ installId: T2, nick: 'надгробия', text: 'перед сносом всего' })).seq;
  const dAllT = await delJ('/chat?all=1');
  const gAll = await feedG(tAll, gBeforeAll);
  check('all=1 ставит надгробия на весь журнал, а не вычищает его молча',
    dAllT.st === 200 && gAll.messages.length === 0 && goneS(gAll).includes(tAll)
    && beforeAll.every(s => goneS(gAll).includes(s)),
    { было: beforeAll.length, надгробий: gAll.gone.length,
      потеряно: beforeAll.filter(s => !goneS(gAll).includes(s)).slice(0, 5) });
  check('пустой журнал даёт firstSeq = 0, а не единицу и не курсор',
    gAll.firstSeq === 0, gAll.firstSeq);

  // Срок жизни — 7 суток, и забытое надгробие поднимает «курсор полноты» (cut): клиенту с
  // курсором ниже него отвечают cold, а не пустым списком. Подкручиваем файл, а не ждём
  // неделю: тем же приёмом выше проверялась серия отказов по просадке.
  const GONEF = path.join(DATA, 'chat-gone.json');
  const gFile = JSON.parse(fs.readFileSync(GONEF, 'utf8'));
  check('в файле надгробий: счётчик, курсор полноты и записи с номером, временем, причиной',
    Number.isInteger(gFile.gseq) && Number.isInteger(gFile.cut) && gFile.tombs.length > 0
    && Number.isInteger(gFile.tombs[0].gseq) && !!gFile.tombs[0].why
    && Number.isFinite(Date.parse(gFile.tombs[0].at)), gFile.tombs[0]);
  const OLDT = 424242, FRESHT = 424243;
  const isoAgo = ms => new Date(Date.now() - ms).toISOString();
  fs.writeFileSync(GONEF, JSON.stringify({ v: 2, gseq: 40, cut: 0, tombs: [
    { seq: OLDT, at: isoAgo(8 * 864e5), gseq: 30, why: 'one' },
    { seq: FRESHT, at: isoAgo(6 * 864e5), gseq: 40, why: 'one' }] }));
  if (!await restart()) console.log('приёмник не поднялся после подкрутки надгробий:\n' + out);
  const gTtl = await feedG(0, 0);
  check('надгробие старше 7 суток забыто, младше — отдаётся',
    !goneS(gTtl).includes(OLDT) && goneS(gTtl).includes(FRESHT), gTtl.gone);
  check('забытое не проглатывается молча: курсор ниже забытого → cold с причиной',
    gTtl.cold === true && /забыт/.test(gTtl.coldWhy || ''), { cold: gTtl.cold, why: gTtl.coldWhy });
  check('курсор выше забытого → cold не ставится: полноту гарантируем',
    (await feedG(0, 30)).cold === false && (await feedG(0, 40)).cold === false);
  const gHigh = await feedG(0, 999);
  check('курсор надгробий ВЫШЕ нашего счётчика → cold: состояние приёмника обнулялось',
    gHigh.cold === true && /выше/.test(gHigh.coldWhy || ''), gHigh.coldWhy);
  const gAfterTtl = JSON.parse(fs.readFileSync(GONEF, 'utf8'));
  check('просроченное вычищено из файла, курсор полноты поднят, счётчик не откатился',
    !gAfterTtl.tombs.some(g => g.seq === OLDT) && gAfterTtl.cut === 30 && gAfterTtl.gseq === 40,
    { cut: gAfterTtl.cut, gseq: gAfterTtl.gseq, номера: gAfterTtl.tombs.map(g => g.seq) });
  check('в журнале ноды сказано, что надгробия забыты и почему', /надгробий забыто/.test(out));

  // Клиент, который догнал журнал, не должен ни перечитывать его, ни получать cold: иначе
  // вкладка встанет в вечный цикл перезагрузок ленты. Проверяем обе стороны и отдельно
  // «дно журнала» — единственное, чем описывается обрезка по лимиту.
  const R1 = CH(14);
  const rs = [];
  for (let i = 0; i < 3; i++) {
    rs.push((await cj({ installId: R1, nick: 'курсор', text: 'после сноса ' + i })).seq);
  }
  const nowG = (await feedJ(0)).gseq;
  const caught = await feedG(rs[2], nowG);
  check('догнавший клиент: пустые надгробия, cold нет, курсор на месте',
    caught.gone.length === 0 && caught.cold === false && caught.seq === rs[2], caught);
  const deep = await feedG(1, nowG);
  check('курсор сообщений ниже дна журнала сам по себе cold НЕ вызывает: дыру описывает'
    + ' firstSeq, а не признак «перечитай»',
    deep.cold === false && deep.firstSeq === rs[0] && deep.messages.length === 3,
    { cold: deep.cold, firstSeq: deep.firstSeq, дно: rs[0] });
  const zero = await feedG(0, nowG);
  check('since=0 отдаёт журнал целиком и не требует ничего перечитывать',
    !zero.cold && zero.messages.length === 3, { cold: zero.cold, n: zero.messages.length });
  check('мусор в gseq= читается как ноль и ленту не роняет',
    (await feedG(0, 'ЗЛО')).cold !== undefined && (await feedG(0, -7)).messages.length === 3);

  // ── Нет места на ноде: отказ вместо падения ────────────────────────────────
  // 🔴 Запись вложения была обёрнута в обработку ошибки, а следом шли НЕЗАЩИЩЁННЫЕ
  // синхронные записи: выдача номера и перезапись журнала. Обработчика uncaughtException в
  // файле не было ни одного, то есть при ENOSPC исключение уходило наверх и роняло процесс:
  // вставал и чат, и обмен срезами у всех шестерых. Чужая переписка при этом не терялась
  // (tmp+rename оставляет журнал целым), но сервис падал вместо честного отказа.
  // ENOSPC на живой машине не устроить, а вот подставить КАТАЛОГ на место времянки — можно:
  // запись падает с EISDIR, а обработчик у приёмника ровно тот же.
  console.log('\nнет места на ноде: отказ вместо падения:');
  const NOSP = CH(17);
  fs.mkdirSync(CHAT + '.tmp');
  const noJournal = await chat({ installId: NOSP, nick: 'диск', text: 'журнал не запишется' });
  const noJournalJ = await noJournal.json();
  check('журнал не записался → 507 с внятным текстом, а не падение процесса',
    noJournal.status === 507 && /журнал/.test(noJournalJ.error || '') && !!noJournalJ.hint,
    { st: noJournal.status, j: noJournalJ });
  const orphTry = await chat({ installId: NOSP, nick: 'диск', text: 'с вложением',
    att: { b64: mkWebp(2000).toString('base64') } });
  const burned = Number(fs.readFileSync(path.join(DATA, 'chat-seq'), 'utf8').trim());
  fs.rmSync(CHAT + '.tmp', { recursive: true });
  check('вложение отвергнутого сообщения не осталось на диске сиротой',
    orphTry.status === 507 && !fs.existsSync(path.join(DATA, 'att', burned + '.webp')),
    { st: orphTry.status, номер: burned });
  fs.mkdirSync(path.join(DATA, 'chat-seq.tmp'));
  const noSeq = await chat({ installId: NOSP, nick: 'диск', text: 'номер не запишется' });
  const noSeqJ = await noSeq.json();
  fs.rmSync(path.join(DATA, 'chat-seq.tmp'), { recursive: true });
  check('счётчик не записался → 507, а не номер, выданный вторично после перезапуска',
    noSeq.status === 507 && /счётчик/.test(noSeqJ.error || ''), { st: noSeq.status, j: noSeqJ });
  const alive = await chat({ installId: NOSP, nick: 'диск', text: 'а теперь можно' });
  check('приёмник жив после трёх ошибок записи: сервис не умер вместе с ними',
    alive.status === 200 && (await fetch(`${BASE}/health`)).status === 200, alive.status);
  check('в журнале ноды видно, что именно не записалось',
    /ЖУРНАЛ ЧАТА НЕ ЗАПИСАЛСЯ/.test(out) && /СЧЁТЧИК СООБЩЕНИЙ НЕ ЗАПИСАЛСЯ/.test(out));

  // ── Удаление: частота и снимок журнала ─────────────────────────────────────
  // Проверок ВЛАДЕНИЯ здесь нет и быть не может: секрет один на шестерых, и приёмник
  // физически не знает, кто к нему обратился (её пробовали 05.09 и сняли в тот же час —
  // хаб отправляет ровно `/chat?installId=<свой>` и получал 403). Поэтому проверяется то,
  // что действительно защищает: минутный предел на самой разрушительной ручке и снимок
  // журнала перед необратимой чисткой. Это переписка шести живых людей.
  console.log('\nудаление: частота и снимок журнала:');
  const DEL = F(20);
  const baks = () => fs.readdirSync(DATA).filter(f => /^chat-.+\.bak\.ndjson$/.test(f));
  const bakHas = s => baks().some(f => fs.readFileSync(path.join(DATA, f), 'utf8').includes(s));
  await cj({ installId: DEL, nick: 'удалялка', text: 'моё 1' });
  await cj({ installId: DEL, nick: 'удалялка', text: 'моё 2' });
  const dMine = await delJ(`/chat?installId=${DEL}`);
  check('«все сообщения установки» без force работает, как и раньше (кнопка «убрать мои»)',
    dMine.st === 200 && dMine.j.removed === 2, dMine);
  check('перед массовым удалением снят снимок журнала', baks().length >= 1, baks());
  check('в снимке лежит удалённое сообщение, а не пустота', bakHas('моё 2'), baks());
  await cj({ installId: DEL, nick: 'удалялка', text: 'перед сносом всего' });
  const dAll = await delJ('/chat?all=1');
  check('all=1 вычищает журнал целиком', dAll.st === 200 && dAll.j.left === 0, dAll.j);
  check('снимок перед all=1 содержит снесённое', bakHas('перед сносом всего'), baks());
  for (let i = 0; i < 6; i++) {
    await cj({ installId: DEL, nick: 'удалялка', text: 'снимок ' + i });
    await del(`/chat?installId=${DEL}`);
    await sleep(3);          // штамп снимка — с миллисекундами, но пусть будет заведомо разный
  }
  check('снимков журнала не больше пяти — страховка не съедает диск сама',
    baks().length === 5, baks().length);
  const dCodes = [];
  let last429 = null;
  for (let i = 0; i < 40; i++) {
    const r = await del(`/chat?installId=${F(30 + (i % 9))}`);
    dCodes.push(r.status);
    if (r.status === 429) last429 = await r.json();
  }
  check('на удалениях есть минутный предел, и он упирается', dCodes.includes(429),
    dCodes.join(',').slice(0, 60));
  check('предел общий на ключ: смена installId его не обходит',
    dCodes.filter(c => c !== 429).length <= 30
    && /удалений в минуту на ключ/.test((last429 || {}).error || ''),
    { прошло: dCodes.filter(c => c !== 429).length, отказ: (last429 || {}).error });
  check('в отказе сказано, что делать дальше, а не только что не так',
    !!(last429 || {}).hint && !!(last429 || {}).retryAfterMs, last429);

  // Вложение сообщения, которое ВЫПАДЕТ из журнала при обрезке до 1000: до правки файл
  // оставался на ноде навсегда — строки нет, ссылки нет, место занято.
  const ORPH = F(21);
  const gseqBeforeBulk = (await feedJ(0)).gseq;
  const orphJ = await cj({ installId: ORPH, nick: 'сирота', text: 'выпадет',
    att: { b64: mkWebp(2200).toString('base64') } });
  const orphFile = path.join(DATA, 'att', orphJ.seq + '.webp');
  check('вложение записано до нагрузки', fs.existsSync(orphFile), orphJ.seq);
  const orphA = await cj({ installId: ORPH, nick: 'сирота', text: 'голос выпадет',
    att: { b64: mkWebm(2400).toString('base64') } });
  const orphAFile = path.join(DATA, 'voice', orphA.seq + '.webm');
  check('голосовое вложение записано до нагрузки', fs.existsSync(orphAFile), orphA.seq);

  console.log('\nчат под нагрузкой:');
  // 1100 сообщений — чтобы обрезка до 1000 действительно сработала, а не осталась
  // теорией. Установок много, потому что 20 сообщений в минуту с одной — это лимит.
  const BULK = 1100;
  const tBulk = Date.now();
  for (let i = 0; i < BULK; i += 20) {
    await Promise.all(Array.from({ length: Math.min(20, BULK - i) }, (_, k) => {
      const n = i + k;
      return chat({ installId: 'bb' + String(n >> 4).padStart(14, '0'),
        nick: 'bulk' + (n >> 4), text: 'нагрузка ' + n });
    }));
  }
  const bulkMs = Date.now() - tBulk;
  const lines = fs.readFileSync(CHAT, 'utf8').trim().split('\n');
  check('журнал обрезан до 1000 последних сообщений', lines.length === 1000, lines.length);
  const parsed = lines.map(l => JSON.parse(l));
  check('обрезка снимает СТАРЫЕ, а не случайные',
    parsed[999].seq - parsed[0].seq === 999, [parsed[0].seq, parsed[999].seq]);
  const page = await (await feed(0)).json();
  check('за один GET отдаётся не больше 200 сообщений', page.messages.length === 200, page.messages.length);
  check('курсор — seq последнего ОТДАННОГО, а не самого свежего в журнале',
    page.seq === page.messages[199].seq && page.seq < parsed[999].seq,
    { курсор: page.seq, максимум: parsed[999].seq });
  // Обрезка журнала обязана снимать и вложения выпавших сообщений: их не удалял никто.
  check('обрезка журнала сняла вложение выпавшего сообщения', !fs.existsSync(orphFile), orphJ.seq);
  check('и ЗВУКОВОЕ вложение тоже: путь обрезки знает и расширение, и отдельный каталог',
    !fs.existsSync(orphAFile), orphA.seq);
  // Обрезка НЕ ставит надгробий: 1000 надгробий непрерывным низом вытеснили бы настоящие
  // удаления из окна и загнали клиентов в постоянное полное перечитывание. Вместо этого —
  // одно число `firstSeq`, и всё ниже клиент выбрасывает у себя сам.
  const gTrim = await feedG(parsed[999].seq, gseqBeforeBulk);
  check('обрезка журнала по лимиту 1000 надгробий НЕ плодит',
    gTrim.gone.length === 0 && !goneS(gTrim).includes(orphJ.seq),
    { надгробий: gTrim.gone.length, номера: goneS(gTrim).slice(0, 5) });
  check('обрезка описана одним числом: firstSeq = дно журнала после обрезки',
    gTrim.firstSeq === parsed[0].seq && gTrim.cold === false,
    { firstSeq: gTrim.firstSeq, дно: parsed[0].seq, cold: gTrim.cold });
  const keptJ = await cj({ installId: ORPH, nick: 'сирота', text: 'остаётся',
    att: { b64: mkWebp(2300).toString('base64') } });
  check('вложение сообщения, которое в журнале ОСТАЛОСЬ, не тронуто',
    fs.existsSync(path.join(DATA, 'att', keptJ.seq + '.webp')), keptJ.seq);
  let bestTail = Infinity, bestPage = Infinity;
  for (let i = 0; i < 5; i++) {
    let t = process.hrtime.bigint();
    await feed(parsed[999].seq - 50);
    bestTail = Math.min(bestTail, Number(process.hrtime.bigint() - t) / 1e6);
    t = process.hrtime.bigint();
    await feed(0);
    bestPage = Math.min(bestPage, Number(process.hrtime.bigint() - t) / 1e6);
  }
  const attBytes = fs.readdirSync(path.join(DATA, 'att'))
    .reduce((s, f) => s + fs.statSync(path.join(DATA, 'att', f)).size, 0);
  console.log(`  ℹ chat.ndjson на 1000 сообщений: ${fs.statSync(CHAT).size} Б`
    + `; GET /chat?since= (50 сообщений) ${bestTail.toFixed(1)} мс`
    + `, полная страница 200 — ${bestPage.toFixed(1)} мс`);
  console.log(`  ℹ ${BULK} POST /chat за ${bulkMs} мс (${(bulkMs / BULK).toFixed(1)} мс на сообщение)`
    + `; вложений на диске ${(attBytes / 1048576).toFixed(2)} МБ`);

  console.log('\nсекрет:');
  check('секрет мелькнул в логах ровно один раз — в баннере создания',
    out.split(SECRET).length - 1 === 1, out.split(SECRET).length - 1);
  const bodies = [await (await feed(0)).text(), await (await peers(A)).text(),
    await (await fetch(`${BASE}/health`)).text(),
    (await rawGet('/chat/att/1.webp', 'wrong-key-0000')).body];
  check('секрет не попадает в ответы ручек', bodies.every(b => !b.includes(SECRET)));

  // ── Пределы на КЛЮЧ: отдельный приёмник ────────────────────────────────────
  // Эти два предела нельзя мерить на основном приёмнике: чтобы упереться в них, надо
  // сжечь минутную квоту ключа и забить каталог срезами, после чего упали бы все
  // остальные проверки файла. Поэтому второй процесс, со своим портом, своим каталогом и
  // своим секретом; в конце он убирается целиком.
  console.log('\nпределы на ключ (отдельный приёмник):');
  const IPORT = PORT + 1000, IDATA = DATA + '-iso';
  fs.mkdirSync(IDATA, { recursive: true });
  let iout = '';
  const ichild = spawn(process.execPath, [RECEIVER, String(IPORT), IDATA],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  ichild.stdout.on('data', d => { iout += d; });
  ichild.stderr.on('data', d => { iout += d; });
  let iup = false;
  for (let i = 0; i < 60 && !iup; i++) {
    await sleep(100);
    try { iup = (await fetch(`http://127.0.0.1:${IPORT}/health`)).ok; } catch { /* ещё не поднялся */ }
  }
  check('второй приёмник поднялся на своём каталоге', iup, iout.slice(0, 200));
  const ISEC = fs.readFileSync(path.join(IDATA, 'secret'), 'utf8').trim();
  const ipost = body => fetch(`http://127.0.0.1:${IPORT}/slice`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-League-Key': ISEC },
    body: JSON.stringify(body) });
  const IS = path.join(IDATA, 'slices');
  // Файлы кладём НАПРЯМУЮ: 200 срезов через ручку — это заведомый упор в минутную квоту,
  // а проверяем мы сейчас не её. `tot` совпадает с mkSlice, иначе честный срез той же
  // установки не прошёл бы по приросту от нуля.
  const iId = n => 'f' + n.toString(16).padStart(15, '0');
  const iGhost = n => fs.writeFileSync(path.join(IS, iId(n) + '.json'), JSON.stringify({
    installId: iId(n), nick: 'бот', recvAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    tot: { tokA: 1e10, promptsAll: 17000, spentAll: 18000, bought: 32, reg: 142 } }));
  for (let i = 0; i < 200; i++) iGhost(i);
  const rCap = await ipost(mkSlice('ab'.repeat(8), 'новичок'));
  const rCapJ = await rCap.json();
  check('новая установка сверх потолка их числа отвергнута кодом 507 и внятным текстом',
    rCap.status === 507 && /установок/.test(rCapJ.error || '') && !!rCapJ.hint, rCapJ);
  const rKnown = await ipost(mkSlice(iId(7), 'ветеран'));
  check('уже известная установка сверх потолка принимается: потолок не выбивает своих',
    rKnown.status === 200, await rKnown.json());
  // Освобождаем место, иначе упрёмся в потолок числа установок, а не в минутную квоту.
  for (let i = 20; i < 200; i++) fs.rmSync(path.join(IS, iId(i) + '.json'));
  const iCodes = [];
  let i429 = null;
  for (let i = 0; i < 90; i++) {
    const r = await ipost(mkSlice('e' + (4096 + i).toString(16).padStart(15, '0'), 'рой'));
    iCodes.push(r.status);
    if (r.status === 429) i429 = await r.json();
  }
  const passed = iCodes.filter(c => c === 200).length;
  check('«один срез в минуту» больше не обходится сменой installId: есть предел на ключ',
    iCodes.includes(429) && passed > 0 && passed <= 60, { принято: passed, отказов: iCodes.filter(c => c === 429).length });
  check('в отказе сказано, что предел общий на ключ, и что делать дальше',
    /на ключ/.test((i429 || {}).error || '') && !!(i429 || {}).hint, i429);
  ichild.kill();
  try { fs.rmSync(IDATA, { recursive: true, force: true }); } catch {}

  // ── Сквозной обмен: отправитель ХАБА → приёмник → league-peers.json ────────
  // Это единственное место, где проверяется код, который в проде работает без
  // присмотра. Если leagueSync() молча не пишет файл, лига просто остаётся пустой,
  // и узнать об этом будет неоткуда. Конфиг и файл соседей уводим во временный
  // каталог: живой hub-identity.json и живой league-peers.json не задеты.
  console.log('\nсквозной обмен (отправитель хаба):');
  const ROUTING = path.join(__dirname, '..', 'routing');
  const SRC = fs.readFileSync(path.join(ROUTING, 'transparent-proxy.js'), 'utf8');
  const block = SRC.slice(SRC.indexOf('const HUB_IDENTITY_FILE'),
    SRC.indexOf('async function handleFinanceHistory'));
  const SANDBOX = path.join(DATA + '-hub');
  fs.mkdirSync(SANDBOX, { recursive: true });
  const load = f => {
    try {
      const raw = fs.readFileSync(path.join(ROUTING, f), 'utf8');
      const j = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
      return Array.isArray(j) ? j : (j.sessions || j.accounts || []);
    } catch { return []; }
  };
  fs.writeFileSync(path.join(SANDBOX, 'league-config.json'),
    JSON.stringify({ enabled: true, url: BASE, key: SECRET, everyMin: 10 }));
  const hub = new Function(
    'fs', 'path', 'os', 'crypto', 'execFileSync', 'http', 'https', '__dirname', 'logLine', 'round2',
    'jsonRes', 'readJsonBody', 'TOKEN_USAGE_FILE', 'FINANCE_HISTORY_FILE',
    'ghLoad', 'arLoad', 'goLoad', 'tbLoad', 'xpLoad', 'jwLoad', 'skLoad', 'tsLoad', 'kkLoad',
    `${block}\nreturn { leagueSync, leagueConfig, leagueSelf, leaguePeers, LEAGUE_PEERS_FILE };`
  )(
    fs, path, os, require('crypto'), require('child_process').execFileSync,
    require('http'), require('https'), SANDBOX,
    () => {}, v => Math.round(v * 100) / 100, () => {}, async () => ({}),
    path.join(ROUTING, 'token-usage.jsonl'), path.join(ROUTING, 'finance-history.jsonl'),
    () => load('github-accounts.json'), () => load('agentrouter-sessions.json'),
    () => load('gorouter-sessions.json'), () => load('tabi-sessions.json'),
    () => load('xpeach-sessions.json'), () => load('justwoker-sessions.json'),
    () => load('seekai-sessions.json'), () => load('truesota-sessions.json'),
    () => load('kktoken-sessions.json')
  );
  check('конфиг прочитан и лига включена', hub.leagueConfig().enabled === true, hub.leagueConfig().url);
  const sync = await hub.leagueSync();
  check('обмен прошёл', sync.ok === true, sync);
  check('соседи записаны в league-peers.json', fs.existsSync(hub.LEAGUE_PEERS_FILE));
  const savedPeers = hub.leaguePeers();
  check('в файле лежат ДВЕ чужие установки, своей там нет',
    savedPeers.peers.length === 2 && !savedPeers.peers.some(p => p.installId === hub.leagueSelf().installId),
    savedPeers.peers.map(p => p.nick));
  check('у соседей серверное время приёма, а не своё',
    savedPeers.peers.every(p => p.recvAt && !p.stamp), savedPeers.peers.map(p => p.recvAt));
  // Без конфига наружу не уезжает ничего — это и есть opt-in.
  fs.rmSync(path.join(SANDBOX, 'league-config.json'));
  const off = await hub.leagueSync();
  check('без конфига обмена не происходит вообще', !!off.skipped, off);

  // ── РЕЖИМ ЛИЧНОСТИ ─────────────────────────────────────────────────────────
  // Всё, что ниже, идёт на ОТДЕЛЬНОМ приёмнике со своим каталогом: режим выбирается
  // раскладкой данных, и мешать его с наследуемым в одном каталоге значило бы проверять
  // не то. Каталог готовится РОВНО так, как его готовит `tools/league-migrate.js` —
  // формы файлов заданы там, приёмник обязан читать их, а не свои.
  console.log('\nличность: переход подхватывается без рестарта, старый ключ продолжает работать:');
  const IDPORT = PORT + 2000, IDDATA = DATA + '-id';
  const IB = `http://127.0.0.1:${IDPORT}`;
  fs.mkdirSync(path.join(IDDATA, 'slices'), { recursive: true });
  let idout = '';
  let idchild = null;
  const idSpawn = () => {
    const ch = spawn(process.execPath, [RECEIVER, String(IDPORT), IDDATA], { stdio: ['ignore', 'pipe', 'pipe'] });
    ch.stdout.on('data', d => { idout += d; });
    ch.stderr.on('data', d => { idout += d; });
    return ch;
  };
  const idUp = async () => {
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      try { if ((await fetch(`${IB}/health`)).ok) return true; } catch { /* ещё не поднялся */ }
    }
    return false;
  };
  const idRestart = async () => {
    if (idchild) idchild.kill();
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      try { await fetch(`${IB}/health`); } catch { break; }
    }
    idchild = idSpawn();
    return idUp();
  };
  idchild = idSpawn();
  if (!await idUp()) { console.log('приёмник личности не поднялся:\n' + idout); }
  const OSEC = fs.readFileSync(path.join(IDDATA, 'secret'), 'utf8').trim();
  // Один помощник на все ручки: ключ по умолчанию — общий секрет (он же будущий личный
  // токен владельца), `null` — вообще без заголовка.
  const iq = async (method, p, body, key) => {
    const headers = { 'Content-Type': 'application/json' };
    if (key !== null) headers['X-League-Key'] = key === undefined ? OSEC : key;
    const r = await fetch(IB + p, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let j = null;
    try { j = await r.json(); } catch { /* не JSON — тело нам тут не нужно */ }
    return { st: r.status, j: j || {}, h: r.headers };
  };
  const iBytes = async (p, key) => {
    const r = await fetch(IB + p, { headers: key === null ? {} : { 'X-League-Key': key === undefined ? OSEC : key } });
    return { st: r.status, buf: Buffer.from(await r.arrayBuffer()), h: r.headers };
  };
  const sha = v => crypto.createHash('sha256').update(v).digest('hex');
  const IP = n => path.join(IDDATA, n);
  const rdJ = n => JSON.parse(fs.readFileSync(IP(n), 'utf8'));
  const wrJ = (n, o) => fs.writeFileSync(IP(n), JSON.stringify(o, null, 2) + '\n');
  const GID_A = 'a1'.repeat(16), M0 = '0f'.repeat(8), OWN = 'ab'.repeat(8);
  const idBackdate = (id, ms) => {
    const f = path.join(IDDATA, 'slices', id + '.json');
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    s.recvAt = new Date(Date.now() - ms).toISOString();
    fs.writeFileSync(f, JSON.stringify(s));
  };
  // До перехода приёмник обязан вести себя как раньше: выкат сборки и перевод данных —
  // РАЗНЫЕ шаги, и между ними идёт живой обмен.
  const pre = await iq('POST', '/slice', { ...mkSlice(OWN, 'worm'), sha: 'deadbeef', avatar: dataUrl(mkWebp(3000)) });
  check('до перехода срез принимается по общему ключу, как раньше', pre.st === 200, pre.j);
  const preChat = await iq('POST', '/chat', { installId: OWN, nick: 'worm', text: 'до перехода' });
  check('до перехода чат работает по общему ключу', preChat.st === 200 && preChat.j.seq >= 1, preChat.j);
  const preMe = await iq('GET', '/me');
  check('до перехода ручки личности отвечают ПРИЧИНОЙ, а не «нет такой ручки»',
    preMe.st === 409 && /members\.json/.test(preMe.j.error || ''), preMe);
  const prePeers = await iq('GET', '/peers', undefined, null);
  check('до перехода рейтинг без ключа закрыт: публичным он становится вместе с личностью',
    prePeers.st === 401, prePeers.st);
  // Перевод данных: ровно те же переносы и файлы, что делает league-migrate.js.
  fs.mkdirSync(IP('chat'), { recursive: true });
  fs.renameSync(IP('chat.ndjson'), path.join(IP('chat'), GID_A + '.ndjson'));
  fs.renameSync(IP('chat-seq'), path.join(IP('chat'), GID_A + '.seq'));
  const atNow = new Date().toISOString();
  wrJ('groups.json', { [GID_A]: { gid: GID_A, title: 'Общий', createdBy: M0, createdAt: atNow, members: [M0] } });
  wrJ('invites.json', {});
  fs.writeFileSync(IP('addr-salt'), crypto.randomBytes(32).toString('hex') + '\n');
  wrJ('members.json', { [M0]: { memberId: M0, tokenHash: sha(OSEC), installId: OWN, nick: 'worm',
    groups: [GID_A], status: 'active', createdAt: atNow, invitedBy: null } });
  // 🔴 РЕСТАРТА НЕТ. Если приёмник читает реестр только при старте, всё ниже покраснеет —
  // и это ровно то, что делает отзыв настоящим: отзыв, вступающий в силу после
  // `systemctl restart`, отзывом не называется.
  const me1 = await iq('GET', '/me');
  check('переход подхвачен БЕЗ рестарта: старый общий секрет стал ЛИЧНЫМ токеном владельца',
    me1.st === 200 && me1.j.memberId === M0 && me1.j.installId === OWN
    && (me1.j.groups[0] || {}).gid === GID_A, me1.j);
  check('чужой токен той же длины не пускает', (await iq('GET', '/me', undefined,
    crypto.randomBytes(24).toString('base64url'))).st === 401);
  check('/health остался без ключа и не изменил форму',
    (await iq('GET', '/health', undefined, null)).j.ok === true);
  idBackdate(OWN, 2 * 3600 * 1000);
  const after = await iq('POST', '/slice', mkSlice(OWN, 'worm', { tokA: 1.02e10 }));
  check('живой обмен не сломан: тем же секретом срез принят и лёг под тем же installId',
    after.st === 200 && after.j.memberId === M0
    && fs.existsSync(path.join(IDDATA, 'slices', OWN + '.json')), after.j);
  console.log('\nличность вместо тела: installId и ник берутся ИЗ ЗАПИСИ:');
  idBackdate(OWN, 2 * 3600 * 1000);
  const alien = await iq('POST', '/slice', mkSlice('cc'.repeat(8), 'чужак', { tokA: 1.03e10 }));
  check('срез с ЧУЖИМ installId в теле отвергнут 409, а не заводит вторую строку в рейтинге',
    alien.st === 409 && /привязан/.test(alien.j.error || ''), alien.j);
  check('и файла среза под чужим id не появилось',
    !fs.existsSync(path.join(IDDATA, 'slices', 'cc'.repeat(8) + '.json')));
  idBackdate(OWN, 2 * 3600 * 1000);
  const noId = await iq('POST', '/slice', { ...mkSlice(OWN, 'worm', { tokA: 1.03e10 }),
    installId: undefined, sha: 'deadbeef', avatar: dataUrl(mkWebp(3000)) });
  check('срез БЕЗ installId в теле принят: он и не нужен, привязка лежит в записи',
    noId.st === 200 && noId.j.installId === OWN, noId.j);
  const spoofChat = await iq('POST', '/chat', { gid: GID_A, installId: 'ff'.repeat(8),
    nick: 'ЗЛОдей', text: 'от чужого имени' });
  const feedA0 = await iq('GET', `/chat?gid=${GID_A}&since=0`);
  const spoofRow = (feedA0.j.messages || []).find(m => m.text === 'от чужого имени') || {};
  check('автор сообщения взят ИЗ ЗАПИСИ: подделать installId и ник телом больше нечем',
    spoofChat.st === 200 && spoofRow.installId === OWN && spoofRow.nick === 'worm',
    { installId: spoofRow.installId, nick: spoofRow.nick });
  check('номер продолжился от перенесённого счётчика, а не начался заново',
    spoofChat.j.seq === preChat.j.seq + 1, { было: preChat.j.seq, стало: spoofChat.j.seq });
  check('перенесённое сообщение на месте: журнал переехал, а не потерялся',
    (feedA0.j.messages || []).some(m => m.text === 'до перехода'), (feedA0.j.messages || []).length);
  check('сообщение без gid отвергнуто 400: у чата теперь есть «где»',
    (await iq('POST', '/chat', { text: 'куда?' })).st === 400);
  const noGid = await iq('GET', '/chat?since=0');
  check('чтение без gid и без cur — 400 с подсказкой, а не молчаливый «журнал по умолчанию»',
    noGid.st === 400 && /gid|cur/.test(noGid.j.error || ''), noGid.j);

  console.log('\nпубличная выдача рейтинга: белый список, а не ветвление:');
  const pub = await iq('GET', '/peers', undefined, null);
  const prow = (pub.j.peers || [])[0] || {};
  const PEER_OK = new Set(['rid', 'nick', 'recvAt', 'keys', 'tok', 'sp', 'tu', 'act', 'acc', 'tot', 'rebased']);
  check('рейтинг читается БЕЗ секрета: свежая установка видит доску, а не ошибку',
    pub.st === 200 && (pub.j.peers || []).length === 1, pub.st);
  check('набор ключей публичной строки ТОЧНО равен белому списку',
    Object.keys(prow).every(k => PEER_OK.has(k)) && !!prow.rid && !!prow.nick,
    Object.keys(prow));
  check('в публичной выдаче НЕТ installId, лица, версии сборки, коммита и часового пояса',
    !('installId' in prow) && !('avatar' in prow) && !('ver' in prow) && !('sha' in prow)
    && !('tzOffsetMin' in prow), Object.keys(prow).filter(k => !PEER_OK.has(k)));
  check('ни одно ЗНАЧЕНИЕ публичной выдачи не совпадает с известным installId',
    !JSON.stringify(pub.j).includes(OWN));
  const grpA = await iq('GET', `/group/${GID_A}`);
  const gm0 = (grpA.j.members || [])[0] || {};
  check('лицо, installId, версия сборки и коммит отдаются ЧЛЕНАМ группы — и только там',
    grpA.st === 200 && gm0.installId === OWN && !!gm0.avatar && !!gm0.ver && !!gm0.sha
    && !!gm0.rid, { keys: Object.keys(gm0), avatar: !!gm0.avatar });
  check('rid в составе группы считается ТАК ЖЕ, как в публичной выдаче: клиент склеит сам',
    gm0.rid === prow.rid, { состав: gm0.rid, доска: prow.rid });
  console.log('\nприглашения: выдача, размен, порядок проверок:');
  const GIDre = /^[a-f0-9]{32}$/, MIDre = /^[a-f0-9]{16}$/;
  const mkInv = async (over, key) => (await iq('POST', '/invite', over || {}, key)).j;
  const patchInv = (id, patch) => { const m = rdJ('invites.json'); m[id] = { ...m[id], ...patch }; wrJ('invites.json', m); };
  const tryJoin = code => iq('POST', '/join', { code }, null);
  const inv1 = await iq('POST', '/invite', {});
  check('приглашение выдаёт любой член группы: код показан один раз, id — его хеш',
    inv1.st === 200 && !!inv1.j.code && inv1.j.id === sha(inv1.j.code)
    && inv1.j.groups[0] === GID_A && inv1.j.maxUses === 1,
    { st: inv1.st, groups: inv1.j.groups, maxUses: inv1.j.maxUses });
  check('на диске лежит только ХЕШ кода, самого кода там нет',
    !fs.readFileSync(IP('invites.json'), 'utf8').includes(inv1.j.code)
    && !!rdJ('invites.json')[inv1.j.id]);
  check('код не попал в журнал ноды — там только id приглашения', !idout.includes(inv1.j.code));
  const ttlH = (Date.parse(inv1.j.expires) - Date.now()) / 3600000;
  check('срок по умолчанию — сутки: не час (друг может спать) и не неделя',
    ttlH > 23 && ttlH <= 24.1, ttlH);
  const invLong = await iq('POST', '/invite', { ttlHours: 240 });
  check('явно заданный срок обрезан потолком семи суток',
    (Date.parse(invLong.j.expires) - Date.now()) / 864e5 <= 7.01, invLong.j.expires);
  const join2 = await iq('POST', '/join', { code: inv1.j.code }, null);
  const TOK2 = join2.j.token, M2 = join2.j.memberId;
  check('токен нового участника делает ПРИЁМНИК: он не равен ни коду, ни токену пригласившего',
    join2.st === 200 && !!TOK2 && TOK2 !== inv1.j.code && TOK2 !== OSEC && MIDre.test(M2 || ''),
    { st: join2.st, memberId: M2, тотЖеКод: TOK2 === inv1.j.code });
  check('размен оставляет видимый след: в записи стоит, кто поручился', join2.j.invitedBy === M0);
  const me2 = await iq('GET', '/me', undefined, TOK2);
  const grpA2 = await iq('GET', `/group/${GID_A}`);
  check('новый участник попал в ту же группу и виден в её составе',
    ((me2.j.groups || [])[0] || {}).gid === GID_A
    && (grpA2.j.members || []).some(x => x.memberId === M2), me2.j.groups);
  check('его запись создана БЕЗ привязки к установке: её прибьёт первый срез',
    me2.j.installId === null, me2.j.installId);
  check('повторный размен одноразового кода посторонним — 409 «уже использовано»',
    (await tryJoin(inv1.j.code)).st === 409);
  const rep = await iq('POST', '/join', { code: inv1.j.code }, TOK2);
  check('🪤 повторный ввод ТЕМ ЖЕ человеком лишнего использования не жжёт и токен не переиздаёт',
    rep.st === 200 && rep.j.replay === true && !rep.j.token, rep.j);
  const blob = 'xgl1_' + Buffer.from(JSON.stringify({ v: 1, u: IB, c: (await mkInv()).code })).toString('base64url');
  check('приглашение принимается и одной строкой xgl1_…, а не только голым кодом',
    (await iq('POST', '/join', { invite: blob }, null)).st === 200);
  check('строка не того вида отвергнута 400 внятно, а не падением на разборе JSON',
    (await iq('POST', '/join', { invite: 'xgl2_нето' }, null)).st === 400);
  check('несуществующий код — 404, а не 200 и не 500',
    (await tryJoin('этого-кода-нет')).st === 404);
  // 🪤 У `/join` СВОЙ предел частоты по адресу — единственная ручка без секрета, которая
  // создаёт личность, иначе перебор кодов ограничен только скоростью сети. Окно живёт в
  // памяти, поэтому дальше по проверкам его приходится сбрасывать рестартом: иначе
  // следующие размены получат 429 и мы будем мерить не порядок проверок, а антифлуд.
  const joinFlood = [];
  for (let i = 0; i < 12; i++) joinFlood.push((await tryJoin('перебор-' + i)).st);
  check('у размена приглашения есть предел частоты по адресу, и он упирается',
    joinFlood.includes(429), joinFlood.join(','));
  if (!await idRestart()) console.log('приёмник личности не поднялся после сброса окна:\n' + idout);

  const iRev = await mkInv();
  await iq('DELETE', `/invite/${iRev.id}`);
  const rRev = await tryJoin(iRev.code);
  check('порядок проверок 1/4 — погашенное приглашение отвечает 410 «погашено»',
    rRev.st === 410 && /погашено/.test(rRev.j.error || ''), rRev.j);
  const iExp = await mkInv();
  patchInv(iExp.id, { expires: new Date(Date.now() - 1000).toISOString() });
  const rExp = await tryJoin(iExp.code);
  check('порядок проверок 2/4 — просроченное отвечает 410 «просрочено»',
    rExp.st === 410 && /просрочен/.test(rExp.j.error || ''), rExp.j);
  const iOrd = await mkInv();
  patchInv(iOrd.id, { enabled: false, expires: new Date(Date.now() - 1000).toISOString() });
  const rOrd = await tryJoin(iOrd.code);
  check('порядок именно такой: погашенное И просроченное отвечает «погашено» — отзыв первым',
    rOrd.st === 410 && /погашено/.test(rOrd.j.error || ''), rOrd.j);
  const iNull = await mkInv();
  patchInv(iNull.id, { expires: null });
  const rNull = await tryJoin(iNull.code);
  check('🪤 пустой срок трактуется как ПРОСРОЧЕННЫЙ, а не как «никогда не истекает»',
    rNull.st === 410 && /срок/.test(rNull.j.error || ''), rNull.j);
  const iMulti = await mkInv({ uses: 3 });
  const nowIso = new Date().toISOString();
  patchInv(iMulti.id, { usedBy: { ['11'.repeat(8)]: nowIso, ['22'.repeat(8)]: nowIso, ['33'.repeat(8)]: nowIso } });
  if (!await idRestart()) console.log('приёмник личности не поднялся перед многоразовым:\n' + idout);
  const rMulti = await tryJoin(iMulti.code);
  check('🪤 порядок проверок 3-4/4 — МНОГОРАЗОВОЕ проверку «использовано» не пропускает: 409',
    rMulti.st === 409 && /израсходован/.test(rMulti.j.error || ''), rMulti.j);
  const iMulti2 = await mkInv({ uses: 3 });
  const mu1 = await tryJoin(iMulti2.code), mu2 = await tryJoin(iMulti2.code);
  check('многоразовое при этом действительно впускает нескольких, а не одного',
    mu1.st === 200 && mu2.st === 200 && mu1.j.memberId !== mu2.j.memberId,
    { a: mu1.st, b: mu2.st });
  console.log('\nгруппы: изоляция по построению, а не по внимательности:');
  const gB = await iq('POST', '/group', { title: 'Вторая' }, TOK2);
  const GID_B = gB.j.gid;
  check('создать группу может любой участник, и он становится её создателем',
    gB.st === 200 && GIDre.test(GID_B || '') && gB.j.createdBy === M2, gB.j);
  const gC = await iq('POST', '/group', { title: 'Третья' }, TOK2);
  const GID_C = gC.j.gid;
  const bImg = mkWebp(2100), cImg = mkWebp(3300);
  const bAtt = await iq('POST', '/chat', { gid: GID_B, text: 'в B', att: { b64: bImg.toString('base64') } }, TOK2);
  const cAtt = await iq('POST', '/chat', { gid: GID_C, text: 'в C', att: { b64: cImg.toString('base64') } }, TOK2);
  check('номер сообщения СВОЙ у каждой группы: обе новые начали с единицы',
    bAtt.j.seq === 1 && cAtt.j.seq === 1, { B: bAtt.j.seq, C: cAtt.j.seq });
  const bUrl = `/chat/att/${GID_B}/1.webp`, cUrl = `/chat/att/${GID_C}/1.webp`;
  const bGot = await iBytes(bUrl, TOK2), cGot = await iBytes(cUrl, TOK2);
  check('вложения с ОДНИМ номером в разных группах не перетёрли друг друга',
    bGot.buf.equals(bImg) && cGot.buf.equals(cImg), { B: bGot.buf.length, C: cGot.buf.length });
  check('файлы лежат в подкаталоге группы, а не в общей куче',
    fs.existsSync(path.join(IDDATA, 'att', GID_B, '1.webp'))
    && fs.existsSync(path.join(IDDATA, 'att', GID_C, '1.webp'))
    && !fs.existsSync(path.join(IDDATA, 'att', '1.webp')));
  check('плоский адрес вложения в этом режиме отвечает ПРИЧИНОЙ, а не «нет такого»',
    (await iBytes('/chat/att/1.webp')).st === 400);
  const readB = await iq('GET', `/chat?gid=${GID_B}&since=0`);
  check('чужую группу член первой НЕ читает: 200 с пустотой и пометкой, а не 401 и не 500',
    readB.st === 200 && (readB.j.messages || []).length === 0 && readB.j.notMember === true, readB.j);
  check('запись в чужую группу — 403, а не тихий успех',
    (await iq('POST', '/chat', { gid: GID_B, text: 'подсажусь' })).st === 403);
  const attB = await iBytes(bUrl);
  check('вложение чужой группы не отдаётся: адрес картинки не становится каналом в чужую переписку',
    attB.st === 403, attB.st);
  const cur = await iq('GET', `/chat?cur=${GID_A}:0:0,${GID_B}:0:0`);
  check('карта курсоров: своя группа отвечает как обычно, чужая уезжает в unknown',
    cur.st === 200 && Array.isArray(((cur.j.groups || {})[GID_A] || {}).messages)
    && (cur.j.unknown || []).includes(GID_B) && !(cur.j.groups || {})[GID_B],
    { unknown: cur.j.unknown, keys: Object.keys(cur.j.groups || {}) });
  check('в чужой группе нет даже поля messages: не «пустой список», а её тут вообще нет',
    !JSON.stringify(cur.j.groups || {}).includes(GID_B));
  check('строгий разбор cur: сломанная форма и дубль группы — 400, а не молчаливая обрезка',
    (await iq('GET', '/chat?cur=нет:0:0')).st === 400
    && (await iq('GET', `/chat?cur=${GID_A}:0:0,${GID_A}:1:1`)).st === 400);
  const many17 = Array.from({ length: 17 }, (_, i) => (i + 16).toString(16).padStart(2, '0').repeat(16));
  check('групп в cur больше шестнадцати — 400, а не молча отброшенная группа',
    (await iq('GET', '/chat?cur=' + many17.map(g => g + ':0:0').join(','))).st === 400);
  const curA = await iq('GET', `/chat?cur=${GID_A}:0:0`);
  check('форма ответа на cur: те же поля внутри groups[gid], плюс more и unknown снаружи',
    curA.st === 200 && Number.isInteger(curA.j.groups[GID_A].gseq)
    && Number.isInteger(curA.j.groups[GID_A].firstSeq) && curA.j.groups[GID_A].cold === false
    && typeof curA.j.groups[GID_A].more === 'boolean' && Array.isArray(curA.j.unknown),
    Object.keys(curA.j.groups[GID_A]));
  // 🔴 Право приглашать проверяет ПРИЁМНИК по записи поручителя, а не флаг от клиента: без
  // этой проверки «любой участник группы может пригласить» незаметно превращается в «любой
  // держатель токена может пригласить куда угодно».
  const invAlien = await iq('POST', '/invite', { groups: [GID_B] });
  check('право приглашать сверяется по записи поручителя: не в группе — 403, а не код в чужую',
    invAlien.st === 403, { st: invAlien.st, error: invAlien.j.error });
  check('приглашение в свою группу тем же участником при этом выдаётся',
    (await iq('POST', '/invite', { groups: [GID_A] })).st === 200);
  check('в приглашении нельзя смешать свою группу с чужой',
    (await iq('POST', '/invite', { groups: [GID_A, GID_B] })).st === 403);
  const invNoPick = await iq('POST', '/invite', {}, TOK2);
  check('у кого групп больше одной, умолчания нет: приёмник просит назвать группу явно',
    invNoPick.st === 400 && Array.isArray(invNoPick.j.groups), invNoPick.j);
  console.log('\nобрезка, счётчик и кеш — всё на группу, а не на приёмник:');
  // Подсовываем в журнал A 1100 строк и дописываем одно сообщение: прогонять 1100 запросов
  // второй раз незачем (это уже сделано выше на наследуемой раскладке), а проверить надо
  // именно то, что болтливая группа не выедает историю тихой.
  const bigLines = [];
  for (let i = 1; i <= 1100; i++) {
    bigLines.push(JSON.stringify({ seq: i, installId: OWN, nick: 'worm',
      text: 'нагрузка ' + i, recvAt: new Date().toISOString() }));
  }
  fs.writeFileSync(path.join(IP('chat'), GID_A + '.ndjson'), bigLines.join('\n') + '\n');
  fs.writeFileSync(path.join(IP('chat'), GID_A + '.seq'), '1100\n');
  const bLinesBefore = fs.readFileSync(path.join(IP('chat'), GID_B + '.ndjson'), 'utf8').trim().split('\n').length;
  // Заодно теряем счётчик группы B: восстановиться он обязан по СВОЕМУ журналу, а не по
  // чужому максимуму — иначе номера пошли бы по второму кругу и тихо спрятали сообщения.
  fs.rmSync(path.join(IP('chat'), GID_B + '.seq'));
  if (!await idRestart()) console.log('приёмник личности не поднялся перед обрезкой:\n' + idout);
  const trimPost = await iq('POST', '/chat', { gid: GID_A, text: 'после нагрузки' });
  const aLines = fs.readFileSync(path.join(IP('chat'), GID_A + '.ndjson'), 'utf8').trim().split('\n');
  check('обрезка до 1000 считается НА ГРУППУ, и номер продолжился с 1101',
    aLines.length === 1000 && trimPost.j.seq === 1101, { строк: aLines.length, seq: trimPost.j.seq });
  check('болтливая группа не выела историю тихой: журнал B не изменился',
    fs.readFileSync(path.join(IP('chat'), GID_B + '.ndjson'), 'utf8').trim().split('\n').length === bLinesBefore);
  const bNext = await iq('POST', '/chat', { gid: GID_B, text: 'после рестарта' }, TOK2);
  check('потерянный счётчик восстановлен по СВОЕЙ группе, а не по чужому максимуму',
    bNext.j.seq === bLinesBefore + 1, { стало: bNext.j.seq, вЖурналеB: bLinesBefore, вA: 1101 });
  const rA1 = await iq('GET', `/chat?gid=${GID_A}&since=1098`);
  const rB1 = await iq('GET', `/chat?gid=${GID_B}&since=0`, undefined, TOK2);
  const rA2 = await iq('GET', `/chat?gid=${GID_A}&since=1098`);
  check('журналы двух групп читаются по очереди и каждый отдаёт своё, не подменяя друг друга',
    JSON.stringify(rA1.j.messages) === JSON.stringify(rA2.j.messages)
    && (rB1.j.messages || []).length === bLinesBefore + 1,
    { A: (rA1.j.messages || []).length, B: (rB1.j.messages || []).length });
  const tailA = await iq('GET', `/chat?gid=${GID_A}&since=0&tail=1`);
  check('tail=1 отдаёт ХВОСТ, а не восемь страниц от дна журнала',
    (tailA.j.messages || []).length === 200
    && tailA.j.messages[199].text === 'после нагрузки', (tailA.j.messages || []).length);
  const beforeA = await iq('GET', `/chat?gid=${GID_A}&before=1000`);
  const beforeSeqs = (beforeA.j.messages || []).map(m => m.seq);
  check('before= листает назад страницей по 200 и вплотную к границе: старое не стало недостижимым',
    beforeSeqs.length === 200 && beforeSeqs[199] === 999,
    { n: beforeSeqs.length, последний: beforeSeqs[beforeSeqs.length - 1] });

  console.log('\nотзыв: три уровня, и все действуют немедленно:');
  const M2INST = 'dd'.repeat(8);
  const s2 = await iq('POST', '/slice', mkSlice(M2INST, 'monty'), TOK2);
  const me2b = await iq('GET', '/me', undefined, TOK2);
  check('первый срез прибивает привязку установки к записи приглашённого',
    s2.st === 200 && me2b.j.installId === M2INST, { st: s2.st, installId: me2b.j.installId });
  const ridsBefore = ((await iq('GET', '/peers', undefined, null)).j.peers || []).map(p => p.rid).sort().join('|');
  fs.writeFileSync(IP('addr-salt'), crypto.randomBytes(32).toString('hex') + '\n');
  const ridsAfter = ((await iq('GET', '/peers', undefined, null)).j.peers || []).map(p => p.rid).sort().join('|');
  check('соль взята из своего файла addr-salt, а не из секрета: сменили файл — сменились rid',
    !!ridsBefore && ridsBefore !== ridsAfter, { было: ridsBefore, стало: ridsAfter });
  const rm1 = await iq('DELETE', `/group/${GID_A}/member/${M2}`);
  check('первый уровень: исключает создатель группы, и это одна правка без рестарта', rm1.st === 200, rm1.j);
  const exRead = await iq('GET', `/chat?gid=${GID_A}&since=0`, undefined, TOK2);
  const exWrite = await iq('POST', '/chat', { gid: GID_A, text: 'я ещё тут' }, TOK2);
  check('исключение действует НЕМЕДЛЕННО: чтение отдаёт notMember, запись 403',
    exRead.j.notMember === true && exWrite.st === 403, { чтение: exRead.j.notMember, запись: exWrite.st });
  check('токен исключённого продолжает работать: ни один токен не переиздан',
    (await iq('GET', '/me', undefined, TOK2)).st === 200);
  const peersAfter = await iq('GET', '/peers', undefined, null);
  check('🔴 рейтинг общий и по группе НЕ фильтруется: строка исключённого на месте',
    (peersAfter.j.peers || []).length === 2, (peersAfter.j.peers || []).length);
  // Член, но НЕ создатель, исключить не может — а уйти сам может каждый. Для этого
  // владелец сам разменивает приглашение M2 в его группу B: существующий участник входит
  // в новую группу своей же записью, без второго токена.
  const invB2 = await mkInv({ groups: [GID_B] }, TOK2);
  const jb = await iq('POST', '/join', { code: invB2.code });
  check('существующий участник разменивает приглашение в НОВУЮ группу своей же записью',
    jb.st === 200 && !jb.j.token && (jb.j.groups || []).includes(GID_B), jb.j);
  check('член группы, но не её создатель, исключить не может',
    (await iq('DELETE', `/group/${GID_B}/member/${M2}`)).st === 403);
  const leave = await iq('DELETE', `/group/${GID_B}/member/${M0}`);
  check('уйти из группы может каждый: единственная разрушительная операция над собой',
    leave.st === 200 && leave.j.left === true
    && !((await iq('GET', '/me')).j.groups || []).some(g => g.gid === GID_B), leave.j);
  // Третий уровень: и сообщения. Возвращаем M2 в A (добавить может любой член), он пишет,
  // и создатель исключает его с чисткой.
  const add2 = await iq('POST', `/group/${GID_A}/member`, { memberId: M2 });
  check('добавить в группу может ЛЮБОЙ её член, и право проверено по записи поручителя',
    add2.st === 200 && ((await iq('GET', '/me', undefined, TOK2)).j.groups || [])
      .some(g => g.gid === GID_A), add2.j);
  const p1 = await iq('POST', '/chat', { gid: GID_A, text: 'сообщение выгоняемого' }, TOK2);
  const gseqBefore = (await iq('GET', `/chat?gid=${GID_A}&tail=1`)).j.gseq;
  const idBaks = () => fs.readdirSync(IDDATA).filter(f => /\.bak\.ndjson$/.test(f));
  const baksBefore = idBaks().length;
  const purge = await iq('DELETE', `/group/${GID_A}/member/${M2}?purge=1`);
  const afterPurge = await iq('GET', `/chat?gid=${GID_A}&since=1100&gseq=${gseqBefore}`);
  check('третий уровень: purge=1 вычищает сообщения исключённого и ставит на них надгробия',
    purge.st === 200 && purge.j.purged >= 1 && purge.j.tombs === true
    && !(afterPurge.j.messages || []).some(m => m.seq === p1.j.seq)
    && (afterPurge.j.gone || []).some(g => g.seq === p1.j.seq),
    { purged: purge.j.purged, gone: (afterPurge.j.gone || []).map(g => g.seq) });
  check('перед чисткой снят снимок журнала, и он назван ИМЕНЕМ ГРУППЫ',
    idBaks().length > baksBefore
    && idBaks().some(f => f.startsWith('chat-' + GID_A.slice(0, 8) + '-')), idBaks());
  check('вычистить сообщения может только создатель: члену группы это 403',
    (await iq('DELETE', `/group/${GID_B}/member/${M2}?purge=1`)).st === 403);
  // «Мои» и «весь журнал» в пределах группы.
  const mineMsg = await iq('POST', '/chat', { gid: GID_A, text: 'моё к удалению' });
  const oldForm = await iq('DELETE', `/chat?gid=${GID_A}&installId=${'ee'.repeat(8)}`);
  check('старая форма ?installId= значит «мои»: присланное значение не читается ВООБЩЕ,'
    + ' и живая кнопка «убрать мои» не ломается',
  oldForm.st === 200 && oldForm.j.removed >= 1
    && (oldForm.j.seqs || []).includes(mineMsg.j.seq), oldForm.j);
  const addBack = await iq('POST', `/group/${GID_A}/member`, { memberId: M2 });
  const allByMember = await iq('DELETE', `/chat?gid=${GID_A}&all=1`, undefined, TOK2);
  check('снести журнал группы целиком может только её создатель',
    addBack.st === 200 && allByMember.st === 403, allByMember.j);
  check('all=1 без группы — 400: смысл «весь журнал» без группы не определён',
    (await iq('DELETE', '/chat?all=1')).st === 400);
  const allOk = await iq('DELETE', `/chat?gid=${GID_A}&all=1`);
  check('создатель сносит журнал группы целиком', allOk.st === 200 && allOk.j.left === 0, allOk.j);
  check('журнал другой группы при этом не тронут',
    ((await iq('GET', `/chat?gid=${GID_B}&since=0`, undefined, TOK2)).j.messages || []).length >= 1);
  // Второй уровень: отзыв установки целиком — правка файла владельцем ноды.
  const mem = rdJ('members.json');
  mem[M2].status = 'revoked';
  wrJ('members.json', mem);
  const rv1 = await iq('GET', '/me', undefined, TOK2);
  const rv2 = await iq('POST', '/chat', { gid: GID_B, text: 'вернулся' }, TOK2);
  const rv3 = await iq('POST', '/slice', mkSlice(M2INST, 'monty'), TOK2);
  check('второй уровень: status ≠ active — 401 на всех ручках со СЛЕДУЮЩЕГО запроса, без рестарта',
    rv1.st === 401 && rv2.st === 401 && rv3.st === 401, { me: rv1.st, chat: rv2.st, slice: rv3.st });
  mem[M2].status = 'active';
  wrJ('members.json', mem);
  check('и возвращается тоже немедленно: правка файла — настоящий аварийный ход владельца',
    (await iq('GET', '/me', undefined, TOK2)).st === 200);
  // Отзыв поручителя гасит его непогашенные приглашения: право проверяется в момент размена,
  // а не только в момент выдачи. Проверяем на ОДНОМ И ТОМ ЖЕ живом коде: сначала отказ при
  // отозванном поручителе, потом успех при живом — иначе зелёное могло бы значить «код
  // вообще не выдался».
  const invM2 = await mkInv({ groups: [GID_B] }, TOK2);
  check('приглашение живым участником в его собственную группу выдано', !!invM2.code, invM2);
  mem[M2].status = 'revoked';
  wrJ('members.json', mem);
  const rS = await tryJoin(invM2.code);
  check('отзыв участника гасит его непогашенные приглашения',
    rS.st === 410 && /пригласивший/.test(rS.j.error || ''), rS.j);
  mem[M2].status = 'active';
  wrJ('members.json', mem);
  const rS2 = await iq('POST', '/join', { code: invM2.code });
  check('тот же код при живом поручителе разменивается: гасит именно отзыв, а не срок и не форма',
    rS2.st === 200 && (rS2.j.groups || []).includes(GID_B), rS2.j);

  console.log('\nиспорченный реестр участников и уход из лиги:');
  const goodMembers = fs.readFileSync(IP('members.json'));
  fs.writeFileSync(IP('members.json'), 'это не json');
  const broke = await iq('GET', '/me');
  check('members.json есть, но не читается → 503 на все ручки, а НЕ откат к общему ключу',
    broke.st === 503 && (await iq('GET', '/peers', undefined, null)).st === 503, broke.j);
  check('/health при этом жив: на нём висят приёмка выката и доказательство подключения',
    (await iq('GET', '/health', undefined, null)).st === 200);
  fs.writeFileSync(IP('members.json'), goodMembers);
  check('починили файл — работает снова, и снова без рестарта', (await iq('GET', '/me')).st === 200);
  const bye = await iq('DELETE', '/me', undefined, TOK2);
  check('уйти из лиги может каждый: DELETE /me, и дальше 401 везде',
    bye.st === 200 && bye.j.status === 'left'
    && (await iq('GET', '/me', undefined, TOK2)).st === 401, bye.j);
  check('токен ушедшего не мелькнул в журнале ноды', !idout.includes(TOK2));
  idchild.kill();

  child.kill();
  // Свои временные каталоги — можно удалять напрямую (правило про корзину про чужие данные).
  for (const d of [DATA, SANDBOX, IDDATA]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(`\nитог: ${ok} прошло, ${bad} упало`);
  // Пауза перед выходом: без неё libuv на Windows падает ассертом на закрытии
  // хендла убитого ребёнка уже ПОСЛЕ итога — выглядит как провал теста, хотя это не он.
  await sleep(150);
  process.exit(bad ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
