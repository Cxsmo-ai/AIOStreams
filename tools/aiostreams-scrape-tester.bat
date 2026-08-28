@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%aiostreams-scrape-tester.ps1" %*
exit /b %ERRORLEVEL%
