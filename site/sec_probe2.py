#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""针对 server.py 的资源耗尽型 DoS 自测（仅连本机）。"""
import os
import socket
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PORT = 18112


def proc_mem(pid):
    try:
        import ctypes
        from ctypes import wintypes
        psapi = ctypes.WinDLL('psapi')
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)

        class PMC(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('pf', wintypes.DWORD),
                        ('pk', ctypes.c_size_t), ('ws', ctypes.c_size_t),
                        ('a', ctypes.c_size_t), ('b', ctypes.c_size_t),
                        ('c', ctypes.c_size_t), ('d', ctypes.c_size_t),
                        ('e', ctypes.c_size_t), ('f', ctypes.c_size_t)]
        h = k32.OpenProcess(0x0410, False, pid)
        if not h:
            return None
        pm = PMC()
        pm.cb = ctypes.sizeof(PMC)
        psapi.GetProcessMemoryInfo(h, ctypes.byref(pm), pm.cb)
        k32.CloseHandle(h)
        return pm.ws / 1048576
    except Exception:
        return None


def thread_count(pid):
    """用 Python 自己数线程：读目标进程的线程句柄不可行，改用 tasklist 替代。"""
    out = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/FO', 'CSV'],
                         capture_output=True, text=True, encoding='gbk',
                         errors='replace').stdout
    return out.strip().replace('\n', ' | ')


def start():
    env = dict(os.environ, PORT=str(PORT), LANSHARE_NO_BROWSER='1',
               SHARE_PIN='probe-pin-123456')
    p = subprocess.Popen([sys.executable, os.path.join(ROOT, 'server.py')],
                         cwd=ROOT, env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            s = socket.create_connection(('127.0.0.1', PORT), timeout=1)
            s.close()
            return p
        except Exception:
            time.sleep(0.2)
    raise RuntimeError('服务没起来')


def probe_A(p):
    """A. 未登录 POST /api/login 声明超大 Content-Length，只发少量数据。"""
    print('\n[A] 未登录 /api/login + 超大 Content-Length（内存/线程耗尽）')
    mem0 = proc_mem(p.pid)
    print(f'    基线内存 {mem0:.1f} MB')
    socks = []
    # 声明 200MB，实际只发 1KB —— 服务端会一直 rfile.read(200MB) 等下去
    for i in range(30):
        s = socket.socket()
        s.settimeout(3)
        s.connect(('127.0.0.1', PORT))
        body = b'{"pin":"x"}'
        s.sendall(
            b'POST /api/login HTTP/1.1\r\nHost: x\r\n'
            b'Content-Type: application/json\r\n'
            + f'Content-Length: {200 * 1024 * 1024}\r\n\r\n'.encode()
            + body[:1])   # 只发 1 字节
        socks.append(s)
    time.sleep(5)
    mem1 = proc_mem(p.pid)
    print(f'    30 个"声明 200MB 只发 1 字节"的连接，5 秒后内存 {mem1:.1f} MB'
          f'（+{mem1-mem0:.1f}）')
    # 服务端还会不会处理正常请求？
    t0 = time.time()
    try:
        s = socket.create_connection(('127.0.0.1', PORT), timeout=8)
        s.sendall(b'GET /api/auth-status HTTP/1.1\r\nHost: x\r\n\r\n')
        d = s.recv(200)
        print(f'    期间正常请求：{d[:40]!r}'
              f' 耗时 {time.time()-t0:.2f}s')
        s.close()
    except Exception as e:
        print(f'    期间正常请求失败: {type(e).__name__} {e}')
    for s in socks:
        try:
            s.close()
        except Exception:
            pass
    time.sleep(1)
    print(f'    断开后内存 {proc_mem(p.pid):.1f} MB')


def probe_B(p):
    """B. keep-alive 空闲连接：发完一个完整请求后不再说话。"""
    print('\n[B] keep-alive 空闲连接是否被回收')
    socks = []
    for _ in range(20):
        s = socket.create_connection(('127.0.0.1', PORT), timeout=5)
        s.sendall(b'GET /login.html HTTP/1.1\r\nHost: x\r\n\r\n')
        s.recv(200)          # 读完响应，连接进入 keep-alive
        socks.append(s)      # 然后什么都不做
    print('    已建立 20 条空闲 keep-alive 连接，等待 35 秒…')
    time.sleep(35)
    alive = 0
    for s in socks:
        try:
            s.setblocking(False)
            d = s.recv(1)
            if d != b'':
                alive += 1
        except BlockingIOError:
            alive += 1
        except Exception:
            pass
    print(f'    35 秒后仍存活: {alive}/20')
    for s in socks:
        try:
            s.close()
        except Exception:
            pass


def probe_C(p):
    """C. 上传接口声明 500MB 只发几字节。"""
    print('\n[C] 已登录上传接口的超大 body（需先拿 Cookie）')
    # 直接构造一个合法 token 太麻烦，改为直接调 _read_json 路径：
    # /api/folder 同样在未登录时被拦，但拦之前会不会先读 body？
    socks = []
    mem0 = proc_mem(p.pid)
    for _ in range(10):
        s = socket.create_connection(('127.0.0.1', PORT), timeout=5)
        s.sendall(
            b'POST /api/upload?path= HTTP/1.1\r\nHost: x\r\n'
            b'Content-Type: multipart/form-data; boundary=zzz\r\n'
            + f'Content-Length: {600 * 1024 * 1024}\r\n\r\n'.encode()
            + b'--zzz\r\n')
        socks.append(s)
    time.sleep(5)
    print(f'    10 个声明 600MB 的连接，内存 {mem0:.1f} -> {proc_mem(p.pid):.1f} MB')
    for s in socks:
        try:
            s.close()
        except Exception:
            pass


if __name__ == '__main__':
    p = start()
    print(f'pid={p.pid}')
    try:
        probe_B(p)
        probe_A(p)
        probe_C(p)
        print('\n进程还在吗:', p.poll() is None, '| tasklist:', thread_count(p.pid)[:120])
    finally:
        p.terminate()
        try:
            p.wait(timeout=5)
        except Exception:
            p.kill()