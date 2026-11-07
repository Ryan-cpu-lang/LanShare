#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""功能回归：确认加固没有破坏正常使用。"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import http.client
from urllib.parse import quote

TMP = os.path.join(os.environ.get('TEMP') or '/tmp', 'lsp_func')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(TMP, exist_ok=True)
shutil.copy(os.path.join(ROOT, 'server.py'), TMP)
pub = os.path.join(TMP, 'public')
if not os.path.isdir(pub):
    shutil.copytree(os.path.join(ROOT, 'public'), pub)
shutil.rmtree(os.path.join(TMP, 'shared'), ignore_errors=True)

PIN = 'func-test-8842'
with open(os.path.join(TMP, 'config.json'), 'w', encoding='utf-8') as f:
    json.dump({'pin': PIN, 'session_hours': 12, 'max_attempts': 5,
               'lock_seconds': 300, 'read_only': False,
               'cookie_secure': False, 'trust_proxy': False, 'https': False}, f)

PORT = 18501
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
fails = []


def call(method, path, body=None, headers=None, raw=False):
    global cookie
    c = http.client.HTTPConnection('127.0.0.1', PORT, timeout=20)
    h = dict(headers or {})
    if cookie:
        h['Cookie'] = cookie
    try:
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        data = r.read()
        sc = r.getheader('Set-Cookie')
        if sc and 'lanshare_session=' in sc:
            cookie = sc.split(';')[0]
        return r.status, data
    finally:
        c.close()


def ok(name, cond, detail=''):
    print(f'  [{"ok" if cond else "FAIL"}] {name}' + (f' — {detail}' if detail else ''))
    if not cond:
        fails.append(name)


print('=' * 64)
print(' 功能回归（加固后正常使用是否受影响）')
print('=' * 64)

# 未登录访问首页 -> 302
st, _ = call('GET', '/')
ok('未登录访问首页跳转登录', st == 302, f'{st}')

# 未登录调 API -> 401
st, body = call('GET', '/api/files')
ok('未登录调接口返回 401', st == 401, f'{st}')

# 登录页可访问
st, body = call('GET', '/login.html')
ok('登录页可访问', st == 200, f'{st}')

# 错误 PIN
st, body = call('POST', '/api/login', json.dumps({'pin': 'wrong'}), {'Content-Type': 'application/json'})
ok('错误 PIN 返回 401', st == 401, f'{st}')

# 正确 PIN
st, body = call('POST', '/api/login', json.dumps({'pin': PIN}), {'Content-Type': 'application/json'})
ok('正确 PIN 登录成功', st == 200 and cookie, f'{st}, cookie={"有" if cookie else "无"}')

# 登录后列表
st, body = call('GET', '/api/files')
ok('登录后获取列表', st == 200 and b'items' in body, f'{st}')

# 新建文件夹
st, body = call('POST', '/api/folder', json.dumps({'name': '测试目录', 'path': ''}),
                {'Content-Type': 'application/json'})
ok('新建中文文件夹', st == 200, f'{st} {body[:60]}')

# 上传一个文件
boundary = '----testboundary123'
content = '你好，这是回归测试内容。' * 20
part = (f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="file"; filename="回归.txt"\r\n'
        f'Content-Type: text/plain\r\n\r\n{content}\r\n'
        f'--{boundary}--\r\n').encode('utf-8')
st, body = call('POST', '/api/upload', part,
                {'Content-Type': f'multipart/form-data; boundary={boundary}'})
ok('上传文件', st == 200 and b'"ok": true' in body, f'{st} {body[:90]}')

# 读回
st, body = call('GET', '/api/read/' + quote('回归.txt'))
ok('读取文件内容一致', st == 200 and content.encode() in body, f'{st}')

# 编辑保存
newc = '编辑后的内容 ✓'
st, body = call('PUT', '/api/read/' + quote('回归.txt'), json.dumps({'content': newc}),
                {'Content-Type': 'application/json'})
st2, body2 = call('GET', '/api/read/' + quote('回归.txt'))
ok('在线编辑并保存', st == 200 and newc.encode() in body2, f'{st}/{st2}')

# 下载
st, body = call('GET', '/api/download/' + quote('回归.txt'))
ok('下载文件', st == 200 and newc.encode() in body, f'{st}, {len(body)} 字节')

# Range 请求
st, body = call('GET', '/api/download/' + quote('回归.txt'), headers={'Range': 'bytes=0-4'})
ok('Range 分段下载', st == 206 and len(body) == 5, f'{st}, {len(body)} 字节')

# 新建文本文件
st, body = call('POST', '/api/file', json.dumps({'name': 'note.md', 'path': '', 'content': '# hi'}),
                {'Content-Type': 'application/json'})
ok('新建文本文件', st == 200, f'{st}')

# zip 打包
st, body = call('GET', '/api/zip/%E6%B5%8B%E8%AF%95%E7%9B%AE%E5%BD%95')
ok('文件夹打包 zip', st == 200, f'{st}, {len(body)} 字节')

# 路径穿越
st, body = call('GET', '/api/download/..%2f..%2fserver.py')
ok('路径穿越被拒绝', st in (403, 404), f'{st}')

# 退出登录
st, body = call('POST', '/api/logout')
cookie = None
st2, _ = call('GET', '/api/files')
ok('退出后重新要求登录', st == 200 and st2 == 401, f'{st}/{st2}')

p.terminate()
try:
    p.wait(timeout=10)
except Exception:
    p.kill()

print('=' * 64)
print(f' {"全部通过 ✓" if not fails else "失败：" + ", ".join(fails)}')
print('=' * 64)
sys.exit(0 if not fails else 1)
