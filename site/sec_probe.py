#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""安全自测脚本（只连本机自己的服务，不外发任何流量）。

验证三件事：
1. 半截请求（slowloris）是否会无限期占住工作线程 —— 即有没有 socket 超时
2. 并发 100 连接时线程数与内存增长
3. 未登录 / 越界路径是否会泄漏文件
"""
import os
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PORT = 18111
BASE = f'http://127.0.0.1:{PORT}'


def http(method, path, body=None, headers=None, timeout=5):
    """极简 HTTP 客户端，避免依赖 requests。"""
    s = socket.create_connection(('127.0.0.1', PORT), timeout=timeout)
    h = {'Host': f'127.0.0.1:{PORT}', 'Connection': 'close'}
    h.update(headers or {})
    payload = b''
    if body is not None:
        payload = body if isinstance(body, bytes) else body.encode()
        h['Content-Length'] = str(len(payload))
    req = f'{method} {path} HTTP/1.1\r\n' + ''.join(
        f'{k}: {v}\r\n' for k, v in h.items()) + '\r\n'
    s.sendall(req.encode() + payload)
    chunks = []
    while True:
        d = s.recv(65536)
        if not d:
            break
        chunks.append(d)
    s.close()
    raw = b''.join(chunks)
    head, _, body_raw = raw.partition(b'\r\n\r\n')
    status = int(head.split(b' ')[1]) if head else 0
    return status, head.decode('latin-1'), body_raw


def proc_stats(pid):
    """通过 psutil 不可用时的兜底：读 /proc 不存在于 Windows，这里只用线程数估算。"""
    try:
        import ctypes
        from ctypes import wintypes
        psapi = ctypes.WinDLL('psapi')
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        PROCESS_QUERY_INFORMATION = 0x0400
        PROCESS_VM_READ = 0x0010
        handle = kernel32.OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
        if not handle:
            return None
        class PMC(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD),
                        ('PageFaultCount', wintypes.DWORD),
                        ('PeakWorkingSetSize', ctypes.c_size_t),
                        ('WorkingSetSize', ctypes.c_size_t),
                        ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                        ('PagefileUsage', ctypes.c_size_t),
                        ('PeakPagefileUsage', ctypes.c_size_t)]
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        psapi.GetProcessMemoryInfo(handle, ctypes.byref(pmc), pmc.cb)
        kernel32.CloseHandle(handle)
        return pmc.WorkingSetSize / 1024 / 1024
    except Exception:
        return None


def main():
    env = dict(os.environ, PORT=str(PORT), LANSHARE_NO_BROWSER='1',
               SHARE_PIN='probe-pin-123456')
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, 'server.py')],
                         cwd=ROOT, env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                http('GET', '/api/auth-status', timeout=1)
                break
            except Exception:
                time.sleep(0.2)
        print(f'服务已启动 pid={p.pid} port={PORT}')
        base_mem = proc_stats(p.pid)
        print(f'初始内存: {base_mem:.1f} MB' if base_mem else '初始内存: n/a')

        # ---------- 1. 并发 100 个半截连接 ----------
        N = 100
        socks = []
        for _ in range(N):
            s = socket.socket()
            s.settimeout(3)
            s.connect(('127.0.0.1', PORT))
            s.send(b'GET / HTTP/1.1\r\nHost: x\r\n')
            socks.append(s)
        print(f'\n[1] 挂起 {N} 个半截请求（未发 headers 结束符）')
        time.sleep(6)
        mem = proc_stats(p.pid)
        print(f'    6 秒后内存: {mem:.1f} MB' if mem else '    内存: n/a')

        # 期间正常请求还能不能响应？
        t0 = time.time()
        try:
            st, _, _ = http('GET', '/api/auth-status', timeout=6)
            print(f'    正常请求仍可响应: HTTP {st}，耗时 {time.time()-t0:.2f}s')
        except Exception as e:
            print(f'    正常请求失败/超时: {e}')

        time.sleep(20)
        still = 0
        for s in socks:
            try:
                s.setblocking(False)
                d = s.recv(1)
                if d != b'':
                    still += 1
            except BlockingIOError:
                still += 1
            except Exception:
                pass
        mem2 = proc_stats(p.pid)
        print(f'    26 秒后仍被服务端挂着的连接: {still}/{N}')
        print(f'    26 秒后内存: {mem2:.1f} MB' if mem2 else '')
        for s in socks:
            try:
                s.close()
            except Exception:
                pass

        # ---------- 2. 越权路径探测 ----------
        print('\n[2] 未登录访问面')
        for path in ('/', '/api/files', '/api/info', '/shared/../server.py',
                     '/api/download/../../server.py', '/q/fake-ticket'):
            try:
                st, head, body = http('GET', path)
                loc = [l for l in head.split('\r\n')
                       if l.lower().startswith('location')]
                print(f'    {path:36s} -> {st} {loc[0] if loc else ""}')
            except Exception as e:
                print(f'    {path:36s} -> ERR {e}')

        # ---------- 3. PIN 暴力破解限流 ----------
        print('\n[3] PIN 限流（同一 IP 连错 8 次）')
        for i in range(8):
            st, _, body = http('POST', '/api/login',
                               body='{"pin":"wrong%d"}' % i,
                               headers={'Content-Type': 'application/json'})
            print(f'    第 {i+1} 次 -> {st} {body.decode("utf-8","replace")[:90]}')

        # ---------- 4. 超长 Cookie / 超长 URI ----------
        print('\n[4] 畸形请求')
        for desc, hdrs, path in (
            ('超长 Cookie 8KB', {'Cookie': 'lanshare_session=' + 'A' * 8000}, '/'),
            ('超长 URL 8KB', {}, '/' + 'a' * 8000),
            ('伪造签名 Cookie', {'Cookie': 'lanshare_session=AAAA.BBBB'}, '/api/files'),
        ):
            try:
                st, _, _ = http('GET', path, headers=hdrs, timeout=6)
                print(f'    {desc:20s} -> {st}')
            except Exception as e:
                print(f'    {desc:20s} -> ERR {type(e).__name__}')

        mem3 = proc_stats(p.pid)
        print(f'\n结束内存: {mem3:.1f} MB' if mem3 else '')
    finally:
        p.terminate()
        try:
            p.wait(timeout=5)
        except Exception:
            p.kill()


if __name__ == '__main__':
    main()