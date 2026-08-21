#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Тяжёлые и опциональные зависимости. Вынесено из install.sh, чтобы базовая
#  установка дашборда была линейной и короткой.
#
#  Запуск:  bash install-deps.sh          (спрашивает по блокам)
#           AUTO=1 bash install-deps.sh   (без вопросов, дефолты как были)
#  Зовётся автоматически в конце install.sh.
#
#  Что здесь: Python-стек (Camoufox-автореги, grok-launcher, venv для ✈ Открыть
#  TG), sqlite3.exe, OmniRoute в Docker, .env ТГ-бота. Каждый блок идемпотентен:
#  сначала проверяет «уже стоит?» и не переустанавливает.
#
#  Дефолты вопросов те же, что были в install.sh: Python-стек и sqlite3 — Y,
#  OmniRoute и ТГ-бот — N. Это контракт update.sh/fix.sh (AUTO=1): менять их
#  нельзя, иначе обновление у друга начнёт молча ставить лишнее.
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")"
. ./install-lib.sh

case "$(uname 2>/dev/null)" in Darwin) IS_MAC=1 ;; *) IS_MAC=0 ;; esac

b "══ Доп. зависимости ══"

# ── sqlite3 ─────────────────────────────────────────────────────────────────
# Нужен дашборду (OmniRoute-вкладка) и парсеру .session для TG-пула
# (freemodel/lib/tg-session-parser.js). Ищется в WinGet Links, в ~/bin
# (setup-sqlite3.bat) либо через env SQLITE3. Без него закидывание .session
# падает невнятной ошибкой.
step "sqlite3 (TG-пул + OmniRoute)"
if [ "$IS_MAC" = "1" ]; then
  # В macOS sqlite3 системный (/usr/bin/sqlite3) — ставить нечего.
  if have sqlite3; then ok "sqlite3 системный: $(command -v sqlite3)"
  else warn "sqlite3 не найден даже в системе — странно для macOS; поставь: brew install sqlite"; fi
else
  SQLITE_LINK="$LOCALAPPDATA/Microsoft/WinGet/Links/sqlite3.exe"
  SQLITE_HOMEBIN="$HOME/bin/sqlite3.exe"
  if [ -n "${SQLITE3:-}" ] && [ -f "$SQLITE3" ]; then
    ok "sqlite3: $SQLITE3 (env SQLITE3)"
  elif [ -f "$SQLITE_LINK" ]; then
    ok "sqlite3: $SQLITE_LINK"
  elif [ -f "$SQLITE_HOMEBIN" ]; then
    ok "sqlite3: $SQLITE_HOMEBIN"
  elif have winget && ask "sqlite3.exe не найден — поставить через winget? (нужен TG-пулу)" Y; then
    winget install -e --id SQLite.SQLite
    [ -f "$SQLITE_LINK" ] && ok "sqlite3 установлен" || warn "sqlite3 не появился в $SQLITE_LINK — проверь winget и перезапусти git-bash"
  else
    warn "winget нет — качаю sqlite-tools с sqlite.org в ~/bin"
    SQLITE_TMP="$(mktemp -d)"
    if curl -fL -o "$SQLITE_TMP/sqlite-tools.zip" https://sqlite.org/2026/sqlite-tools-win-x64-3530300.zip \
       && (cd "$SQLITE_TMP" && unzip -o -q sqlite-tools.zip); then
      mkdir -p "$HOME/bin"
      find "$SQLITE_TMP" -name sqlite3.exe -exec cp {} "$HOME/bin/" \;
      [ -f "$SQLITE_HOMEBIN" ] && ok "sqlite3: $SQLITE_HOMEBIN" \
        || warn "sqlite3.exe не встал — без него не работают: закидывание .session в TG-пул, вкладка OmniRoute"
    else
      warn "скачать не вышло — без sqlite3 не работают: закидывание .session в TG-пул, вкладка OmniRoute"
    fi
    rm -rf "$SQLITE_TMP"
  fi
fi

# ── Python-стек ─────────────────────────────────────────────────────────────
# Идемпотентно: каждый блок сначала чекает "уже стоит?" и не переустанавливает.
step "Python: TokenRouter (Camoufox) + ✈ Открыть TG"

