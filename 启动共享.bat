@echo off
chcp 65001 >nul
title 局域网文件共享服务器
cd /d "%~dp0"

echo ================================================
echo          局域网文件共享服务器
echo ================================================
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo [错误] 没有找到 Python，请先安装 Python 3
    echo        下载地址: https://www.python.org/downloads/
    pause
    exit /b 1
)

echo [1/2] 正在读取本机局域网地址...
echo.
echo [2/2] 启动服务...
echo.
python server.py

pause