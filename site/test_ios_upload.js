/* iOS Safari 真机关键路径：上传（相册/文件选择）+ 下载 + 编辑保存。
 * 用 WebKit + iPhone 视口，走真实 HTTP。
 * 用法: node site/test_ios_upload.js [http://192.168.2.1:8080]
 */
const { webkit, devices } = require('E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';

/* PIN 不能硬编码 —— 这个仓库是公开的，写死等于把密码发到 GitHub 上。
 * 优先级：环境变量 SHARE_PIN > 本地 config.json（该文件被 .gitignore 排除）。 */
function readPin() {
  if (process.env.SHARE_PIN) return process.env.SHARE_PIN;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    if (cfg.pin) return String(cfg.pin);
  } catch (_) { /* 没有 config.json 就走下面报错 */ }
  console.error('找不到 PIN：请在本地 config.json 里配置，或用 SHARE_PIN=xxxxxx 运行。');
  process.exit(1);
}
const PIN = readPin();

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`);
}

(async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  await page.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
  await page.fill('#pin', PIN);
  await page.click('#btnLogin');
  await page.waitForSelector('#list', { timeout: 10000 });
  await page.waitForLoadState('networkidle');

  /* 准备一个带中文名 + 空格的测试文件，模拟 iPhone 相册导出的名字 */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-'));
  const cnName = '照片 IMG 2049.txt';
  const cnPath = path.join(tmpDir, 'upload-cn.txt');
  fs.writeFileSync(cnPath, '这是从 iPhone 上传的中文名文件\n第二行内容\n', 'utf8');

  /* 用 setInputFiles 模拟 iOS「选取文件」—— 底层就是 multipart POST */
  await page.setInputFiles('#fileInput', { name: cnName, mimeType: 'text/plain', buffer: Buffer.from('这是从 iPhone 上传的中文名文件\n第二行内容\n', 'utf8') });
  await page.waitForTimeout(2500);

  const afterUpload = await page.evaluate(() => ({
    names: [...document.querySelectorAll('.item-name')].map((n) => n.textContent),
    toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
    barHidden: document.querySelector('#uploadBar').hidden,
  }));
  const upOk = afterUpload.names.includes(cnName);
  check('上传中文名+空格文件成功', upOk,
    '列表: ' + JSON.stringify(afterUpload.names) + ' 提示: ' + JSON.stringify(afterUpload.toast));

  /* 上传后进度条要收起来，否则会一直盖住页面 */
  check('上传完成后进度条自动收起', afterUpload.barHidden === true, 'hidden=' + afterUpload.barHidden);

  /* iPhone 相册默认给 HEIC，录像给 MOV。这两个格式要能认出来、在 Safari 上能预览，
     否则用户从手机传上去的照片连看都看不了。 */
  await page.setInputFiles('#fileInput', [
    { name: 'IMG_0042.HEIC', mimeType: 'image/heic', buffer: Buffer.from('fake-heic') },
    { name: 'IMG_0043.MOV', mimeType: 'video/quicktime', buffer: Buffer.from('fake-mov') },
  ]);
  await page.waitForTimeout(2500);

  const heicState = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.item')];
    const pick = (name) => {
      const r = rows.find((x) => x.querySelector('.item-name')?.textContent === name);
      if (!r) return null;
      return {
        icon: (r.querySelector('.item-icon') || {}).textContent,
        acts: [...r.querySelectorAll('[data-act]')].map((b) => b.dataset.act),
      };
    };
    return { heic: pick('IMG_0042.HEIC'), mov: pick('IMG_0043.MOV') };
  });
  check('HEIC 照片有专属图标且能预览',
    !!heicState.heic && heicState.heic.icon === '🖼' && heicState.heic.acts.includes('preview'),
    JSON.stringify(heicState.heic));
  check('MOV 录像有专属图标且能预览',
    !!heicState.mov && heicState.mov.icon === '🎬' && heicState.mov.acts.includes('preview'),
    JSON.stringify(heicState.mov));

  /* 下载刚上传的文件 */
  let dl = null;
  page.on('download', (d) => { dl = d; });
  const target = await page.evaluateHandle((name) => {
    const rows = [...document.querySelectorAll('.item')];
    const row = rows.find((r) => r.querySelector('.item-name')?.textContent === name);
    return row ? row.querySelector('[data-act="download"]') : null;
  }, cnName);
  if (target) {
    try {
      await Promise.all([
        page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
        target.asElement().click(),
      ]);
    } catch (_) {}
  }
  const fname = dl ? dl.suggestedFilename() : '';
  check('下载中文名文件，文件名不乱码', dl && fname === cnName, 'filename=' + fname + ' 期望=' + cnName);

  /* 编辑并保存（iOS Safari 的 textarea 有自动滚动/缩放问题）。
     注意要编辑刚上传的测试文件，不能抓第一个 .item —— 那是 shared/使用说明.txt，
     改它会污染仓库里的真实文件（之前的版本就是这么把说明文件改坏的）。 */
  const editBtn = await page.evaluateHandle((name) => {
    const row = [...document.querySelectorAll('.item')]
      .find((r) => r.querySelector('.item-name')?.textContent === name);
    return row ? row.querySelector('[data-act="edit"]') : null;
  }, cnName);
  if (editBtn && editBtn.asElement()) {
    await editBtn.asElement().click();
    await page.waitForTimeout(600);
    const editorState = await page.evaluate(() => {
      const ta = document.querySelector('#editorArea');
      const r = ta.getBoundingClientRect();
      return {
        visible: document.querySelector('#editor').classList.contains('show'),
        // iOS 上 textarea 的 font-size < 16 也会触发缩放
        font: parseFloat(getComputedStyle(ta).fontSize),
        inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
      };
    });
    check('编辑器能打开且输入框字号 >= 16px', editorState.visible && editorState.font >= 16,
      JSON.stringify(editorState));

    await page.fill('#editorArea', 'iOS 修改后的内容 🍎');
    await page.click('#editorSave');
    await page.waitForTimeout(1500);
    const saved = await page.evaluate(() => ({
      closed: !document.querySelector('#editor').classList.contains('show'),
      toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
    }));
    check('保存修改成功', saved.closed && saved.toast.some((t) => t.includes('已保存')),
      JSON.stringify(saved));
  } else {
    check('编辑器能打开且输入框字号 >= 16px', false, '找不到编辑按钮');
  }

  /* 清理测试文件：走 API 删除，避免污染共享目录 */
  await page.evaluate(async (names) => {
    for (const name of names) {
      const row = [...document.querySelectorAll('.item')]
        .find((r) => r.querySelector('.item-name')?.textContent === name);
      if (!row) continue;
      await fetch('/api/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: row.dataset.path }),
      });
    }
  }, [cnName, 'IMG_0042.HEIC', 'IMG_0043.MOV']);
  await page.waitForTimeout(800);
  const gone = await page.evaluate(async () => {
    const r = await fetch('/api/files?path=');
    const d = await r.json();
    return d.items.map((i) => i.name);
  });
  check('测试文件已清理',
    !gone.includes(cnName) && !gone.includes('IMG_0042.HEIC') && !gone.includes('IMG_0043.MOV'),
    '剩余: ' + JSON.stringify(gone));

  check('无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n===== 汇总: ' + pass + '/' + (pass + fail) + ' 通过 =====');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
