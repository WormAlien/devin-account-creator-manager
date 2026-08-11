"""anymodel/recorder_bg.py
Рекордер anymodel.org — 1 в 1 по образцу camoufox_tmailor.py.
Те же параметры запуска, тот же Turnstile-флоу.
"""
import asyncio, json, os, re, sys, time, traceback
from pathlib import Path

from camoufox import AsyncCamoufox

REGISTER_URL = "https://anymodel.org/app/register"

OUT_DIR = Path(__file__).parent / "recordings"
OUT_DIR.mkdir(parents=True, exist_ok=True)
SESSION_ID = time.strftime("%Y%m%d_%H%M%S")
LOG_FILE = OUT_DIR / f"{SESSION_ID}_log.jsonl"
SHOT_DIR = OUT_DIR / f"{SESSION_ID}_shots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)
PROFILE_DIR = OUT_DIR / f"profile_{SESSION_ID}"
PROFILE_DIR.mkdir(parents=True, exist_ok=True)


def log(tag, msg):
    t = time.strftime("%H:%M:%S")
    line = f"[{t}] [{tag}] {msg}"
    try:
        print(line, flush=True, file=sys.stderr)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode(), flush=True, file=sys.stderr)
    entry = {"t": time.time(), "tag": tag, "msg": msg}
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")


async def snapshot_dom(page, label):
    try:
        data = await page.evaluate("""() => {
            const inputs = Array.from(document.querySelectorAll('input, textarea')).map(i => ({
                type: i.type, name: i.name, placeholder: i.placeholder, value: (i.value||'').slice(0,80)
            }));
            const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
                text: (b.textContent||'').trim().slice(0,60), disabled: b.disabled,
            }));
            const cf = document.querySelector('.cf-turnstile');
            let cfBox = null;
            if (cf) {
                const r = cf.getBoundingClientRect();
                cfBox = {x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height)};
            }
            const iframes = Array.from(document.querySelectorAll('iframe')).map(f => {
                const r = f.getBoundingClientRect();
                return {src: (f.src||'').slice(0,120), x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height)};
            }).filter(f => f.w > 0 && f.h > 0);
            return {
                url: location.href,
                inputs, buttons,
                cfToken: (document.querySelector('input[name="cf-turnstile-response"]')||{}).value||null,
                cfWidget: cfBox,
                iframes,
            };
        }""")
        log("dom", f"[{label}] {json.dumps(data, ensure_ascii=False)[:500]}")
        return data
    except Exception as e:
        log("dom_err", f"[{label}] {e}")
        return None


# ── Turnstile ───────────────────────────────────────────────────────
# Те же функции что в camoufox_tmailor.py, адаптированные под anymodel.org

FIND_VERIFY_JS = """
() => {
  const RE = /not a robot|verify that you|подтвердите|не робот|я не робот|verify you are human|подтвердите, что вы человек/i;
  const els = Array.from(document.querySelectorAll('button,div,span,a,p,label'));
  const cand = els.filter(x => {
    const r = x.getBoundingClientRect();
    if (r.width < 60 || r.height < 12 || r.height > 120) return false;
    if (x.offsetParent === null) return false;
    const txt = (x.textContent || '');
    if (!RE.test(txt)) return false;
    return txt.trim().length < 120;
  }).sort((a,b) => {
    const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
    return (ra.width*ra.height) - (rb.width*rb.height);
  });
  const b = cand[0];
  if (!b) return null;
  b.scrollIntoView({block:'center'});
  const r = b.getBoundingClientRect();
  return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
          box:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},
          text:(b.textContent||'').trim().slice(0,60)};
}
"""


