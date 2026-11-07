// 截官网「公网快传」入口区块，检查排版
const { chromium } = require('E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const errors = [];

  // 桌面
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => errors.push('js: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle' });

  // 导航项
  const navs = await page.$$eval('.nav-links a', as => as.map(a => a.textContent.trim()));
  console.log('nav:', JSON.stringify(navs));

  // Hero
  const hero = await page.$$eval('.hero-actions a', as => as.map(a => a.textContent.replace(/\s+/g, ' ').trim()));
  console.log('hero buttons:', JSON.stringify(hero));

  // relay 块是否存在
  const relay = await page.$('#relay');
  console.log('relay exists:', !!relay);

  if (relay) {
    const box = await relay.boundingBox();
    console.log('relay box:', JSON.stringify(box));

    const info = await page.$eval('#relay', el => {
      const h3 = el.querySelector('h3');
      const btn = el.querySelector('.relay-actions a.btn.primary');
      const rows = [...el.querySelectorAll('.relay-meta .row')].map(r => r.textContent.replace(/\s+/g, ' ').trim());
      const nodes = [...el.querySelectorAll('.relay-flow .node')].map(n => n.textContent.replace(/\s+/g, ' ').trim());
      return {
        h3: h3 ? h3.textContent.trim() : null,
        btnText: btn ? btn.textContent.replace(/\s+/g, ' ').trim() : null,
        btnHref: btn ? btn.getAttribute('href') : null,
        rows, nodes,
        hasHScroll: el.scrollWidth > el.clientWidth + 1,
      };
    });
    console.log('relay:', JSON.stringify(info, null, 2));

    await relay.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await relay.screenshot({ path: 'E:/代码项目/default-workspace/site/shot-relay-block.png' });
  }

  // 全页无横向溢出
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('desktop h-overflow:', overflow);

  // 移动端
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  m.on('pageerror', e => errors.push('m-js: ' + e.message));
  await m.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle' });
  const mOverflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log('mobile h-overflow:', mOverflow);

  const mRelay = await m.$('#relay');
  if (mRelay) {
    await mRelay.scrollIntoViewIfNeeded();
    await m.waitForTimeout(300);
    await mRelay.screenshot({ path: 'E:/代码项目/default-workspace/site/shot-relay-mobile.png' });
    const mBox = await mRelay.boundingBox();
    console.log('mobile relay box:', JSON.stringify(mBox));
  }

  console.log('errors:', errors.length ? JSON.stringify(errors, null, 2) : 'none');
  await browser.close();
})();
