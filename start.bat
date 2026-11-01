@echo off
setlocal
title NovaPDF Reader
cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 goto :missing_node

REM Install missing runtime dependencies on the first launch.
node -e "for (const name of Object.keys(require('./package.json').dependencies || {})) require.resolve(name)" >nul 2>&1
if errorlevel 1 (
  where npm.cmd >nul 2>&1
  if errorlevel 1 goto :missing_npm
  echo Installing dependencies ^(first run^)...
  call npm.cmd install
  if errorlevel 1 goto :install_failed
)

if not defined PORT set "PORT=8000"
node -e "const p = process.env.PORT; if (!/^[0-9]+$/.test(p) || Number(p) < 1 || Number(p) > 65535) process.exit(1)"
if errorlevel 1 goto :invalid_port
set "NOVAPDF_URL=http://localhost:%PORT%"

echo.
echo   NovaPDF Reader - %NOVAPDF_URL%
echo   The browser will open when the server is ready.
echo   Close this window to stop the server.
echo.

REM Poll in this console without opening an extra window.
start "" /b powershell.exe -NoProfile -Command "$url = $env:NOVAPDF_URL; $deadline = (Get-Date).AddSeconds(30); do { try { $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2; if ($response.StatusCode -eq 200) { Start-Process $url; exit 0 } } catch {}; Start-Sleep -Milliseconds 250 } while ((Get-Date) -lt $deadline); Write-Host 'Open the URL above manually once the server is ready.'"
node serve.js
if errorlevel 1 goto :server_failed
exit /b 0

:missing_node
echo Node.js is required. Install Node.js LTS from https://nodejs.org,
echo then double-click this file again.
goto :failed

:missing_npm
echo npm is missing. Reinstall Node.js with npm included, then try again.
goto :failed

:install_failed
echo Dependency installation failed. Check your internet connection and try again.
goto :failed

:invalid_port
echo PORT must be a number between 1 and 65535.
goto :failed

:server_failed
echo The server could not run. Check the error above.

:failed
echo.
pause
exit /b 1
