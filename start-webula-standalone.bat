@echo off
setlocal

set "PROJECT_DIR=%~dp0webula-main--1--main\webula-main"
set "APP_URL=http://localhost:4000"
set "LOG_FILE=%~dp0webula-dev-server.log"

if /I "%~1"=="--check" (
  if not exist "%PROJECT_DIR%\package.json" (
    echo Standalone launcher check failed: package.json not found at %PROJECT_DIR%
    exit /b 1
  )
  where npm >nul 2>nul
  if errorlevel 1 (
    echo Standalone launcher check failed: npm not found in PATH.
    exit /b 1
  )
  echo Standalone launcher check OK: %PROJECT_DIR%
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

set "SERVER_ALREADY_RUNNING=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri '%APP_URL%' -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 set "SERVER_ALREADY_RUNNING=1"

if "%SERVER_ALREADY_RUNNING%"=="1" (
  echo Dev server already running at %APP_URL%.
) else (
  echo Starting Webula dev server in background...
  > "%LOG_FILE%" echo [%date% %time%] Starting dev server from %PROJECT_DIR%
  start "" /min cmd /c "(cd /d ""%PROJECT_DIR%"" && (if not exist node_modules (call npm install)) && call npm run dev) >> ""%LOG_FILE%"" 2>&1"
)

echo Waiting for server...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 300;$i++){ try { Invoke-WebRequest -UseBasicParsing -Uri '%APP_URL%' -TimeoutSec 1 | Out-Null; $ok=$true; break } catch { Start-Sleep -Milliseconds 500 } }; if(-not $ok){ exit 1 }"
if errorlevel 1 (
  echo Server did not become ready at %APP_URL%.
  echo Check log: %LOG_FILE%
  echo.
  if exist "%LOG_FILE%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -Path '%LOG_FILE%' -Tail 60"
  )
  pause
  exit /b 1
)

echo Opening standalone app window...
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --new-window --app="%APP_URL%"
  exit /b 0
)

if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --new-window --app="%APP_URL%"
  exit /b 0
)

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --new-window --app="%APP_URL%"
  exit /b 0
)

if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --new-window --app="%APP_URL%"
  exit /b 0
)

echo Edge/Chrome app mode not found. Opening default browser instead.
start "" "%APP_URL%"
exit /b 0
