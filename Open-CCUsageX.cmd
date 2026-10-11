@echo off
rem Starts the CCUsageX server (hidden) if needed and opens the dashboard app window.
setlocal
set "PS=powershell.exe"
where pwsh.exe >nul 2>nul && set "PS=pwsh.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0CCUsageX.ps1" -Action start -Popup %*
