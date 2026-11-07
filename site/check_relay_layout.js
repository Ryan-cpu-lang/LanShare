// 程序化布局检测：#relay 内元素是否重叠 / 文字是否被裁切
const { chromium } = require('E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core');

const CHECK = () => {
  const root = document.querySelector('#relay');
  if (!root) return { error: 'no #relay' };

  const rect = el => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  // 1) 文字裁切：scrollWidth/Height 超出 client 且 overflow 是 hidden
  const clipped = [];
  root.querySelectorAll('*').forEach(el => {
    if (!el.textContent.trim() && el.children.length === 0) return;
    if (el.children.length > 0) return;
    const cs = getComputedStyle(el);
    if (cs.overflow === 'visible') return;
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
      clipped.push({ tag: el.tagName, cls: el.className, txt: el.textContent.trim().slice(0, 30) });
    }
  });

  // 2) 主要块重叠
  const blocks = [];
  const push = (sel, name) => { const e = root.querySelector(sel); if (e) blocks.push({ name, r: rect(e) }); };
  push('.relay-top', 'top');
  push('.relay-sub', 'sub');
  push('.relay-flow', 'flow');
  push('.relay-actions', 'actions');
  push('#relay-tip', 'tip');
  push('.relay-meta', 'meta');

  const bad = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (overlap(blocks[i].r, blocks[j].r)) bad.push(blocks[i].name + ' × ' + blocks[j].name);
    }
  }

  // 3) 是否所有内容都在卡片内
  const rootR = rect(root);
  const outside = blocks.filter(b =>
    b.r.x < rootR.x - 1 || b.r.y < rootR.y - 1 ||
    b.r.x + b.r.w > rootR.x + rootR.w + 1 || b.r.y + b.r.h > rootR.y + rootR.h + 1
  ).map(b => b.name);

  // 4) 按钮对比度 / 可点击尺寸
  const btn = root.querySelector('.relay-actions a.btn.primary');
  const btnR = btn ? rect(btn) : null;

  return { blocks, bad, clipped, outside, btnR, rootR };
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });

  for (const vp of [
    { name: 'desktop-1280', width: 1280, height: 900 },
    { name: 'laptop-1024', width: 1024, height: 768 },
    { name: 'tablet-820', width: 820, height: 1000 },
    { name: 'mobile-390', width: 390, height: 844 },
    { name: 'mobile-320', width: 320, height: 700 },
  ]) {
    const p = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await p.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'domcontentloaded' });
    const r = await p.evaluate(CHECK);
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`\n[${vp.name}] pageHOverflow=${ov}`);
    if (r.error) { console.log('  ' + r.error); await p.close(); continue; }
    console.log('  overlap:', r.bad.length ? r.bad.join(', ') : 'none');
    console.log('  clipped:', r.clipped.length ? JSON.stringify(r.clipped) : 'none');
    console.log('  outside:', r.outside.length ? r.outside.join(', ') : 'none');
    console.log('  btn:', JSON.stringify(r.btnR));
    console.log('  card:', JSON.stringify(r.rootR));
    await p.close();
  }

  await browser.close();
})();
