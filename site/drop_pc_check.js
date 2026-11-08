/**
 * 电脑端「收件箱」弹窗验证。
 *
 * 要看的是：
 *   · 「📥 收件箱」按钮在桌面可见、点得开
 *   · 弹窗里有二维码、地址、等待状态条
 *   · 手机真发了一个文件后，电脑的弹窗能自动变成「已收到 1 个」
 *   · 关掉弹窗后轮询要停，不能一直打请求
 */
const { chromium } = require(
  'E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 端口别写死：exe 首启验证跑在别的端口上时，写死会打到上一个进程身上，
// 症状是 waitForURL 超时或登录 401，很容易被当成功能坏了。
const BASE = process.env.DROP_BASE || process.argv[2] || 'http://127.0.0.1:18210';
const PIN = process.env.DROP_PIN;

async function main() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? '  [OK]   ' : '  [FAIL] ') + name + (detail ? '  -> ' + detail : ''));
  };

  const browser = await chromium.launch({ channel: 'msedge' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  // ---- 登录 ----
  console.log('[1] 登录并进入首页');
  await p.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
  await p.fill('.pin-input', PIN);
  await p.click('button[type=submit], #btnLogin, .btn-login');
  await p.waitForURL(BASE + '/', { timeout: 10000 });
  check('登录后进入首页', p.url().replace(BASE, '') === '/', p.url());

  // ---- 按钮存在 ----
  console.log('\n[2] 「收件箱」按钮');
  const btn = p.locator('#btnDrop');
  check('按钮存在', await btn.count() === 1);
  check('按钮在桌面可见', await btn.isVisible());
  check('按钮文案含「收件箱」', (await btn.textContent()).includes('收件箱'),
        (await btn.textContent()).trim());

  // ---- 打开弹窗 ----
  console.log('\n[3] 打开收件箱弹窗');
  await btn.click();
  await p.waitForSelector('#modal.show', { timeout: 5000 });
  check('弹窗已打开', await p.locator('#modal').evaluate((n) => n.classList.contains('show')));
  check('标题是「收件箱」',
        (await p.locator('#modalTitle').textContent()).trim() === '收件箱',
        await p.locator('#modalTitle').textContent());
  check('有二维码 SVG', await p.locator('#modalBody .qr-img svg').count() === 1);
  check('提示 2 小时内可反复用',
        (await p.locator('#modalBody').textContent()).includes('2 小时内可以反复用'));
  check('提示上限 200 个',
        (await p.locator('#modalBody').textContent()).includes('200'));
  check('有等待状态条', await p.locator('#dropLive').count() === 1);

  const liveText = await p.locator('#dropLiveText').textContent();
  check('状态条初始文案正确', liveText.includes('正在等手机发送'), liveText.trim());

  // 从弹窗里抠出投放链接（等于手机扫到的东西）
  const dropUrl = (await p.locator('#modalBody .qr-url code').textContent()).trim();
  check('地址形如 /d/<ticket>', /\/d\/[A-Za-z0-9_-]{10,}$/.test(dropUrl), dropUrl);
  const ticket = dropUrl.split('/d/')[1];

  // ---- 模拟手机发一个文件 ----
  console.log('\n[4] 模拟手机发送文件');
  const tmp = path.join(os.tmpdir(), '电脑端弹窗测试.txt');
  fs.writeFileSync(tmp, '手机发来的文件', 'utf8');
  const buf = fs.readFileSync(tmp);
  const boundary = '----pctest';
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\n'),
    Buffer.from('Content-Disposition: form-data; name="file"; filename="电脑端弹窗测试.txt"\r\n'),
    Buffer.from('Content-Type: text/plain\r\n\r\n'),
    buf,
    Buffer.from('\r\n--' + boundary + '--\r\n'),
  ]);
  const up = await fetch(BASE + '/api/drop-upload?ticket=' + ticket, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body,
  });
  check('上传返回 200', up.status === 200, 'HTTP ' + up.status);

  // 等弹窗自己轮询到（2 秒一轮，给 8 秒余量）
  console.log('\n[5] 弹窗自动感知');
  let sensed = false;
  try {
    await p.waitForFunction(() => {
      const n = document.getElementById('dropLiveText');
      return n && n.textContent.includes('已收到');
    }, { timeout: 9000 });
    sensed = true;
  } catch (_) {}
  const after = await p.locator('#dropLiveText').textContent();
  check('弹窗提示「已收到」', sensed, after.trim());
  check('数量是 1', after.includes('1'), after.trim());

  // 列表也刷新过（新文件应该出现在页面里）
  const inList = await p.locator('.list').textContent();
  check('列表里出现了「手机收件箱」文件夹', inList.includes('手机收件箱'));

  // ---- 关掉弹窗，轮询要停 ----
  console.log('\n[6] 关闭弹窗');
  let dropInfoCalls = 0;
  p.on('request', (r) => { if (r.url().includes('/api/drop-info')) dropInfoCalls++; });
  await p.locator('#modalActions .btn.primary').click();
  await p.waitForTimeout(300);
  check('弹窗已关闭', !(await p.locator('#modal').evaluate((n) => n.classList.contains('show'))));
  await p.waitForTimeout(5000);   // 关掉后再观察 5 秒，本该 2-3 次请求
  check('关掉后不再轮询 drop-info', dropInfoCalls === 0, dropInfoCalls + ' 次请求');

  check('页面无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();

  const passed = results.filter((r) => r.ok).length;
  console.log('\n' + '='.repeat(56));
  console.log('结果：' + passed + '/' + results.length + ' 通过');
  if (passed < results.length) {
    console.log('\n失败项：');
    results.filter((r) => !r.ok).forEach((r) =>
      console.log('  · ' + r.name + (r.detail ? '  -> ' + r.detail : '')));
  }
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e.message);
  process.exit(1);
});
