// tools/jw-tariff-probe.js
//
// Замер ТАРИФА JustWoker: платим за токены или плоско за запрос? От ответа зависит,
// можно ли включать хедж в keepalive (`maxHedges`) — на плоском тарифе каждый дубль
// стоит как полный ответ, и страховка превращается в +N% к счёту без выигрыша в скорости.
//
// Хост внесён в `FLAT_RATE_HOSTS` (keepalive-proxy.js) ПО АНАЛОГИИ с tabi/gorouter, без
// замера — так и записано в KEEPALIVE-TUNING.md. Этот скрипт закрывает пробел.
//
// Считаем по `usage.cost`, который панель отдаёт в ответе сама (у New-API-форков это
// её же биллинговая цифра, в долларах). Для порванного запроса ответа нет — там
// сравниваем остаток `quota` до и после через tools/jw-self-probe.js.
//
// Ключ берём аргументом, чтобы мерить на аккаунте с нулевым расходом и не путать
// замер с рабочим трафиком.
//
// Использование: node tools/jw-tariff-probe.js <sk-ключ>

const HOST = 'api.justwoker.icu';
const MODEL = 'claude-opus-4-5-20251101';
const key = String(process.argv[2] || '').trim();
if (!/^sk-/.test(key)) { console.error('нужен sk-ключ аккаунта'); process.exit(1); }

// Заголовки Claude Code обязательны: без них шлюз отвечает 403 на всё (замер 22.08 —
// первый прогон этого же скрипта). Набор — копия JW_CC_HEADERS из transparent-proxy.js.
// 🪤 Слать одновременно `x-api-key` и `Authorization` нельзя, шлюз ждёт Bearer.
const CC_HEADERS = {
  'content-type': 'application/json',
  'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12',
  'anthropic-dangerous-direct-browser-access': 'true',
  'x-app': 'cli',
};

async function call(name, body, { abortAfterMs = 0 } = {}) {
  const ac = new AbortController();
  let timer = null;
  if (abortAfterMs) timer = setTimeout(() => ac.abort(), abortAfterMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`https://${HOST}/v1/messages`, {
      method: 'POST',
      headers: { ...CC_HEADERS, Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    const ms = Date.now() - t0;
    const u = (j && j.usage) || {};
    console.log(`${name.padEnd(22)} ${String(r.status).padEnd(4)} ${String(ms + 'мс').padEnd(8)}`
      + ` in=${String(u.input_tokens ?? '?').padEnd(7)} out=${String(u.output_tokens ?? '?').padEnd(5)}`
      + ` cost=$${u.cost != null ? Number(u.cost).toFixed(7) : '?'}`
      + (r.status !== 200 ? `  ← ${text.slice(0, 200)}` : ''));
    return { status: r.status, ms, usage: u };
  } catch (e) {
    console.log(`${name.padEnd(22)} ПОРВАН после ${Date.now() - t0}мс (${e.name})`);
    return { aborted: true, ms: Date.now() - t0 };
  } finally { if (timer) clearTimeout(timer); }
}

(async () => {
  console.log('шлюз ' + HOST + ', модель ' + MODEL + '\n');
  console.log('сценарий               код  время    входные      выход  цена');

  // A. Пол входа: у этого шлюза он ~7.17к даже на трёх словах (подмешивается свой
  // системный промпт, апстрим Amazon Kiro).
  await call('A крошечный', { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'reply with the single word PONG' }] });

  // B. Тот же вход, много выхода. Токенный тариф → цена вырастет кратно выходу;
  // плоский → останется той же.
  await call('B много выхода', { model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: 'Напиши подробный рассказ на 900 слов про кота-программиста.' }] });

  // C. Много входа: +~10к токенов мусора. Отделяет «плоско за запрос» от «по входу».
  const filler = 'лорем ипсум долор сит амет консектетур адипискинг элит '.repeat(700);
  await call('C много входа', { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: filler + '\n\nОтветь одним словом: OK' }] });

  // D. Порванный дубль — ровно судьба проигравшего в хедже (settle() рвёт соединение).
  // Цену смотрим по остатку quota до/после: ответа тут нет.
  await call('D порван на 6с', { model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: 'Напиши рассказ на 900 слов про кота-архитектора.' }] }, { abortAfterMs: 6000 });

  console.log('\nОстаток сверить: node tools/jw-self-probe.js <label> до и после прогона.');
})();
