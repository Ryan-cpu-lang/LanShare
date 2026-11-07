/* 线上验证：邮箱登录通道是否真的通
 * 要点：全程只通过 UI 操作，不额外直连发码（否则会撞「每邮箱每分钟 1 条」的限制）
 */
const PC = require('E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core');

const URL_BASE = 'https://lanshare-relay.app.workbuddy.host/?sharecode=DUCZ4LTDLO';
const TEST_EMAIL = process.env.TEST_EMAIL || ('lsc-check-' + Date.now() + '@example.com');
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

  await page.goto(URL_BASE, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(1500);

  const init = await page.evaluate(() => ({
    loginVisible: !document.getElementById('viewLogin').hidden,
    emailPane: !document.getElementById('paneEmail').hidden,
    phonePane: !document.getElementById('panePhone').hidden,
    activeBtn: (document.querySelector('.auth-switch-btn.active') || {}).textContent,
    hasSwitch: !!document.querySelector('.auth-switch'),
    noLoadError: !document.body.textContent.includes('组件加载失败')
  }));
  check('线上登录页默认显示邮箱输入框',
    init.loginVisible && init.emailPane && !init.phonePane, JSON.stringify(init));
  check('线上默认选中「邮箱」且分段控件在', (init.activeBtn || '').trim() === '邮箱' && init.hasSwitch, init.activeBtn);
  check('SDK 正常加载（无「组件加载失败」）', init.noLoadError, String(init.noLoadError));

  // 走 UI：填邮箱 → 点获取验证码
  await page.fill('#email', TEST_EMAIL);
  await page.click('#btnSendCode');
  await page.waitForTimeout(3000);

  const after = await page.evaluate(() => ({
    btnText: document.getElementById('btnSendCode').textContent.trim(),
    btnDisabled: document.getElementById('btnSendCode').disabled,
    tipHidden: document.getElementById('authErr').hidden,
    tip: document.getElementById('authErr').textContent.trim()
  }));

  const sentOk = /秒后重发/.test(after.btnText) && after.btnDisabled;
  if (sentOk) {
    check('邮箱验证码发送成功（按钮进入 60 秒倒计时）', true, after.btnText);
    check('提示指向邮箱查收', !after.tipHidden && after.tip.indexOf('邮箱') >= 0, after.tip);
  } else {
    // 可能是限流（前一次探测刚发过）。此时至少要确认提示是中文、可读
    const isChinese = /[\u4e00-\u9fa5]/.test(after.tip);
    check('发送被限流时给出中文提示（不是英文原文）',
      !after.tipHidden && isChinese, after.tip);
    check('提示告知要等 1 分钟', /1 分钟|分钟/.test(after.tip), after.tip);
  }

  // 手机号段落仍在，且切过去正常
  await page.click('.auth-switch-btn[data-method="phone"]');
  await page.waitForTimeout(300);
  const ph = await page.evaluate(() => ({
    phonePane: !document.getElementById('panePhone').hidden,
    emailPane: !document.getElementById('paneEmail').hidden
  }));
  check('切到手机号后只显示手机号输入框', ph.phonePane && !ph.emailPane, JSON.stringify(ph));

  check('无 JS 运行时报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  const fail = results.filter(x => !x.ok);
  console.log('\n===== 汇总: ' + (results.length - fail.length) + '/' + results.length + ' 通过 =====');
  if (fail.length) process.exit(1);
})().catch(e => { console.error('脚本异常:', e.message); process.exit(2); });