if [ -f tools/tg-venv/pyvenv.cfg ]; then
  VENV_HOME=$(grep -E '^home = ' tools/tg-venv/pyvenv.cfg | sed 's/^home = //')
  VENV_EXE=$(grep -E '^executable = ' tools/tg-venv/pyvenv.cfg | sed 's/^executable = //')
  if [ -n "$VENV_HOME" ] && [ ! -e "$VENV_HOME" ]; then
    warn "tools/tg-venv ссылается на несуществующий Python: $VENV_HOME"
    warn "Если папку переносили — удали tools/tg-venv и пересоздай через установщик."
  elif [ -n "$VENV_EXE" ] && [ ! -e "$VENV_EXE" ]; then
    warn "tools/tg-venv ссылается на несуществующий Python: $VENV_EXE"
    warn "Если папку переносили — удали tools/tg-venv и пересоздай через установщик."
  fi
fi

choose_python() {
  local cmd ver best=""
  for cmd in py python python3; do
    have "$cmd" || continue
    if [ "$cmd" = "py" ]; then
      if py -3.11 -c 'import sys' >/dev/null 2>&1; then echo "py -3.11"; return 0; fi
      if py -3.12 -c 'import sys' >/dev/null 2>&1; then best="py -3.12"; fi
    else
      ver=$($cmd -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true)
      [ "$ver" = "3.11" ] && { echo "$cmd"; return 0; }
      [ "$ver" = "3.12" ] && best="$cmd"
      [ -z "$best" ] && [ -n "$ver" ] && best="$cmd"
    fi
  done
  [ -n "$best" ] && echo "$best"
}

has_cpp_build_tools() {
  [ -d "/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC" ] || \
    [ -d "/c/Program Files/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC" ]
}

# Python 3.11 — целевая версия для tg-venv (tgcrypto без компиляции).
# Ставится через winget, а без winget — напрямую с python.org.
PY311_EXE="${LOCALAPPDATA:-}/Programs/Python/Python311/python.exe"
install_python311() {
  if [ -f "$PY311_EXE" ]; then return 0; fi
  if have winget; then
    winget install -e --id Python.Python.3.11
  else
    warn "winget нет — качаю Python 3.11.9 с python.org (~25 МБ)"
    local exe="${TEMP:-/tmp}/python-3.11.9-amd64.exe"
    curl -fL -o "$exe" https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe || return 1
    warn "Ставлю (окно прогресса появится и само закроется)..."
    MSYS_NO_PATHCONV=1 "$exe" /passive InstallAllUsers=0 PrependPath=1 Include_test=0
  fi
  [ -f "$PY311_EXE" ]
}

# tg-venv живой? (главный источник "нет tools/tg-venv" в дашборде)
# Путь до интерпретатора внутри venv платформозависимый: Scripts/python.exe на
# Windows, bin/python на macOS. Резолвер один — tools/tg-venv-python.js.
tg_venv_py() { node tools/tg-venv-python.js 2>/dev/null; }
tg_venv_ok() {
  local py; py="$(tg_venv_py)"
  [ -n "$py" ] && [ -f "$py" ] && "$py" -c 'import opentele, tgcrypto' >/dev/null 2>&1
}

