@echo off
rem ===========================================================================
rem  DEPRECATED (2026-08-24). Use HUB.bat in the repo root.
rem
rem  The oldest of the five launchers: it started transparent-proxy.js alone -
rem  no FreeModel rotator (:20126), no OpenAI proxies (:20130 / :20131), no port
rem  cleanup at all - and opened /dashboard/, a URL the switcher UI moved off
rem  long ago. Kept only as a name that may sit in someone's shortcut.
rem ===========================================================================
call "%~dp0..\HUB.bat" start %*
exit /b %ERRORLEVEL%
