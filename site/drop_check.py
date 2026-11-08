"""收件箱（手机 → 电脑）功能验证。

覆盖：
1. 未登录不能拿投放票据
2. 登录后能拿到票据，票据可用于访问 /d/<ticket>
3. 无效票据访问 /d/ 返回 410 提示页
4. 手机端上传文件成功，落到「手机收件箱」子目录
5. 票据可重复使用（连传多次都行）
6. 投放票据不能读文件（/api/list 仍然要求登录）
7. 票据不能用于上传到任意路径（只会进收件箱）
8. 无票据调用上传接口被拒
9. drop-info 不泄露文件信息
"""
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error
import http.cookiejar

# 端口可覆盖：exe 首启验证时会跑在别的端口上，写死 18210 就会打到上一个进程身上，
# 表现是「登录 401」，很容易误判成鉴权坏了。
BASE = os.environ.get('DROPTEST_BASE', 'http://127.0.0.1:18210')
_INBOX_ROOT = os.environ.get('DROPTEST_DIR', '/tmp/droptest')
PIN = None
_log = os.path.join(_INBOX_ROOT, 'run.log')
# run.log 里可能混着上一次、甚至别的端口那次的启动横幅，PIN 未必是当前这个进程的。
# 所以以 config.json 为准，run.log 只在读不到 config 时兜底。
try:
    PIN = json.load(open(os.path.join(_INBOX_ROOT, 'config.json'), encoding='utf-8'))['pin']
except (OSError, ValueError, KeyError):
    pass
if not PIN and os.path.isfile(_log):
    for line in open(_log, encoding='utf-8', errors='replace'):
        if '访问 PIN' in line:
            PIN = line.split(':')[-1].strip()
if not PIN:
    raise SystemExit('拿不到 PIN：确认 DROPTEST_DIR 指向一个已初始化过的运行目录')

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

results = []


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('  [OK]   ' if ok else '  [FAIL] ') + name + (('  -> ' + detail) if detail else ''))


