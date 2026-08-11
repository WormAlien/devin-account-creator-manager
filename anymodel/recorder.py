"""anymodel/recorder.py
Camoufox рекордер для anymodel.org — записывает весь процесс регистрации:
  - клики (селектор, координаты, текст элемента)
  - URL-изменения
  - console.log / console.error / page errors
  - network responses (все запросы)
  - скриншоты после каждого клика
  - DOM-слепки (инпуты, кнопки, cf-turnstile)

Использование:
  cd Autoreger_Clean
  python anymodel/recorder.py
Затем кликай в браузере, проходи регистрацию. Нажми Enter в консоли, когда закончишь.
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


def log_event(kind, payload):
    entry = {"t": time.time(), "kind": kind, "payload": payload}
    line = json.dumps(entry, ensure_ascii=False, default=str)
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


async def snapshot_dom(page, label):
    try:
        data = await page.evaluate("""() => {
            const input = (sel) => {
                const el = document.querySelector(sel);
                return el ? { value: el.value, type: el.type, name: el.name, placeholder: el.placeholder } : null;
            };
            const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]')).map(b => ({
                tag: b.tagName,
                text: (b.textContent || "").trim().slice(0, 80),
                id: b.id,
                class: (b.className || "").toString().slice(0, 100),
                href: b.href || null,
                disabled: b.disabled,
                rect: b.getBoundingClientRect ? {
                    x: Math.round(b.getBoundingClientRect().x),
                    y: Math.round(b.getBoundingClientRect().y),
                    w: Math.round(b.getBoundingClientRect().width),
                    h: Math.round(b.getBoundingClientRect().height),
                } : null,
            }));
            const inputs = Array.from(document.querySelectorAll('input, textarea')).map(i => ({
                tag: i.tagName,
                type: i.type,
                name: i.name,
                id: i.id,
                placeholder: i.placeholder,
                value: i.value,
                maxLength: i.maxLength > 0 ? i.maxLength : null,
            }));
            return {
                url: location.href,
                title: document.title,
                inputs: inputs,
                buttons: buttons.slice(0, 50),
                cfToken: (document.querySelector('input[name="cf-turnstile-response"]') || {}).value || null,
                bodyText: document.body ? document.body.innerText.slice(0, 1000) : "",
            };
        }""")
        log_event("dom_snapshot", {"label": label, "data": data})
    except Exception as e:
        log_event("dom_snapshot_error", {"label": label, "error": str(e)})


async def log_response(res):
    try:
        url = res.url
        status = res.status
        method = res.request.method if res.request else "?"
        # Логируем все запросы (не только API)
        try:
            body = await res.text()
            if len(body) > 3000:
                body = body[:3000] + "..."
        except Exception:
            body = "<unreadable>"
        log_event("network", {"url": url, "status": status, "method": method, "body": body})
    except Exception:
        pass


async def main():
    print(f"=== AnyModel Recorder ===")
    print(f"Лог: {LOG_FILE}")
    print(f"Скриншоты: {SHOT_DIR}")
    print(f"Открой окно браузера, проходи регистрацию на anymodel.org.")
    print(f"Нажми Enter в консоли, когда закончишь.")

    try:
        async with AsyncCamoufox(
            headless=False,
            os="windows",
            window=(1280, 900),
            persistent_context=True,
            user_data_dir=str(PROFILE_DIR),
            disable_coop=True,
            humanize=10.0,
            main_world_eval=True,
            i_know_what_im_doing=True,
        ) as browser:
            page = browser.pages[0] if browser.pages else await browser.new_page()

            # Логируем ошибки страницы
            page.on("pageerror", lambda e: log_event("pageerror", {"msg": str(e)}))
            page.on("console", lambda msg: log_event("console", {"type": msg.type, "text": msg.text}))

            # Слушаем ВСЕ network responses
            page.on("response", lambda res: asyncio.create_task(log_response(res)))

            # Ловим redirect-цепочку (тут может быть OTP / magic link)
            page.on("framenavigated", lambda frame: log_event("navigation", {
                "url": frame.url,
                "name": frame.name,
            }) if frame == page.main_frame else None)

            log_event("start", {"url": REGISTER_URL})
            await page.goto(REGISTER_URL, wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(2)
            await snapshot_dom(page, "after_goto")

            # Экспонируем Python-функцию в страницу для записи кликов
            async def click_handler(data):
                log_event("click", data)
                try:
                    shot_path = SHOT_DIR / f"{int(time.time()*1000)}.png"
                    await page.screenshot(path=str(shot_path), full_page=False)
                    log_event("screenshot", {"path": str(shot_path)})
                except Exception as e:
                    log_event("screenshot_error", {"error": str(e)})
                await snapshot_dom(page, "after_click")

            await page.expose_function("__recorderClick", click_handler)

            # Инжектируем JS-рекордер кликов
            await page.evaluate("""() => {
                window.__recorderClicks = [];
                document.addEventListener("click", (e) => {
                    const el = e.target;
                    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : {};
                    const data = {
                        time: Date.now(),
                        x: e.clientX,
                        y: e.clientY,
                        tag: el.tagName,
                        id: el.id,
                        class: (el.className || "").toString(),
                        text: (el.textContent || "").trim().slice(0, 100),
                        href: el.href || null,
                        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                    };
                    window.__recorderClicks.push(data);
                    if (typeof window.__recorderClick === "function") {
                        window.__recorderClick(data).catch(() => {});
                    }
                }, true);

                // Перехватываем submit форм
                document.addEventListener("submit", (e) => {
                    const form = e.target;
                    const fd = new FormData(form);
                    const data = {};
                    for (const [k,v] of fd.entries()) data[k] = typeof v === "string" ? v : "<file>";
                    if (typeof window.__recorderClick === "function") {
                        window.__recorderClick({ time: Date.now(), tag: "FORM_SUBMIT", action: form.action, method: form.method, fields: data, x: 0, y: 0, rect: {} }).catch(() => {});
                    }
                }, true);
            }""")

            # Периодические слепки DOM
            async def poll():
                while True:
                    await asyncio.sleep(3)
                    await snapshot_dom(page, "poll")

            poll_task = asyncio.create_task(poll())

            # Ожидаем Enter в консоли
            await asyncio.to_thread(sys.stdin.readline)

            poll_task.cancel()
            try:
                await poll_task
            except asyncio.CancelError:
                pass

            await snapshot_dom(page, "final")
            print(f"\nГотово. Лог: {LOG_FILE}")
            print(f"Скриншоты: {SHOT_DIR}")

    except Exception as e:
        print(f"Ошибка: {e}")
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())
