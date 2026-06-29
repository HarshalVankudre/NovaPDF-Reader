@echo off
REM ===== DB Slide Finder - local launcher =====
REM Uses the bundled Node server (serve.js), which streams the PDFs reliably.
REM (Python's http.server drops large files on Windows - do not use it here.)
cd /d "%~dp0"

REM First run: install dependencies (Anthropic SDK for the Claude Opus tutor, mysql2, sql.js).
if not exist "node_modules\@anthropic-ai\sdk" (
  echo.
  echo   Installing dependencies ^(first run^)...
  call npm install
)

echo.
echo   DB Slide Finder  -  http://localhost:8000
echo   Tutor model: Claude Opus 4.8, high reasoning ^(set ANTHROPIC_API_KEY in serve.config.json or env^)
echo   Deep reasoning is on - the first answer can take a few seconds.
echo   (close this window to stop the server)
echo.
start "" http://localhost:8000
node serve.js