def req(path, data=None, headers=None, method=None, use_cookie=True):
    url = BASE + path
    body = None
    hdrs = dict(headers or {})
    if data is not None:
        if isinstance(data, (dict, list)):
            body = json.dumps(data).encode()
            hdrs.setdefault('Content-Type', 'application/json')
        else:
            body = data
    r = urllib.request.Request(url, data=body, headers=hdrs,
                               method=method or ('POST' if body else 'GET'))
    op = opener if use_cookie else urllib.request.build_opener()
    try:
        with op.open(r, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def multipart(field, filename, payload):
    boundary = '----dropcheck'
    parts = [
        ('--' + boundary).encode(),
        ('Content-Disposition: form-data; name="%s"; filename="%s"' % (field, filename)).encode(),
        b'Content-Type: application/octet-stream',
        b'',
        payload,
        ('--' + boundary + '--').encode(),
        b'',
    ]
    return b'\r\n'.join(parts), 'multipart/form-data; boundary=' + boundary


print('=' * 60)
print('收件箱（手机 → 电脑）功能验证')
print('=' * 60)

# --- 1. 未登录拿不到票据 ---
print('\n[1] 未登录不能生成票据')
st, body = req('/api/drop-ticket', use_cookie=False)
check('未登录 /api/drop-ticket 被拒（401）', st == 401, 'HTTP %d' % st)

# --- 2. 登录 ---
print('\n[2] PIN 登录')
st, body = req('/api/login', {'pin': PIN})
check('登录成功', st == 200, 'HTTP %d' % st)

# --- 3. 拿到票据 ---
print('\n[3] 生成投放票据')
st, body = req('/api/drop-ticket')
ok = st == 200
ticket = None
if ok:
    d = json.loads(body)
    ticket = d.get('ticket')
    ok = bool(ticket) and d.get('ttl') == 7200 and d.get('maxFiles') == 200
check('拿到票据 + TTL 7200 + 上限 200', ok,
      'ttl=%s maxFiles=%s' % (json.loads(body).get('ttl') if st == 200 else '?',
                              json.loads(body).get('maxFiles') if st == 200 else '?'))

# --- 4. 无效票据的投放页 ---
print('\n[4] 无效票据边界')
st, body = req('/d/not-a-real-ticket', use_cookie=False)
check('无效票据 /d/ 返回 410', st == 410, 'HTTP %d' % st)
check('410 页面提示重新出码', '重新' in body.decode('utf-8', 'replace'))

# --- 5. 有效票据的投放页 ---
print('\n[5] 有效票据打开投放页')
st, body = req('/d/' + ticket, use_cookie=False)
txt = body.decode('utf-8', 'replace')
check('投放页 200', st == 200, 'HTTP %d' % st)
check('票据已注入页面（无占位符残留）',
      '{{DROP_TICKET}}' not in txt and ticket in txt)
check('页面含「选择照片或文件」', '选择照片或文件' in txt)
check('页面含拍照入口', 'capture="environment"' in txt)

# --- 6. 无票据上传被拒 ---
print('\n[6] 无票据上传被拒')
payload, ctype = multipart('file', 'x.txt', b'no ticket')
st, body = req('/api/drop-upload', payload, {'Content-Type': ctype}, use_cookie=False)
check('无票据上传返回 410', st == 410, 'HTTP %d' % st)

# --- 7. 正常上传 ---
print('\n[7] 手机上传文件')
payload, ctype = multipart('file', '手机照片测试.txt', '这是从手机发来的内容'.encode())
st, body = req('/api/drop-upload?ticket=' + ticket, payload,
               {'Content-Type': ctype}, use_cookie=False)
ok = st == 200
d = json.loads(body) if ok else {}
check('上传成功（免登录）', ok, 'HTTP %d %s' % (st, body[:120].decode('utf-8', 'replace')))
check('返回 sent=1', d.get('sent') == 1, 'sent=%s' % d.get('sent'))

inbox = os.path.join(_INBOX_ROOT, 'shared', '手机收件箱')
exists = os.path.isdir(inbox)
check('落盘到「手机收件箱」子目录', exists)
if exists:
    files = os.listdir(inbox)
    check('文件确实写进去了', '手机照片测试.txt' in files, str(files))
    if '手机照片测试.txt' in files:
        content = open(os.path.join(inbox, '手机照片测试.txt'), encoding='utf-8').read()
        check('内容一致', content == '这是从手机发来的内容', repr(content))

# --- 8. 票据可重复使用 ---
print('\n[8] 票据可重复使用（多人/多批次）')
payload, ctype = multipart('file', '第二批.dat', b'batch-2')
st, body = req('/api/drop-upload?ticket=' + ticket, payload,
               {'Content-Type': ctype}, use_cookie=False)
d = json.loads(body) if st == 200 else {}
check('第二批次上传成功', st == 200, 'HTTP %d' % st)
check('sent 累加到 2', d.get('sent') == 2, 'sent=%s' % d.get('sent'))

# --- 9. 重名自动加序号 ---
print('\n[9] 重名文件自动改名')
payload, ctype = multipart('file', '手机照片测试.txt', '第二份同名'.encode())
st, body = req('/api/drop-upload?ticket=' + ticket, payload,
               {'Content-Type': ctype}, use_cookie=False)
files = os.listdir(inbox) if exists else []
check('同名不覆盖，生成了新名字',
      st == 200 and any('(1)' in f for f in files), str(sorted(files)))

# --- 10. 投放票据不能读文件 ---
print('\n[10] 最小权限：票据不能读')
st, body = req('/api/files?path=', use_cookie=False)
check('无登录态不能列目录（401）', st == 401, 'HTTP %d' % st)
st, body = req('/api/drop-info?ticket=' + ticket, use_cookie=False)
ok = st == 200 and json.loads(body).get('ok') is True
check('drop-info 可用', ok)
raw = body.decode('utf-8', 'replace')
check('drop-info 不含任何文件名', '手机照片测试' not in raw and '第二批' not in raw, raw[:200])

# --- 11. 非法文件名 ---
print('\n[11] 非法文件名被拦')
payload, ctype = multipart('file', 'bad:name.txt', b'x')
st, body = req('/api/drop-upload?ticket=' + ticket, payload,
               {'Content-Type': ctype}, use_cookie=False)
txt = body.decode('utf-8', 'replace')
check('含非法字符的文件被跳过或拒绝', st in (400,) or 'skipped' in txt,
      'HTTP %d %s' % (st, txt[:160]))

# --- 12. 路径穿越 ---
print('\n[12] 路径穿越尝试')
payload, ctype = multipart('file', '../../evil.txt', b'x')
st, body = req('/api/drop-upload?ticket=' + ticket, payload,
               {'Content-Type': ctype}, use_cookie=False)
escaped = os.path.exists(os.path.join(_INBOX_ROOT, 'evil.txt')) or os.path.exists('/tmp/evil.txt')
check('没有写到收件箱外面', not escaped,
      'HTTP %d' % st)

# --- 13. 主站未受影响 ---
print('\n[13] 原有功能未受影响')
st, body = req('/api/files?path=')
check('登录后列目录正常（200）', st == 200, 'HTTP %d' % st)
st, body = req('/')
check('首页 200', st == 200, 'HTTP %d' % st)
st, body = req('/api/qr-ticket')
check('扫码头像票据仍可用', st == 200 and 'ticket' in json.loads(body), 'HTTP %d' % st)

print('\n' + '=' * 60)
passed = sum(1 for _, ok, _ in results if ok)
total = len(results)
print('结果：%d/%d 通过' % (passed, total))
if passed < total:
    print('\n失败项：')
    for name, ok, detail in results:
        if not ok:
            print('  · ' + name + (('  -> ' + detail) if detail else ''))
sys.exit(0 if passed == total else 1)
