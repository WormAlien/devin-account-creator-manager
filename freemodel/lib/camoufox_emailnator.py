"""freemodel/lib/camoufox_emailnator.py
Camoufox (Firefox stealth) клиент для emailnator.com.
Протокол: JSON-lines через stdin/stdout.
Команды:
  {"cmd":"create"}                -> {"ok":true, "email":...}
  {"cmd":"wait_otp", "timeout":120, "poll":8, "from_hint":"cun"} -> {"ok":true, "code":"123456"} | {"ok":false, "error":"timeout"}
  {"cmd":"stop"}                  -> завершает процесс
"""
import asyncio, json, os, re, shutil, sys, time, traceback
from pathlib import Path

from camoufox import AsyncCamoufox

BASE_URL = "https://www.emailnator.com"
PROFILE_DIR = Path(__file__).parent / f"camoufox_emailnator_profile_{os.getpid()}"
PROFILE_DIR.mkdir(parents=True, exist_ok=True)

# Профиль свой на каждый запуск и до 21.08.2026 не убирался никогда: накопилось
# 580 каталогов на 37.4 ГБ — 82% веса всего репо. Подметаем по mtime, а НЕ по
# живости PID: Windows переиспользует номера (2 из 580 мёртвых профилей совпали
# с чужими живыми python.exe), а os.kill(pid, 0) здесь зовёт TerminateProcess.
# 6 часов — с большим запасом дольше любого прогона, который длится минуты.
for _stale in PROFILE_DIR.parent.glob("camoufox_emailnator_profile_*"):
    try:
        if _stale != PROFILE_DIR and _stale.is_dir() and _stale.stat().st_mtime < time.time() - 6 * 3600:
            shutil.rmtree(_stale, ignore_errors=True)
    except OSError:
        pass

POLL_INTERVAL_MS = 8000
MAX_WAIT_MIN = 15


def log(tag: str, msg: str):
    t = time.strftime("%H:%M:%S")
    line = f"[{t}] [{tag}] {msg}"
    try:
        print(line, flush=True, file=sys.stderr)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode(), flush=True, file=sys.stderr)


def out(obj: dict):
    try:
        print(json.dumps(obj, ensure_ascii=False), flush=True, file=sys.stdout)
    except UnicodeEncodeError:
        print(json.dumps(obj, ensure_ascii=True), flush=True, file=sys.stdout)


async def _configure_toggles(page):
    """Выставляет галочки: только .Gmail ON, остальные OFF.
    Все 4 тумблера делаем за один JS-вызов — меньше round-trip'ов и
    не падаем если один label не найден."""
    await page.evaluate("""() => {
        const desired = {
            'custom-switch-domain':     false,
            'custom-switch-plusGmail':  false,
            'custom-switch-dotGmail':   true,
            'custom-switch-googleMail': false,
        };
        for (const [id, want] of Object.entries(desired)) {
            try {
                const el = document.getElementById(id);
                if (!el || el.checked === want) continue;
                const lbl = document.querySelector('label[for="' + id + '"]');
                if (lbl) lbl.click(); else el.click();
            } catch(e) {}
        }
    }""")
    await asyncio.sleep(0.5)
    # Логируем итоговое состояние
    try:
        states = await page.evaluate("""() => {
            const ids = ['custom-switch-domain','custom-switch-plusGmail',
                         'custom-switch-dotGmail','custom-switch-googleMail'];
            return ids.map(id => {
                const el = document.getElementById(id);
                return el ? el.checked : null;
            });
        }""")
        log("email", f"toggles after config: domain={states[0]} +gmail={states[1]} .gmail={states[2]} googlemail={states[3]}")
    except Exception:
        pass


