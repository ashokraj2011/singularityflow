@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-sflow.ps1" %*
set "sflow_updater_result=%errorlevel%"
if not "%SINGULARITY_FLOW_UPDATER_NO_PAUSE%"=="1" pause
exit /b %sflow_updater_result%