if [ "$IS_MAC" = "1" ]; then
  # На маке ставим ТОЛЬКО ТГ-менеджер (opentele venv + Telegram.app).
  #
  # Camoufox-автореги сюда НЕ входят: пины (camoufox 0.4.11 + playwright 1.60.0)
  # подобраны на Windows-машине, мак-колёса никто не проверял, и вслепую они дают
  # другу сломанную установку вместо работающей. Ветка появится, когда будет мак
  # под рукой и лог живого прогона.
  #
  # Всё, что ниже, писалось без мака на руках — поэтому лог сборки пишем в файл и
  # печатаем хвост при падении: одна присланная простыня лучше десяти скриншотов.
  warn "macOS: Camoufox-автореги пропускаю (пины не проверены на маке)."
  if ! ask "Поставить ТГ-менеджер (venv opentele для ✈ Открыть TG)?" Y; then
    echo "  Позже: bash install-deps.sh"
  elif tg_venv_ok; then
    ok "tg-venv уже готов (opentele+tgcrypto импортируются) — пропускаю"
  else
    # Python 3.11 целевой: TgCrypto/PyQt5 ставятся колесом, без компиляции.
    # brew НЕ кладёт свои питоны в PATH под именем python3.11 гарантированно —
    # берём по абсолютному пути из `brew --prefix`, та же грабля, что с brew
    # shellenv в install-mac.sh.
    MAC_PY=""
    if have brew; then
      BP="$(brew --prefix python@3.11 2>/dev/null)"
      [ -n "$BP" ] && [ -x "$BP/bin/python3.11" ] && MAC_PY="$BP/bin/python3.11"
      if [ -z "$MAC_PY" ]; then
        warn "Python 3.11 не найден — ставлю через brew"
        brew install python@3.11 || err "brew install python@3.11 упал"
        BP="$(brew --prefix python@3.11 2>/dev/null)"
        [ -n "$BP" ] && [ -x "$BP/bin/python3.11" ] && MAC_PY="$BP/bin/python3.11"
      fi
    fi
    # Запасной вариант: системный python3. TgCrypto/PyQt5 на нём могут потребовать
    # сборки — тогда упадём с логом, а не молча.
    [ -z "$MAC_PY" ] && have python3 && MAC_PY="$(command -v python3)"
    if [ -z "$MAC_PY" ]; then
      err "python3 не найден вообще — поставь brew, потом: brew install python@3.11"
    else
      ok "Python $("$MAC_PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null) → $MAC_PY"
      rm -rf tools/tg-venv
      TG_VENV_LOG="${TMPDIR:-/tmp}/tg-venv-install.log"
      if "$MAC_PY" -m venv tools/tg-venv && \
         tools/tg-venv/bin/python -m pip install --upgrade pip >"$TG_VENV_LOG" 2>&1 && \
         tools/tg-venv/bin/pip install -r tools/tg-venv-requirements.txt >>"$TG_VENV_LOG" 2>&1 && \
         tools/tg-venv/bin/python -c 'import opentele; import tgcrypto' 2>>"$TG_VENV_LOG"; then
        ok "tg-venv готов"
      else
        err "tg-venv не собрался. Последние строки лога:"
        tail -15 "$TG_VENV_LOG" 2>/dev/null | sed 's/^/    /'
        err "Полный лог: $TG_VENV_LOG — пришли его целиком."
        err "Вероятные виновники на маке: PyQt5 или TgCrypto без готового колеса."
      fi
    fi
  fi
  # Клиент: портативной сборки под мак не существует, ставим обычный .app.
  # Изоляция профилей держится на -workdir, а не на копии бинаря (tg-open.py).
  if [ -x "/Applications/Telegram.app/Contents/MacOS/Telegram" ] \
     || [ -x "$HOME/Applications/Telegram.app/Contents/MacOS/Telegram" ]; then
    ok "Telegram.app на месте"
  elif ask "  Telegram.app не найден — поставить (brew install --cask telegram)?" Y; then
    brew install --cask telegram && ok "Telegram.app установлен" \
      || err "не установился — поставь вручную с https://desktop.telegram.org"
  else
    warn "Для ✈ Открыть нужен Telegram.app в /Applications"
  fi
elif [ ! -f package.json ]; then
  err "запускать из папки репо (нет package.json)"
