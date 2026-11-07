/* 公网快传 — 云服务前端主线
 * 依赖：WorkBuddyCloud（CDN 全局）+ config.js 里的 LS_CLOUD_CONFIG
 *
 * 设计要点：
 * 1) 额度只在服务端 create_transfer() 里校验扣减，前端拿到的 usage 仅用于展示。
 * 2) 先上传文件到 storage，再调 create_transfer 登记；任一步失败则回收已传对象。
 * 3) 接收方通过取件码走 get_transfer() 拿文件清单，用签名 URL 下载。
 */
(function () {
  'use strict';

  var CFG = window.LS_CLOUD_CONFIG;
  if (!CFG || !window.WorkBuddyCloud) {
    document.body.innerHTML =
      '<div style="padding:40px;font:15px/1.7 system-ui;color:#e8eef9;background:#0e1420;min-height:100vh">' +
      '<h2 style="margin:0 0 10px">组件加载失败</h2>' +
      '<p style="color:#93a2bd">云服务 SDK 没有加载成功，请检查网络后刷新页面。</p></div>';
    return;
  }

  var cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: CFG.endpoint,
    oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
    publishableKey: CFG.publishableKey
  });

  // ---------------- 工具 ----------------
  var $ = function (id) { return document.getElementById(id); };

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 100 ? n.toFixed(0) : n.toFixed(n >= 10 ? 1 : 2)) + ' ' + u[i];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg, kind) {
    var box = $('toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(function () { el.remove(); }, 320);
    }, kind === 'err' ? 4200 : 2600);
  }

  function showErr(el, msg, ok) {
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = msg;
    el.classList.toggle('ok', !!ok);
  }

  function humanErr(err) {
    if (!err) return '操作失败，请重试';
    var m = err.message || String(err);
    if (/fetch|network|Failed to fetch|NetworkError/i.test(m)) return '网络连接失败，请检查网络后重试';
    if (/quota|exceeded|too large/i.test(m)) return '文件超出容量限制';
    return m;
  }

  // 文件类型图标
  function iconFor(name, mime) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    if (/^image\//.test(mime || '') || /^(png|jpe?g|gif|webp|svg|bmp|heic)$/.test(ext)) return '▣';
    if (/^video\//.test(mime || '') || /^(mp4|mov|mkv|avi|webm)$/.test(ext)) return '▶';
    if (/^audio\//.test(mime || '') || /^(mp3|wav|flac|m4a|ogg)$/.test(ext)) return '♪';
    if (/^(zip|rar|7z|tar|gz|bz2|xz)$/.test(ext)) return '▤';
    if (/^(pdf)$/.test(ext)) return '▥';
    if (/^(docx?|xlsx?|pptx?|txt|md|csv)$/.test(ext)) return '▦';
    return '▧';
  }

  // ---------------- 状态 ----------------
  var session = null;
  var queue = [];          // [{file, name, size, ok, reason}]
  var usage = null;        // 最近一次 usage
  var currentRecv = null;  // 当前取件结果
  var busy = false;
  var pendingPick = null;  // 登录后待自动取件的取件码

  // ---------------- 鉴权 ----------------
  function showLogin() {
    $('viewLogin').hidden = false;
    $('viewApp').hidden = true;
  }

  function showApp() {
    $('viewLogin').hidden = true;
    $('viewApp').hidden = false;
    var u = session && session.user;
    var label = (u && (u.name || u.phone || u.email)) || '已登录';
    if (u && u.phone) {
      label = u.phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
    } else if (u && !u.name && u.email) {
      // 邮箱脱敏：只露前 2 位和域名
      var at = u.email.indexOf('@');
      if (at > 2) label = u.email.slice(0, 2) + '***' + u.email.slice(at);
    }
    $('whoami').textContent = label;
  }

  /* 一个页面只能有一个回调分发器；这里微信和 WorkBuddy 都走它。 */
  async function restoreAuth() {
    var url = new URL(location.href);
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
      return continueStartup();
    }

    var provider = url.searchParams.get('provider');
    if (provider !== 'workbuddy' && provider !== 'wechat') {
      showLogin();
      showErr($('authErr'), '授权回调缺少有效的登录方式，请重新登录。');
      return;
    }

    var handler = provider === 'workbuddy'
      ? cloud.auth.handleWorkBuddyCallback
      : cloud.auth.handleWechatWebCallback;

    if (typeof handler !== 'function') {
      showLogin();
      showErr($('authErr'), '当前 SDK 版本缺少对应登录能力，请刷新或联系管理员。');
      return;
    }

    var res = await handler.call(cloud.auth);
    if (res.error) {
      showLogin();
      showErr($('authErr'), res.error.message || '登录失败');
      return;
    }
    if (res.data) {
      for (var k of ['code', 'state', 'provider']) url.searchParams.delete(k);
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      session = res.data;
      enterApp();
      return;
    }
    return continueStartup();
  }

  async function continueStartup() {
    var res = await cloud.auth.getSession();
    if (res.error || !res.data) { showLogin(); return; }
    session = res.data;
    enterApp();
  }

  async function enterApp() {
    showApp();
    await refreshUsage();
    await loadMine();
    // 带 ?pick= 进来的，登录完成后自动取件一次
    if (pendingPick) {
      var c = pendingPick;
      pendingPick = null;
      switchTab('receive');
      $('rcode').value = c;
      setTimeout(doFetch, 200);
    }
  }

  // ---------------- 额度展示 ----------------
  async function refreshUsage() {
    var res = await cloud.database.rpc('my_transfer_usage');
    if (res.error) {
      // 不打断主流程，只在控制台留痕
      console.warn('[usage]', res.error.message);
      return null;
    }
    var d = res.data;
    if (!d || !d.ok) return null;
    usage = d;
    renderUsage(d);
    renderDropHint(d);
    return d;
  }

  function renderUsage(u) {
    var pct = u.limit_bytes > 0 ? Math.min(100, (u.used_bytes / u.limit_bytes) * 100) : 0;
    var fill = $('quotaBytesFill');
    fill.style.width = pct + '%';
    fill.className = 'quota-fill' + (pct >= 99 ? ' full' : pct >= 75 ? ' warn' : '');
    $('quotaBytesText').textContent = fmtBytes(u.used_bytes) + ' / ' + fmtBytes(u.limit_bytes);
    $('quotaCountText').textContent = u.used_count + ' / ' + u.limit_count + ' 次';
    $('quotaReset').textContent = '每日 0 点重置';
  }

  function renderDropHint(u) {
    $('dropHint').textContent =
      '单个文件上限 ' + fmtBytes(u.max_file_bytes) +
      ' · 一次最多 ' + u.max_files + ' 个 · 今日剩余 ' +
      fmtBytes(Math.max(0, u.limit_bytes - u.used_bytes));
  }

  // ---------------- 队列 ----------------
  function addFiles(files) {
    if (!files || !files.length) return;
    var maxFile = usage ? usage.max_file_bytes : 100 * 1024 * 1024;
    var maxCount = usage ? usage.max_files : 20;

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (queue.length >= maxCount) {
        toast('一次最多 ' + maxCount + ' 个文件', 'err');
        break;
      }
      if (f.size > maxFile) {
        toast(f.name + ' 超过 ' + fmtBytes(maxFile) + '，已跳过', 'err');
        continue;
      }
      if (f.size === 0) {
        toast(f.name + ' 是空文件，已跳过', 'err');
        continue;
      }
      // 同名去重
      var dup = queue.some(function (q) { return q.name === f.name && q.size === f.size; });
      if (dup) continue;
      queue.push({ file: f, name: f.name, size: f.size, mime: f.type || 'application/octet-stream' });
    }
    renderQueue();
  }

  function renderQueue() {
    var box = $('queue');
    var list = $('queueList');

    if (!queue.length) {
      box.hidden = true;
      $('btnSend').disabled = true;
      return;
    }
    box.hidden = false;

    var total = queue.reduce(function (s, q) { return s + q.size; }, 0);
    $('queueSummary').textContent = '已选 ' + queue.length + ' 个文件 · 共 ' + fmtBytes(total);

    list.innerHTML = '';
    queue.forEach(function (q, idx) {
      var li = document.createElement('li');
      li.className = 'queue-item';
      li.innerHTML =
        '<span class="file-icon">' + iconFor(q.name, q.mime) + '</span>' +
        '<span class="q-name" title="' + esc(q.name) + '">' + esc(q.name) + '</span>' +
        '<span class="q-size">' + fmtBytes(q.size) + '</span>' +
        '<button class="q-remove" type="button" aria-label="移除">×</button>';
      li.querySelector('.q-remove').addEventListener('click', function () {
        queue.splice(idx, 1);
        renderQueue();
      });
      list.appendChild(li);
    });

    var left = usage ? Math.max(0, usage.limit_bytes - usage.used_bytes) : Infinity;
    var countLeft = usage ? Math.max(0, usage.limit_count - usage.used_count) : Infinity;
    var over = total > left || countLeft < 1;
    $('btnSend').disabled = over || busy;
    if (over) {
      showErr($('sendErr'), total > left
        ? '这批文件共 ' + fmtBytes(total) + '，超过今日剩余额度 ' + fmtBytes(left)
        : '今日传输次数已用完，明天再来');
    } else {
      showErr($('sendErr'), '');
    }
  }

  // ---------------- 发送 ----------------
  async function doSend() {
    if (busy || !queue.length) return;
    busy = true;
    $('btnSend').disabled = true;
    showErr($('sendErr'), '');
    $('sendProgress').hidden = false;
    $('sendDone').hidden = true;

    var totalBytes = queue.reduce(function (s, q) { return s + q.size; }, 0);
    var uid = session.user.id;
    var uploaded = [];   // 已成功上传的对象路径，失败时回收

    try {
      // 1) 逐个上传
      var doneBytes = 0;
      for (var i = 0; i < queue.length; i++) {
        var item = queue[i];
        var safeName = item.name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 80);
        var objectName = Date.now().toString(36) + '-' +
          Math.random().toString(36).slice(2, 8) + '-' + safeName;
        // 必须放 shared/<uid>/ 下：所有登录用户可读，只有自己能写删。
        // 用 userPath(users/<uid>/) 的话别人对不了签名 URL，取件会 403。
        var path = cloud.storage.sharedPath(uid, 'relay/' + objectName);

        $('sendProgressText').textContent =
          '正在上传 ' + (i + 1) + ' / ' + queue.length + '：' + item.name;

        var up = await cloud.storage.upload(path, item.file, {
          contentType: item.mime,
          upsert: false,
          metadata: { original_name: item.name }
        });

        if (up.error) throw new Error('「' + item.name + '」上传失败：' + up.error.message);

        uploaded.push(path);
        item.objectPath = path;
        doneBytes += item.size;
        $('sendProgressFill').style.width = ((doneBytes / totalBytes) * 92).toFixed(1) + '%';
      }

      // 2) 登记 + 扣额度（服务端原子校验）
      $('sendProgressText').textContent = '正在生成取件码…';
      $('sendProgressFill').style.width = '96%';

      var payload = queue.map(function (q) {
        return { name: q.name, bytes: q.size, mime: q.mime, path: q.objectPath };
      });

      var ttl = parseInt($('ttl').value, 10) || 7;
      var res = await cloud.database.rpc('create_transfer', {
        p_note: ($('note').value || '').trim(),
        p_files: payload,
        p_ttl_days: ttl
      });

      if (res.error) throw new Error(res.error.message);

      var r = res.data;
      if (!r || !r.ok) {
        // 额度被拒 → 回收刚传的对象，避免占空间
        await cleanup(uploaded);
        uploaded = [];
        throw new Error(quotaMessage(r));
      }

      $('sendProgressFill').style.width = '100%';
      $('sendProgressText').textContent = '完成';

      // 3) 展示取件码
      $('doneCode').textContent = r.code;
      $('doneExpire').textContent =
        '有效期至 ' + new Date(r.expires_at).toLocaleString('zh-CN') +
        ' · 这批用了 ' + fmtBytes(totalBytes);
      $('sendDone').hidden = false;
      currentCode = r.code;

      queue = [];
      $('note').value = '';
      renderQueue();
      $('sendProgress').hidden = true;

      await refreshUsage();
      await loadMine();
      showErr($('sendErr'), '');
      toast('取件码已生成：' + r.code, 'ok');

    } catch (err) {
      if (uploaded.length) await cleanup(uploaded);
      showErr($('sendErr'), humanErr(err));
      $('sendProgress').hidden = true;
      toast(humanErr(err), 'err');
    } finally {
      busy = false;
      renderQueue();
    }
  }

  function quotaMessage(r) {
    if (r.code === 'daily_bytes') {
      return '超出今日流量额度：这批 ' + fmtBytes(r.need) +
        '，今日只剩 ' + fmtBytes(r.left) + '。明天 0 点重置。';
    }
    if (r.code === 'daily_count') {
      return '今日传输次数已用完（每天 ' + r.limit + ' 次），明天再来。';
    }
    if (r.code === 'too_large') return '「' + r.name + '」超过单文件上限 ' + fmtBytes(r.limit);
    if (r.code === 'too_many_files') return '文件数超过上限 ' + r.limit + ' 个';
    if (r.code === 'not_signed_in') return '登录状态已失效，请重新登录';
    if (r.code === 'bad_name') return '文件名不合法：' + r.name;
    return '传输创建失败（' + (r.code || 'unknown') + '）';
  }

  async function cleanup(paths) {
    try { await cloud.storage.remove(paths); } catch (e) { /* 回收失败不阻塞主流程 */ }
  }

  // ---------------- 取件 ----------------
  async function doFetch() {
    var code = ($('rcode').value || '').trim().toUpperCase();
    if (code.length < 4) {
      showErr($('receiveErr'), '请输入完整的取件码');
      return;
    }
    showErr($('receiveErr'), '');
    $('btnFetch').disabled = true;

    try {
      var res = await cloud.database.rpc('get_transfer', { p_code: code });
      if (res.error) throw new Error(res.error.message);

      var d = res.data;
      if (!d || !d.ok) {
        $('recvResult').hidden = true;
        showErr($('receiveErr'), fetchErrorText(d && d.code));
        return;
      }

      currentRecv = d;
      renderRecv(d);
    } catch (err) {
      $('recvResult').hidden = true;
      showErr($('receiveErr'), humanErr(err));
    } finally {
      $('btnFetch').disabled = false;
    }
  }

  function fetchErrorText(code) {
    switch (code) {
      case 'not_found': return '取件码不存在，检查一下是不是输错了';
      case 'expired': return '这个取件码已经过期了，让对方重新发一次';
      case 'revoked': return '发送方已撤销这次传输';
      case 'not_signed_in': return '请先登录';
      default: return '取件失败，请重试';
    }
  }

  function renderRecv(d) {
    $('recvResult').hidden = false;
    $('recvTitle').textContent = '共 ' + d.file_count + ' 个文件 · ' + fmtBytes(d.bytes_total);
    var exp = new Date(d.expires_at);
    var leftMs = exp - Date.now();
    var leftDays = Math.max(0, Math.ceil(leftMs / 86400000));
    $('recvMeta').textContent =
      '有效期还剩 ' + leftDays + ' 天 · 已被下载 ' + d.downloads + ' 次' +
      (d.is_owner ? ' · 这是你自己发的' : '');

    if (d.note) {
      $('recvNote').hidden = false;
      $('recvNote').textContent = d.note;
    } else {
      $('recvNote').hidden = true;
    }

    var list = $('recvList');
    list.innerHTML = '';
    (d.files || []).forEach(function (f) {
      var li = document.createElement('li');
      li.className = 'file-item';
      li.innerHTML =
        '<span class="file-icon">' + iconFor(f.name, f.mime) + '</span>' +
        '<div class="file-info">' +
          '<div class="file-name" title="' + esc(f.name) + '">' + esc(f.name) + '</div>' +
          '<div class="file-size">' + fmtBytes(f.bytes) + '</div>' +
        '</div>' +
        '<button class="btn btn-ghost btn-sm" type="button">下载</button>';
      li.querySelector('button').addEventListener('click', function () {
        downloadOne(d.code, f, this);
      });
      list.appendChild(li);
    });

    $('btnZipAll').onclick = function () { downloadAll(d); };
  }

  async function downloadOne(code, f, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '准备中'; }
    try {
      var signed = await cloud.storage.createSignedUrl(f.path, 600);
      if (signed.error) throw new Error(signed.error.message);
      var u = signed.data && (signed.data.signedUrl || signed.data.url);
      if (!u) throw new Error('未能取得下载地址');
      triggerDownload(u, f.name);
      cloud.database.rpc('bump_download', { p_code: code }).catch(function () {});
      toast('开始下载 ' + f.name, 'ok');
    } catch (err) {
      toast('下载失败：' + humanErr(err), 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '下载'; }
    }
  }

  function triggerDownload(url, name) {
    var a = document.createElement('a');
    a.href = url;
    a.download = name || '';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 1000);
  }

  async function downloadAll(d) {
    var btn = $('btnZipAll');
    btn.disabled = true;
    btn.textContent = '准备中…';
    try {
      var paths = (d.files || []).map(function (f) { return f.path; });
      var many = await cloud.storage.createSignedUrls(paths, 600);
      if (many.error) throw new Error(many.error.message);

      var items = many.data || [];
      var started = 0;
      for (var i = 0; i < items.length; i++) {
        var name = (d.files[i] && d.files[i].name) || ('file-' + i);
        var u = items[i] && (items[i].signedUrl || items[i].url);
        if (!u) continue;                       // 个别失败就跳过，别把整批带崩
        triggerDownload(u, name);
        started++;
        await new Promise(function (r) { setTimeout(r, 260); });
      }
      if (!started) throw new Error('没有可下载的文件');
      cloud.database.rpc('bump_download', { p_code: d.code }).catch(function () {});
      toast('已开始下载 ' + started + ' 个文件', 'ok');
    } catch (err) {
      toast('打包下载失败：' + humanErr(err), 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '打包下载';
    }
  }

  // ---------------- 我的传输 ----------------
  async function loadMine() {
    var res = await cloud.database
      .from('transfers')
      .select('id, code, note, file_count, bytes_total, downloads, created_at, expires_at, status')
      .order('created_at', { ascending: false })
      .limit(50);

    if (res.error) {
      showErr($('mineErr'), '读取失败：' + res.error.message);
      return;
    }
    showErr($('mineErr'), '');
    renderMine(res.data || []);
  }

  function renderMine(rows) {
    var list = $('mineList');
    list.innerHTML = '';
    $('mineEmpty').hidden = rows.length > 0;

    rows.forEach(function (t) {
      var exp = new Date(t.expires_at);
      var dead = t.status !== 'active' || exp < new Date();
      var li = document.createElement('li');
      li.className = 'mine-card' + (dead ? ' dead' : '');

      var badge = dead
        ? '<span class="mine-badge off">' + (t.status !== 'active' ? '已撤销' : '已过期') + '</span>'
        : '<span class="mine-badge on">有效</span>';

      li.innerHTML =
        '<div class="mine-top">' +
          '<span class="mine-code">' + esc(t.code) + '</span>' + badge +
          '<span class="mine-meta">' + t.file_count + ' 个文件 · ' + fmtBytes(t.bytes_total) +
            ' · 下载 ' + t.downloads + ' 次</span>' +
        '</div>' +
        (t.note ? '<p class="mine-note">' + esc(t.note) + '</p>' : '') +
        '<p class="mine-meta">有效至 ' + exp.toLocaleString('zh-CN') + '</p>' +
        '<div class="mine-actions">' +
          '<button class="btn btn-ghost btn-sm" data-act="copy">复制取件码</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="link">复制链接</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="open">查看</button>' +
          (dead ? '' : '<button class="btn btn-ghost btn-sm" data-act="revoke">撤销</button>') +
        '</div>';

      li.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-act');
          if (act === 'copy') copyText(t.code, '取件码已复制');
          if (act === 'link') copyText(shareLink(t.code), '取件链接已复制');
          if (act === 'open') { switchTab('receive'); $('rcode').value = t.code; doFetch(); }
          if (act === 'revoke') revoke(t, li);
        });
      });

      list.appendChild(li);
    });
  }

  function shareLink(code) {
    // 注意：不能把 search 整个清空。发布平台要求首次访问带 sharecode=xxx，
    // 清掉的话对方打开只会看到「链接不完整」。只替换/追加 pick 参数。
    var u = new URL(location.href);
    u.hash = '';
    u.searchParams.delete('pick');
    u.searchParams.delete('code');
    u.searchParams.delete('state');
    u.searchParams.set('pick', code);
    return u.toString();
  }

  async function revoke(t, cardEl) {
    if (!confirm('撤销后对方将无法下载，且不能恢复。确定撤销 ' + t.code + '？')) return;
    var res = await cloud.database
      .from('transfers')
      .update({ status: 'revoked' })
      .eq('id', t.id)
      .select();

    if (res.error) { toast('撤销失败：' + res.error.message, 'err'); return; }
    if (!res.data || !res.data.length) {
      toast('撤销失败：没有权限或记录不存在', 'err');
      return;
    }
    toast('已撤销 ' + t.code, 'ok');
    await loadMine();
  }

  async function copyText(text, okMsg) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast(okMsg || '已复制', 'ok');
    } catch (e) {
      toast('复制失败，请手动选中', 'err');
    }
  }

  // ---------------- 标签切换 ----------------
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === name);
    });
    ['send', 'receive', 'mine'].forEach(function (k) {
      var pane = $('pane' + k.charAt(0).toUpperCase() + k.slice(1));
      if (pane) pane.hidden = k !== name;
    });
    if (name === 'mine') loadMine();
    if (name === 'send') refreshUsage();
  }

  // ---------------- 登录交互 ----------------
  var pendingOtp = null;   // {method:'email'|'phone', target, verificationId, isExistingUser}
  var sendTimer = null;
  var authMethod = 'email'; // 默认走邮箱：不受短信每日限额影响

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var PHONE_RE = /^1\d{10}$/;

  function setAuthMethod(m) {
    authMethod = m;
    document.querySelectorAll('.auth-switch-btn').forEach(function (b) {
      var on = b.getAttribute('data-method') === m;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('paneEmail').hidden = m !== 'email';
    $('panePhone').hidden = m !== 'phone';
    // 换方式后旧验证码作废，避免拿 A 通道的码去 B 通道提交
    pendingOtp = null;
    showErr($('authErr'), '');
    showErr($('emailErr'), '');
    showErr($('phoneErr'), '');
  }

  function currentTarget() {
    return authMethod === 'email'
      ? ($('email').value || '').trim()
      : ($('phone').value || '').trim();
  }

  function onPhoneInput() { showErr($('phoneErr'), ''); }
  function onEmailInput() { showErr($('emailErr'), ''); }

  async function sendCode() {
    var target = currentTarget();
    var isEmail = authMethod === 'email';
    var errEl = isEmail ? $('emailErr') : $('phoneErr');

    if (isEmail) {
      if (!EMAIL_RE.test(target)) {
        showErr(errEl, '请输入正确的邮箱地址');
        return;
      }
    } else if (!PHONE_RE.test(target)) {
      showErr(errEl, '请输入正确的 11 位手机号');
      return;
    }
    showErr(errEl, '');
    showErr($('authErr'), '');

    var btn = $('btnSendCode');
    btn.disabled = true;
    btn.textContent = '发送中…';

    var sent = await cloud.auth.sendOtp(isEmail ? { email: target } : { phone: target });
    if (sent.error) {
      btn.disabled = false;
      btn.textContent = '获取验证码';
      showErr($('authErr'), sent.error.message || '验证码发送失败');
      return;
    }

    pendingOtp = {
      method: authMethod,
      target: target,
      verificationId: sent.data.verificationId,
      isExistingUser: sent.data.isExistingUser
    };

    showErr($('authErr'),
      isEmail ? '验证码已发到邮箱，请查收（含垃圾箱）' : '验证码已发送，请查看短信', true);

    var left = 60;
    btn.textContent = left + ' 秒后重发';
    clearInterval(sendTimer);
    sendTimer = setInterval(function () {
      left--;
      if (left <= 0) {
        clearInterval(sendTimer);
        btn.disabled = false;
        btn.textContent = '重新获取';
      } else {
        btn.textContent = left + ' 秒后重发';
      }
    }, 1000);
  }

  async function submitLogin() {
    var target = currentTarget();
    var token = ($('code').value || '').trim();

    if (!pendingOtp || pendingOtp.method !== authMethod || pendingOtp.target !== target) {
      showErr($('authErr'), authMethod === 'email'
        ? '请先获取当前邮箱的验证码'
        : '请先获取当前手机号的验证码');
      return;
    }
    if (!/^\d{4,8}$/.test(token)) {
      showErr($('authErr'), '请输入收到的验证码');
      return;
    }

    var btn = $('btnLogin');
    btn.disabled = true;
    btn.textContent = '登录中…';

    var payload = {
      verificationId: pendingOtp.verificationId,
      isExistingUser: pendingOtp.isExistingUser,
      token: token
    };
    if (pendingOtp.method === 'email') payload.email = pendingOtp.target;
    else payload.phone = pendingOtp.target;

    var done = await cloud.auth.verifyOtp(payload);

    btn.disabled = false;
    btn.textContent = '登录 / 注册';

    if (done.error) {
      showErr($('authErr'), done.error.message || '验证码错误或已失效');
      return;
    }

    pendingOtp = null;
    session = done.data;
    showErr($('authErr'), '');
    enterApp();
  }

  async function wechatLogin() {
    var btn = $('btnWechat');
    btn.disabled = true;
    btn.textContent = '正在跳转…';

    var back = new URL(location.href);
    back.pathname = location.pathname;
    for (var k of ['code', 'state', 'provider']) back.searchParams.delete(k);

    var res = await cloud.auth.signInWithOAuth({
      provider: 'wechat',
      redirectTo: back.toString()
    });

    if (res.error) {
      btn.disabled = false;
      btn.textContent = '微信扫码登录';
      showErr($('authErr'), res.error.message || '微信登录不可用');
      return;
    }
    // 同标签页跳转，PKCE verifier 在 sessionStorage 里
    location.assign(res.data.url);
  }

  // ---------------- 事件绑定 ----------------
  var currentCode = '';

  function bind() {
    $('email').addEventListener('input', onEmailInput);
    $('phone').addEventListener('input', onPhoneInput);
    document.querySelectorAll('.auth-switch-btn').forEach(function (b) {
      b.addEventListener('click', function () { setAuthMethod(b.getAttribute('data-method')); });
    });
    $('btnSendCode').addEventListener('click', sendCode);
    $('btnLogin').addEventListener('click', submitLogin);
    $('btnWechat').addEventListener('click', wechatLogin);

    $('email').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') sendCode();
    });
    $('phone').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') sendCode();
    });

    $('code').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitLogin();
    });

    $('btnLogout').addEventListener('click', async function () {
      await cloud.auth.signOut();
      session = null;
      queue = [];
      showLogin();
      toast('已退出登录');
    });

    // 拖放
    var drop = $('dropZone');
    drop.addEventListener('click', function () { $('fileInput').click(); });
    drop.addEventListener('dragover', function (e) {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      drop.classList.remove('over');
      addFiles(e.dataTransfer.files);
    });

    $('fileInput').addEventListener('change', function (e) {
      addFiles(e.target.files);
      e.target.value = '';
    });

    $('btnClearQueue').addEventListener('click', function () {
      queue = [];
      renderQueue();
      showErr($('sendErr'), '');
    });

    $('btnSend').addEventListener('click', doSend);

    $('btnCopyCode').addEventListener('click', function () {
      copyText($('doneCode').textContent, '取件码已复制');
    });
    $('btnCopyLink').addEventListener('click', function () {
      copyText(shareLink(currentCode), '取件链接已复制');
    });
    $('btnSendAgain').addEventListener('click', function () {
      $('sendDone').hidden = true;
      $('fileInput').click();
    });

    // 取件
    $('btnFetch').addEventListener('click', doFetch);
    $('rcode').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doFetch();
    });
    $('rcode').addEventListener('input', function () {
      this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });

    $('btnRefreshMine').addEventListener('click', loadMine);

    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); });
    });

    // 从 ?pick=XXXX 直达取件（未登录时先记着，登录成功后再执行）
    var pick = new URL(location.href).searchParams.get('pick');
    if (pick) {
      pendingPick = pick.toUpperCase().replace(/[^A-Z0-9]/g, '');
      switchTab('receive');
      $('rcode').value = pendingPick;
      if (session) { pendingPick = null; setTimeout(doFetch, 300); }
    }
  }

  // ---------------- 启动 ----------------
  bind();
  restoreAuth();
})();
