@echo off
rem ===========================================================================
rem  HUB.bat - double-click entry point for the ABUSE HUB dashboard.
rem  Start / stop / restart / update / doctor all live in one menu: hub.js.
rem
rem  ASCII ONLY, and NO chcp on purpose.
rem    * chcp 65001 prints a stray line on some consoles and can break the
rem      first command; the project rule for .bat is plain ASCII, no BOM.
rem    * All Russian text is printed by node, not by cmd. Node writes to a TTY
rem      through WriteConsoleW, so the console code page does not matter.
rem  This file must stay ASCII: the moment it gets Cyrillic it needs chcp,
rem  and we are back to the old mess.
rem
rem  This script does NOT ask for Administrator rights. That used to happen on
rem  every single start (restart-dashboard.bat, 2026-08-13) because taskkill
rem  cannot kill an elevated node from a normal console - but the only reason
rem  those processes were elevated is that the launcher elevated itself. Break
rem  the loop: start plain, and let the hub offer elevation if it is needed.
rem ===========================================================================
setlocal
cd /d "%~dp0"

set "NODE="
where node >nul 2>&1 && set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODE=%NVM_SYMLINK%\node.exe"

if not defined NODE (
    echo.
    echo   Node.js not found.
    echo.
    echo   Install it and run this file again:
    echo       winget install OpenJS.NodeJS.LTS
    echo.
    pause
    exit /b 1
)

title ABUSE HUB
"%NODE%" "%~dp0hub.js" %*
set "RC=%ERRORLEVEL%"

rem Non-zero means the hub itself failed (a crash, or an operation that did not
rem finish). Keep the window so the message survives the double-click. A clean
rem exit through the menu closes the window, which is what you want there.
if not "%RC%"=="0" (
    echo.
    echo   Hub exited with code %RC%.
    pause
)
exit /b %RC%
