@echo off
chcp 65001 >nul
title LanShare - LAN File Share
cd /d "%~dp0"

rem Prefer the packaged exe: no Python needed.
if exist "LanShare.exe" (
    start "" "LanShare.exe"
    exit /b 0
)
if exist "dist\LanShare.exe" (
    start "" "dist\LanShare.exe"
    exit /b 0
)

rem Fall back to source. Check py launcher first, then python.
set "PY="
where py >nul 2>&1 && set "PY=py"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY (
    echo.
    echo [ERROR] Python not found, and LanShare.exe is missing too.
    echo.
    echo   Option 1: download LanShare.exe from Releases, put it here, double-click it.
    echo   Option 2: install Python 3 from https://www.python.org/downloads/
    echo             remember to tick "Add Python to PATH".
    echo.
    pause
    exit /b 1
)

echo Starting... the browser will open in a few seconds.
echo.
%PY% server.py

pause
