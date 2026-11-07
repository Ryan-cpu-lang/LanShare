#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
局域网文件共享服务器（纯标准库实现，无需 pip 安装依赖）
支持：文件上传/下载、文字在线编辑、文件夹创建与浏览
"""

import os
import re
import sys
import json
import time
import hmac
import base64
import hashlib
import shutil
import socket
import secrets
import tempfile
import zipfile
import mimetypes
import posixpath
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, unquote, quote, parse_qs
from datetime import datetime

# ---------------- 目录 ----------------
# 打包成 exe（PyInstaller）后，程序内部文件被解到一个临时目录，
# 而用户看得见的文件（shared/ 里的文件、config.json）必须留在 exe 旁边，
# 否则用户传的文件会随程序退出一起消失。所以要区分两套目录。
_FROZEN = bool(getattr(sys, 'frozen', False))
if _FROZEN:
    # exe 所在目录：用户放文件、改 PIN 的地方
    BASE_DIR = os.path.dirname(os.path.abspath(sys.executable))
    # 解包目录：public/ 这类只读资源
    RES_DIR = getattr(sys, '_MEIPASS', BASE_DIR)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    RES_DIR = BASE_DIR

PUBLIC_DIR = os.path.join(RES_DIR, 'public')


def _writable(path):
    """探测目录是否真的能写文件（光看权限位在 Windows 上不准）。"""
    probe = os.path.join(path, '.lanshare_write_test')
    try:
        with open(probe, 'wb') as f:
            f.write(b'1')
        os.remove(probe)
        return True
    except Exception:
        return False


# 数据目录：默认就是 exe 旁边，用户一眼能看到文件传到哪了。
# 但要是有人把 exe 扔进 Program Files（需要管理员权限才能写），
# 在那里写文件会失败，PIN 也会每次启动都重新生成。这种情况退到用户数据目录。
DATA_DIR = BASE_DIR
_FALLBACK_DIR = False
try:
    os.makedirs(BASE_DIR, exist_ok=True)
except Exception:
    pass
if not _writable(BASE_DIR):
    DATA_DIR = os.path.join(
        os.environ.get('LOCALAPPDATA') or os.path.expanduser('~'), 'LanShare')
    os.makedirs(DATA_DIR, exist_ok=True)
    _FALLBACK_DIR = True

SHARED_DIR = os.path.join(DATA_DIR, 'shared')
CONFIG_PATH = os.path.join(DATA_DIR, 'config.json')
SECRET_PATH = os.path.join(DATA_DIR, '.session_secret')
PORT = int(os.environ.get('PORT', 8080))
HOST = '0.0.0.0'
MAX_UPLOAD = 500 * 1024 * 1024  # 单次请求上限 500MB
COOKIE_NAME = 'lanshare_session'

DEFAULT_CONFIG = {
    'pin': None,              # 访问 PIN；为空则首次启动自动生成
    'session_hours': 12,      # 登录有效期（小时）
    'max_attempts': 5,        # 连续错误次数上限
    'lock_seconds': 300,      # 触发上限后锁定秒数
    'read_only': False,       # 只读模式：只能浏览/下载，不能上传修改
    'cookie_secure': False,   # 走 HTTPS 时设为 true
    'trust_proxy': False,     # 放在 Nginx / Cloudflare 后面时设为 true
    'https': False,           # 是否直接以 HTTPS 提供服务
    'cert_file': 'cert.pem',  # HTTPS 证书
    'key_file': 'key.pem',    # HTTPS 私钥
}

os.makedirs(SHARED_DIR, exist_ok=True)

# ---------------- 控制台中文输出 ----------------
# Windows 控制台默认代码页是 936(GBK)。Python 3.6+ 直接写控制台时走 WriteConsoleW，
# 本来没问题；但只要输出被重定向（`> log.txt`、被别的程序捕获）就会按代码页编码，中文变问号。
# 这里把控制台代码页切成 65001(UTF-8)，同时把 stdout/stderr 也设成 utf-8，两边对齐。
if os.name == 'nt':
    try:
        import ctypes
        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
        ctypes.windll.kernel32.SetConsoleCP(65001)
    except Exception:
        pass
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


def set_title(title):
    """设置控制台窗口标题（Windows）。用户开了好几个窗口时能分得清哪个是哪个。"""
    if os.name != 'nt':
        return
    try:
        import ctypes
        ctypes.windll.kernel32.SetConsoleTitleW(title)
    except Exception:
        pass


def fatal(msg):
    """致命错误：把原因打出来，并等用户看完再关窗。

    双击运行时窗口一关就什么都看不见，小白只会觉得「点了没反应」。
    """
    sys.stderr.write(msg)
    sys.stderr.flush()
    if _FROZEN and sys.stdin and sys.stdin.isatty():
        try:
            input('\n按回车键退出...')
        except Exception:
            pass
    raise SystemExit(1)


def load_config():
    """读取 config.json；缺少 PIN 时自动生成一个 6 位数字 PIN。"""
    cfg = dict(DEFAULT_CONFIG)
    created = not os.path.isfile(CONFIG_PATH)
    if not created:
        # utf-8-sig 兼容 Windows 记事本 / PowerShell 写入时带的 BOM
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8-sig') as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                cfg.update(loaded)
            else:
                raise ValueError('config.json 顶层必须是对象')
        except Exception as e:
            # 解析失败时保留原文件，退出而不是悄悄生成新 PIN
            fatal(
                '\n[错误] config.json 解析失败，为避免 PIN 被意外覆盖，服务停止启动。\n'
                f'       原因: {e}\n'
                f'       文件: {CONFIG_PATH}\n'
                '       请修正该文件，或删除它让程序重新生成一个 PIN。\n')

    env_pin = os.environ.get('SHARE_PIN')
    if env_pin:
        cfg['pin'] = env_pin

    changed = created
    if not cfg.get('pin'):
        cfg['pin'] = ''.join(secrets.choice('0123456789') for _ in range(6))
        changed = True
    if changed:
        try:
            with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
        except Exception as e:
            sys.stderr.write(f'[警告] 无法写入 config.json: {e}\n')
    return cfg


def load_secret():
    """用于签名登录 Cookie 的密钥，持久化保存，重启后仍然有效。"""
    if os.path.isfile(SECRET_PATH):
        try:
            with open(SECRET_PATH, 'rb') as f:
                data = f.read().strip()
            if len(data) >= 32:
                return data
        except Exception:
            pass
    data = secrets.token_bytes(32)
    try:
        with open(SECRET_PATH, 'wb') as f:
            f.write(data)
        os.chmod(SECRET_PATH, 0o600)
    except Exception:
        pass
    return data


CFG = load_config()
PIN = str(CFG['pin'])
SECRET = load_secret()
SESSION_TTL = int(CFG.get('session_hours', 12)) * 3600
READ_ONLY = bool(CFG.get('read_only', False))
MAX_ATTEMPTS = int(CFG.get('max_attempts', 5))
LOCK_SECONDS = int(CFG.get('lock_seconds', 300))

# 登录失败计数： ip -> [时间戳, ...]
_FAILS = {}

# ---------------- 扫码登录票据 ----------------
# 电脑上点「手机扫码」时生成一张一次性票据，二维码里带的是 /q/<票据>。
# 手机扫到后才知道该连哪个地址、也就不用再手输 PIN。
# 票据只活在内存里，服务重启即失效；一次性，用过就作废。
QR_TTL = 10 * 60          # 10 分钟有效
_QR_TICKETS = {}          # ticket -> 过期时间戳
_QR_LOCK = threading.Lock()


def qr_issue():
    """生成一张扫码票据，顺手清掉过期的。"""
    now = time.time()
    with _QR_LOCK:
        for key in [k for k, exp in _QR_TICKETS.items() if exp < now]:
            _QR_TICKETS.pop(key, None)
        ticket = secrets.token_urlsafe(16)
        _QR_TICKETS[ticket] = now + QR_TTL
    return ticket


def qr_consume(ticket):
    """核销票据：有效且未被用过返回 True。用过立即作废，防止链接被转发复用。"""
    now = time.time()
    with _QR_LOCK:
        exp = _QR_TICKETS.pop(ticket, None)
    return exp is not None and exp >= now


def _b64e(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def _b64d(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def issue_token():
    """生成 '有效期.随机串' 的 HMAC 签名令牌。"""
    payload = f"{int(time.time()) + SESSION_TTL}.{secrets.token_hex(8)}"
    sig = hmac.new(SECRET, payload.encode(), hashlib.sha256).digest()
    return _b64e(payload.encode()) + '.' + _b64e(sig)


def verify_token(token):
    if not token or token.count('.') != 1:
        return False
    try:
        payload_b64, sig_b64 = token.split('.')
        payload = _b64d(payload_b64).decode()
        sig = _b64d(sig_b64)
        expect = hmac.new(SECRET, payload.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(sig, expect):
            return False
        exp = int(payload.split('.', 1)[0])
        return exp > time.time()
    except Exception:
        return False


def locked_until(ip):
    now = time.time()
    records = [t for t in _FAILS.get(ip, []) if now - t < LOCK_SECONDS]
    if records:
        _FAILS[ip] = records
    else:
        _FAILS.pop(ip, None)
    if len(records) >= MAX_ATTEMPTS:
        return int(LOCK_SECONDS - (now - records[0])) + 1
    return 0


def record_failure(ip):
    _FAILS.setdefault(ip, []).append(time.time())


def safe_join(base, *paths):
    """把用户传入的相对路径安全地拼到 base 下，阻止 ../ 越权访问。"""
    parts = [p.replace('\\', '/') for p in paths if p]
    rel = posixpath.join(*parts) if parts else ''
    target = os.path.realpath(os.path.join(base, rel))
    base_real = os.path.realpath(base)
    if target != base_real and not target.startswith(base_real + os.sep):
        raise PermissionError('路径越界')
    return target


# 文件名里不允许出现的字符（Windows 会静默改写或直接抛 OSError）
_BAD_NAME_CHARS = set('<>:"/\\|?*')
# Windows 设备保留名，写成 CON.txt 这类也会出问题
_RESERVED_NAMES = ({'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'}
                   | {f'COM{i}' for i in range(1, 10)}
                   | {f'LPT{i}' for i in range(1, 10)})

# 只有这些类型允许在浏览器里 inline 打开，其余一律强制下载。
# html / svg / xml / js 是存储型 XSS 的主要载体，绝不能 inline 同源渲染。
SAFE_INLINE_TYPES = {
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
    # iPhone 拍照默认 HEIC/HEIF；Safari 能直接显示，其他浏览器打不开也不会有安全问题
    'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence',
    'video/mp4', 'video/webm', 'video/ogg',
    # iPhone 录屏/录像默认 .mov
    'video/quicktime', 'video/x-m4v',
    'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/flac',
    'audio/mp4', 'audio/x-m4a',
    'application/pdf',
}

_RANGE_UNSATISFIABLE = object()

# 扫码票据过期 / 已被扫过时的提示页。做成内联 HTML，不额外占文件。
QR_FAIL_HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0f1420">
<title>二维码已失效</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0f1420;color:#e6ecf5;padding:24px;
       font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .box{max-width:420px;width:100%;background:#161d2e;border:1px solid #2a3448;
       border-radius:16px;padding:28px 24px;text-align:center}
  .ico{font-size:40px;line-height:1;margin-bottom:14px}
  h1{font-size:19px;margin:0 0 10px}
  p{color:#8b9bb4;font-size:14px;margin:0 0 18px}
  a{display:inline-block;padding:12px 22px;border-radius:10px;
    background:#3d7eff;color:#fff;text-decoration:none;font-size:15px;font-weight:600}
  a:active{opacity:.85}
</style></head>
<body><div class="box">
  <div class="ico">⏳</div>
  <h1>这个二维码已经过期了</h1>
  <p>二维码只能用一次，10 分钟内有效。<br>请在电脑上重新点「手机扫码」，再用手机扫新的那张。</p>
  <a href="/">去输入 PIN 登录</a>
</div></body></html>"""

