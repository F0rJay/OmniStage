@echo off
setlocal ENABLEDELAYEDEXPANSION

cd /d "%~dp0"

echo.
echo [CanonWeave] Quick Start
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ first.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. Please install Node.js with npm.
  pause
  exit /b 1
)

if not exist "apps\web\.env.local" (
  if exist "apps\web\.env.example" (
    echo [STEP] Creating apps\web\.env.local from template...
    copy /Y "apps\web\.env.example" "apps\web\.env.local" >nul
  ) else (
    echo [WARN] apps\web\.env.example not found, creating minimal .env.local
    type nul > "apps\web\.env.local"
  )
)

findstr /R /C:"^[ ]*CW_CHAT_MOCK=1[ ]*$" "apps\web\.env.local" >nul 2>nul
if errorlevel 1 (
  echo [STEP] Enabling CW_CHAT_MOCK=1 for first-run experience...
  echo.>>"apps\web\.env.local"
  echo CW_CHAT_MOCK=1>>"apps\web\.env.local"
)

if not exist "node_modules\" (
  echo [STEP] Installing dependencies (first run)...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [STEP] Starting web app at http://localhost:3000 ...
call npm run dev:web

if errorlevel 1 (
  echo [ERROR] Failed to start dev server.
  pause
  exit /b 1
)

endlocal
