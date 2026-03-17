@echo off
setlocal

set "PROJECT_DIR=%~dp0webula-main--1--main\webula-main"
set "APP_URL=http://localhost:4000"

if /I "%~1"=="--check" (
  if not exist "%PROJECT_DIR%\package.json" (
    echo Dev launcher check failed: package.json not found at %PROJECT_DIR%
    exit /b 1
  )
  where npm >nul 2>nul
  if errorlevel 1 (
    echo Dev launcher check failed: npm not found in PATH.
    exit /b 1
  )
  echo Dev launcher check OK: %PROJECT_DIR%
  exit /b 0
)

if not exist "%PROJECT_DIR%\package.json" (
  echo Could not find package.json at:
  echo %PROJECT_DIR%
  echo.
  echo Make sure this .bat file is in:
  echo C:\Users\J_lin\Downloads\webula-main--1--main
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found in PATH. Install Node.js and reopen terminal.
  pause
  exit /b 1
)

cd /d "%PROJECT_DIR%"

if not exist "node_modules" (
  echo node_modules not found. Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting Webula dev server...
echo Browser mode: open DevTools with F12 after page loads.

start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='%APP_URL%'; for($i=0;$i -lt 240;$i++){ try { Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1 | Out-Null; Start-Process $url; break } catch { Start-Sleep -Milliseconds 500 } }"

call npm run dev
if errorlevel 1 (
  echo.
  echo Dev server exited with errors.
  pause
  exit /b 1
)

exit /b 0
