@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "RELEASE_DIR=%~dp0"
set "SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT=%~f0"
where node >nul 2>nul || (echo Node.js 26 or newer is required. 1>&2 & exit /b 1)
node "%RELEASE_DIR%bootstrap.mjs" install %*
exit /b %ERRORLEVEL%
