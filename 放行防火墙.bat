@echo off
chcp 65001 >nul
title 放行 8080 端口（需要管理员权限）

:: 检查管理员权限
net session >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [!] 需要管理员权限才能修改防火墙规则。
    echo      请右键这个文件，选择「以管理员身份运行」。
    echo.
    pause
    exit /b 1
)

echo.
echo  正在为 TCP 8080 端口添加入站放行规则...
echo.

netsh advfirewall firewall delete rule name="局域网文件共享8080" >nul 2>&1
netsh advfirewall firewall add rule name="局域网文件共享8080" dir=in action=allow protocol=TCP localport=8080 profile=private,domain

if errorlevel 1 (
    echo  [失败] 规则添加失败，请手动在防火墙里放行 8080 端口。
) else (
    echo  [成功] 已放行 8080 端口（仅专用网络 / 域网络）。
    echo.
    echo  现在同一局域网内的其他设备应该可以访问了。
    echo  如果你的网络被识别为「公用网络」，请在系统设置里改成「专用网络」。
)

echo.
pause