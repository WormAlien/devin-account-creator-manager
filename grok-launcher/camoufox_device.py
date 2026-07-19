"""Авторизация на accounts.x.ai через Camoufox (обход Cloudflare) по кукам
из менеджера сессий Grok.

Camoufox (Firefox) лучше проходит Cloudflare, чем headless Chrome.
"""

import asyncio
import json
import sys
from pathlib import Path

from camoufox import AsyncCamoufox

COOKIE_DIR = Path(__file__).parent / "cookies"
XAI_DOMAINS = [".x.ai", "x.ai", "accounts.x.ai", "auth.x.ai", "www.x.ai"]


def load_cookies(name: str | None) -> list[dict]:
    """Надёжная загрузка куки: поддерживает '1', '1.json', полный путь."""
    if name:
        candidates = []
        n = str(name)
        # Прямые варианты
        candidates.append(COOKIE_DIR / n)
        if not n.lower().endswith('.json'):
            candidates.append(COOKIE_DIR / (n + '.json'))
        candidates.append(Path(n))
        if not n.lower().endswith('.json'):
            candidates.append(Path(n + '.json'))

        p = None
        for cand in candidates:
            if cand.exists():
                p = cand
                break
        if p is None:
            sys.exit(f"[x] cookie file not found for name='{name}'. Tried: {candidates}")
    else:
        cands = sorted(
            f for f in COOKIE_DIR.glob("*.json")
            if not f.name.endswith(".meta.json")
        )
        if not cands:
            sys.exit("[x] нет cookie-файлов в " + str(COOKIE_DIR))
        p = cands[0]

    data = json.loads(p.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "cookies" in data:
        data = data["cookies"]
    return data, p


def to_xai(cookies: list[dict]) -> list[dict]:
    out = []
    for c in cookies:
        dom = (c.get("domain") or "").lower()
        if "grok.com" not in dom and "x.ai" not in dom:
            continue
        if not c.get("name") or c.get("value") is None:
            continue
        exp = c.get("expirationDate") or c.get("expiration") or c.get("expires") or 2147483647
        for d in XAI_DOMAINS:
            out.append({
                "name": c["name"], "value": c["value"], "domain": d,
                "path": c.get("path", "/"),
                "expires": float(exp),
                "httpOnly": bool(c.get("httpOnly", False)),
                "secure": bool(c.get("secure", True)),
                "sameSite": "None",
            })
    return out


async def main():
    user_code = sys.argv[1] if len(sys.argv) > 1 else None
    cookie_name = sys.argv[2] if len(sys.argv) > 2 else None

    cookies, cpath = load_cookies(cookie_name)
    xai = to_xai(cookies)
    if not xai:
        sys.exit(f"[x] нет grok.com/x.ai кук в {cpath}")
    print(f"[+] {len(cookies)} кук из {cpath.name} -> {len(xai)} для .x.ai")

    async with AsyncCamoufox(
        headless=False, os="windows", window=(1280, 900),
        i_know_what_im_doing=True,
        humanize=0.0,
    ) as browser:
        ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
        await ctx.add_cookies(xai)

        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        if user_code:
            await page.goto(
                f"https://accounts.x.ai/oauth2/device?user_code={user_code}",
                wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(1500)
            print(f"[+] device-страница: {page.url}")

            # Ждём загрузки страницы device (может быть CF challenge)
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=30000)
            except:
                pass

            # Авто-ввод кода + Continue. Пробуем несколько раз с паузами (CF может мешать).
            for attempt in range(4):
                try:
                    # Ввод кода
                    inp = page.locator('input[name="user_code"], input[type="text"], input').first
                    if await inp.count() > 0:
                        current = ""
                        try:
                            current = await inp.input_value()
                        except:
                            pass
                        if not current and user_code:
                            await inp.fill(user_code)
                            print(f"[+] ввёл код {user_code} (attempt {attempt+1})")

                    # Кликаем Continue / Продолжить
                    for label in ["Continue", "Продолжить", "Authorize", "Authorise", "Continue →", "Sign in"]:
                        btn = page.get_by_role("button", name=label, exact=False)
                        if await btn.count() > 0:
                            try:
                                await btn.first.click(timeout=3000)
                                print(f"[+] нажал '{label}'")
                                break
                            except:
                                pass

                    # Небольшая пауза перед следующей попыткой
                    await page.wait_for_timeout(1200)
                    # Если уже перешли на Allow экран — выходим из цикла
                    if await page.get_by_role("button", name="Allow", exact=False).count() > 0:
                        break
                except Exception as e:
                    print(f"[!] попытка {attempt+1} ввода кода: {e}")
                    await page.wait_for_timeout(1500)

            # Ждём экран "Authorize Grok Build" / приложение и жмём Allow
            try:
                allow = page.get_by_role("button", name="Allow", exact=False)
                await allow.wait_for(state="visible", timeout=15000)
                await allow.first.click(timeout=5000)
                print("[+] нажал 'Allow' — device-flow подтверждён")
                print("[*] Теперь вернись в терминал, где запущен 'grok login --device-auth'.")
                print("[*] Там должна сразу сохраниться сессия (auth.json для этого аккаунта).")
            except Exception as e:
                print(f"[!] авто-Allow не сработал (нажми вручную): {e}")
                print("[*] После ручного Allow вернись в терминал — он сохранит сессию.")

            # Дополнительно пробуем другие варианты кнопок подтверждения
            for lbl in ["Confirm", "Подтвердить", "Yes, allow", "Разрешить"]:
                try:
                    b = page.get_by_role("button", name=lbl, exact=False)
                    if await b.count() > 0:
                        await b.first.click(timeout=2000)
                        print(f"[+] нажал дополнительно '{lbl}'")
                except:
                    pass

            await page.wait_for_timeout(1500)
            try:
                txt = await page.inner_text("body")
            except Exception:
                txt = ""
            print("--- TEXT ---")
            print(txt[:800])
            Path("device_text.txt").write_text(txt, encoding="utf-8")
            print("[*] браузер открыт. Закрой окно для выхода.")
            await page.wait_for_timeout(600000)
        else:
            print("[*] браузер открыт. Закрой окно для выхода.")
            await page.wait_for_timeout(600000)


if __name__ == "__main__":
    asyncio.run(main())
