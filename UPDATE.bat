@echo off
rem Double-click updater: runs update.sh in git-bash. ASCII only (no chcp!).
setlocal
set "BASH=C:\Program Files\Git\bin\bash.exe"
if not exist "%BASH%" set "BASH=C:\Program Files (x86)\Git\bin\bash.exe"
if not exist "%BASH%" set "BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not exist "%BASH%" (
    echo ERROR: git-bash not found. Install Git for Windows first.
    pause
    exit /b 1
)
"%BASH%" -lc "cd \"$(cygpath -u '%~dp0')\" && bash update.sh"
