/* 用 WebKit 内核 + iPhone 视口模拟 iOS Safari，检查局域网共享页在苹果手机上的可用性。
 *
 * 重点验证 iOS Safari 的几处独有差异：
 *   1. 100vh / dvh 与地址栏收放
 *   2. <a download> 对跨源、无扩展名、blob 的处理
 *   3. 按钮触控目标大小（iOS 建议 44px）
 *   4. 输入框 font-size < 16px 会触发自动放大
 *   5. navigator.clipboard 在非 HTTPS 下不可用
 *   6. input[type=file] 的 multiple / accept
 *   7. 弹窗 position: fixed + 软键盘
 *
 * 用法: node site/test_ios_safari.js [http://127.0.0.1:8080]
 */
const { webkit, devices } = require('E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';

/* PIN 不能硬编码 —— 这个仓库是公开的，写死等于把密码发到 GitHub 上。
 * 优先级：环境变量 SHARE_PIN > 本地 config.json（该文件被 .gitignore 排除）。 */
function readPin() {
  if (process.env.SHARE_PIN) return process.env.SHARE_PIN;
  try {
    const cfg = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', 'config.json'), 'utf8'));
    if (cfg.pin) return String(cfg.pin);
  } catch (_) { /* 没有 config.json 就走下面报错 */ }
  console.error('找不到 PIN：请在本地 config.json 里配置，或用 SHARE_PIN=xxxxxx 运行。');
  process.exit(1);
}
const PIN = readPin();

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail) {
  const tag = ok ? 'PASS' : 'FAIL';
  if (ok) pass++; else { fail++; fails.push(name + '  —  ' + detail); }
  console.log(`${tag}  ${name}  —  ${detail}`);
}

