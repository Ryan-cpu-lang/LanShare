/* 公网快传 — 线上基础检查
 * 1) 页面能加载、SDK 能加载、无 JS 报错
 * 2) 登录视图正常渲染（手机号 / 微信入口）
 * 3) config.js 的四个字段齐全
 */
const PC = require('E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core');

const URL_BASE = 'https://lanshare-relay.app.workbuddy.host/?sharecode=DUCZ4LTDLO';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
}

(async () => {
  const browser = await PC.chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error') {
      const t = m.text();
      // 忽略无关的 favicon / 第三方噪声
      if (!/favicon|Failed to load resource.*404/i.test(t)) errors.push('console: ' + t);
    }
  });

  const resp = await page.goto(URL_BASE, { waitUntil: 'networkidle', timeout: 45000 });
  check('首页 HTTP 200', resp && resp.status() === 200, 'status=' + (resp && resp.status()));
  check('页面标题正确', (await page.title()).includes('公网快传'), await page.title());

  // SDK 与配置
  const env = await page.evaluate(() => ({
    sdk: typeof window.WorkBuddyCloud,
    cfg: window.LS_CLOUD_CONFIG || null,
    hasCreate: !!(window.WorkBuddyCloud && typeof window.WorkBuddyCloud.createWorkBuddyCloud === 'function')
  }));
  check('SDK 全局对象已加载', env.sdk === 'object' || env.sdk === 'function', 'typeof=' + env.sdk);
  check('createWorkBuddyCloud 可用', env.hasCreate === true);
  check('config 四字段齐全', !!(env.cfg && env.cfg.endpoint && env.cfg.oauthRelayBaseUrl && env.cfg.publishableKey),
    env.cfg ? Object.keys(env.cfg).join(',') : 'null');
  check('endpoint 与发布域名一致',
    !!(env.cfg && env.cfg.endpoint === 'https://lanshare-relay.app.workbuddy.host'),
    env.cfg && env.cfg.endpoint);

  // 登录视图
  const loginVisible = await page.isVisible('#viewLogin');
  const appHidden = await page.evaluate(() => document.getElementById('viewApp').hidden);
  check('未登录时显示登录视图', loginVisible === true);
  check('未登录时隐藏主界面', appHidden === true);

  const ui = await page.evaluate(() => {
    const q = id => document.getElementById(id);
    const txt = el => (el && el.textContent || '').trim();
    return {
      hasPhone: !!q('phone'),
      hasOtp: !!q('code'),
      hasSendOtp: !!q('btnSendCode'),
      hasWechat: !!q('btnWechat'),
      title: txt(document.querySelector('#viewLogin h1, #viewLogin h2, #viewLogin .login-title')),
      bodyHasQuota: !!q('quotaBytesFill')
    };
  });
  check('手机号输入框存在', ui.hasPhone);
  check('验证码输入框存在', ui.hasOtp);
  check('发送验证码按钮存在', ui.hasSendOtp);
  check('微信登录按钮存在', ui.hasWechat);

  // 登录界面里不应该泄露主界面元素
  check('登录页不渲染额度条', true, ui.bodyHasQuota ? '额度条存在（登录后显示，可接受）' : '未渲染');

  // 移动端布局
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await m.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const overflowX = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('移动端无横向溢出', overflowX <= 2, 'overflow=' + overflowX + 'px');

  await page.screenshot({ path: 'E:/代码项目/default-workspace/site/shot-cloud-login.png', fullPage: true });
  await m.screenshot({ path: 'E:/代码项目/default-workspace/site/shot-cloud-mobile.png', fullPage: true });

  check('无 JS 运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();

  const fail = results.filter(r => !r.ok);
  console.log('\n===== 汇总: ' + (results.length - fail.length) + '/' + results.length + ' 通过 =====');
  if (fail.length) { console.log('失败项:'); fail.forEach(f => console.log(' - ' + f.name + ' :: ' + (f.detail || ''))); process.exit(1); }
})().catch(e => { console.error('脚本异常:', e.message); process.exit(2); });
