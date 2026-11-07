/*
 * 演示页交互自测：跑一遍新建文件夹 / 新建文字 / 编辑保存 / 删除 /
 * 搜索 / 面包屑 / 上传，并把结果打印出来。
 *
 * 用法：node site/test_demo.js [baseUrl]
 */
const path = require('path');
const PW = 'E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(PW);

const BASE = process.argv[2] || 'http://127.0.0.1:18100/demo/';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
  const page = await browser.newContext().then((c) => c.newPage());

  const errors = [];
  const badUrls = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/i.test(t)) return; // 由 badUrls 单独判定
    errors.push(t);
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('response', (r) => {
    if (r.status() >= 400 && !/favicon/i.test(r.url())) badUrls.push(r.status() + ' ' + r.url());
  });

  const log = (ok, label, extra) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  →  ' + extra : ''}`);
    if (!ok) process.exitCode = 1;
  };

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // 0) 初始列表
  const initial = await page.locator('#list .item').count();
  log(initial === 3, '初始列表 3 项', '实际 ' + initial);

  // 1) 新建文件夹
  await page.click('#btnFolder');
  await page.fill('#dlgName', '自测目录');
  await page.click('#modalActions .btn.primary');
  await page.waitForTimeout(500);
  const afterMkdir = await page.locator('#list .item').count();
  const hasDir = await page.locator('.item-name', { hasText: '自测目录' }).count();
  log(afterMkdir === 4 && hasDir === 1, '新建文件夹', '共 ' + afterMkdir + ' 项');

  // 2) 新建文字文件
  await page.click('#btnText');
  await page.fill('#dlgName', '自测.md');
  await page.fill('#dlgContent', '# 自测\n第一行内容');
  await page.click('#modalActions .btn.primary');
  await page.waitForTimeout(500);
  const hasFile = await page.locator('.item-name', { hasText: '自测.md' }).count();
  log(hasFile === 1, '新建文字文件');

  // 3) 打开编辑器并保存
  await page.click('.item-name:has-text("自测.md")');
  await page.waitForTimeout(400);
  const editorOpen = await page.locator('#editor.show').count();
  const content = await page.inputValue('#editorArea');
  log(editorOpen === 1 && content.includes('第一行内容'), '打开编辑器读到内容', JSON.stringify(content.slice(0, 20)));

  await page.fill('#editorArea', '# 自测\n改过的内容 ABC');
  await page.click('#editorSave');
  await page.waitForTimeout(500);
  const reopen = await page.locator('.item-name', { hasText: '自测.md' }).count();
  await page.click('.item-name:has-text("自测.md")');
  await page.waitForTimeout(400);
  const saved = await page.inputValue('#editorArea');
  log(saved.includes('改过的内容 ABC'), '编辑保存生效', JSON.stringify(saved.slice(0, 24)));
  await page.click('#editorCancel');
  await page.waitForTimeout(200);

  // 4) 搜索过滤
  await page.fill('#search', '自测');
  await page.waitForTimeout(300);
  const filtered = await page.locator('#list .item').count();
  log(filtered === 2, '搜索过滤「自测」', '剩余 ' + filtered);
  await page.fill('#search', '');
  await page.waitForTimeout(200);

  // 5) 进入文件夹 + 面包屑返回
  await page.click('.item-name:has-text("自测目录")');
  await page.waitForTimeout(500);
  const inDir = await page.locator('#crumbs .crumb', { hasText: '自测目录' }).count();
  const emptyHint = await page.locator('.empty').count();
  log(inDir === 1 && emptyHint === 1, '进入空文件夹', '空状态提示 ' + emptyHint);

  await page.click('#crumbs .crumb:has-text("根目录")');
  await page.waitForTimeout(500);
  const backRoot = await page.locator('#crumbs .crumb.current').innerText();
  log(backRoot.includes('根目录'), '面包屑返回根目录', backRoot.trim());

  // 6) 删除
  page.once('dialog', (d) => d.accept());
  const before = await page.locator('#list .item').count();
  await page.locator('.item:has-text("自测目录") button:has-text("删除")').click();
  await page.waitForTimeout(400);
  await page.click('#modalActions .btn.danger');
  await page.waitForTimeout(600);
  const afterDel = await page.locator('#list .item').count();
  log(afterDel === before - 1, '删除文件夹', before + ' → ' + afterDel);

  // 7) 上传（用 setInputFiles 直接喂一个文件）
  const tmp = path.join(require('os').tmpdir(), 'lanshare_upload_test.txt');
  require('fs').writeFileSync(tmp, '这是通过上传加进去的文件');
  await page.setInputFiles('#fileInput', tmp);
  await page.waitForTimeout(1800);
  const uploaded = await page.locator('.item-name', { hasText: 'lanshare_upload_test.txt' }).count();
  log(uploaded === 1, '上传文件（XHR 被模拟接管）');

  // 8) 刷新后数据还在（localStorage 持久化）
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const persisted = await page.locator('.item-name', { hasText: 'lanshare_upload_test.txt' }).count();
  log(persisted === 1, '刷新后数据保留');

  // 9) 下载：点「下载」按钮，等真实 download 事件（模拟层把文件转成 blob）
  const dlPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await page.locator('.item:has-text("自测.md") button:has-text("下载")').click();
  const dl = await dlPromise;
  log(!!dl, '下载触发（blob 接管成功）', dl ? dl.suggestedFilename() : '未触发');

  // 9b) 文件夹打包下载
  const zipPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await page.locator('.item:has-text("项目资料") button:has-text("打包下载")').click();
  const zip = await zipPromise;
  log(!!zip && /\.zip$/.test(zip ? zip.suggestedFilename() : ''),
    '文件夹打包成 zip', zip ? zip.suggestedFilename() : '未触发');

  // 10) console 无异常、无失败请求
  const real = errors.filter((e) => !/favicon/i.test(e));
  log(real.length === 0, '无 JS 运行时异常', real.slice(0, 2).join(' | '));
  log(badUrls.length === 0, '无失败的网络请求', badUrls.slice(0, 2).join(' | '));

  await page.screenshot({ path: 'site/demo-shot.png', fullPage: false });
  await browser.close();
})().catch((e) => {
  console.error('测试脚本异常：', e.message);
  process.exit(1);
});
