#!/usr/bin/env python3
# tools/tg-open.py
#
# Открыть TG-сессию из freemodel/tg_pool.json в отдельном портативном
# Telegram Desktop (tools/telegram-portable). auth_key_hex + dc_id -> tdata
# через opentele (UseCurrentSession = тот же auth_key, без релогина/SMS).
#
# Каждый аккаунт = свой -workdir, профили не пересекаются и НЕ трогают
# пользовательский AyuGram.
#
# Запуск только через tools/tg-venv (opentele). Пример:
#   tools/tg-venv/Scripts/python.exe tools/tg-open.py 240718298   # Windows
#   tools/tg-venv/bin/python tools/tg-open.py 240718298           # macOS
#   ... tg-open.py 240718298 --check        # офлайн-проверка, без сети/запуска
#   ... tg-open.py 240718298 --no-launch     # сделать tdata, но не запускать

import argparse
import asyncio
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POOL = ROOT / "freemodel" / "tg_pool.json"
PROFILES = ROOT / "tools" / "tg-profiles"
PORTABLE = ROOT / "tools" / "telegram-portable"

# Prod DC адреса (как в freemodel/lib/tg-client.js). telethon знает их сам,
# но из голой StringSession без bootstrap иногда не находит — задаём явно.
DC_IPS = {
    1: ("149.154.175.50", 443),
    2: ("149.154.167.51", 443),
    3: ("149.154.175.100", 443),
    4: ("149.154.167.91", 443),
    5: ("91.108.56.130", 443),
}


def find_entry(phone: str) -> dict:
    entries = json.loads(POOL.read_text(encoding="utf-8"))
    p = phone.lstrip("+")
    for e in entries:
        if str(e.get("phone", "")).lstrip("+") == p:
            return e
    raise SystemExit(f"phone {phone!r} не найден в {POOL}")


def build_session(entry: dict):
    from telethon.sessions import StringSession
    from telethon.crypto import AuthKey

    dc_id = int(entry["dc_id"])
    if dc_id not in DC_IPS:
        raise SystemExit(f"неизвестный dc_id: {dc_id}")
    key_hex = entry["auth_key_hex"]
    if len(key_hex) != 512:
        raise SystemExit(f"auth_key_hex неверной длины: {len(key_hex)} (нужно 512)")

    ip, port = DC_IPS[dc_id]
    s = StringSession()
    s.set_dc(dc_id, ip, port)
    s.auth_key = AuthKey(bytes.fromhex(key_hex))
    return s


def profile_dir(entry: dict) -> Path:
    safe = str(entry["phone"]).lstrip("+").replace("\\", "_").replace("/", "_")
    return PROFILES / safe


async def make_tdata(entry: dict) -> Path:
    from opentele.tl import TelegramClient
    from opentele.api import API, UseCurrentSession

    wd = profile_dir(entry)
    tdata = wd / "tdata"
    if (tdata / "key_datas").exists():
        return wd  # уже сконвертировано — переиспользуем

    client = TelegramClient(build_session(entry), api=API.TelegramDesktop)
    await client.connect()
    if not await client.is_user_authorized():
        await client.disconnect()
        raise SystemExit("auth_key не авторизован (сессия мертва/отозвана)")
    me = await client.get_me()
    print(f"[tg] me id={me.id} @{me.username or '-'} phone={me.phone or '-'}",
          file=sys.stderr)

    tdesk = await client.ToTDesktop(flag=UseCurrentSession)
    await client.disconnect()
    tdata.mkdir(parents=True, exist_ok=True)
    tdesk.SaveTData(str(tdata))
    return wd


def telegram_candidates():
    """Где искать клиент Telegram Desktop, в порядке предпочтения.

    Windows: только портативный в репо — его кладёт install-deps.sh, и он
    гарантированно не трогает пользовательский AyuGram.

    macOS: портативной сборки для мака не существует, поэтому берём .app —
    сначала свою в репо (если кто-то положил руками), потом системную из
    /Applications (её ставит `brew install --cask telegram`) и из ~/Applications.
    Изоляция профилей всё равно держится на -workdir, а не на копии бинаря.
    """
    if sys.platform == "darwin":
        rel = Path("Contents") / "MacOS" / "Telegram"
        return [
            PORTABLE / "Telegram.app" / rel,
            Path("/Applications/Telegram.app") / rel,
            Path.home() / "Applications" / "Telegram.app" / rel,
        ]
    return [PORTABLE / "Telegram" / "Telegram.exe"]


def find_telegram():
    for p in telegram_candidates():
        if p.exists():
            return p
    return None


def launch(workdir: Path):
    exe = find_telegram()
    if exe is None:
        tried = "\n  ".join(str(p) for p in telegram_candidates())
        hint = ("поставь: brew install --cask telegram"
                if sys.platform == "darwin"
                else "поставь через install-deps.sh (скачает портативный)")
        raise SystemExit(f"не найден клиент Telegram. Искал:\n  {tried}\n{hint}")
    # Отвязываем от родителя, чтобы клиент жил после выхода этого скрипта.
    # DETACHED_PROCESS — виндовый флаг, setsid (start_new_session) — POSIX-ный,
    # и на Windows передавать его нельзя: subprocess бросит ValueError.
    kw = {"close_fds": True}
    if sys.platform == "win32":
        kw["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0)
    else:
        kw["start_new_session"] = True
    subprocess.Popen([str(exe), "-workdir", str(workdir)], **kw)
    return exe


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("phone")
    ap.add_argument("--check", action="store_true",
                    help="офлайн: только собрать сессию и проверить, без сети/запуска")
    ap.add_argument("--no-launch", action="store_true",
                    help="сделать tdata, но не запускать клиент")
    args = ap.parse_args()

    entry = find_entry(args.phone)

    if args.check:
        build_session(entry)  # бросит SystemExit при битом ключе/dc
        tg = find_telegram()
        print(f"OK check: {entry['phone']} dc={entry['dc_id']} "
              f"key_len={len(entry['auth_key_hex'])}")
        print(f"клиент: {tg if tg else 'НЕ НАЙДЕН (см. telegram_candidates)'}")
        return

    wd = asyncio.run(make_tdata(entry))
    print(f"tdata: {wd / 'tdata'}")
    if args.no_launch:
        return
    exe = launch(wd)
    print(f"launched: {exe.name} -workdir {wd}")


if __name__ == "__main__":
    main()
