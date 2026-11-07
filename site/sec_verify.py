#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LanShare 抗压/抗绕过回归测试。

覆盖四个已验证过的漏洞：
 1. 半截连接（slowloris）不超时  -> 现在应被看门狗/超时掐掉
 2. Content-Length 声明巨大导致 OOM -> 现在应回 413，内存不涨
 3. 伪造 X-Forwarded-For 绕过封禁  -> 现在应回 429
 4. 单连接无限发请求              -> 现在应被 MAX_REQ_PER_CONN 拦下
"""
import os
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(os.environ.get('TEMP') or '/tmp', 'lsp_verify')
PORT = 18299

os.makedirs(TMP, exist_ok=True)
import shutil
for name in ('server.py',):
    shutil.copy(os.path.join(os.path.dirname(ROOT), 'server.py'), TMP)
pub_src = os.path.join(os.path.dirname(ROOT), 'public')
pub_dst = os.path.join(TMP, 'public')
if os.path.isdir(pub_dst):
    shutil.rmtree(pub_dst)
shutil.copytree(pub_src, pub_dst)

with open(os.path.join(TMP, 'config.json'), 'w', encoding='utf-8') as f:
    # 关键：trusted_proxies 故意设成 10.0.0.0/8（反代在另一台机器），
    # 这样测试用的 127.0.0.1 对端就是「不可信来源」，
    # 它发来的 X-Forwarded-For 必须被忽略 —— 这正是要验证的绕过场景。
    f.write('{"pin":"verify-pin-9f3a","session_hours":12,"max_attempts":5,'
            '"lock_seconds":300,"read_only":false,"cookie_secure":false,'
            '"trust_proxy":true,"trusted_proxies":["10.0.0.0/8"],"https":false}')

env = dict(os.environ, PORT=str(PORT), LANSHARE_NO_BROWSER='1')


def start():
    p = subprocess.Popen([sys.executable, os.path.join(TMP, 'server.py')],
                         cwd=TMP, env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            socket.create_connection(('127.0.0.1', PORT), timeout=1).close()
            return p
        except Exception:
            time.sleep(0.2)
    raise RuntimeError('服务没起来')


def rss_mb(pid):
    try:
        import ctypes
        from ctypes import wintypes
        PROCESS_QUERY_INFORMATION = 0x0400
        PROCESS_VM_READ = 0x0010
        class PMC(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD),
                        ('PeakWorkingSetSize', ctypes.c_size_t),
                        ('WorkingSetSize', ctypes.c_size_t),
                        ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                        ('PagefileUsage', ctypes.c_size_t),
                        ('PeakPagefileUsage', ctypes.c_size_t)]
        h = ctypes.windll.kernel32.OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
        if not h:
            return -1
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        ctypes.windll.psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb)
        ctypes.windll.kernel32.CloseHandle(h)
        return round(pmc.WorkingSetSize / 1048576, 1)
    except Exception:
        return -1


def raw_request(payload, timeout=6, xff=None, keep=False):
    s = socket.create_connection(('127.0.0.1', PORT), timeout=timeout)
    if xff is not None:
        payload = payload.replace(b'\r\n\r\n',
                                  b'\r\nX-Forwarded-For: ' + xff.encode() + b'\r\n\r\n', 1)
    if not keep:
        payload = payload.replace(b'\r\n\r\n', b'\r\nConnection: close\r\n\r\n', 1)
    s.sendall(payload)
    data = b''
    try:
        while True:
            c = s.recv(65536)
            if not c:
                break
            data += c
    except socket.timeout:
        pass
    s.close()
    line = data.split(b'\r\n')[0].decode('utf-8', 'replace') if data else '(无响应)'
    body = data.split(b'\r\n\r\n', 1)[-1].decode('utf-8', 'replace')[:90] if b'\r\n\r\n' in data else ''
    return line, body


def login(xff_value):
    body = b'{"pin":"definitely-wrong"}'
    req = (b'POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n'
           + f'Content-Length: {len(body)}\r\n'.encode() + b'\r\n' + body)
    return raw_request(req, xff=xff_value)


results = []


def check(name, ok, detail):
    results.append((name, ok, detail))
    print(f'  [{"通过" if ok else "未通过"}] {name}')
    print(f'        {detail}')


print('=' * 70)
print(' LanShare 安全回归测试')
print('=' * 70)

proc = start()
print(f'  服务已启动 pid={proc.pid} 基础内存 {rss_mb(proc.pid)} MB\n')

# ---- 1. Content-Length 声明巨大 ----
print('【1】Content-Length 声明 200MB，但只发 1 字节')
base = rss_mb(proc.pid)
socks = []
for i in range(30):
    try:
        s = socket.create_connection(('127.0.0.1', PORT), timeout=5)
        s.sendall(b'POST /api/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n'
                  b'Content-Length: 209715200\r\n\r\nX')
        socks.append(s)
    except Exception as e:
        print(f'        第 {i+1} 个连接建立失败：{e}')
        break
time.sleep(6)
peak = rss_mb(proc.pid)
for s in socks:
    try:
        s.close()
    except Exception:
        pass
grew = peak - base
check('巨型 Content-Length 不再吃内存',
      grew < 120,
      f'内存 {base} MB -> {peak} MB（增长 {grew:.1f} MB）；修复前会涨到 3000+ MB')

proc.terminate()
proc.wait(timeout=10)
time.sleep(0.5)

# ---- 2. 伪造 XFF 绕封禁 ----
print('\n【2】同一来源，每次伪造不同的 X-Forwarded-For 试 PIN')
proc = start()
codes = []
for i in range(10):
    line, body = login(f'203.0.113.{i + 1}')
    code = line.split(' ')[1] if ' ' in line else '???'
    codes.append(code)
    print(f'        第 {i+1:2d} 次 -> {code}  {body[:56]}')
blocked = sum(1 for c in codes if c in ('429', '503'))
check('伪造 XFF 无法无限试 PIN',
      blocked >= 4,
      f'10 次里有 {blocked} 次被限流/拒绝（修复前 10 次全是 401）')

# ---- 3. 单个 keep-alive 连接狂发请求 ----
print('\n【3】单条 keep-alive 连接连发 260 个请求')
s = socket.create_connection(('127.0.0.1', PORT), timeout=8)
f = s.makefile('rb')
sent = 0
got_429 = False
closed_by_server = False
try:
    while sent < 260:
        s.sendall(b'GET /api/auth-status HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n')
        sent += 1
        # 必须按 HTTP 帧解析：一次 recv 可能只拿到半个响应，
        # 直接 split 状态行会把响应体当成状态行（上一版测试就栽在这）
        status = f.readline().decode('utf-8', 'replace').strip()
        if not status:
            closed_by_server = True
            break
        clen = 0
        while True:
            h = f.readline()
            if h in (b'\r\n', b''):
                break
            if h.lower().startswith(b'content-length:'):
                try:
                    clen = int(h.split(b':', 1)[1])
                except ValueError:
                    clen = 0
        if clen:
            f.read(clen)
        if '429' in status:
            got_429 = True
            break
except Exception as e:
    print(f'        连接中断：{type(e).__name__}')
finally:
    try:
        s.close()
    except Exception:
        pass
check('单连接请求数有上限', got_429 or closed_by_server,
      f'第 {sent} 个请求{"被 429 拦下" if got_429 else ("时服务端关闭连接" if closed_by_server else "仍未被拦下")}'
      f'（上限 {200}）')

# ---- 4. 半截连接 slowloris ----
print('\n【4】100 个只发半个请求头的连接，观察 40 秒')
socks = []
rejected = 0
for i in range(100):
    try:
        s = socket.create_connection(('127.0.0.1', PORT), timeout=3)
        s.sendall(b'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n')
        socks.append(s)
    except Exception:
        rejected += 1
print(f'        成功挂起 {len(socks)} 个，另有 {rejected} 个被直接拒绝')
time.sleep(40)
alive = 0
for s in socks:
    try:
        s.settimeout(0.3)
        d = s.recv(1)
        if d:
            # 收到了响应（503 server busy）说明服务端主动处理后关闭了，
            # 不算「挂着不放」。再探一次看是否已断开。
            try:
                s.settimeout(0.3)
                while True:
                    if not s.recv(4096):
                        break
            except Exception:
                pass
            continue
        # d == b'' 表示对端已关闭
    except socket.timeout:
        alive += 1            # 既没响应也没关，才是真正占着槽位
    except Exception:
        pass
for s in socks:
    try:
        s.close()
    except Exception:
        pass
check('slowloris 半截连接会被清理',
      alive <= 5,
      f'40 秒后仍被占住 {alive}/{len(socks)} 个（另有 {rejected} 个当场被拒）；'
      f'修复前 100/100 全部存活')

# ---- 5. 服务是否还活着 ----
print('\n【5】挨完上面所有折腾后，服务是否还能正常响应')
try:
    line, body = raw_request(b'GET /api/auth-status HTTP/1.1\r\nHost: x\r\n\r\n')
    ok = ' 200 ' in line
    check('服务仍然可用', ok, f'GET /api/auth-status -> {line}')
except Exception as e:
    check('服务仍然可用', False, f'请求失败：{e}')

proc.terminate()
try:
    proc.wait(timeout=10)
except Exception:
    proc.kill()

print('\n' + '=' * 70)
passed = sum(1 for _, ok, _ in results if ok)
print(f' 结果：{passed}/{len(results)} 项通过')
for name, ok, _ in results:
    print(f'   {"✓" if ok else "✗"} {name}')
print('=' * 70)
