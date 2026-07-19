@echo off
REM Wrapper for Grok auth_provider_command on Windows (no bash required).
setlocal
node "%~dp0auth-helper.js" %*
exit /b %ERRORLEVEL%
