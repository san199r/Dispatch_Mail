@echo off
REM Double-click this file to start the Dispatch Board and open it in your browser.
cd /d "%~dp0"

echo Starting Dispatch Board server...

REM Launch the server in its own window (keep it open to keep the app running).
start "Dispatch Board server" cmd /k node server.js

REM Wait for the server to boot, then open the app in your default browser.
timeout /t 2 /nobreak >nul
start "" http://localhost:4173

echo.
echo The app is opening at http://localhost:4173
echo Keep the "Dispatch Board server" window open while you use the app.
echo Close that window to stop the app.
timeout /t 4 /nobreak >nul
