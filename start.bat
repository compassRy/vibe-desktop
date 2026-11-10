@echo off
rem Vibe Desktop launcher
cd /d "%~dp0"
if not exist "node_modules\.bin\electron.cmd" (
  echo First run: installing dependencies...
  call npm install --no-audit --no-fund
)
start "" "node_modules\.bin\electron.cmd" .
