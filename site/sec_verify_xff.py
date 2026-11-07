#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 trust_proxy 语义：环回对端采信 XFF，非可信来源伪造无效。"""
import os
import socket
import subprocess
import sys
import time
import shutil

TMP = os.path.join(os.environ.get('TEMP') or '/tmp', 'lsp_xff')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(TMP, exist_ok=True)
shutil.copy(os.path.join(ROOT, 'server.py'), TMP)
dst = os.path.join(TMP, 'public')
if not os.path.isdir(dst):
    shutil.copytree(os.path.join(ROOT, 'public'), dst)

PORT = 18401
with open(os.path.join(TMP, 'config.json'), 'w', encoding='utf-8') as f:
    f.write('{"pin":"p@ss-verify-77","session_hours":12,"max_attempts":3,'
            '"lock_seconds":600,"read_only":false,"cookie_secure":false,'
            '"trust_proxy":true,"https":false}')

env = dict(os.environ, PORT=str(PORT), LANSHARE_NO_BROWSER='1')
p = subprocess.Popen([sys.executable, os.path.join(TMP, 'server.py')],
                     cwd=TMP, env=env,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(100):
    try:
        socket.create_connection(('127.0.0.1', PORT), timeout=1).close()
        break
    except Exception:
        time.sleep(0.2)


def req(xff, body=b'{"pin":"wrong"}', path=b'/api/login', method=b'POST'):
    s = socket.create_connection(('127.0.0.1', PORT), timeout=6)
    head = method + b' ' + path + b' HTTP/1.1\r\nHost: x\r\nConnection: close\r\n'
    if xff:
        head += b'X-Forwarded-For: ' + xff.encode() + b'\r\n'
    if method == b'POST':
        head += b'Content-Type: application/json\r\n'
        head += f'Content-Length: {len(body)}\r\n'.encode()
    head += b'\r\n'
    s.sendall(head + (body if method == b'POST' else b''))
    d = b''
    try:
        while True:
            c = s.recv(65536)
            if not c:
                break
            d += c
    except socket.timeout:
        pass
    s.close()
    code = d.split(b' ')[1].decode() if b' ' in d.split(b'\r\n')[0] else '???'
    return code


print('=' * 62)
print(' trust_proxy 语义验证（对端是 127.0.0.1，等同 cloudflared 在本机）')
print('=' * 62)

# 场景 A：每个请求伪造不同 XFF。环回对端算可信，所以 XFF 被采信，
#         但真实来源是 127.0.0.1、XFF 各不相同 -> 每个 XFF 各自独立计数
print('\nA. 环回对端 + 每次换不同 XFF（模拟不同真人经隧道访问）')
codes = [req(f'198.51.100.{i+1}') for i in range(4)]
ok_a = codes == ['401'] * 4
print(f'   4 个不同来源各错 1 次 -> {codes}')
print(f'   期望：全是 401（各自独立计数，不该互相牵连）  {"✓" if ok_a else "✗ 疑似串号"}')

# 场景 B：同一来源 IP 连续错，应该被锁死
print('\nB. 同一个来源 IP 连续输错（上限 3 次）')
codes = [req('203.0.113.99') for _ in range(6)]
print(f'   连续 6 次 -> {codes}')
ok_b = codes.count('401') <= 3 and '429' in codes
print(f'   期望：前 3 次 401，之后 429   {"✓" if ok_b else "✗"}')

# 场景 C：XFF 里塞可信网段想冒充代理
print('\nC. XFF 塞入 127.0.0.1 想冒充内网')
codes = [req('127.0.0.1') for _ in range(5)]
ok_c = '429' in codes
print(f'   连续 5 次 XFF=127.0.0.1 -> {codes}')
print(f'   期望：仍会被锁（不能靠冒充 127.0.0.1 换身份）  {"✓" if ok_c else "✗"}')

# 场景 D：XFF 多跳伪造 a, b —— 从右往左取第一个非可信
print('\nD. XFF 多跳 "1.2.3.4, 203.0.113.77"（左边是编的，右边是代理追加）')
codes = [req('1.2.3.4, 203.0.113.77') for _ in range(6)]
ok_d = codes.count('401') <= 3 and '429' in codes
print(f'   连续 6 次 -> {codes}')
print(f'   期望：按 203.0.113.77 计数并锁定（不被左边的 1.2.3.4 骗）  {"✓" if ok_d else "✗"}')

# 场景 E：服务仍可用
code = req(None, path=b'/api/auth-status', method=b'GET')
ok_e = code == '200'
print(f'\nE. 服务仍可用 -> {code}  {"✓" if ok_e else "✗"}')

p.terminate()
try:
    p.wait(timeout=10)
except Exception:
    p.kill()
print('\n' + '=' * 62)
