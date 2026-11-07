/* 官网公网快传区块文案 & 布局检查（本地 docs/） */
const PC = require('E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  — ' + detail : ''));
}

(async () => {
  const browser = await PC.chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(800);

  const t = await page.evaluate(() => {
    const tip = document.querySelector('#relay-tip');
    const link = document.querySelector('.relay-actions a.primary');
    return {
      tipText: tip ? tip.textContent.replace(/\s+/g, ' ').trim() : '',
      hasEmail: tip ? tip.textContent.includes('邮箱') : false,
      hasPhoneOnly: tip ? /都需要用手机号登录/.test(tip.textContent) : false,
      href: link ? link.getAttribute('href') : null
    };
  });

  check('额度说明提到邮箱或手机号', t.hasEmail, t.tipText.slice(0, 120));
  check('不再写「都需要用手机号登录」', !t.hasPhoneOnly, String(t.hasPhoneOnly));
  check('入口按钮仍带 sharecode',
    !!t.href && t.href.includes('lanshare-relay.app.workbuddy.host') && t.href.includes('sharecode='),
    t.href);

  // 多视口布局
  for (const w of [1280, 1024, 820, 390, 320]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(250);
    const m = await page.evaluate(() => {
      const el = document.getElementById('relay-tip');
      const r = el.getBoundingClientRect();
      const sec = document.getElementById('relay').getBoundingClientRect();
      return {
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tipInside: r.left >= sec.left - 1 && r.right <= sec.right + 1,
        tipH: Math.round(r.height)
      };
    });
    check(w + 'px 无横向溢出且提示文字未溢出卡片',
      m.overflowX <= 0 && m.tipInside && m.tipH > 20, JSON.stringify(m));
  }

  check('无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  const fail = results.filter(x => !x.ok);
  console.log('\n===== 汇总: ' + (results.length - fail.length) + '/' + results.length + ' 通过 =====');
  if (fail.length) process.exit(1);
})().catch(e => { console.error('脚本异常:', e.message); process.exit(2); });
