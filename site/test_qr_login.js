#!/usr/bin/env node
/**
 * 扫码登录端到端测试（Chromium 当电脑，WebKit + iPhone 当手机）
 *
 * 要测的其实是这条链路：
 *   电脑点「手机扫码」→ 弹窗里出现真二维码 → 手机扫（这里直接把 URL 打开）
 *   → 手机拿到 Cookie 直接进首页，全程没输过 PIN
 *
 * 关键断言：
 *   1. 二维码 SVG 真的画出来了，不是空白
 *   2. SVG 里的编码是真的二维码（用 getModuleCount 之类的间接判断：模块数 > 21）
 *   3. 手机端打开 /q/<票据> 后落在首页且能拿到文件列表
 *   4. 票据只能一次（重放返回 410）
 *   5. 手机端不显示「手机扫码」按钮（你在手机上，扫自己没意义）
 *
 * 用法：node site/test_qr_login.js [http://127.0.0.1:8080]
 */

const { chromium, webkit, devices } = require(
  'E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';

function readPin() {
  if (process.env.SHARE_PIN) return process.env.SHARE_PIN;
  try {
    return JSON.parse(fs.readFileSync('config.json', 'utf8')).pin;
  } catch (_) {
    return null;
  }
}
const PIN = readPin();

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('FAIL  ' + name + '  — ' + (detail || '')); }
}

(async () => {
  // chromiun 走本机 Edge，省得再下内核（跟 test_home.js 一致）
  const browserPc = await chromium.launch({ channel: 'msedge' })
    .catch(() => chromium.launch());
  const browserPhone = await webkit.launch();
  const errors = [];

  // ---------- 电脑端 ----------
  const pc = await browserPc.newContext({ viewport: { width: 1280, height: 800 } });
  const pagePc = await pc.newPage();
  pagePc.on('pageerror', (e) => errors.push('PC: ' + e.message));

  await pagePc.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
  await pagePc.fill('#pin', PIN);
  await pagePc.click('#btnLogin');
  await pagePc.waitForSelector('#list', { timeout: 10000 });
  check('电脑端能登录', true);

  // 点「手机扫码」
  await pagePc.click('#btnQr');
  await pagePc.waitForSelector('.qr-img svg', { timeout: 5000 }).catch(() => null);

  const qr = await pagePc.evaluate(() => {
    const svg = document.querySelector('.qr-img svg');
    if (!svg) return { found: false };
    const rect = svg.getBoundingClientRect();
    // 统计 path 里的绘制指令数量，够多说明确实是二维码而不是空壳
    const paths = svg.querySelectorAll('path');
    return {
      found: true,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      pathCount: paths.length,
      // viewBox 能推出模块数（21 起，每级 +4）
      viewBox: svg.getAttribute('viewBox') || '',
      urlText: (document.querySelector('.qr-url code') || {}).textContent || '',
    };
  });

  check('二维码 SVG 已渲染', qr.found && qr.width > 100 && qr.height > 100,
    qr.found ? `${qr.width}x${qr.height}` : '没有找到 .qr-img svg');
  check('二维码是方形', qr.found && qr.width === qr.height,
    qr.found ? `${qr.width} vs ${qr.height}` : '');

  // 反推模块数：viewBox = margin*2 + 模块数 * cellSize，
  // 这里 margin=3、cellSize=6，所以 (204 - 6) / 6 = 33 个模块。
  // 注意 createSvgTag 的 margin 单位是像素，不是模块。QR 规范要求模块数是 21 + 4n。
  const vbMatch = /^0 0 (\d+) (\d+)$/.exec(qr.viewBox.trim());
  const CELL = 6, MARGIN = 3;
  const modules = vbMatch
    ? Math.round((parseInt(vbMatch[1], 10) - MARGIN * 2) / CELL)
    : 0;
  check('二维码模块数合法', modules >= 21 && (modules - 21) % 4 === 0,
    `viewBox=${qr.viewBox} → ${modules} 模块`);

  check('弹窗里显示了扫码地址', /^http:\/\/[\d.]+:\d+\/q\/.+/.test(qr.urlText),
    qr.urlText || '（空）');

  const qrUrl = qr.urlText;

  /* ---------- 真解码：这一步才是「手机扫得出来」的凭据 ----------
     光看 SVG 里有一堆 path 不算数，得把屏幕像素喂给真正的解码器。
     jsQR 是纯 JS 的二维码解码库，被手机扫码 App 广泛使用，
     它解得出来，手机相机就基本没问题。
     没装 jsQR 时跳过（不阻塞主流程），装了就跑。 */
  let jsQR = null;
  for (const p of [
    '../node_modules/jsqr/dist/jsQR.js',
    'jsqr',
  ]) {
    try { jsQR = require(p); break; } catch (_) { /* 继续试下一个 */ }
  }
  if (jsQR) {
    const buf = await pagePc.locator('.qr-img').screenshot();
    const px = await pagePc.evaluate(async (url) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      return { w: c.width, h: c.height, pixels: Array.from(d.data) };
    }, 'data:image/png;base64,' + buf.toString('base64'));

    const res = jsQR(new Uint8ClampedArray(px.pixels), px.w, px.h);
    check('二维码能被真实解码器解出正确地址',
      !!res && res.data === qrUrl,
      res ? '解出 ' + res.data : '解不出来');
  } else {
    console.log('SKIP  二维码解码验证（没装 jsqr）');
  }

  // ---------- 手机端 ----------
  const phone = await browserPhone.newContext({ ...devices['iPhone 13'] });
  const pagePhone = await phone.newPage();
  pagePhone.on('pageerror', (e) => errors.push('Phone: ' + e.message));

  await pagePhone.goto(qrUrl, { waitUntil: 'networkidle' });
  await pagePhone.waitForSelector('#list', { timeout: 10000 }).catch(() => null);
  const phoneLoggedIn = (await pagePhone.$('#list')) !== null;
  check('手机扫码后直接进首页（未输 PIN）', phoneLoggedIn, 'URL ' + pagePhone.url());

  const phoneUrls = await pagePhone.evaluate(async () => {
    const r = await fetch('/api/files?path=');
    if (!r.ok) return null;
    const d = await r.json();
    return { count: d.items.length, names: d.items.map((i) => i.name).slice(0, 3) };
  });
  check('手机端能读到文件列表', phoneUrls !== null,
    phoneUrls ? phoneUrls.count + ' 项：' + phoneUrls.names.join('/') : '请求失败');

  // 手机上不该出现「手机扫码」按钮
  const qrVisible = await pagePhone.evaluate(() => {
    const b = document.querySelector('#btnQr');
    if (!b) return false;
    const cs = getComputedStyle(b);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  });
  check('手机上隐藏「手机扫码」按钮', !qrVisible);

  // 手机上「上传文件」必须在（用户反馈只能电脑，这里守一下）
  const uploadVisible = await pagePhone.evaluate(() => {
    const b = document.querySelector('#btnUpload');
    if (!b) return false;
    const rect = b.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  check('手机上「上传文件」按钮可见', uploadVisible);

  // ---------- 票据只能一次 ----------
  const replay = await pagePhone.request.get(qrUrl, { maxRedirects: 0 }).catch((e) => ({ status: () => 0, err: e.message }));
  check('同一票据重放被拒（410）', replay.status() === 410,
    'HTTP ' + replay.status());

  check('无 JS 报错', errors.length === 0, errors.join(' | '));

  await browserPc.close();
  await browserPhone.close();

  console.log('\n' + '='.repeat(46));
  console.log(`  扫码登录：${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