# 不同系统自带的 mime 表差异很大，Linux 上常认不出 HEIC / m4a。
# 显式注册一遍，保证 iPhone 拍的照片、录的音能正确 inline 预览而不会被强制下载。
for _ext, _type in (
    ('.heic', 'image/heic'), ('.heif', 'image/heif'),
    ('.mov', 'video/quicktime'), ('.m4v', 'video/x-m4v'),
    ('.m4a', 'audio/x-m4a'), ('.opus', 'audio/ogg'),
):
    mimetypes.add_type(_type, _ext)


def check_filename(name):
    """校验单个文件名。返回 (是否可用, 原因)。"""
    if not name or name in ('.', '..'):
        return False, '文件名为空或非法'
    if any(c in _BAD_NAME_CHARS for c in name):
        return False, '文件名包含非法字符 <>:"/\\|?*'
    stem = name.split('.')[0].strip().upper()
    if stem in _RESERVED_NAMES or name.strip().upper() in _RESERVED_NAMES:
        return False, '文件名与系统保留名冲突'
    if name != name.rstrip(' .'):
        return False, '文件名不能以空格或点结尾'
    return True, ''


def parse_range(header, size):
    """解析单段 Range 头。

    返回 (start, end) 闭区间；无法解析或无需分段返回 None；
    范围完全落在文件之外返回 _RANGE_UNSATISFIABLE（调用方回 416）。
    多段 Range 只取第一段，对局域网预览足够。
    """
    if not header or not header.lower().startswith('bytes='):
        return None
    spec = header[6:].strip()
    if ',' in spec:
        spec = spec.split(',', 1)[0].strip()
    if '-' not in spec:
        return None
    first, _, last = spec.partition('-')
    first, last = first.strip(), last.strip()
    try:
        if not first:                     # bytes=-500 表示最后 500 字节
            n = int(last)
            if n <= 0 or size == 0:
                return _RANGE_UNSATISFIABLE
            start, end = max(0, size - n), size - 1
        else:
            start = int(first)
            end = int(last) if last else size - 1
    except ValueError:
        return None
    if start < 0 or start > end or start >= size or size == 0:
        return _RANGE_UNSATISFIABLE
    return start, min(end, size - 1)


