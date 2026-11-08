/**
 * 用真实浏览器（iPhone 视口）验证手机投放页。
 * drop_check.py 已经证明接口能通，这里要看的是「人用起来怎么样」：
 *   · 按钮够不够大、点得到吗
 *   · 选完文件是否自动开始传、进度条动没动
 *   · 传完有没有明确反馈
 *   · 有没有横向溢出（手机上最烦的就是这个）
 */
const { chromium, devices } = require(
  'E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core');

const BASE = process.env.DROP_BASE || process.argv[2] || 'http://127.0.0.1:18210';
const PIN = process.env.DROP_PIN;

if (!PIN) {
  console.error('缺少 DROP_PIN 环境变量');
  process.exit(2);
}

async function main() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? '  [OK]   ' : '  [FAIL] ') + name + (detail ? '  -> ' + detail : ''));
  };

  // ---- 用 API 登录拿 Cookie，再生成一张投放票 ----
  const login = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: PIN }),
  });
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie')])
    .filter(Boolean).map((c) => c.split(';')[0]).join('; ');

  const tik = await fetch(BASE + '/api/drop-ticket', { headers: { Cookie: cookie } });
  const { ticket } = await tik.json();
  const dropUrl = BASE + '/d/' + ticket;
  console.log('\n票据：' + ticket.slice(0, 12) + '…');

  const browser = await chromium.launch({
    channel: 'msedge',
    args: ['--disable-web-security=false'],
  });

  // ========== A. iPhone 视口 ==========
  console.log('\n[A] iPhone 视口（390×844，DPR 3）');
  const iphone = await browser.newContext({
    ...devices['iPhone 13'],
    acceptDownloads: true,
  });
  const p = await iphone.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await p.goto(dropUrl, { waitUntil: 'networkidle' });

  check('页面标题是「发到电脑」', (await p.title()).includes('发到电脑'),
        await p.title());
  check('主标题可见', await p.locator('h1').first().isVisible());

  // 主按钮尺寸：手指要能轻松点到
  const pickBox = await p.locator('#btnPick').boundingBox();
  check('主按钮高度 ≥ 88px（好按）', pickBox && pickBox.height >= 88,
        pickBox ? Math.round(pickBox.width) + '×' + Math.round(pickBox.height) : '未找到');
  check('主按钮宽度接近满宽', pickBox && pickBox.width > 300,
        pickBox ? Math.round(pickBox.width) + 'px' : '未找到');

  // 次要按钮（拍照/录像）也要够高
  const subBox = await p.locator('#btnPhoto').boundingBox();
  check('拍照按钮高度 ≥ 44px', subBox && subBox.height >= 44,
        subBox ? Math.round(subBox.height) + 'px' : '未找到');

  // 横向溢出检查
  const overflow = await p.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('没有横向溢出', overflow <= 1, '溢出 ' + overflow + 'px');

  // 服务端连通性：页面自己会去查票据
  await p.waitForTimeout(600);
  const stateText = await p.locator('#ticketState').textContent();
  check('页脚显示了票据状态', !!stateText && stateText.trim().length > 0, stateText.trim());
  check('状态提示「就绪」', (stateText || '').includes('就绪'), stateText.trim());
  check('目标目录显示为「手机收件箱」',
        (await p.locator('#whereName').textContent()).includes('手机收件箱'),
        await p.locator('#whereName').textContent());

  // ---- 真实上传：塞一个文件进 input，走完整 JS 流程 ----
  console.log('\n[B] 真实上传流程');
  const tmpFile = require('path').join(
    require('os').tmpdir(), '手机端UI测试.txt');
  fs.writeFileSync(tmpFile, '这是 iPhone 视口下真实上传的内容', 'utf8');

  await p.setInputFiles('#inFile', tmpFile);
  // 等成功卡片出现（最多 15 秒）
  let doneOk = false;
  try {
    await p.waitForSelector('#done:not(.hidden)', { timeout: 15000 });
    doneOk = true;
  } catch (_) {}
  check('传完后出现成功卡片', doneOk);
  if (doneOk) {
    const t = await p.locator('#doneTitle').textContent();
    const d = await p.locator('#doneText').textContent();
    check('成功标题正确', t.includes('已发到电脑'), t);
    check('成功副文案指明目录', d.includes('手机收件箱'), d);
    const doneBox = await p.locator('#done').boundingBox();
    check('成功卡片在视口内（不用滚动就能看到）',
          doneBox && doneBox.y + doneBox.height <= 844 + 20,
          doneBox ? 'bottom=' + Math.round(doneBox.y + doneBox.height) : '未找到');
  }

  // 拖拽也要能用（电脑浏览器打开这个页面时）
  const overflowAfter = await p.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('上传后仍无横向溢出', overflowAfter <= 1, '溢出 ' + overflowAfter + 'px');

  check('页面无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  await iphone.close();

  // ========== C. 窄屏 320（iPhone SE 一代那种）==========
  console.log('\n[C] 窄屏 320×568');
  const se = await browser.newContext({
    viewport: { width: 320, height: 568 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const p2 = await se.newPage();
  await p2.goto(dropUrl, { waitUntil: 'networkidle' });
  const ov320 = await p2.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('320 宽无横向溢出', ov320 <= 1, '溢出 ' + ov320 + 'px');
  const b320 = await p2.locator('#btnPick').boundingBox();
  check('320 宽下主按钮仍满宽', b320 && b320.width > 240,
        b320 ? Math.round(b320.width) + 'px' : '未找到');
  await se.close();

  // ========== D. 失效票据 ==========
  console.log('\n[D] 票据失效页面');
  const badCtx = await browser.newContext({ ...devices['iPhone 13'] });
  const p3 = await badCtx.newPage();
  const bad = await p3.goto(BASE + '/d/deadbeef-not-real');
  check('失效票据返回 410', bad.status() === 410, 'HTTP ' + bad.status());
  const badTxt = await p3.textContent('body');
  check('提示让电脑重新出码', badTxt.includes('重新'), badTxt.replace(/\s+/g, ' ').slice(0, 80));
  check('明确告知文件没传出去', badTxt.includes('没有传出去'));
  const ovBad = await p3.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('失效页无横向溢出', ovBad <= 1, '溢出 ' + ovBad + 'px');
  await badCtx.close();

  await browser.close();

  // ---- 汇总 ----
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

const fs = require('fs');
main().catch((e) => {
  console.error('脚本异常：', e.message);
  process.exit(1);
});