async def create_email(page):
    log("email", "открываю emailnator.com...")
    await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60000)
    try:
        await page.click('button:has-text("Consent")', timeout=4000)
    except Exception:
        pass
    await asyncio.sleep(1.5)

    # Иногда emailnator встречает Cloudflare-челленджем ("Just a moment...",
    # ?__cf_chl_rt_tk в url). Camoufox проходит его сам за несколько секунд,
    # но подождать надо — иначе читаем пустую страницу без единого input.
    for _ in range(30):
        try:
            st = await page.evaluate(
                "() => ({t: document.title, n: document.querySelectorAll('input').length})"
            )
        except Exception:
            await asyncio.sleep(1)
            continue
        if st["n"] > 0 and "just a moment" not in (st["t"] or "").lower():
            break
        log("email", "Cloudflare-челлендж, жду...")
        await asyncio.sleep(2)

    # Выставляем нужные переключатели: только .Gmail ON, остальные OFF.
    # Это даёт уникальные dot-варианты вида cal.i.na.sam@gmail.com.
    await _configure_toggles(page)

    # Жмём кнопку генерации: Go! (если на главной) или Generate New (если уже
    # на /mailbox/ после предыдущего вызова).
    try:
        clicked = await page.evaluate("""() => {
            const btns = [...document.querySelectorAll('button')];
            // "Generate New" приоритетнее — если мы уже на mailbox.
            const genNew = btns.find(b => (b.innerText||'').trim().startsWith('Generate'));
            if (genNew) { genNew.click(); return 'generate_new'; }
            const go = btns.find(b => (b.innerText||'').trim().startsWith('Go'));
            if (go) { go.click(); return 'go'; }
            return null;
        }""")
        log("email", f"нажата кнопка: {clicked}")
        try:
            await page.wait_for_url("**mailbox**", timeout=8000)
        except Exception:
            await asyncio.sleep(3)
    except Exception as e:
        log("email", f"кнопка генерации: {e}")

    def looks_like_gmail(v):
        # googlemail.com — тот же Gmail, другой домен; anymodel принимает оба.
        return "@" in v and v.strip().split("@")[-1].lower() in ("gmail.com", "googlemail.com")

    email = ""
    for i in range(10):
        try:
            email = await page.evaluate("""() => {
                function isGmail(v) {
                    const d = (v||'').trim().split('@')[1];
                    return d === 'gmail.com' || d === 'googlemail.com';
                }
                // После Go! сайт редиректит на /mailbox/#email — адрес в хеше.
                const hash = decodeURIComponent(location.hash.replace('#',''));
                if (isGmail(hash)) return hash.trim();
                // Fallback: поле input (до редиректа).
                for (const el of document.querySelectorAll('input')) {
                    if (isGmail(el.value)) return el.value.trim();
                }
                // Fallback: текст страницы.
                const m = (document.body.innerText||'').match(/[a-zA-Z0-9.+_%\\-]+@(?:gmail|googlemail)\\.com/);
                return m ? m[0] : '';
            }""")
            if looks_like_gmail(email):
                break
            email = ""
        except Exception:
            pass
        await asyncio.sleep(1)

    if not email:
        try:
            diag = await page.evaluate(
                """() => ({u: location.href, t: document.title,
                          n: document.querySelectorAll('input').length,
                          v: [...document.querySelectorAll('input')].map(e=>(e.value||'').slice(0,30)),
                          b: (document.body.innerText||'').slice(0,300)})"""
            )
            log("email", f"диагностика: url={diag['u']} title={diag['t']!r} inputs={diag['n']} vals={diag['v']}")
            log("email", f"body: {diag['b']}")
        except Exception as de:
            log("email", f"диагностика не удалась: {de}")
        raise Exception("Не удалось получить email от emailnator")

    log("email", f"Gmail alias: {email}")
    return email


