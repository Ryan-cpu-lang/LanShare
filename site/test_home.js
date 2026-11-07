// 官网落地页 + 内嵌演示的浏览器自测
const PW = 'E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(PW);

const BASE = process.argv[2] || 'http://127.0.0.1:18100/';
const OUT = process.argv[3] || 'E:/代码项目/default-workspace/site/home-shot.png';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? '  →  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  →  ' + extra : '')); }
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge' });
  } catch (e) {
    browser = await chromium.launch();
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const errors = [], badUrls = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/i.test(t)) return;
    errors.push(t);
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('response', (r) => {
    if (r.status() >= 400 && !/favicon/i.test(r.url())) badUrls.push(r.status() + ' ' + r.url());
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  // ---------- 基础内容 ----------
  ok((await page.title()).includes('LanShare'), '页面标题', await page.title());
  ok(await page.locator('h1').isVisible(), 'Hero 大标题可见');
  ok((await page.locator('.card').count()) === 6, '功能卡片 6 张', String(await page.locator('.card').count()));
  ok((await page.locator('.step').count()) === 3, '快速开始 3 步');
  ok((await page.locator('.sec-item').count()) === 6, '安全清单 6 条');

  // ---------- 内嵌 iframe 演示 ----------
  const frame = page.frameLocator('.demo-frame');
  await frame.locator('#list').waitFor({ timeout: 10000 });
  const items = await frame.locator('.item').count();
  ok(items >= 3, '内嵌演示列表渲染', items + ' 项');

  // 在 iframe 里新建一个文件夹，验证是真交互而非截图
  await page.evaluate(() => {
    const el = document.querySelector('.demo-frame');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(300);
  await frame.locator('#btnFolder').click();
  await page.waitForTimeout(300);
  const hasModal = await frame.locator('#modal').isVisible();
  ok(hasModal, '点击「新建文件夹」弹出对话框');

  // 关闭弹窗（用 dispatchEvent，绕开 iframe 视口裁剪问题）
  const cancel = frame.locator('#modalActions button').filter({ hasText: /取消|关闭/ }).first();
  if (await cancel.count()) await cancel.dispatchEvent('click');
  await page.waitForTimeout(250);

  // ---------- 锚点导航 ----------
  for (const id of ['features', 'demo', 'start', 'security']) {
    ok(await page.locator('#' + id).count() === 1, '锚点 #' + id + ' 存在');
  }

  // ---------- GitHub 链接 ----------
  const gh = page.locator('a[href*="github.com/Ryan-cpu-lang/LanShare"]');
  ok((await gh.count()) >= 2, 'GitHub 链接数量', String(await gh.count()));

  // ---------- 外部链接指向 ----------
  const ext = await page.locator('.foot-links a').count();
  ok(ext === 4, '页脚链接 4 个', String(ext));

  // ---------- 响应式 ----------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const hOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(hOverflow <= 1, '移动端无横向溢出', 'overflow=' + hOverflow + 'px');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);

  // ---------- 截图 ----------
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT, fullPage: false });
  ok(true, '截图已保存', OUT);

  // ---------- 错误汇总 ----------
  ok(errors.length === 0, '无 JS 运行时异常', errors.slice(0, 3).join(' | ') || '0');
  ok(badUrls.length === 0, '无失败的网络请求', badUrls.slice(0, 3).join(' | ') || '0');

  console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常: ' + e.message); process.exit(2); });
