@echo off
REM ============================================================
REM  FENCEPOST - launch the projector calibration tool
REM  Double-click this file, or run "start.bat" in this folder.
REM ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [FENCEPOST] Node.js was not found on your PATH.
  echo            Install it from https://nodejs.org/ ^(LTS^) and try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [FENCEPOST] Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo [FENCEPOST] npm install failed. See the messages above.
    pause
    exit /b 1
  )
)

echo [FENCEPOST] Starting dev server... a browser tab will open automatically.
echo            Press Ctrl+C in this window to stop.

REM --open lets Vite launch the browser at the actual port it binds to, so
REM if 5173 is busy and it falls back to 5174 the right tab still opens.
REM Running Vite in this window means Ctrl+C stops it cleanly.
call npm run dev -- --open

endlocal