async def _get_turnstile_token(page, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            tok = await page.evaluate(
                "() => (document.querySelector('input[name=\"cf-turnstile-response\"]')||{}).value||''"
            )
        except Exception:
            tok = ""
        if tok and len(tok) > 20:
            return tok
        await asyncio.sleep(0.5)
    return ""


async def _cf_widget_box(page):
    try:
        return await page.evaluate(
            """() => { const el=document.querySelector('.cf-turnstile'); if(!el) return null;
               const r=el.getBoundingClientRect();
               return r.width>0 && r.height>0 ? {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)} : null; }"""
        )
    except Exception:
        return None


async def _human_click(page, x, y, label=""):
    await page.mouse.move(x, y)
    await asyncio.sleep(0.02)
    await page.mouse.down()
    await asyncio.sleep(0.03)
    await page.mouse.up()
    log("captcha", f"клик [{label}] ({round(x)},{round(y)})")


async def _click_verify_trigger(page, retries=6, delay=0.3):
    for attempt in range(1, retries + 1):
        try:
            info = await page.evaluate(FIND_VERIFY_JS)
        except Exception as e:
            log("captcha", f"verify-trigger err: {e}")
            info = None

        if info:
            log("captcha", f"нашёл кнопку 'не робот' {info.get('box')} «{info.get('text')}» — жму")
            await _human_click(page, info["x"], info["y"], "verify-not-a-robot")
            return True

        if await _cf_widget_box(page):
            log("captcha", "виджет уже отрисован, плашка не нужна")
            return True

        if attempt == 1 or attempt % 3 == 0:
            log("captcha", f"жду появления 'не робот' ({attempt}/{retries})")
        await asyncio.sleep(delay)

    log("captcha", "кнопка 'не робот' не найдена")
    return False


async def _auto_solve_turnstile(page, timeout=30, reset_token=True):
    if reset_token:
        try:
            await page.evaluate(
                """() => { const el=document.querySelector('input[name="cf-turnstile-response"]');
                   if (el) el.value = '';
                   if (window.turnstile && window.turnstile.reset) { try { window.turnstile.reset(); } catch(e){} } }"""
            )
        except Exception:
            pass

    await _click_verify_trigger(page)

    deadline = time.time() + timeout
    clicked = False
    last_trigger = time.time()
    trigger_count = 1
    while time.time() < deadline:
        tok = await _get_turnstile_token(page, timeout=1)
        if tok:
            log("captcha", f"turnstile решён, токен {len(tok)} симв")
            return tok

        box = await _cf_widget_box(page)
        if box and not clicked:
            try:
                await page.evaluate(
                    "() => { const el=document.querySelector('.cf-turnstile'); if(el) el.scrollIntoView({block:'center'}); }"
                )
            except Exception:
                pass
            await asyncio.sleep(0.2)
            box = await _cf_widget_box(page)
            if box:
                cx = box["x"] + 30
                cy = box["y"] + box["h"] // 2
                log("captcha", f"виджет {box}, кликаю чекбокс ({cx},{round(cy)})")
                await _human_click(page, cx, cy, "turnstile-checkbox")
                clicked = True
                await asyncio.sleep(0.5)
        elif not box and not clicked:
            now = time.time()
            if trigger_count < 2 and now - last_trigger >= 10.0:
                last_trigger = now
                trigger_count += 1
                log("captcha", "виджет не появился — пробую триггер ещё раз")
                await _click_verify_trigger(page)

        await asyncio.sleep(0.3)

    log("captcha", "turnstile не решён за отведённое время")
    return None


async def main():
    log("start", f"Camoufox anymodel recorder (PID={os.getpid()})")

    try:
        async with AsyncCamoufox(
            headless=False,
            os="windows",
            window=(1280, 720),
            persistent_context=True,
            user_data_dir=str(PROFILE_DIR),
            disable_coop=True,
            humanize=True,
            main_world_eval=True,
            i_know_what_im_doing=True,
        ) as browser:
            page = browser.pages[0] if browser.pages else await browser.new_page()
            page.on("pageerror", lambda e: log("pageerror", str(e)))

            log("nav", f"открываю {REGISTER_URL}")
            await page.goto(REGISTER_URL, wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(3)
            await snapshot_dom(page, "after_goto")

            # Пытаемся решить Turnstile сразу
            log("captcha", "пробую решить Turnstile...")
            tok = await _auto_solve_turnstile(page, timeout=30)
            if tok:
                log("captcha", f"✅ Turnstile решён на старте ({len(tok)} симв)")
            else:
                log("captcha", "❌ Turnstile не решён на старте — пробую через 5с...")
                await asyncio.sleep(5)
                tok = await _auto_solve_turnstile(page, timeout=30)
                if tok:
                    log("captcha", f"✅ Turnstile решён после паузы ({len(tok)} симв)")
                else:
                    log("captcha", "❌ Turnstile не решён — продолжаем без токена (кнопка Sign up будет заблокирована)")

            await snapshot_dom(page, "after_captcha")

            # Периодический мониторинг + повторные попытки
            attempt = 0
            while True:
                await asyncio.sleep(5)
                data = await snapshot_dom(page, "poll")
                if data and not data.get("cfToken"):
                    attempt += 1
                    if attempt % 6 == 0:  # каждые 30с
                        log("captcha", f"повторная попытка #{attempt//6}")
                        await _auto_solve_turnstile(page, timeout=20)

    except Exception as e:
        log("fatal", f"{e}\n{traceback.format_exc()}")


if __name__ == "__main__":
    asyncio.run(main())