else
  if tg_venv_ok; then TG_VENV_STATE="уже готов"; else TG_VENV_STATE="НЕ создан — нужен для ✈ Открыть TG"; fi
  if ask "Проверить/поставить Python-зависимости (Camoufox + opentele venv)? [tg-venv: $TG_VENV_STATE]" Y; then
    PY=$(choose_python)
    # Питона нет вообще (или только в LOCALAPPDATA без PATH) — ставим 3.11 сами
    # и берём по прямому пути, не полагаясь на PATH текущей сессии.
    if [ -z "$PY" ] && [ -f "$PY311_EXE" ]; then
      PY="$PY311_EXE"
    fi
    if [ -z "$PY" ]; then
      warn "python не найден вообще — без него не работают Camoufox-автореги и ✈ Открыть TG"
      if ask "  Поставить Python 3.11 автоматически?" Y; then
        if install_python311; then
          PY="$PY311_EXE"
          ok "Python 3.11 установлен: $PY311_EXE"
        else
          err "Python 3.11 не установился — пропускаю Python-шаги. Поставь вручную: https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"
        fi
      else
        err "python не найден — пропускаю Python-шаги."
      fi
    fi
    if [ -n "$PY" ]; then
      # PY бывает двусловным ("py -3.11") или путём с пробелами
      # ("C:\Users\Happy Creator\...\python.exe") — py_run обслуживает оба.
      py_run() { if [ -f "$PY" ]; then "$PY" "$@"; else $PY "$@"; fi; }
      PYVER=$(py_run -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null)
      ok "Python $PYVER → $PY"
      if [ "$PYVER" = "3.12" ]; then
        warn "Python 3.12 часто ломает tgcrypto/opentele без сборки. Надёжнее: winget install -e --id Python.Python.3.11"
      fi

      # Camoufox: пропускаем, если уже стоит рабочая пара camoufox + playwright 1.60.0
      PW_VER=$(py_run -c 'import importlib.metadata as m; print(m.version("playwright"))' 2>/dev/null)
      if py_run -c 'import camoufox' >/dev/null 2>&1 && [ "$PW_VER" = "1.60.0" ]; then
        ok "camoufox уже стоит (playwright $PW_VER) — пропускаю"
      elif ask "  Camoufox (TokenRouter автореги)?" Y; then
        py_run -m pip install --upgrade pip
        # playwright строго 1.60.0: в 1.61 Firefox-клиент шлёт viewport.isMobile,
        # которого juggler Camoufox (FF152) не знает → Browser.setDefaultViewport
        # падает на старте и вся авторега умирает (проверено на чистой установке).
        py_run -m pip install camoufox==0.4.11 requests playwright==1.60.0 && py_run -m camoufox fetch && ok "camoufox готов"
      fi

      # grok-launcher: FastAPI-сервис на :8765 для SuperGrok Sessions.
      # Поднимается transparent-proxy.js автоматически, но зависимости надо один раз поставить.
      if py_run -c 'import fastapi, uvicorn, websockets, httpx' >/dev/null 2>&1; then
        ok "grok-launcher deps уже стоят — пропускаю"
      elif ask "  grok-launcher (SuperGrok Sessions — headless-квоты + Chrome-launcher)?" Y; then
        py_run -m pip install -r grok-launcher/requirements.txt && ok "grok-launcher готов"
      fi

      if tg_venv_ok; then
        ok "tg-venv уже готов (opentele+tgcrypto импортируются) — пропускаю"
      elif ask "  venv для ✈ Открыть TG (opentele)?" Y; then
        # tgcrypto ставится колесом только на Python 3.11; на 3.12+ без Build Tools
        # сборка падает. Поэтому: нет 3.11 → ставим его сами (winget или python.org)
        # и берём по прямому пути — в PATH текущей сессии он всё равно не попадёт.
        # tg_py: обёртка, т.к. PY бывает двусловным ("py -3.11"), а PY311_EXE —
        # путём с пробелами (C:\Users\Happy Creator\...).
        TG_PY_EXE=""
        tg_py() { if [ -n "$TG_PY_EXE" ]; then "$TG_PY_EXE" "$@"; else py_run "$@"; fi; }
        if [ "$PYVER" != "3.11" ]; then
          if [ -f "$PY311_EXE" ]; then
            TG_PY_EXE="$PY311_EXE"
            ok "для tg-venv беру Python 3.11: $PY311_EXE"
          elif [ "$PYVER" = "3.12" ] && has_cpp_build_tools; then
            warn "Python 3.12 + Build Tools — пробую собрать tgcrypto из исходников"
          elif ask "  Python 3.11 не найден — поставить автоматически? (надёжный путь для tg-venv)" Y; then
            if install_python311; then
              TG_PY_EXE="$PY311_EXE"
              ok "Python 3.11 установлен: $PY311_EXE"
            else
              err "Python 3.11 не встал — пробую на Python $PYVER (может упасть на tgcrypto)"
            fi
          fi
        fi

        rm -rf tools/tg-venv
        TG_VENV_LOG="${TEMP:-/tmp}/tg-venv-install.log"
        if tg_py -m venv tools/tg-venv && \
           tools/tg-venv/Scripts/python -m pip install --upgrade pip >"$TG_VENV_LOG" 2>&1 && \
           tools/tg-venv/Scripts/pip install -r tools/tg-venv-requirements.txt >>"$TG_VENV_LOG" 2>&1 && \
           tools/tg-venv/Scripts/python -c 'import opentele; import tgcrypto' 2>>"$TG_VENV_LOG"; then
          ok "tg-venv готов"
        else
          err "tg-venv не собрался. Последние строки лога:"
          tail -15 "$TG_VENV_LOG" 2>/dev/null | sed 's/^/    /'
          err "Полный лог: $TG_VENV_LOG"
          err "Обычно лечится Python 3.11 — перезапусти install-deps.sh и согласись на его установку."
        fi
      fi

      if tg_venv_ok && [ ! -f tools/telegram-portable/Telegram/Telegram.exe ]; then
        if ask "  Портативного Telegram нет — скачать с telegram.org (~70 МБ)? (нужен для ✈ Открыть)" Y; then
          TG_ZIP="${TEMP:-/tmp}/tportable.zip"
          # официальная ссылка-редирект на свежий tportable-x64.*.zip; распаковывается в Telegram/Telegram.exe
          if curl -fL -o "$TG_ZIP" https://telegram.org/dl/desktop/win64_portable && \
             mkdir -p tools/telegram-portable && \
             unzip -o -q "$TG_ZIP" -d tools/telegram-portable && \
             [ -f tools/telegram-portable/Telegram/Telegram.exe ]; then
            ok "портативный Telegram установлен (tools/telegram-portable/Telegram)"
            rm -f "$TG_ZIP"
          else
            err "не скачался/не распаковался — положи вручную: зип с https://desktop.telegram.org (Portable) → tools/telegram-portable/"
          fi
        else
          warn "Для ✈ Открыть ещё нужен портативный Telegram в tools/telegram-portable/Telegram/Telegram.exe"
        fi
      fi
    fi
  fi
