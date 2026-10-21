@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "SINGULARITY_FLOW_MANAGED_DISTRIBUTION=1"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -File "%~dp0install.ps1" %*
exit /b %errorlevel%