async def regenerate_email(page):
    """Жмём "Generate New" на той же сессии — сайт подставит новый алиас."""
    log("email", "генерирую новый адрес (Generate New)...")

    # Кнопка может называться "Generate New" или быть с иконкой обновления.
    btn = None
    for name in ("Generate New", "Generate", "New"):
        loc = page.get_by_role("button", name=name)
        if await loc.count():
            btn = loc.first
            break

    if not btn:
        # Если по роли не нашли — пробуем по тексту.
        try:
            btn = page.get_by_text("Generate New", exact=False).first
            if not await btn.count():
                btn = None
        except Exception:
            btn = None

    if btn:
        await btn.click(timeout=3000)
        await asyncio.sleep(2)
    else:
        # Нет кнопки — перезагружаем страницу, это тоже даст новый адрес.
        log("email", "кнопка Generate New не найдена — перезагружаю страницу")
        await page.reload(wait_until="domcontentloaded", timeout=60000)
        await asyncio.sleep(2)

    # Ждём новый адрес (логика та же, что в create_email).
    def looks_like_email(v):
        v = (v or "").strip()
        return "@" in v and v.split("@")[-1].lower() in ("gmail.com", "googlemail.com")

    email = ""
    for i in range(10):
        try:
            vals = await page.evaluate(
                "() => [...document.querySelectorAll('input')].map(e => e.value || '')"
            )
            for v in vals:
                if looks_like_email(v):
                    email = v.strip()
                    break
            if email:
                break
        except Exception:
            pass
        await asyncio.sleep(1)

    if not email:
        raise Exception("Не удалось получить новый email от emailnator")

    log("email", f"новый Gmail alias: {email}")
    return email


async def _js_click_by_text(page, *texts):
    """Находит элемент с нужным текстом через JS и кликает мышью. Возвращает текст или None."""
    info = await page.evaluate(f"""() => {{
        const candidates = {list(texts)};
        for (const txt of candidates) {{
            for (const el of document.querySelectorAll('button, a, span, div, input[type="submit"]')) {{
                if ((el.innerText||el.value||'').trim() === txt) {{
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0)
                        return {{x: r.x+r.width/2, y: r.y+r.height/2, txt}};
                }}
            }}
        }}
        return null;
    }}""")
    if info:
        await page.mouse.click(info["x"], info["y"])
    return info["txt"] if info else None


async def _fill_input_native(page, selector, value):
    """Заполняет инпут через native setter — не вызывает зависания."""
    await page.evaluate(f"""() => {{
        const el = document.querySelector({repr(selector)});
        if (!el) return;
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(el, {repr(value)});
        el.dispatchEvent(new Event('input', {{bubbles:true}}));
        el.dispatchEvent(new Event('change', {{bubbles:true}}));
    }}""")