fi

# ── OmniRoute (Docker) ──────────────────────────────────────────────────────
step "OmniRoute backend (Docker, :20128) — опционально"
if ask "Поднять OmniRoute в Docker?" N; then
  if ! have docker; then
    err "docker не найден. Поставь Docker Desktop и запусти снова."
  elif docker ps -a --format '{{.Names}}' | grep -qx omniroute; then
    warn "контейнер omniroute уже есть — пропускаю."
  else
    MSYS_NO_PATHCONV=1 docker run -d --name omniroute \
      -p 20128:20128 -v omniroute-data:/app/data --restart unless-stopped \
      -e PORT=20128 -e HOSTNAME=0.0.0.0 \
      ghcr.io/diegosouzapw/omniroute:latest && ok "omniroute запущен"
    sleep 3
    curl -s -o /dev/null -w '  HTTP %{http_code} на /v1/models\n' http://localhost:20128/v1/models 2>/dev/null
  fi
  copy_if_absent routing/.env.example routing/.env >/dev/null 2>&1
  if ask "  Вписать OMNIROUTE_API_KEY сейчас? (можно позже в дашборде)" N; then
    K=$(prompt "  OMNIROUTE_API_KEY (scope manage)")
    [ -n "$K" ] && set_env routing/.env OMNIROUTE_API_KEY "$K" && ok "ключ записан в routing/.env"
  fi
fi

# ── Telegram-бот (пульт) ────────────────────────────────────────────────────
step "Telegram-бот (пульт управления с телефона) — опционально"
if ask "Заполнить tgbot/.env?" N; then
  copy_if_absent tgbot/.env.example tgbot/.env
  echo "  Токен — у @BotFather (/newbot). Свой ID — у @userinfobot."
  TOK=$(prompt "BOT_TOKEN")
  USR=$(prompt "ALLOWED_USERS (Telegram ID, через запятую)")
  [ -n "$TOK" ] && set_env tgbot/.env BOT_TOKEN "$TOK"
  [ -n "$USR" ] && set_env tgbot/.env ALLOWED_USERS "$USR"
  CWD=$(prompt "DEFAULT_CWD (рабочая папка claude)" "$(pwd -W 2>/dev/null || pwd)")
  [ -n "$CWD" ] && set_env tgbot/.env DEFAULT_CWD "$CWD"
  ok "tgbot/.env заполнен"
  if ask "  Запустить ТГ-бота сейчас?" N; then npm run tgbot; fi
fi

echo
b "── Доп. зависимости: готово ──"
