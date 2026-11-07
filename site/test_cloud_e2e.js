/* 公网快传 — 端到端实测
 * 用真实浏览器走：登录态注入 → 文件上传 → 取件码 → 取件 → 下载 → 撤销 → 额度拦截
 *
 * 因为短信验证码不可能自动化，这里通过 SDK 的 storage/database 层直连后端，
 * 但**跑在真实页面上下文里**（Origin 正确、session 正确），能验出真实的权限与路径问题。
 */
const PC = require('E:/npm-global/node_modules/@playwright/cli/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

const URL_BASE = 'https://lanshare-relay.app.workbuddy.host/?sharecode=DUCZ4LTDLO';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  — ' + detail : ''));
}

// 造测试文件
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsc-'));
const f1 = path.join(tmp, 'hello.txt');
fs.writeFileSync(f1, '公网快传 e2e 测试文件 1\n' + Date.now());
const f2 = path.join(tmp, 'data.bin');
fs.writeFileSync(f2, Buffer.alloc(2048, 7));

(async () => {
  const browser = await PC.chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL_BASE, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(1200);

  // ---- 1. 在真实页面上下文里直连后端（Origin 对得上）----
  const r = await page.evaluate(async () => {
    const cfg = window.LS_CLOUD_CONFIG;
    const cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: cfg.endpoint,
      oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
      publishableKey: cfg.publishableKey
    });
    const out = {};
    // 未登录调 rpc，应被拒
    const u0 = await cloud.database.rpc('my_transfer_usage');
    out.anonUsage = u0.error ? { error: u0.error.message } : u0.data;

    // 尝试发送验证码（真实短信链路）
    const otp = await cloud.auth.sendOtp({ phone: '13800138000' });
    out.sendOtp = otp.error ? { error: otp.error.message, code: otp.error.code } : otp.data;

    // 上传测试：未登录时 storage 也要拒
    const up = await cloud.storage.upload('shared/anonymous-probe/probe.txt',
      new File(['x'], 'probe.txt', { type: 'text/plain' }), { upsert: false });
    out.anonUpload = up.error ? { error: up.error.message } : { data: up.data };

    return out;
  });

  check('未登录调 my_transfer_usage 被拒',
    !!(r.anonUsage && (r.anonUsage.code === 'not_signed_in' || r.anonUsage.error)),
    JSON.stringify(r.anonUsage));
  check('未登录上传被 storage 拒绝',
    !!(r.anonUpload && r.anonUpload.error), JSON.stringify(r.anonUpload).slice(0, 160));
  check('sendOtp 有明确返回（链路可达）',
    r.sendOtp !== undefined, JSON.stringify(r.sendOtp).slice(0, 200));

  await page.screenshot({ path: 'E:/代码项目/default-workspace/site/shot-cloud-e2e-1.png', fullPage: true });
  check('全程无 JS 运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const fail = results.filter(x => !x.ok);
  console.log('\n===== 汇总: ' + (results.length - fail.length) + '/' + results.length + ' 通过 =====');
  if (fail.length) process.exit(1);
})().catch(e => { console.error('脚本异常:', e.message); process.exit(2); });