async def poll_inbox(page, email, timeout=120, poll=10, from_hint=""):
    log("inbox", f"проверяю {email} каждые {poll}s ({timeout}s макс)...")
    await page.goto(f"{BASE_URL}/mailbox#{email}", wait_until="domcontentloaded", timeout=30000)
    await asyncio.sleep(3)

    seen_ids = set()
    deadline = asyncio.get_event_loop().time() + timeout

    while asyncio.get_event_loop().time() < deadline:
        try:
            result = await page.evaluate("""async (email) => {
                const csrf = decodeURIComponent(
                    document.cookie.split(';').map(c=>c.trim())
                    .find(c=>c.startsWith('XSRF-TOKEN='))?.split('=')[1] || ''
                );
                const r = await fetch('/message-list', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'X-XSRF-TOKEN': csrf,
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: JSON.stringify({email})
                });
                const text = await r.text();
                if (!r.ok) return {error: r.status, body: text.slice(0,200)};
                try { return JSON.parse(text); } catch(e) { return {error: 'parse', body: text.slice(0,200)}; }
            }""", email)

            log("inbox", f"list: {str(result)[:300]}")

            if isinstance(result, dict) and result.get("error") in (419, 403):
                log("inbox", f"{result.get('error')} — перезагружаю mailbox...")
                await page.goto(f"{BASE_URL}/mailbox#{email}", wait_until="domcontentloaded", timeout=30000)
                await asyncio.sleep(5)
                continue

            if isinstance(result, dict) and result.get("error"):
                await asyncio.sleep(poll)
                continue

            msgs = (result or {}).get("messageData", [])
            for msg in msgs:
                mid = msg.get("messageID", "")
                if mid == "ADSVPN" or mid in seen_ids:
                    continue

                frm = msg.get("from", "")
                subj = msg.get("subject", "")

                # Если задан from_hint — пропускаем письма не от нужного отправителя
                if from_hint and from_hint.lower() not in frm.lower():
                    seen_ids.add(mid)
                    continue

                log("inbox", f"новое письмо: from={frm!r} subj={subj!r}")

                body_res = await page.evaluate("""async (args) => {
                    const csrf = decodeURIComponent(
                        document.cookie.split(';').map(c=>c.trim())
                        .find(c=>c.startsWith('XSRF-TOKEN='))?.split('=')[1] || ''
                    );
                    const r = await fetch('/message-list', {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            'X-XSRF-TOKEN': csrf,
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        body: JSON.stringify(args)
                    });
                    const text = await r.text();
                    if (!r.ok) return {error: r.status, raw: text.slice(0,100)};
                    try { return {ok: true, data: JSON.parse(text)}; } catch(e) { return {ok: true, raw: text}; }
                }""", {"email": email, "messageID": mid})

                log("inbox", f"body_res: {str(body_res)[:400]}")
                seen_ids.add(mid)

                text = ""
                if isinstance(body_res, dict) and body_res.get("ok"):
                    data = body_res.get("data")
                    if isinstance(data, dict):
                        text = data.get("mail_body", "") or data.get("body", "") or str(data)
                    else:
                        text = body_res.get("raw", "")

                for pat in [
                    r"(?:code|verify|otp|pin|token)[^\d]{0,40}(\d{6,8})",
                    r"\b(\d{6})\b",
                ]:
                    m = re.search(pat, text, re.I)
                    if m:
                        log("inbox", f"КОД: {m.group(1)}")
                        return {"ok": True, "code": m.group(1)}

        except Exception as e:
            log("inbox", f"⚠️ {e}")

        await asyncio.sleep(poll)

    log("inbox", f"❌ timeout {timeout}s")
    return {"ok": False, "error": "timeout"}


async def main():
    headless = "--headless" in sys.argv or os.environ.get("HEADLESS") == "1"
    log("start", f"Camoufox emailnator headless={headless}")

    try:
        async with AsyncCamoufox(
            headless=headless,
            os="windows",
            window=(1280, 720),
            persistent_context=True,
            user_data_dir=str(PROFILE_DIR),
            disable_coop=True,
            humanize=10.0,
            main_world_eval=True,
            i_know_what_im_doing=True,
        ) as browser:
            page = browser.pages[0] if browser.pages else await browser.new_page()
            page.on("pageerror", lambda e: None)

            current_email = None

            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    cmd = json.loads(line)
                except Exception as e:
                    out({"ok": False, "error": f"invalid json: {e}"})
                    continue

                action = cmd.get("cmd")
                if action == "create":
                    try:
                        current_email = await create_email(page)
                        out({"ok": True, "email": current_email})
                    except Exception as e:
                        log("create", f"error: {e}")
                        out({"ok": False, "error": str(e)})

                elif action == "wait_otp":
                    if not current_email:
                        out({"ok": False, "error": "no email created yet"})
                        continue
                    try:
                        result = await poll_inbox(
                            page,
                            current_email,
                            timeout=cmd.get("timeout", 120),
                            poll=cmd.get("poll", 8),
                            from_hint=cmd.get("from_hint", ""),
                        )
                        out(result)
                    except Exception as e:
                        log("wait_otp", f"error: {e}")
                        out({"ok": False, "error": str(e)})

                elif action == "stop":
                    out({"ok": True})
                    break

                else:
                    out({"ok": False, "error": f"unknown cmd: {action}"})

    except Exception as e:
        log("fatal", f"{e}\n{traceback.format_exc()}")
        out({"ok": False, "error": str(e)})
    finally:
        pass


if __name__ == "__main__":
    asyncio.run(main())
