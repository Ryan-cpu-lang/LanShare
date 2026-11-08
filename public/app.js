/* 局域网文件共享 - 前端逻辑 */
(function () {
  'use strict';

  const state = {
    path: '',        // 当前相对目录，'' 表示根
    items: [],
    editing: null,   // 正在编辑的相对路径
    info: null,
    readOnly: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const el = {
    list: $('#list'),
    crumbs: $('#crumbs'),
    count: $('#countLabel'),
    search: $('#search'),
    fileInput: $('#fileInput'),
    addrHint: $('#addrHint'),
    sharedDir: $('#sharedDir'),
    uploadBar: $('#uploadBar'),
    uploadInfo: $('#uploadInfo'),
    progressFill: $('#progressFill'),
    panel: $('.panel'),
    modal: $('#modal'),
    modalTitle: $('#modalTitle'),
    modalBody: $('#modalBody'),
    modalActions: $('#modalActions'),
    editor: $('#editor'),
    editorTitle: $('#editorTitle'),
    editorArea: $('#editorArea'),
    toasts: $('#toasts'),
  };

  /* ---------------- 工具函数 ---------------- */
  function toast(msg, type) {
    const node = document.createElement('div');
    node.className = 'toast' + (type ? ' ' + type : '');
    node.textContent = msg;
    el.toasts.appendChild(node);
    setTimeout(() => node.remove(), 2800);
  }

  async function api(url, options) {
    const res = await fetch(url, options);
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (res.status === 401) {
      location.replace('/login.html');
      throw new Error('登录已过期');
    }
    if (!res.ok) throw new Error((data && data.error) || ('请求失败 (' + res.status + ')'));
    return data;
  }

  function joinPath(dir, name) {
    return dir ? dir + '/' + name : name;
  }

  /* 逐段编码，保证文件名里的 # ? & 等字符不会破坏 URL */
  function encodePath(p) {
    return String(p).split('/').map(encodeURIComponent).join('/');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  const ICONS = {
    txt: '📄', md: '📝', markdown: '📝', log: '🧾',
    doc: '📄', docx: '📄', pdf: '📕',
    xls: '📊', xlsx: '📊', csv: '📊',
    ppt: '📽', pptx: '📽',
    jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', webp: '🖼', bmp: '🖼', svg: '🖼',
    heic: '🖼', heif: '🖼',
    mp3: '🎵', wav: '🎵', flac: '🎵', m4a: '🎵',
    mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', webm: '🎬',
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    exe: '⚙', msi: '⚙', apk: '📱',
    js: '🧩', json: '🧩', html: '🧩', css: '🧩', py: '🧩', java: '🧩', c: '🧩', cpp: '🧩',
  };

  function iconFor(item) {
    if (item.isDirectory) return '📁';
    return ICONS[item.ext] || '📄';
  }

  const TEXT_EXT = new Set([
    'txt', 'md', 'markdown', 'log', 'json', 'js', 'ts', 'css', 'html', 'htm',
    'xml', 'yml', 'yaml', 'ini', 'conf', 'bat', 'sh', 'py', 'java', 'c', 'cpp',
    'h', 'cs', 'go', 'rs', 'sql', 'csv', 'env', '',
  ]);
  // 可在线预览的图片：与 server.py 的 SAFE_INLINE_TYPES 保持一致
  // svg 能内嵌脚本，服务端强制下载，所以这里也不给预览
  const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']);
  // iPhone 拍照默认存成 HEIC，Safari 自己能打开，Chrome/Windows 打不开。
  // 给预览按钮，打开后由浏览器决定能不能显示，不额外拦。
  const HEIC_EXT = new Set(['heic', 'heif']);
  const VIDEO_EXT = new Set(['mp4', 'webm', 'ogv', 'ogg', 'mov', 'm4v']);

  /* ---------------- 初始化 ---------------- */
  async function init() {
    bindEvents();
    try {
      state.info = await api('/api/info');
      state.readOnly = !!state.info.readOnly;
      applyReadOnly();
      const ips = (state.info.lanIps || []);
      const port = state.info.port;
      const ip = ips[0] || location.hostname;
      el.addrHint.innerHTML =
        '局域网访问：<code>http://' + ip + ':' + port + '</code>' +
        (ips.length > 1 ? '（其他地址：' + ips.slice(1).join('、') + '）' : '');
      el.sharedDir.textContent = '共享目录：' + state.info.sharedDir;
    } catch (e) {
      if (e.message !== '登录已过期') el.addrHint.textContent = '地址获取失败，但服务可用';
    }
    await load('');
  }

  function applyReadOnly() {
    const badge = $('#roBadge');
    if (badge) badge.hidden = !state.readOnly;
    ['#btnUpload', '#btnFolder', '#btnText'].forEach((sel) => {
      const node = $(sel);
      if (node) node.disabled = state.readOnly;
    });
  }

  function bindEvents() {
    $('#btnRefresh').onclick = () => load(state.path);
    $('#btnUpload').onclick = () => {
      if (state.readOnly) return toast('只读模式，无法上传', 'err');
      el.fileInput.click();
    };
    $('#btnFolder').onclick = () => {
      if (state.readOnly) return toast('只读模式，无法新建', 'err');
      newFolderDialog();
    };
    $('#btnText').onclick = () => {
      if (state.readOnly) return toast('只读模式，无法新建', 'err');
      newTextDialog();
    };
    $('#btnCopy').onclick = copyAddress;
    const qrBtn = $('#btnQr');
    if (qrBtn) qrBtn.onclick = showQrDialog;
    const dropBtn = $('#btnDrop');
    if (dropBtn) dropBtn.onclick = showDropDialog;
    $('#btnRefresh').onclick = () => load(state.path);
    const logoutBtn = $('#btnLogout');
    if (logoutBtn) logoutBtn.onclick = logout;

    el.fileInput.onchange = (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length) upload(files);
      el.fileInput.value = '';
    };
    el.search.oninput = () => render();

    // 拖拽上传
    let dragDepth = 0;
    el.panel.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (state.readOnly) return;
      dragDepth++;
      el.panel.classList.add('dragging');
    });
    el.panel.addEventListener('dragover', (e) => e.preventDefault());
    el.panel.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (--dragDepth <= 0) { dragDepth = 0; el.panel.classList.remove('dragging'); }
    });
    el.panel.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      el.panel.classList.remove('dragging');
      if (state.readOnly) return toast('只读模式，无法上传', 'err');
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) upload(files);
    });

    // 编辑器
    $('#editorCancel').onclick = () => el.editor.classList.remove('show');
    $('#editorSave').onclick = saveEditor;
    el.editor.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') el.editor.classList.remove('show');
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!el.editorArea.readOnly) saveEditor();
      }
    });
    el.modal.addEventListener('click', (e) => {
      if (e.target === el.modal) el.modal.classList.remove('show');
    });
  }

  function copyAddress() {
    const ips = (state.info && state.info.lanIps) || [];
    const port = (state.info && state.info.port) || location.port;
    const url = ips.length ? 'http://' + ips[0] + ':' + port : location.origin;
    const done = () => toast('已复制：' + url, 'ok');

    /* iOS Safari 在 http（非 HTTPS）下 navigator.clipboard 是 undefined，
       而 document.execCommand('copy') 需要 textarea 在可视区域内、且处于焦点，
       否则会静默失败。这里把 textarea 定位成「不可见但仍在视口内」，
       并把 readOnly 打开避免弹出键盘。 */
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.cssText =
        'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;' +
        'border:0;outline:0;box-shadow:none;background:transparent;opacity:0.01;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      // iOS 需要显式设置选区，只 select() 有时选不中
      ta.setSelectionRange(0, url.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      if (ok) return done();
      // 彻底失败时把地址显示出来，让用户长按手动复制（iOS 上这是最稳的办法）
      showCopyDialog(url);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  /* 复制失败时的兜底：弹一个可长按选中的输入框 */
  function showCopyDialog(url) {
    openModal('手动复制地址',
      '<p style="color:#8b9bb4;font-size:12px;line-height:1.6;margin-bottom:10px">' +
        '当前浏览器不允许自动复制，请长按下面的地址全选后复制：</p>' +
      '<input id="dlgCopyUrl" readonly value="' + escapeHtml(url) + '" ' +
        'style="font-size:16px;text-align:center">',
      [{ text: '知道了', kind: 'primary', onClick: closeModal }]);
    setTimeout(() => {
      const n = $('#dlgCopyUrl');
      if (n) { n.focus(); n.select(); }
    }, 50);
  }

  /* ---------------- 手机扫码 ----------------
     手机上要敲 http://192.168.x.x:8080 再输 PIN，五步劝退。
     这里让电脑生成一张带一次性票据的二维码，手机扫一下直接登录。

     票据存在服务端内存里，10 分钟有效、只能用一次。
     所以二维码截图发给别人也没用（对方不在同一局域网，压根连不上）。 */
  async function showQrDialog() {
    // 手机上再弹二维码没意义，直接在按钮层就藏掉
    let ticket;
    try {
      const data = await api('/api/qr-ticket');
      ticket = data.ticket;
    } catch (e) {
      return toast('二维码生成失败：' + e.message, 'err');
    }

    const ips = (state.info && state.info.lanIps) || [];
    const port = (state.info && state.info.port) || location.port;
    // 优先用真实局域网 IP；万一只有回环地址，扫了也连不上，提示换设备
    const ip = ips[0];
    if (!ip) {
      return toast('没检测到局域网地址，请检查网络连接', 'err');
    }
    const url = 'http://' + ip + ':' + port + '/q/' + ticket;

    let svg = '';
    try {
      const qr = qrcode(0, 'M');   // 0 = 自动选版本，M = 中等纠错（屏幕上有反光也能扫）
      qr.addData(url);
      qr.make();
      // cellSize 6 + margin 3：在手机上看着够大，扫码枪/相机都好对
      svg = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
    } catch (e) {
      return toast('二维码绘制失败', 'err');
    }

    openModal('手机扫码连接',
      '<div class="qr-wrap">' +
        '<div class="qr-img">' + svg + '</div>' +
        '<p class="qr-tip">用手机相机或微信「扫一扫」对准二维码</p>' +
        '<p class="qr-note">手机要和电脑连同一个 WiFi。' +
          '二维码 10 分钟内有效，且只能用一次。</p>' +
        '<p class="qr-url"><code>' + escapeHtml(url) + '</code></p>' +
      '</div>',
      [{ text: '完成', kind: 'primary', onClick: closeModal }]);
  }

  async function logout() {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch (_) { /* 忽略 */ }
    location.replace('/login.html');
  }

  /* ---------------- 收件箱：手机往电脑投文件 ---------------- */
  /* 扫码登录那张票是一次性的、换登录态的，投文件用不了：
     手机点「选择文件」时页面会被系统切走，回来可能已换会话；
     而且要传多个文件，票据不能传一个就废。
     所以走 /api/drop-ticket 那套：可复用、只写不读、2 小时有效。 */
  let dropTimer = null;

  function stopDropPoll() {
    if (dropTimer) { clearInterval(dropTimer); dropTimer = null; }
  }

  async function showDropDialog() {
    let data;
    try {
      data = await api('/api/drop-ticket');
    } catch (e) {
      return toast('生成失败：' + e.message, 'err');
    }

    const ips = (state.info && state.info.lanIps) || [];
    const port = (state.info && state.info.port) || location.port;
    const ip = ips[0];
    if (!ip) return toast('没检测到局域网地址，请检查网络连接', 'err');

    const url = 'http://' + ip + ':' + port + '/d/' + data.ticket;

    let svg = '';
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      svg = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
    } catch (e) {
      return toast('二维码绘制失败', 'err');
    }

    openModal('收件箱',
      '<div class="qr-wrap">' +
        '<div class="qr-img">' + svg + '</div>' +
        '<p class="qr-tip">用手机扫这张码，选文件就自动传过来</p>' +
        '<p class="qr-note">手机要和电脑连同一个 WiFi。' +
          '这张码 <b>2 小时内可以反复用</b>，传多少个都行（上限 ' +
          data.maxFiles + ' 个）。</p>' +
        '<div class="drop-live" id="dropLive">' +
          '<span class="drop-dot"></span>' +
          '<span id="dropLiveText">正在等手机发送…</span>' +
        '</div>' +
        '<p class="qr-url"><code>' + escapeHtml(url) + '</code></p>' +
        '<p class="qr-note" style="margin-top:12px">' +
          '想让电脑给别人发文件，用上面的「手机扫码」；<br>' +
          '想让手机给你发文件，就用这张码。</p>' +
      '</div>',
      [
        { text: '在电脑上打开', kind: 'ghost', onClick: () => window.open(url, '_blank') },
        { text: '完成', kind: 'primary', onClick: closeModal },
      ]);

    // 轮询「已收几个」，让用户不用回头翻文件夹就知道传过来了
    let lastSeen = -1;
    const tick = async () => {
      if (!el.modal.classList.contains('show')) return stopDropPoll();
      try {
        const res = await fetch('/api/drop-info?ticket=' + encodeURIComponent(data.ticket),
                               { cache: 'no-store' });
        if (!res.ok) { stopDropPoll(); return; }
        const info = await res.json();
        const box = $('#dropLiveText');
        if (!box) return;
        const sent = info.sent || 0;
        if (sent > lastSeen && lastSeen >= 0) {
          box.innerHTML = '已收到 <b>' + sent + '</b> 个文件，正在刷新列表…';
          load(state.path);
        } else {
          box.innerHTML = sent
            ? '已收到 <b>' + sent + '</b> 个文件，继续扫着传就行'
            : '正在等手机发送…';
        }
        lastSeen = sent;
      } catch (_) { /* 掉线了就下一轮再试，不打断用户 */ }
    };
    stopDropPoll();
    dropTimer = setInterval(tick, 2000);
    tick();
  }

  /* ---------------- 加载与渲染 ---------------- */
  async function load(path) {
    try {
      const data = await api('/api/files?path=' + encodeURIComponent(path || ''));
      state.path = data.path || '';
      state.items = data.items || [];
      el.search.value = '';
      renderCrumbs();
      render();
    } catch (e) {
      if (e.message !== '登录已过期') toast(e.message, 'err');
    }
  }

  function renderCrumbs() {
    const parts = state.path ? state.path.split('/').filter(Boolean) : [];
    let html = '<span class="crumb ' + (parts.length ? '' : 'current') + '" data-path="">🏠 根目录</span>';
    let acc = '';
    parts.forEach((part, i) => {
      acc = acc ? acc + '/' + part : part;
      const isLast = i === parts.length - 1;
      html += '<span class="crumb-sep">/</span>' +
        '<span class="crumb ' + (isLast ? 'current' : '') + '" data-path="' +
        escapeHtml(acc) + '">' + escapeHtml(part) + '</span>';
    });
    el.crumbs.innerHTML = html;
    el.crumbs.querySelectorAll('.crumb').forEach((node) => {
      node.onclick = () => {
        if (node.classList.contains('current')) return;
        load(node.dataset.path || '');
      };
    });
  }

  function render() {
    const kw = el.search.value.trim().toLowerCase();
    let items = state.items;
    if (kw) items = items.filter((it) => it.name.toLowerCase().includes(kw));

    items = items.slice().sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

    el.count.textContent = '共 ' + items.length + ' 项' + (kw ? '（已筛选）' : '');

    if (!items.length) {
      el.list.innerHTML = '<div class="empty"><span class="big">' +
        (kw ? '🔍' : '📂') + '</span>' +
        (kw ? '没有匹配的文件' : '这里还是空的，上传文件或新建文件夹吧') + '</div>';
      return;
    }

    el.list.innerHTML = items.map((item) => {
      const meta = item.isDirectory
        ? '文件夹'
        : (item.sizeText || '') + ' · ' + item.updatedAt;
      return '<div class="item" data-path="' + escapeHtml(item.path) + '" data-dir="' + item.isDirectory + '">' +
        '<div class="item-icon">' + iconFor(item) + '</div>' +
        '<div class="item-main">' +
          '<div class="item-name" data-act="open" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</div>' +
          '<div class="item-meta">' + escapeHtml(meta) + '</div>' +
        '</div>' +
        '<div class="item-actions">' + actionButtons(item) + '</div>' +
      '</div>';
    }).join('');

    el.list.querySelectorAll('.item').forEach((row) => {
      const item = state.items.find((i) => i.path === row.dataset.path);
      if (!item) return;
      row.querySelector('[data-act="open"]').onclick = () => openItem(item);
      row.querySelectorAll('[data-act]').forEach((btn) => {
        const act = btn.dataset.act;
        if (act === 'open') return;
        btn.onclick = (e) => { e.stopPropagation(); handleAction(act, item); };
      });
    });
  }

  /* Safari（含 iOS）原生支持 HEIC，Chrome / Firefox / Windows 基本都不支持。
     只在 Safari 上给 HEIC 预览按钮，避免别的浏览器点了打不开还一脸疑惑。 */
  function isSafari() {
    const ua = navigator.userAgent;
    return /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/.test(ua);
  }

  function canPreview(item) {
    if (item.isDirectory) return false;
    const ext = item.ext;
    if (IMAGE_EXT.has(ext)) return true;
    if (HEIC_EXT.has(ext)) return isSafari();   // iPhone 拍的照
    if (VIDEO_EXT.has(ext)) return true;        // iPhone 录的 .mov
    if (ext === 'pdf' || ext === 'mp3' || ext === 'm4a' || ext === 'wav') return true;
    return false;
  }

  function actionButtons(item) {
    if (item.isDirectory) {
      return '<button class="btn sm" data-act="download">打包下载</button>' +
        (state.readOnly ? '' : '<button class="btn sm danger" data-act="delete">删除</button>');
    }
    const btn = [];
    if (TEXT_EXT.has(item.ext)) {
      btn.push('<button class="btn sm" data-act="' + (state.readOnly ? 'previewText' : 'edit') + '">' +
        (state.readOnly ? '查看' : '编辑') + '</button>');
    }
    if (canPreview(item)) {
      btn.push('<button class="btn sm" data-act="preview">预览</button>');
    }
    btn.push('<button class="btn sm" data-act="download">下载</button>');
    if (!state.readOnly) btn.push('<button class="btn sm danger" data-act="delete">删除</button>');
    return btn.join('');
  }

  function openItem(item) {
    if (!item) return;
    if (item.isDirectory) load(item.path);
    else if (TEXT_EXT.has(item.ext)) openEditor(item);
    else preview(item);
  }

  function handleAction(act, item) {
    if (act === 'edit') return openEditor(item);
    if (act === 'previewText') return openEditor(item, true);
    if (act === 'preview') return preview(item);
    if (act === 'download') return download(item);
    if (act === 'delete') return remove(item);
  }

  /* ---------------- 文件操作 ---------------- */
  function preview(item) {
    if (canPreview(item)) {
      window.open('/shared/' + encodePath(item.path), '_blank');
    } else {
      toast('该类型不支持预览，请下载后查看');
    }
  }

  function download(item) {
    const a = document.createElement('a');
    a.href = item.isDirectory
      ? '/api/zip/' + encodePath(item.path)
      : '/api/download/' + encodePath(item.path);
    // 文件夹是打包成 zip 下载的，名字必须带 .zip 后缀：
    // 服务端的 Content-Disposition 虽然写了 .zip，但 iOS Safari 会无视 <a download>
    // 和跨源分发头，最终用的是这里给的名字 —— 不带后缀就成了无类型文件，存不下来。
    a.download = item.isDirectory ? item.name + '.zip' : item.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function remove(item) {
    const ok = await confirmDialog('删除确认',
      '确定删除「' + item.name + '」吗？' +
      (item.isDirectory ? '\n文件夹内的所有内容都会被删除。' : '') + '\n此操作不可恢复。');
    if (!ok) return;
    try {
      await api('/api/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: item.path }),
      });
      toast('已删除', 'ok');
      load(state.path);
    } catch (e) { toast(e.message, 'err'); }
  }

  async function upload(files) {
    if (state.readOnly) return toast('只读模式，无法上传', 'err');
    el.uploadBar.hidden = false;
    el.progressFill.style.width = '0%';
    el.uploadInfo.textContent = '正在上传 ' + files.length + ' 个文件…';

    const form = new FormData();
    files.forEach((f) => form.append('file', f, f.name));

    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload?path=' + encodeURIComponent(state.path));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          el.progressFill.style.width = pct + '%';
          el.uploadInfo.textContent = '上传中… ' + pct + '%';
        }
      };
      xhr.onload = () => {
        if (xhr.status === 401) { location.replace('/login.html'); return resolve(); }
        if (xhr.status >= 200 && xhr.status < 300) {
          let n = files.length;
          let skipped = [];
          try {
            const res = JSON.parse(xhr.responseText);
            n = res.files.length;
            skipped = res.skipped || [];
          } catch (_) {}
          if (skipped.length) {
            toast('成功上传 ' + n + ' 个，跳过 ' + skipped.length + ' 个：' + skipped[0], 'err');
          } else {
            toast('成功上传 ' + n + ' 个文件', 'ok');
          }
        } else {
          let msg = '上传失败';
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
          toast(msg, 'err');
        }
        resolve();
      };
      xhr.onerror = () => { toast('网络错误，上传失败', 'err'); resolve(); };
      xhr.send(form);
    });

    el.uploadInfo.textContent = '完成';
    setTimeout(() => { el.uploadBar.hidden = true; }, 800);
    load(state.path);
  }

  /* ---------------- 弹窗 ---------------- */
  function openModal(title, bodyHtml, buttons) {
    el.modalTitle.textContent = title;
    el.modalBody.innerHTML = bodyHtml;
    el.modalActions.innerHTML = '';
    buttons.forEach((b) => {
      const node = document.createElement('button');
      node.className = 'btn ' + (b.kind || '');
      node.textContent = b.text;
      node.onclick = b.onClick;
      el.modalActions.appendChild(node);
    });
    el.modal.classList.add('show');
  }

  function closeModal() {
    el.modal.classList.remove('show');
    // 弹窗一关就停掉收件箱的轮询，不然页面在后台一直打请求
    if (typeof stopDropPoll === 'function') stopDropPoll();
  }

  function confirmDialog(title, message) {
    return new Promise((resolve) => {
      openModal(title,
        '<p style="white-space:pre-wrap;line-height:1.6;color:#c3cede">' + escapeHtml(message) + '</p>',
        [
          { text: '取消', kind: 'ghost', onClick: () => { closeModal(); resolve(false); } },
          { text: '确定删除', kind: 'danger', onClick: () => { closeModal(); resolve(true); } },
        ]);
    });
  }

  function newFolderDialog() {
    openModal('新建文件夹',
      '<label>文件夹名称</label><input id="dlgName" placeholder="例如：项目资料" autocomplete="off">',
      [
        { text: '取消', kind: 'ghost', onClick: closeModal },
        {
          text: '创建', kind: 'primary', onClick: async () => {
            const name = $('#dlgName').value.trim();
            if (!name) return toast('请填写文件夹名称', 'err');
            try {
              await api('/api/folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, path: state.path }),
              });
              closeModal();
              toast('文件夹已创建', 'ok');
              load(state.path);
            } catch (e) { toast(e.message, 'err'); }
          }
        },
      ]);
    setTimeout(() => { const n = $('#dlgName'); if (n) n.focus(); }, 30);
  }

  function newTextDialog() {
    openModal('新建文字文件',
      '<label>文件名</label><input id="dlgName" placeholder="例如：说明.txt 或 笔记.md" autocomplete="off">' +
      '<label>内容（可选）</label><textarea id="dlgContent" placeholder="在这里输入文字…"></textarea>',
      [
        { text: '取消', kind: 'ghost', onClick: closeModal },
        {
          text: '创建', kind: 'primary', onClick: async () => {
            const name = $('#dlgName').value.trim();
            const content = $('#dlgContent').value;
            if (!name) return toast('请填写文件名', 'err');
            try {
              await api('/api/file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, content, path: state.path }),
              });
              closeModal();
              toast('文件已创建', 'ok');
              load(state.path);
            } catch (e) { toast(e.message, 'err'); }
          }
        },
      ]);
    setTimeout(() => { const n = $('#dlgName'); if (n) n.focus(); }, 30);
  }

  /* ---------------- 编辑器 ---------------- */
  async function openEditor(item, readonly) {
    try {
      const data = await api('/api/read/' + encodePath(item.path));
      state.editing = item.path;
      const ro = !!(readonly || state.readOnly);
      el.editorTitle.textContent = (ro ? '查看：' : '编辑：') + item.name;
      el.editorArea.value = data.content || '';
      el.editorArea.readOnly = ro;
      const saveBtn = $('#editorSave');
      if (saveBtn) saveBtn.hidden = ro;
      el.editor.classList.add('show');
      el.editorArea.focus();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function saveEditor() {
    if (!state.editing || state.readOnly) return;
    try {
      await api('/api/read/' + encodePath(state.editing), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: el.editorArea.value }),
      });
      toast('已保存', 'ok');
      el.editor.classList.remove('show');
      load(state.path);
    } catch (e) { toast(e.message, 'err'); }
  }

  document.addEventListener('DOMContentLoaded', init);
})();