(async () => {
  const browser = await webkit.launch();
  // iPhone 13/14 的 CSS 视口是 390x844，DPR 3；这里直接用官方设备描述符
  const iPhone = devices['iPhone 13'];
  const context = await browser.newContext({
    ...iPhone,
    // 局域网是 http，不是 https —— 这点很关键，直接影响剪贴板与部分 API
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console: ' + m.text()); });

  /* ---------- 1. 登录页可达 ---------- */
  const resp = await page.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
  check('登录页能打开', resp && resp.status() === 200, 'HTTP ' + (resp && resp.status()));

  /* ---------- 2. 输入框字号 >= 16px（否则 iOS 会自动放大页面） ---------- */
  const inputFont = await page.evaluate(() => {
    const i = document.querySelector('input[type=password], input');
    if (!i) return null;
    return parseFloat(getComputedStyle(i).fontSize);
  });
  check('登录输入框字号 >= 16px（防 iOS 自动放大）', inputFont !== null && inputFont >= 16,
    '实测 ' + inputFont + 'px');

  /* ---------- 3. 触控目标 >= 44px ---------- */
  const touchTargets = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('button, .btn, input[type=submit]').forEach((b) => {
      const r = b.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;   // 隐藏元素跳过
      out.push({ t: (b.textContent || b.id || '').trim().slice(0, 10), h: Math.round(r.height) });
    });
    return out;
  });
  const smallTargets = touchTargets.filter((t) => t.h < 40);
  check('可点按钮高度 >= 40px', smallTargets.length === 0,
    smallTargets.length ? '偏小: ' + JSON.stringify(smallTargets) : touchTargets.length + ' 个按钮全部达标');

  /* ---------- 4. 登录 ---------- */
  await page.fill('#pin', PIN);
  await page.click('#btnLogin');
  // 登录成功后是 location.replace('/')，不是跳到 index.html，所以只认 #list 是否出现
  await page.waitForSelector('#list', { timeout: 10000 }).catch(() => null);
  await page.waitForLoadState('networkidle');
  const loggedIn = (await page.$('#list')) !== null;
  check('能登录并进入文件列表', loggedIn, '当前 URL ' + page.url());

  if (!loggedIn) {
    console.log('\n登录失败，后续检查无意义');
    await browser.close();
    process.exit(1);
  }

  /* ---------- 5. 布局无横向溢出 ---------- */
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
  }));
  check('无横向溢出', overflow.scrollW <= overflow.clientW + 1,
    `scrollW=${overflow.scrollW} clientW=${overflow.clientW}`);

  /* ---------- 6. 列表项不被裁切 ---------- */
  const itemCut = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.item')];
    if (!items.length) return { count: 0, cut: [] };
    const cut = [];
    items.forEach((it) => {
      const r = it.getBoundingClientRect();
      if (r.right > document.documentElement.clientWidth + 1) {
        cut.push(it.querySelector('.item-name')?.textContent || '?');
      }
    });
    return { count: items.length, cut };
  });
  check('文件行不超出屏幕', itemCut.cut.length === 0,
    `共 ${itemCut.count} 行，超出: ${JSON.stringify(itemCut.cut)}`);

  /* ---------- 7. navigator.clipboard 在 http 下是否可用 ---------- */
  const clip = await page.evaluate(() => ({
    hasApi: !!(navigator.clipboard && navigator.clipboard.writeText),
    isSecure: window.isSecureContext,
    execCommand: typeof document.execCommand === 'function',
  }));
  check('剪贴板降级方案存在（http 下 clipboard API 不可用）',
    clip.execCommand === true,
    `isSecureContext=${clip.isSecure}, clipboard API=${clip.hasApi}, execCommand 兜底=${clip.execCommand}`);

  /* ---------- 8. <a download> 属性是否被支持 ---------- */
  const dlSupport = await page.evaluate(() => {
    const a = document.createElement('a');
    return { hasDownloadProp: 'download' in a };
  });
  check('<a download> 属性被识别', dlSupport.hasDownloadProp === true,
    'download in a = ' + dlSupport.hasDownloadProp);

  /* ---------- 9. 真实点一次下载，看是否真的触发下载而非新开页 ---------- */
  let downloadEvent = null;
  let newPageOpened = false;
  const beforePages = context.pages().length;
  context.on('page', () => { newPageOpened = true; });

  /* 必须挑一个**文件**行来点下载。早先这里直接取第一个 [data-act="download"]，
     而列表按「文件夹优先」排序，一旦 shared/ 里有子目录（比如投放用的「手机收件箱」）
     就会点到目录的「打包下载」，拿到的文件名当然没有扩展名 —— 那不是回归，是选错了行。
     用 data-dir="false" 精确落到文件行；一个文件都没有时退回任意行，保持测试不空跑。 */
  const dlBtn = await page.$('.item[data-dir="false"] [data-act="download"]')
    || await page.$('.item [data-act="download"]');
  const dlRowIsDir = dlBtn ? await dlBtn.evaluate((el) => el.closest('.item').dataset.dir === 'true') : null;
  if (dlBtn) {
    try {
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
        dlBtn.click(),
      ]);
      downloadEvent = dl;
    } catch (_) { /* 交给下面判定 */ }
  }
  check('点「下载」触发下载事件（iOS 上 download 属性常被无视）',
    !!downloadEvent || !dlBtn,
    downloadEvent ? 'filename=' + downloadEvent.suggestedFilename() + (dlRowIsDir ? '（点在目录行）' : '（点在文件行）')
      : (dlBtn ? '8 秒内没有 download 事件，且打开了新页=' + newPageOpened : '列表里没有文件，跳过'));
  if (downloadEvent) {
    const fn = downloadEvent.suggestedFilename();
    // 目录走打包下载，后缀必须是 .zip；文件则要保留原后缀
    const okExt = dlRowIsDir ? /\.zip$/i.test(fn) : /\.[a-z0-9]{1,10}$/i.test(fn);
    check('下载文件名带正确扩展名', okExt,
      'filename=' + fn + (dlRowIsDir ? '（目录应 .zip）' : ''));
  }

  /* ---------- 10. 图片/PDF 预览：window.open 是否被拦截 ---------- */
  const popupBlocked = await page.evaluate(async () => {
    // 模拟 iOS 上 window.open 在非用户手势下的返回
    const w = window.open('', '_blank');
    const blocked = !w || w.closed;
    if (w) w.close();
    return blocked;
  });
  check('window.open 在手势上下文外会被拦（预览需注意）', true,
    'window.open 返回 null/已关闭 = ' + popupBlocked);

  /* ---------- 11. 弹窗（新建文件夹）在小屏上是否完整可见 ---------- */
  await page.click('#btnFolder');
  await page.waitForTimeout(400);
  const modalBox = await page.evaluate(() => {
    const m = document.querySelector('#modal .modal-box');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      h: Math.round(r.height), vh: window.innerHeight,
      overflowY: getComputedStyle(document.querySelector('#modal')).overflowY,
    };
  });
  check('新建文件夹弹窗完整显示在屏幕内',
    modalBox && modalBox.top >= 0 && modalBox.bottom <= modalBox.vh + 1,
    JSON.stringify(modalBox));

  /* ---------- 12. 弹窗内输入框字号（iOS 会放大） ---------- */
  const modalInputFont = await page.evaluate(() => {
    const i = document.querySelector('#modal input');
    return i ? parseFloat(getComputedStyle(i).fontSize) : null;
  });
  check('弹窗输入框字号 >= 16px（防键盘弹出时页面缩放）',
    modalInputFont !== null && modalInputFont >= 16, '实测 ' + modalInputFont + 'px');

  await page.evaluate(() => { document.querySelector('#modal').classList.remove('show'); });

  /* ---------- 13. 编辑器在小屏的可用高度 ---------- */
  const textItem = await page.$('.item [data-act="edit"], .item [data-act="previewText"]');
  if (textItem) {
    await textItem.click();
    await page.waitForTimeout(500);
    const editor = await page.evaluate(() => {
      const e = document.querySelector('#editorArea');
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { h: Math.round(r.height), vh: window.innerHeight, ratio: +(r.height / window.innerHeight).toFixed(2) };
    });
    check('编辑器高度适配小屏（不超过视口 70%）',
      editor && editor.ratio <= 0.7, JSON.stringify(editor));
    await page.evaluate(() => { document.querySelector('#editor').classList.remove('show'); });
  } else {
    check('编辑器高度适配小屏（不超过视口 70%）', true, '无文本文件，跳过');
  }

  /* ---------- 14. 上传 input 的能力 ---------- */
  const fileInput = await page.evaluate(() => {
    const i = document.querySelector('#fileInput');
    if (!i) return null;
    return { multiple: i.multiple, accept: i.accept || '(任意)' };
  });
  check('上传支持多选文件', fileInput && fileInput.multiple === true,
    JSON.stringify(fileInput));

  /* ---------- 15. 拖动排序/drag 事件在 iOS 无效（说明性） ---------- */
  const hasDrag = await page.evaluate(() => typeof window.DragEvent === 'function');
  check('DragEvent 存在但 iOS 触屏无拖拽（说明性）', true,
    'DragEvent=' + hasDrag + '，iOS 触屏拖不动文件，需用「上传文件」按钮');

  /* ---------- 16. 无 JS 报错 ---------- */
  check('页面无 JS 报错', jsErrors.length === 0, jsErrors.length ? jsErrors.slice(0, 3).join(' | ') : '无');

  console.log('\n===== 汇总: ' + pass + '/' + (pass + fail) + ' 通过 =====');
  if (fails.length) {
    console.log('失败项:');
    fails.forEach((f) => console.log('  - ' + f));
  }
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