_FNAME_RE = re.compile(r'filename\*?=(?:UTF-8\'\')?("([^"]*)"|([^;\r\n]*))', re.IGNORECASE)


def parse_multipart(body, boundary):
    """解析 multipart/form-data，返回 [(文件名或 None, 数据 bytes), ...]"""
    delim = b'--' + boundary
    results = []
    for chunk in body.split(delim):
        if not chunk or chunk in (b'--', b'--\r\n', b'\r\n'):
            continue
        if chunk.startswith(b'\r\n'):
            chunk = chunk[2:]
        if not chunk.strip():
            continue
        sep = chunk.find(b'\r\n\r\n')
        if sep < 0:
            continue
        head = chunk[:sep].decode('utf-8', 'replace')
        data = chunk[sep + 4:]
        if data.endswith(b'\r\n'):
            data = data[:-2]
        filename = None
        m = _FNAME_RE.search(head)
        if m:
            filename = m.group(2) if m.group(2) is not None else m.group(3)
            filename = (filename or '').strip()
        results.append((filename, data))
    return results


def human_size(n):
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if n < 1024 or unit == 'TB':
            return f'{n:.0f} {unit}' if unit == 'B' else f'{n:.1f} {unit}'
        n /= 1024.0


class Handler(BaseHTTPRequestHandler):
    server_version = 'LanShare/2.0'
    protocol_version = 'HTTP/1.1'

    # ---------- 工具方法 ----------
    def _send(self, code, body=b'', content_type='application/json; charset=utf-8',
              extra_headers=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD' and body:
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def _err(self, code, msg):
        self._json(code, {'error': msg})

    def _read_json(self):
        try:
            length = max(0, int(self.headers.get('Content-Length') or 0))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b'{}'
        try:
            return json.loads(raw.decode('utf-8') or '{}')
        except Exception:
            return {}

    def log_message(self, fmt, *args):
        # 精简日志，避免刷屏
        sys.stderr.write('[%s] %s\n' % (datetime.now().strftime('%H:%M:%S'), fmt % args))

    def handle_one_request(self):
        # 客户端提前断开（刷新、取消下载等）属于正常现象，不输出堆栈
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True

    # ---------- 会话 / 客户端 ----------
    def client_ip(self):
        if CFG.get('trust_proxy'):
            fwd = self.headers.get('X-Forwarded-For')
            if fwd:
                return fwd.split(',')[0].strip()
            real = self.headers.get('CF-Connecting-IP') or self.headers.get('X-Real-IP')
            if real:
                return real.strip()
        return self.client_address[0]

    def cookie_token(self):
        raw = self.headers.get('Cookie') or ''
        for part in raw.split(';'):
            if '=' not in part:
                continue
            name, value = part.split('=', 1)
            if name.strip() == COOKIE_NAME:
                return value.strip()
        return None

    def is_authed(self):
        return verify_token(self.cookie_token())

    def check_auth(self, path):
        """返回 True 表示已放行；否则已写好响应并返回 False。"""
        if self.is_authed():
            return True
        # 允许未登录时访问的路径
        # /q/<票据> 是扫码入口，必须免登录，否则手机还没登录就进不来
        if path in ('/login.html', '/login.js', '/login.css',
                    '/api/login', '/api/auth-status', '/favicon.ico'):
            return True
        if path.startswith('/q/'):
            return True
        if path.startswith('/api/'):
            self._json(401, {'error': '未登录或登录已过期', 'needLogin': True})
        else:
            self.send_response(302)
            self.send_header('Location', '/login.html')
            self.send_header('Content-Length', '0')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
        return False

    def require_write(self):
        """只读模式下拦截写操作。"""
        if READ_ONLY:
            self._json(403, {'error': '当前为只读模式，不允许修改'})
            return False
        return True

    # ---------- 路由 ----------
    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)

        if not self.check_auth(path):
            return

        if path.startswith('/q/'):
            return self.handle_qr_login(path[len('/q/'):])
        if path == '/api/info':
            return self.api_info()
        if path == '/api/qr-ticket':
            return self.api_qr_ticket()
        if path == '/api/auth-status':
            return self.api_auth_status()
        if path in ('/api/files', '/api/list'):
            return self.api_list(query)
        if path.startswith('/api/read/'):
            return self.api_read(path[len('/api/read/'):])
        if path.startswith('/api/download/'):
            return self.api_download(path[len('/api/download/'):])
        if path.startswith('/api/zip/'):
            return self.api_zip(path[len('/api/zip/'):])
        if path.startswith('/shared/'):
            return self.serve_shared(path[len('/shared/'):])
        return self.serve_static(path)

    def do_HEAD(self):
        return self.do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == '/api/login':
            return self.api_login()
        if path == '/api/logout':
            return self.api_logout()

        if not self.check_auth(path):
            return
        if not self.require_write():
            return
        if path == '/api/upload':
            return self.api_upload()
        if path == '/api/folder':
            return self.api_mkdir()
        if path == '/api/file':
            return self.api_create_file()
        return self._err(404, '接口不存在')

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if not self.check_auth(path):
            return
        if not self.require_write():
            return
        if path.startswith('/api/read/'):
            return self.api_write(path[len('/api/read/'):])
        return self._err(404, '接口不存在')

    def do_DELETE(self):
        if not self.check_auth(unquote(urlparse(self.path).path)):
            return
        if not self.require_write():
            return
        return self.api_delete()

    # ---------- 登录 ----------
    def api_auth_status(self):
        self._json(200, {
            'authed': self.is_authed(),
            'readOnly': READ_ONLY,
            'lockedFor': locked_until(self.client_ip()),
        })

    def api_login(self):
        ip = self.client_ip()
        wait = locked_until(ip)
        if wait:
            return self._json(429, {
                'error': f'尝试次数过多，请 {wait} 秒后再试', 'retryAfter': wait})

        data = self._read_json()
        pin = str(data.get('pin') or '').strip()
        if not pin:
            return self._json(400, {'error': '请输入 PIN 码'})

        # compare_digest 不接受非 ASCII str，先编码成 bytes 才支持中文/emoji PIN
        if hmac.compare_digest(pin.encode('utf-8'), PIN.encode('utf-8')):
            _FAILS.pop(ip, None)
            return self._login_ok()

        record_failure(ip)
        left = MAX_ATTEMPTS - len(_FAILS.get(ip, []))
        if left <= 0:
            return self._json(429, {
                'error': f'错误次数过多，已锁定 {LOCK_SECONDS} 秒',
                'retryAfter': LOCK_SECONDS})
        return self._json(401, {'error': f'PIN 码不正确，还可尝试 {left} 次', 'remaining': left})

    def _login_ok(self, redirect_to=None):
        """发一张登录 Cookie。PIN 登录和扫码登录共用这一段。"""
        token = issue_token()
        cookie = f'{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL}'
        if CFG.get('cookie_secure') or CFG.get('https'):
            cookie += '; Secure'

        if redirect_to:
            # 扫码走浏览器跳转，直接 302 到首页
            self.send_response(302)
            self.send_header('Location', redirect_to)
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', '0')
        self.send_header('Set-Cookie', cookie)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()

    def handle_qr_login(self, ticket):
        """手机扫二维码打开 /q/<票据>：核销票据、发 Cookie、跳首页。

        票据是一次性的，用过就废。所以这链接不能反复用、也不能转发给别人。
        """
        if not qr_consume(unquote(ticket).strip()):
            # 过期或已用过：给一个能看懂的页面，而不是干巴巴的 404
            return self._send(410, QR_FAIL_HTML, 'text/html; charset=utf-8')

        ip = self.client_ip()
        _FAILS.pop(ip, None)   # 扫码等于证明「人就在电脑旁边」，清掉失败计数
        return self._login_ok(redirect_to='/')

    def api_logout(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', '0')
        self.send_header('Set-Cookie',
                         f'{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()

    # ---------- 静态资源 ----------
    def serve_static(self, path):
        if path == '/':
            path = '/index.html'
        try:
            fs_path = safe_join(PUBLIC_DIR, path.lstrip('/'))
        except PermissionError:
            return self._err(403, '禁止访问')
        if not os.path.isfile(fs_path):
            return self._send(404, '<h1>404 页面不存在</h1>', 'text/html; charset=utf-8')
        ctype = mimetypes.guess_type(fs_path)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'application/json'):
            ctype += '; charset=utf-8'
        with open(fs_path, 'rb') as f:
            return self._send(200, f.read(), ctype)

    def serve_shared(self, rel_path, as_attachment=False):
        try:
            fs_path = safe_join(SHARED_DIR, rel_path)
        except PermissionError:
            return self._err(403, '禁止访问')
        if not os.path.isfile(fs_path):
            return self._send(404, '文件不存在', 'text/plain; charset=utf-8')
        ctype = mimetypes.guess_type(fs_path)[0] or 'application/octet-stream'
        # 只有白名单类型才 inline，其余（html/svg/xml/js…）强制下载，堵存储型 XSS
        if not as_attachment and ctype not in SAFE_INLINE_TYPES:
            as_attachment = True
        size = os.path.getsize(fs_path)
        disposition = '%s; filename*=UTF-8\'\'%s' % (
            'attachment' if as_attachment else 'inline',
            quote(os.path.basename(fs_path)))

        rng = parse_range(self.headers.get('Range'), size)
        if rng is _RANGE_UNSATISFIABLE:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.send_header('Accept-Ranges', 'bytes')
            self.end_headers()
            return
        if rng:
            start, end = rng
            length = end - start + 1
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        else:
            start, length = 0, size
            self.send_response(200)

        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Disposition', disposition)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        if self.command == 'HEAD' or length <= 0:
            return
        # 分段读写：大文件不整体读进内存，客户端中断也能及时退出
        with open(fs_path, 'rb') as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def api_zip(self, rel_path):
        """把文件夹打包成 zip 下载"""
        try:
            fs_dir = safe_join(SHARED_DIR, rel_path)
        except PermissionError:
            return self._err(403, '禁止访问')
        if not os.path.isdir(fs_dir):
            return self._err(400, '不是文件夹')
        archive_name = (os.path.basename(fs_dir.rstrip(os.sep)) or '共享文件') + '.zip'
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.zip')
        tmp.close()
        try:
            with zipfile.ZipFile(tmp.name, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
                for root, _dirs, files in os.walk(fs_dir):
                    for fn in files:
                        full = os.path.join(root, fn)
                        arc = os.path.relpath(full, fs_dir).replace('\\', '/')
                        try:
                            zf.write(full, arc)
                        except OSError:
                            continue
            size = os.path.getsize(tmp.name)
            self.send_response(200)
            self.send_header('Content-Type', 'application/zip')
            self.send_header('Content-Length', str(size))
            self.send_header('Content-Disposition',
                             'attachment; filename*=UTF-8\'\'%s' % quote(archive_name))
            self.end_headers()
            if self.command != 'HEAD':
                with open(tmp.name, 'rb') as f:
                    shutil.copyfileobj(f, self.wfile)
        finally:
            try:
                os.remove(tmp.name)
            except OSError:
                pass

    # ---------- API ----------
    def api_info(self):
        self._json(200, {
            'host': HOST,
            'port': PORT,
            'sharedDir': os.path.basename(SHARED_DIR),
            'lanIps': [] if CFG.get('trust_proxy') else local_ips(),
            'readOnly': READ_ONLY,
        })

    def api_qr_ticket(self):
        """给电脑端页面生成一张扫码票据。只有已登录的人才能调，避免变成开放入口。"""
        self._json(200, {
            'ticket': qr_issue(),
            'ttl': QR_TTL,
        })

    def api_list(self, query):
        rel = (query.get('path') or [''])[0]
        try:
            fs_dir = safe_join(SHARED_DIR, rel)
        except PermissionError:
            return self._err(403, '禁止访问')
        if not os.path.exists(fs_dir):
            return self._err(404, '目录不存在')
        if not os.path.isdir(fs_dir):
            return self._err(400, '不是目录')

        items = []
        try:
            names = sorted(os.listdir(fs_dir), key=lambda s: (not os.path.isdir(os.path.join(fs_dir, s)), s.lower()))
        except PermissionError:
            return self._err(403, '无权限读取该目录')

        for name in names:
            full = os.path.join(fs_dir, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            is_dir = os.path.isdir(full)
            rel_path = posixpath.join(rel.replace('\\', '/'), name) if rel else name
            items.append({
                'name': name,
                'path': rel_path,
                'isDirectory': is_dir,
                'size': 0 if is_dir else st.st_size,
                'sizeText': '' if is_dir else human_size(st.st_size),
                'ext': '' if is_dir else (name.rsplit('.', 1)[-1].lower() if '.' in name else ''),
                'updatedAt': datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M'),
                'mtime': st.st_mtime,
            })
        self._json(200, {'path': rel.replace('\\', '/'), 'items': items})

    def api_read(self, rel):
        try:
            fs_path = safe_join(SHARED_DIR, rel)
        except PermissionError:
            return self._err(403, '禁止访问')
        if not os.path.isfile(fs_path):
            return self._err(404, '文件不存在')
        if os.path.getsize(fs_path) > 2 * 1024 * 1024:
            return self._err(413, '文件过大，请直接下载')
        try:
            with open(fs_path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
        except Exception as e:
            return self._err(500, f'读取失败: {e}')
        self._json(200, {'path': rel, 'content': content,
                         'name': os.path.basename(fs_path)})

    def api_write(self, rel):
        data = self._read_json()
        try:
            fs_path = safe_join(SHARED_DIR, rel)
        except PermissionError:
            return self._err(403, '禁止访问')
        if not os.path.isfile(fs_path):
            return self._err(404, '文件不存在')
        with open(fs_path, 'w', encoding='utf-8', newline='') as f:
            f.write(data.get('content', ''))
        self._json(200, {'ok': True})

    def api_download(self, rel):
        return self.serve_shared(rel, as_attachment=True)

    def api_mkdir(self):
        data = self._read_json()
        name = (data.get('name') or '').strip()
        parent = data.get('path') or ''
        if not name:
            return self._err(400, '请填写文件夹名称')
        ok, why = check_filename(name)
        if not ok:
            return self._err(400, f'文件夹名称不可用：{why}')
        try:
            target = safe_join(SHARED_DIR, parent, name)
        except PermissionError:
            return self._err(403, '禁止访问')
        if os.path.exists(target):
            return self._err(400, '同名文件或文件夹已存在')
        os.makedirs(target, exist_ok=True)
        self._json(200, {'ok': True, 'path': posixpath.join(parent.replace('\\', '/'), name)})

    def api_create_file(self):
        data = self._read_json()
        name = (data.get('name') or '').strip()
        parent = data.get('path') or ''
        content = data.get('content') or ''
        if not name:
            return self._err(400, '请填写文件名')
        if '.' not in name:
            name += '.txt'
        ok, why = check_filename(name)
        if not ok:
            return self._err(400, f'文件名不可用：{why}')
        try:
            target = safe_join(SHARED_DIR, parent, name)
        except PermissionError:
            return self._err(403, '禁止访问')
        if os.path.exists(target):
            return self._err(400, '同名文件已存在')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'w', encoding='utf-8', newline='') as f:
            f.write(content)
        self._json(200, {'ok': True, 'path': posixpath.join(parent.replace('\\', '/'), name)})

    def api_upload(self):
        ctype = self.headers.get('Content-Type', '')
        if not ctype.startswith('multipart/form-data'):
            return self._err(400, '请使用表单上传')
        try:
            length = max(0, int(self.headers.get('Content-Length') or 0))
        except ValueError:
            length = 0
        if length > MAX_UPLOAD:
            return self._err(413, '文件过大（上限 500MB）')

        # 目标子目录通过查询参数传入
        query = parse_qs(urlparse(self.path).query)
        rel_dir = (query.get('path') or [''])[0]

        boundary = None
        for seg in ctype.split(';'):
            seg = seg.strip()
            if seg.lower().startswith('boundary='):
                boundary = seg[len('boundary='):].strip('"')
                break
        if not boundary:
            return self._err(400, '上传格式错误')

        body = self.rfile.read(length)
        saved = []
        skipped = []
        for filename, data in parse_multipart(body, boundary.encode('utf-8', 'replace')):
            if not filename:
                continue
            # 关键：Windows 下 os.path.basename('a:b.txt') 会返回 'b.txt'，
            # 冒号被静默截断，导致校验漏掉非法字符。所以必须先用原始名查非法字符，
            # 再去目录前缀。
            if any(ch in filename for ch in _BAD_NAME_CHARS):
                skipped.append(f'{filename}: 文件名包含非法字符 <>:"/\\|?*')
                continue
            # 去掉浏览器可能带上的目录前缀，再统一校验文件名
            filename = os.path.basename(filename.replace('\\', '/')).strip()
            ok, why = check_filename(filename)
            if not ok:
                skipped.append(f'{filename or "(空名)"}: {why}')
                continue
            try:
                target = safe_join(SHARED_DIR, rel_dir, filename)
            except PermissionError:
                skipped.append(f'{filename}: 目标路径越界')
                continue
            # 重名自动加序号
            base, ext = os.path.splitext(target)
            idx = 1
            while os.path.exists(target):
                target = f'{base} ({idx}){ext}'
                idx += 1
            try:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, 'wb') as out:
                    out.write(data)
            except OSError as e:
                # 单个文件写失败不影响同批其他文件
                skipped.append(f'{filename}: {e.strerror or e}')
                continue
            saved.append({'name': os.path.basename(target),
                          'size': len(data),
                          'sizeText': human_size(len(data))})
        if not saved:
            msg = '没有收到有效文件'
            if skipped:
                msg += '（' + '；'.join(skipped[:3]) + '）'
            return self._err(400, msg)
        self._json(200, {'ok': True, 'files': saved, 'skipped': skipped})

    def api_delete(self):
        data = self._read_json()
        rel = data.get('path') or ''
        if not rel:
            return self._err(400, '缺少路径')
        try:
            target = safe_join(SHARED_DIR, rel)
        except PermissionError:
            return self._err(403, '禁止访问')
        if os.path.realpath(target) == os.path.realpath(SHARED_DIR):
            return self._err(400, '不能删除共享根目录')
        if not os.path.exists(target):
            return self._err(404, '不存在')
        if os.path.isdir(target):
            shutil.rmtree(target)
        else:
            os.remove(target)
        self._json(200, {'ok': True})


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    # Windows 的 SO_REUSEADDR 语义和 Unix 不同：它允许多个进程同时绑同一端口
    # （结果是两个服务抢请求，用户看到「文件一会儿有一会儿没有」这种鬼现象），
    # 所以这里在 Windows 上必须关掉，让第二次启动干脆地失败。
    # Unix 上保留，避免刚关就重启时被 TIME_WAIT 卡住。
    allow_reuse_address = os.name != 'nt'


def local_ips():
    """返回本机局域网 IPv4 列表，真实局域网地址排在虚拟网卡前面。

    Radmin VPN / VMware / VirtualBox 这类虚拟网卡也常有 IPv4，
    如果把它们的地址排第一，用户「复制访问地址」拿到的手机根本连不上。
    """
    import ipaddress
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith('127.'):
                ips.append(ip)
    except Exception:
        pass

    def rank(ip):
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return 9
        if ip.startswith('192.168.'):
            return 0                      # 家用路由器最常见
        if ip.startswith('10.'):
            return 1                      # 企业 / 校园网
        if addr.is_private and ip.startswith('172.'):
            try:
                second = int(ip.split('.')[1])
            except (ValueError, IndexError):
                return 3
            return 2 if 16 <= second <= 31 else 8   # 172.16-31 是私有段
        if addr.is_private:
            return 5                      # 100.64/10 等运营商级 NAT
        return 6                          # 公网地址
    return sorted(ips, key=rank)


def main():
    try:
        httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        # 最常见的一种：上一个窗口没关，又双击了一次
        if getattr(e, 'errno', None) in (48, 98, 10048) or 'in use' in str(e).lower():
            fatal(
                f'\n[错误] 端口 {PORT} 已经被占用了。\n'
                '       多半是程序已经在运行——找找任务栏 / 桌面上有没有已经打开的黑色窗口，\n'
                '       有的话直接用它就行，不要重复启动。\n'
                '       如果确认没开，可能是别的软件占了这个端口，可以改端口启动：\n'
                f'         在命令提示符里执行：set PORT=8081 && LanShare.exe\n')
        fatal(f'\n[错误] 无法启动服务：{e}\n')

    scheme = 'http'
    if CFG.get('https'):
        cert = os.path.join(BASE_DIR, CFG.get('cert_file') or 'cert.pem')
        key = os.path.join(BASE_DIR, CFG.get('key_file') or 'key.pem')
        if os.path.isfile(cert) and os.path.isfile(key):
            import ssl
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            ctx.load_cert_chain(cert, key)
            httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
            scheme = 'https'
        else:
            fatal(
                '\n[错误] 配置要求启用 HTTPS，但没找到证书文件：\n'
                f'       证书: {cert}\n       私钥: {key}\n'
                '       请把证书放到上述位置，或把 config.json 的 "https" 改为 false。\n')

    ips = [] if CFG.get('trust_proxy') else local_ips()
    lan_url = f'{scheme}://{ips[0]}:{PORT}' if ips else None
    local_url = f'{scheme}://localhost:{PORT}'

    # 窗口标题带上地址，任务栏里一眼能认出来
    set_title(f'局域网文件共享 - {lan_url or local_url}')

    print('=' * 56)
    print('  局域网文件共享')
    print('=' * 56)
    print(f'  共享目录 : {SHARED_DIR}')
    print(f'  访问 PIN : {PIN}')
    if lan_url:
        # 手机要连的就是这一行，加粗显示，别让人再从一堆输出里找
        print(f'  手机访问 : {lan_url}')
    for ip in ips[1:]:
        print(f'  备用地址 : {scheme}://{ip}:{PORT}')
    print(f'  本机访问 : {local_url}')
    if READ_ONLY:
        print('  运行模式 : 只读（只能浏览和下载）')
    print('=' * 56)
    if _FALLBACK_DIR:
        print(f'  程序所在位置不可写，数据改存在：{DATA_DIR}')
    if lan_url:
        print('  手机连同一个 WiFi，扫电脑页面上的二维码即可进入，不用输地址。')
    print('  关闭这个窗口 = 停止服务')
    if scheme == 'http':
        print('  注意：当前是 HTTP 明文传输，公网部署请启用 HTTPS（见 README）。')
    print('=' * 56)
    # 输出被重定向到文件/管道时 Python 会改成块缓冲，横幅会卡在缓冲区里不显示，
    # 用户会以为「点了没反应」。这里强制刷一次。
    try:
        sys.stdout.flush()
    except Exception:
        pass

    # 自动开浏览器：小白不用自己去地址栏敲 localhost:8080
    if not os.environ.get('LANSHARE_NO_BROWSER'):
        try:
            import webbrowser
            webbrowser.open(local_url)
        except Exception:
            pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n服务已停止')
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()