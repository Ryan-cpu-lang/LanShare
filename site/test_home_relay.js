/* 线上官网「公网快传」入口验证
 * 检查：入口存在、链接正确、点击可跳转、无布局问题
 */
const PC = require('E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core');

const HOME = 'https://ryan-cpu-lang.github.io/LanShare/';
const RELAY = 'https://lanshare-relay.app.workbuddy.host/?sharecode=DUCZ4LTDLO';
const results = [];
const check = (n, ok, d) => { results.push({ n, ok, d }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  — ' + d : '')); };

(async () => {
  const browser = await PC.chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push('page: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404/i.test(m.text())) errs.push('console: ' + m.text()); });

  const resp = await page.goto(HOME, { waitUntil: 'networkidle', timeout: 45000 });
  check('官网 HTTP 200', resp && resp.status() === 200, 'status=' + (resp && resp.status()));

  // 入口块
  const relay = await page.$('#relay');
  check('公网快传区块存在', !!relay);

  const info = await page.evaluate(() => {
    const r = document.querySelector('#relay');
    if (!r) return null;
    const btn = r.querySelector('.relay-actions a.btn.primary');
    const rows = [...r.querySelectorAll('.relay-meta .row')].map(x => x.textContent.replace(/\s+/g, ' ').trim());
    const navRelay = [...document.querySelectorAll('.nav-links a')].find(a => a.getAttribute('href') === '#relay');
    const footRelay = [...document.querySelectorAll('.foot-links a')].find(a => /lanshare-relay/.test(a.href));
    return {
      btnHref: btn && btn.getAttribute('href'),
      btnText: btn && btn.textContent.replace(/\s+/g, ' ').trim(),
      btnTarget: btn && btn.getAttribute('target'),
      rows,
      navRelay: navRelay ? navRelay.textContent.trim() : null,
      footHref: footRelay ? footRelay.href : null,
      h3: (r.querySelector('h3') || {}).textContent
    };
  });

  check('导航栏有「公网快传」锚点', info.navRelay === '公网快传', info.navRelay);
  check('入口按钮文案正确', /打开公网快传/.test(info.btnText || ''), info.btnText);
  check('入口按钮链接完整（含 sharecode）', info.btnHref === RELAY, info.btnHref);
  check('入口按钮新窗口打开', info.btnTarget === '_blank', info.btnTarget);
  check('页脚也有入口', info.footHref === RELAY, info.footHref);
  check('额度表 6 行齐全', info.rows.length === 6, info.rows.join(' | '));

  // 导航锚点可点击
  await page.click('.nav-links a[href="#relay"]');
  await page.waitForTimeout(700);
  const anchorOk = await page.evaluate(() => {
    const r = document.querySelector('#relay').getBoundingClientRect();
    return { top: Math.round(r.top), inView: r.top > -200 && r.top < window.innerHeight };
  });
  check('点击导航可滚动到入口', anchorOk.inView, 'relay.top=' + anchorOk.top);

  // 布局
  const lo = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('桌面无横向溢出', lo === 0, 'overflow=' + lo);

  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await m.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const mo = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('移动端无横向溢出', mo <= 2, 'overflow=' + mo);
  const mBlock = await m.evaluate(() => {
    const r = document.querySelector('#relay');
    if (!r) return null;
    const rect = r.getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height), hasH: r.scrollWidth > r.clientWidth + 1 };
  });
  check('移动端入口块正常渲染', mBlock && !mBlock.hasH, JSON.stringify(mBlock));

  // 目标站点可达
  const relayPage = await browser.newPage();
  const rresp = await relayPage.goto(RELAY, { waitUntil: 'domcontentloaded', timeout: 45000 });
  check('公网快传站点可达（HTTP 200）', rresp && rresp.status() === 200, 'status=' + (rresp && rresp.status()));
  const rTitle = await relayPage.title();
  check('公网快传页面标题正确', /公网快传/.test(rTitle), rTitle);
  // 落到了登录页而不是空页
  const rLogin = await relayPage.evaluate(() => ({
    loginVisible: !document.getElementById('viewLogin')?.hidden,
    phone: !!document.getElementById('phone')
  }));
  check('落到登录视图', rLogin.loginVisible && rLogin.phone, JSON.stringify(rLogin));

  check('官网无 JS 错误', errs.length === 0, errs.slice(0, 3).join(' | '));

  await browser.close();
  const fail = results.filter(r => !r.ok);
  console.log('\n===== ' + (results.length - fail.length) + '/' + results.length + ' 通过 =====');
  if (fail.length) process.exit(1);
})().catch(e => { console.error('异常:', e.message); process.exit(2); });
