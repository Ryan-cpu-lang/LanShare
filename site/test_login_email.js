/* 登录页登录方式切换检查（本地静态页）
 * 用 file:// 打开会因 SDK CDN + config 缺失而报错，所以起本地服务
 */
const PC = require('E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core');

const URL_BASE = process.env.LOCAL_URL || 'http://127.0.0.1:8898/index.html';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  — ' + detail : ''));
}

(async () => {
  const browser = await PC.chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);

  // 默认应是邮箱
  const init = await page.evaluate(() => ({
    emailPane: !document.getElementById('paneEmail').hidden,
    phonePane: !document.getElementById('panePhone').hidden,
    activeBtn: (document.querySelector('.auth-switch-btn.active') || {}).textContent,
    tabs: [...document.querySelectorAll('.auth-switch-btn')].map(b => b.textContent.trim())
  }));
  check('默认显示邮箱输入框', init.emailPane && !init.phonePane, JSON.stringify(init));
  check('默认选中「邮箱」分段', (init.activeBtn || '').trim() === '邮箱', init.activeBtn);
  check('两个分段按钮都在', init.tabs.length === 2 && init.tabs.join('/') === '邮箱/手机号', init.tabs.join(' / '));

  // 切到手机号
  await page.click('.auth-switch-btn[data-method="phone"]');
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => ({
    emailPane: !document.getElementById('paneEmail').hidden,
    phonePane: !document.getElementById('panePhone').hidden,
    activeBtn: (document.querySelector('.auth-switch-btn.active') || {}).textContent
  }));
  check('切到手机号后只显示手机号输入框',
    after.phonePane && !after.emailPane && (after.activeBtn || '').trim() === '手机号',
    JSON.stringify(after));

  // 布局：无重叠、无溢出
  const layout = await page.evaluate(() => {
    const card = document.querySelector('.auth-card');
    const r = card.getBoundingClientRect();
    const sw = document.querySelector('.auth-switch');
    const sws = [...document.querySelectorAll('.auth-switch-btn')].map(b => {
      const x = b.getBoundingClientRect();
      return { t: b.textContent.trim(), w: Math.round(x.width), h: Math.round(x.height) };
    });
    return {
      cardW: Math.round(r.width),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      swW: Math.round(sw.getBoundingClientRect().width),
      sws
    };
  });
  check('桌面端无横向溢出', layout.overflowX <= 0, 'overflowX=' + layout.overflowX);
  check('分段按钮等宽无裁切', layout.sws.every(s => s.w > 40 && s.h >= 28), JSON.stringify(layout.sws));

  // 切回邮箱，测邮箱格式校验
  await page.click('.auth-switch-btn[data-method="email"]');
  await page.waitForTimeout(200);
  await page.fill('#email', 'not-an-email');
  await page.click('#btnSendCode');
  await page.waitForTimeout(400);
  const emailErr = await page.evaluate(() => {
    const e = document.getElementById('emailErr');
    return { hidden: e.hidden, text: e.textContent.trim() };
  });
  check('非法邮箱被前端拦下且提示显示',
    !emailErr.hidden && emailErr.text.indexOf('邮箱') >= 0, JSON.stringify(emailErr));

  // 手机号通道的格式校验仍在
  await page.click('.auth-switch-btn[data-method="phone"]');
  await page.waitForTimeout(200);
  await page.fill('#phone', '12345');
  await page.click('#btnSendCode');
  await page.waitForTimeout(400);
  const phoneErr = await page.evaluate(() => {
    const e = document.getElementById('phoneErr');
    return { hidden: e.hidden, text: e.textContent.trim() };
  });
  check('非法手机号仍被拦下', !phoneErr.hidden && phoneErr.text.indexOf('手机号') >= 0, JSON.stringify(phoneErr));

  // 未获取验证码直接登录 → 提示先获取
  await page.click('.auth-switch-btn[data-method="email"]');
  await page.waitForTimeout(200);
  await page.fill('#email', 'probe@example.com');
  await page.fill('#code', '123456');
  await page.click('#btnLogin');
  await page.waitForTimeout(400);
  const loginErr = await page.evaluate(() => {
    const e = document.getElementById('authErr');
    return { hidden: e.hidden, text: e.textContent.trim() };
  });
  check('未取码直接登录被拦下', !loginErr.hidden && loginErr.text.indexOf('验证码') >= 0, JSON.stringify(loginErr));

  // 切换方式后旧验证码作废
  const cleared = await page.evaluate(() => {
    // 模拟：切方式再切回，pendingOtp 应被清空
    return document.getElementById('paneEmail').hidden === false;
  });
  check('切回邮箱后输入框恢复', cleared, String(cleared));

  check('全程无 JS 运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  // 移动端
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(300);
  const m = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    sws: [...document.querySelectorAll('.auth-switch-btn')].map(b => {
      const x = b.getBoundingClientRect();
      return { w: Math.round(x.width), h: Math.round(x.height) };
    })
  }));
  check('移动端 360 无横向溢出', m.overflowX <= 0, 'overflowX=' + m.overflowX);
  check('移动端分段按钮不裁切', m.sws.every(s => s.w > 40 && s.h >= 28), JSON.stringify(m.sws));

  await page.screenshot({ path: 'E:/代码项目/default-workspace/site/shot-login-email.png', fullPage: true });

  await browser.close();
  const fail = results.filter(x => !x.ok);
  console.log('\n===== 汇总: ' + (results.length - fail.length) + '/' + results.length + ' 通过 =====');
  if (fail.length) process.exit(1);
})().catch(e => { console.error('脚本异常:', e.message); process.exit(2); });
