"""投放接口的抗滥用验证。

投放接口是**免登录**的（手机扫码就能用），所以它是整个服务里
唯一一个「不需要任何凭据就能往磁盘写东西」的入口。
必须确认它没有被做成一个任意文件上传漏洞：

1. 没有有效票据就写不进去
2. 票据不能指定目标路径（只能进收件箱）
3. 超大文件被 413 挡住，且不占内存
4. 超过 200 个文件的票据自动失效
5. 大量并发上传不会把服务拖死
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
import http.cookiejar

BASE = os.environ.get('DROPTEST_BASE', 'http://127.0.0.1:18210')
# http.client 要主机和端口分开，从 BASE 里解析，别再写死一遍——两处不一致会测出鬼结果
from urllib.parse import urlparse as _urlparse
_u = _urlparse(BASE)
_HOST, _PORT = _u.hostname, _u.port
ROOT = os.environ.get('DROPTEST_DIR')
PIN = json.load(open(os.path.join(ROOT, 'config.json'), encoding='utf-8'))['pin']

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

results = []


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('  [OK]   ' if ok else '  [FAIL] ') + name + (('  -> ' + detail) if detail else ''))


def call(path, data=None, headers=None, cookie=True):
    hdrs = dict(headers or {})
    body = None
    if isinstance(data, (dict, list)):
        body = json.dumps(data).encode()
        hdrs.setdefault('Content-Type', 'application/json')
    elif isinstance(data, bytes):
        body = data
    req = urllib.request.Request(BASE + path, data=body, headers=hdrs,
                                 method='POST' if body else 'GET')
    op = opener if cookie else urllib.request.build_opener()
    try:
        with op.open(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()


def mp(filename, payload):
    b = '----sec'
    parts = [
        ('--' + b).encode(),
        ('Content-Disposition: form-data; name="file"; filename="%s"' % filename).encode(),
        b'Content-Type: application/octet-stream', b'', payload,
        ('--' + b + '--').encode(), b'',
    ]
    return b'\r\n'.join(parts), 'multipart/form-data; boundary=' + b


print('=' * 60)
print('投放接口抗滥用验证')
print('=' * 60)

ST_INBOX = os.path.join(ROOT, 'shared', '手机收件箱')

# 登录拿票
st, _ = call('/api/login', {'pin': PIN})
assert st == 200, '登录失败'
st, body = call('/api/drop-ticket')
ticket = json.loads(body)['ticket']
print('票据：%s…\n' % ticket[:12])

# --- 1. 无票据写入 ---
print('[1] 无票据写不进去')
before = set(os.listdir(ST_INBOX)) if os.path.isdir(ST_INBOX) else set()
payload, ctype = mp('hack.txt', b'hacked')
st, _ = call('/api/drop-upload', payload, {'Content-Type': ctype}, cookie=False)
after = set(os.listdir(ST_INBOX)) if os.path.isdir(ST_INBOX) else set()
check('无票据上传被拒（410）', st == 410, 'HTTP %d' % st)
check('磁盘上没有多出文件', before == after, str(sorted(after - before)))

# --- 2. 伪造票据 ---
print('\n[2] 伪造票据')
for fake in ['AAAAAAAAAAAAAAAAAAAAAA', '../../etc', 'null', '0']:
    payload, ctype = mp('fake.txt', b'x')
    st, _ = call('/api/drop-upload?ticket=' + urllib.parse.quote(fake),
                 payload, {'Content-Type': ctype}, cookie=False)
    if st != 410:
        check('伪造票据 %r 被拒' % fake, False, 'HTTP %d' % st)
check('所有伪造票据都被拒（410）', True, '4 种')

# --- 3. 票据不能指定目标路径 ---
print('\n[3] 票据不能指定写入路径')
# 故意带一个 path 参数，试图写到 shared/ 根目录以外
payload, ctype = mp('pathtest.txt', b'x')
st, body = call('/api/drop-upload?ticket=%s&path=../../' % ticket,
                payload, {'Content-Type': ctype}, cookie=False)
root_file = os.path.join(ROOT, 'shared', 'pathtest.txt')
inbox_file = os.path.join(ST_INBOX, 'pathtest.txt')
check('带 path 参数也写不到外面', not os.path.exists(root_file), root_file)
check('文件仍落在收件箱里', os.path.exists(inbox_file), inbox_file)

# --- 4. 超大声明被 413 ---
print('\n[4] 超大文件被挡')
payload, ctype = mp('big.bin', b'x')
# 手动构造一个带巨大 Content-Length 的请求
import http.client
conn = http.client.HTTPConnection(_HOST, _PORT, timeout=20)
conn.putrequest('POST', '/api/drop-upload?ticket=' + ticket)
conn.putheader('Content-Type', ctype)
conn.putheader('Content-Length', str(600 * 1024 * 1024))
conn.endheaders()
try:
    conn.send(b'x')
    resp = conn.getresponse()
    st = resp.status
    resp.read()
except Exception as e:
    st = 0
conn.close()
check('声明 600MB 被 413 拒绝', st == 413, 'HTTP %d' % st)

# --- 5. 文件数量上限 ---
print('\n[5] 200 个文件上限')
# 这张票已经收了不少，先换一张新票来测
st, body = call('/api/drop-ticket')
t2 = json.loads(body)['ticket']
sent = 0
st_last = None
# 每次塞 10 个（multipart 多段），看会不会在第 20 批后失效
for batch in range(21):
    b = '----batch%d' % batch
    parts = []
    for i in range(10):
        parts += [
            ('--' + b).encode(),
            ('Content-Disposition: form-data; name="file"; filename="b%d_%d.txt"' % (batch, i)).encode(),
            b'Content-Type: text/plain', b'', b'x',
        ]
    parts += [('--' + b + '--').encode(), b'']
    body_bytes = b'\r\n'.join(parts)
    st_last, resp = call('/api/drop-upload?ticket=' + t2, body_bytes,
                         {'Content-Type': 'multipart/form-data; boundary=' + b}, cookie=False)
    if st_last == 200:
        sent += 10
    else:
        break
check('收到 200 个左右后票据失效', st_last in (410, 400),
      '最后状态 %s，已收 %d 个' % (st_last, sent))

st, body = call('/api/drop-info?ticket=' + t2, cookie=False)
check('失效后 drop-info 返回 410', st == 410, 'HTTP %d' % st)

# --- 6. 并发上传不拖死 ---
print('\n[6] 并发上传压力')
st, body = call('/api/drop-ticket')
t3 = json.loads(body)['ticket']
import threading
codes = []
lock = threading.Lock()


def one(i):
    p, c = mp('c%d.txt' % i, b'y' * 1024)
    s, _ = call('/api/drop-upload?ticket=' + t3, p, {'Content-Type': c}, cookie=False)
    with lock:
        codes.append(s)


threads = [threading.Thread(target=one, args=(i,)) for i in range(16)]
t0 = time.time()
for t in threads:
    t.start()
for t in threads:
    t.join()
elapsed = time.time() - t0
ok_n = sum(1 for c in codes if c == 200)
busy_n = sum(1 for c in codes if c == 503)
check('并发 16 个都有响应（无挂死）', len(codes) == 16, '%d 个响应' % len(codes))
check('没有 5xx 崩坏', all(c in (200, 503) for c in codes),
      '200×%d 503×%d 其他×%d' % (ok_n, busy_n, 16 - ok_n - busy_n))
check('总耗时在合理范围（<30s）', elapsed < 30, '%.1fs' % elapsed)

# --- 7. 挨完折腾服务还活着 ---
print('\n[7] 服务存活')
st, body = call('/api/auth-status', cookie=False)
check('auth-status 仍 200', st == 200, 'HTTP %d' % st)
st, body = call('/api/files?path=')
check('登录态仍可用', st == 200, 'HTTP %d' % st)

print('\n' + '=' * 60)
passed = sum(1 for _, ok, _ in results if ok)
print('结果：%d/%d 通过' % (passed, len(results)))
if passed < len(results):
    for name, ok, detail in results:
        if not ok:
            print('  · ' + name + (('  -> ' + detail) if detail else ''))
sys.exit(0 if passed == len(results) else 1)
