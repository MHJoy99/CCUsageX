@echo off
rem Stops the CCUsageX server and closes its app window.
setlocal
set "PS=powershell.exe"
where pwsh.exe >nul 2>nul && set "PS=pwsh.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0CCUsageX.ps1" -Action stop -CloseWindow -Popup %*
