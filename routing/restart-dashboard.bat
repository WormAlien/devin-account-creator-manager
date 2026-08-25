@echo off
rem ===========================================================================
rem  restart-dashboard.bat - forwarder. The real implementation is hub.js.
rem
rem  This file used to BE the implementation, and it was the only one of the five
rem  launchers that got things right: UAC self-elevation, per-port taskkill with a
rem  netstat loop that waited until the socket was really released, hidden
rem  Start-Process for the three proxies, /MIN window for the dashboard. All of
rem  that logic lives on in routing/lifecycle.js - including the part that
rem  mattered most, refusing to start on a port that never got freed instead of
rem  crashing with EADDRINUSE.
rem
rem  Two things deliberately did NOT come along:
rem    * Elevation on every start. It was self-sustaining: the launcher elevated
rem      itself, its children became elevated, and then a normal taskkill could
rem      not touch them - which is why elevation was needed in the first place.
rem      The hub starts plain and offers elevation only if a port really is held.
rem    * The visible /MIN console. Every process now starts hidden and logs to
rem      routing/dashboard.out.log; the hub prints its tail when a start fails.
rem
rem  Need the old file? It is in git history:
rem      git show HEAD~1:routing/restart-dashboard.bat
rem ===========================================================================
call "%~dp0..\HUB.bat" restart %*
exit /b %ERRORLEVEL%
