@echo off
rem Overlay one-step setup for Windows. Double-click or run from a terminal.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 is not installed. Get it from https://nodejs.org or run: winget install OpenJS.NodeJS
  pause
  exit /b 1
)
call npm run setup -- %*
set RESULT=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %RESULT%
