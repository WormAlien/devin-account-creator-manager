@echo off
rem ===========================================================================
rem  DEPRECATED (2026-08-24). Use HUB.bat in the repo root.
rem
rem  This was the previous generation of the launcher and it kept its own copy of
rem  the port list and of the start logic:
rem    * `start /B node ...` tied every child to THIS console, so the window
rem      lived on forever after the script exited;
rem    * no verification that a port was actually released, so the next start
rem      could die with EADDRINUSE right after "port freed";
rem    * cleanup at the end killed by WINDOW TITLE, which misses anything
rem      started hidden or renamed.
rem  One implementation now: hub.js -> routing/lifecycle.js.
rem
rem  NOTE, and it is a real behaviour change: this file also invoked
rem  cleanup-reg-procs.ps1 (the orphaned chrome/camoufox sweeper) on every
rem  dashboard start, and restart-dashboard.bat never did. The sweeper is NOT
rem  wired into the hub - killing browser processes is a side effect with a blast
rem  radius, so that call is the owner's decision, not a silent addition. Run it
rem  by hand when needed:
rem      powershell -NoProfile -ExecutionPolicy Bypass -File routing\cleanup-reg-procs.ps1
rem ===========================================================================
call "%~dp0..\HUB.bat" restart %*
exit /b %ERRORLEVEL%
