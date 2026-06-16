@echo off
REM ===== DB Slide Finder - local launcher =====
REM Uses the bundled Node server (serve.js), which streams the PDFs reliably.
REM (Python's http.server drops large files on Windows — do not use it here.)
cd /d "%~dp0"
echo.
echo   DB Slide Finder  -  http://localhost:8000
echo   (close this window to stop the server)
echo.
start "" http://localhost:8000
node serve.js
