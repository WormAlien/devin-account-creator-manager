@echo off
rem ===========================================================================
rem  START.bat - forwarder. The real implementation is hub.js (see HUB.bat).
rem
rem  Until 2026-08-24 this file had its OWN copy of the launch logic, and it was
rem  the worst of the five that existed: it freed 2 ports out of 8, never started
rem  the FreeModel OpenAI proxy (:20130) or the VyceAI proxy (:20131) at all, and
rem  ran without elevation - so taskkill silently failed against processes the
rem  old restart-dashboard.bat had elevated. "Works on a fresh repo, broken on
rem  mine" came from exactly here: which of the five you clicked decided which
rem  ports came up.
rem
rem  Kept as a name that already lives in shortcuts and docs. `start` is
rem  idempotent: it brings up only what is down, so clicking it while the
rem  dashboard runs restarts nothing - and does not drop the front-door that
rem  Claude Code talks through.
rem ===========================================================================
call "%~dp0HUB.bat" start %*
exit /b %ERRORLEVEL%
