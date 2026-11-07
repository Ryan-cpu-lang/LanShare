#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""大文件上传/下载回归：确认看门狗与超时不会误杀正常的长耗时传输。"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import http.client
from urllib.parse import quote

TMP = os.path.join(os.environ.get('TEMP') or '/tmp', 'lsp_big')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(TMP, exist_ok=True)
shutil.copy(os.path.join(ROOT, 'server.py'), TMP)
pub = os.path.join(TMP, 'public')
if not os.path.isdir(pub):
    shutil.copytree(os.path.join(ROOT, 'public'), pub)
shutil.rmtree(os.path.join(TMP, 'shared'), ignore_errors=True)

PIN = 'big-test-5531'
with open(os.path.join(TMP, 'config.json'), 'w', encoding='utf-8') as f:
    json.dump({'pin': PIN, 'session_hours': 12, 'max_attempts': 5,
               'lock_seconds': 300, 'read_only': False,
               'cookie_secure': False, 'trust_proxy': False, 'https': False}, f)

PORT = 18601
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

cookie = None


def conn():
    return http.client.HTTPConnection('127.0.0.1', PORT, timeout=180)


print('=' * 64)
print(' 大文件传输回归（慢速客户端不应被误杀）')
print('=' * 64)

# 登录
c = conn()
c.request('POST', '/api/login', json.dumps({'pin': PIN}),
          {'Content-Type': 'application/json'})
r = c.getresponse()
r.read()
cookie = r.getheader('Set-Cookie').split(';')[0]
c.close()
print(f'  已登录')

# 上传 60MB
SIZE = 60 * 1024 * 1024
blob = bytes(range(256)) * (SIZE // 256)
boundary = '----bigtest'
head = (f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="file"; filename="big.bin"\r\n'
        f'Content-Type: application/octet-stream\r\n\r\n').encode()
tail = f'\r\n--{boundary}--\r\n'.encode()
body = head + blob + tail
print(f'  上传 {SIZE // 1048576} MB ...')
t0 = time.time()
c = conn()
c.request('POST', '/api/upload', body,
          {'Content-Type': f'multipart/form-data; boundary={boundary}',
           'Cookie': cookie})
r = c.getresponse()
data = r.read()
up_time = time.time() - t0
c.close()
print(f'  上传结果 {r.status}，耗时 {up_time:.1f}s  {data[:80]}')

# 下载并做慢速读取（每 0.2 秒读 512KB，模拟 2.5MB/s 的慢网）
print(f'  慢速下载（限速约 2.5 MB/s）...')
t0 = time.time()
c = conn()
c.request('GET', '/api/download/big.bin', headers={'Cookie': cookie})
r = c.getresponse()
got = 0
slow = True
while True:
    chunk = r.read(512 * 1024)
    if not chunk:
        break
    got += len(chunk)
    if slow and got < SIZE:
        time.sleep(0.2)
    if time.time() - t0 > 120:
        print('  超时中断')
        break
dl_time = time.time() - t0
c.close()
print(f'  下载结果 {r.status}，收到 {got // 1048576} MB，耗时 {dl_time:.1f}s')

# 慢速上传：分片发送，每片之间停 0.3 秒，总耗时 > 30 秒，验证不会被看门狗掐
print(f'  慢速上传（分 45 片，每片停 1s，总耗时 > 45s）...')
small = bytes(range(256)) * (9 * 1024 * 1024 // 256)   # 9MB
head2 = (f'--{boundary}\r\n'
         f'Content-Disposition: form-data; name="file"; filename="slow.bin"\r\n'
         f'Content-Type: application/octet-stream\r\n\r\n').encode()
total = len(head2) + len(small) + len(tail)
t0 = time.time()
s = socket.create_connection(('127.0.0.1', PORT), timeout=120)
s.sendall((f'POST /api/upload HTTP/1.1\r\nHost: x\r\nCookie: {cookie}\r\n'
           f'Content-Type: multipart/form-data; boundary={boundary}\r\n'
           f'Content-Length: {total}\r\nConnection: close\r\n\r\n').encode())
s.sendall(head2)
sent = 0
CHUNK = max(1, len(small) // 45)
while sent < len(small):
    piece = small[sent:sent + CHUNK]
    s.sendall(piece)
    sent += len(piece)
    time.sleep(1.0)
s.sendall(tail)
resp = b''
try:
    while True:
        d = s.recv(65536)
        if not d:
            break
        resp += d
except socket.timeout:
    pass
s.close()
slow_up = time.time() - t0
status = resp.split(b'\r\n')[0].decode(errors='replace') if resp else '(无响应)'
print(f'  慢速上传结果 {status}，耗时 {slow_up:.1f}s')

p.terminate()
try:
    p.wait(timeout=10)
except Exception:
    p.kill()

print('\n' + '=' * 64)
results = [
    ('60MB 上传', r.status == 200 or b'"ok": true' in data, f'{up_time:.1f}s'),
    ('60MB 慢速下载完整', got == SIZE, f'{got // 1048576}/{SIZE // 1048576} MB, {dl_time:.1f}s'),
    ('9MB 慢速上传（>45s）未被打断', '200' in status, f'{slow_up:.1f}s, {status}'),
]
for name, ok_, detail in results:
    print(f'  {"✓" if ok_ else "✗"} {name} — {detail}')
print('=' * 64)
