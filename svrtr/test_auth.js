// Запуск: node svrtr/test_auth.js
// Выводит link, ждёт пока ты авторизуешься через TG, потом проверяет cookies и profile
const api = require('./svrtr/lib/svrtr-api');

(async () => {
  const cookies = [];
  const s = await api.authStart(cookies);
  if (!s.ok) { console.error('authStart failed:', s); process.exit(1); }
  console.log('\nОткрой ссылку в браузере или Telegram:');
  console.log('  ' + s.link);
  console.log('  (или t.me/' + 'svrtrbot?start=' + s.nonce + ')');
  console.log('\nОжидаю авторизации (макс 120с)...\n');

  const deadline = Date.now() + 120_000;
  let done = false;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const p = await api.authPoll(cookies, s.nonce);
    process.stdout.write(`poll status=${p.status} cookies=[${cookies.map(c=>c.name).join(',')}]\r`);
    if (p.done) { done = true; break; }
  }
  console.log();

  if (!done) { console.error('Timeout — авторизация не прошла'); process.exit(1); }

  console.log('\n✅ Poll 200! Cookies:');
  console.log(JSON.stringify(cookies, null, 2));

  console.log('\nПробую /api/user...');
  const ur = await api.apiFetch(cookies, '/api/user');
  console.log('  status:', ur.status, JSON.stringify(ur.json)?.slice(0,300) || ur.text?.slice(0,300));

  console.log('\nПробую /api/me...');
  const mr = await api.apiFetch(cookies, '/api/me');
  console.log('  status:', mr.status, JSON.stringify(mr.json)?.slice(0,300) || mr.text?.slice(0,300));

  console.log('\nПробую /profile...');
  const pr = await api.getProfile(cookies);
  console.log('  ok:', pr.ok, 'status:', pr.status, 'url:', pr.url);
  if (pr.apiKey) console.log('  KEY:', pr.apiKey);
  else console.log('  html[0..600]:', pr.html?.slice(0, 600));

  // Пробуем все /api/* пути
  for (const path of ['/api/keys', '/api/profile', '/api/account', '/api/settings']) {
    const r = await api.apiFetch(cookies, path);
    if (r.status !== 404 && r.status !== 405) {
      console.log(`\n${path}: ${r.status} ${JSON.stringify(r.json)?.slice(0,200) || r.text?.slice(0,200)}`);
    }
  }
})();
