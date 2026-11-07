/*
 * LanShare 在线演示 —— 纯前端模拟后端
 *
 * GitHub Pages 只能托管静态文件，没有 Python 运行时。
 * 这个脚本在浏览器里拦截所有 /api/* 请求，用一个虚拟文件系统（存在
 * localStorage）来应答，让「上传 / 新建 / 编辑 / 删除 / 搜索 / 下载」
 * 在演示页里全部真实可操作，但数据永远不会离开你的浏览器。
 *
 * 它不修改 app.js / index.html，只替换网络层。
 */
(function () {
  'use strict';

  var STORE = 'lanshare_demo_vfs_v1';
  var MIN = 60000;
  var NOW = Date.now();

  /* ================= 虚拟文件系统 =================
     节点：{ t: 'file'|'dir', text: string|null, data: dataURL|null, m: mtime } */
  function file(text, m) { return { t: 'file', text: text, data: null, m: m }; }
  function dirNode(m) { return { t: 'dir', text: null, data: null, m: m }; }

  function seed() {
    var fs = {};
    fs['README 先看我.txt'] = file(
      '这里是 LanShare 的在线演示，页面上的每个操作都是真的：\n\n' +
      '  · 上传文件 —— 点按钮，或者把文件直接拖进列表\n' +
      '  · 新建文件夹 / 新建文字\n' +
      '  · 点文字文件名在线编辑，Ctrl + S 保存\n' +
      '  · 删除、搜索、面包屑跳转\n\n' +
      '唯一的区别：数据存在你浏览器的 localStorage 里，\n' +
      '刷新还在，换个浏览器就没了 —— 它不会上传到任何服务器。\n\n' +
      '真实的 LanShare 跑在你自己电脑上，共享目录就是 ./shared，\n' +
      '同一个 WiFi 下的手机平板都能直接访问。\n', NOW - 8 * MIN);

    fs['项目资料'] = dirNode(NOW - 2880 * MIN);
    fs['项目资料/需求文档.md'] = file(
      '# 局域网文件共享 · 需求\n\n' +
      '## 目标\n' +
      '在同一个 WiFi 下把文件从电脑扔到手机、平板、别人的笔记本，\n' +
      '不用微信压缩、不用登网盘、不用插 U 盘。\n\n' +
      '## 硬性约束\n' +
      '- 不装任何第三方依赖（纯 Python 标准库）\n' +
      '- 双击就能跑，命令行参数一律可省\n' +
      '- 默认带访问密码，不能谁连上 WiFi 谁就能看\n\n' +
      '## 验收标准\n' +
      '1. 手机浏览器打开 http://192.168.x.x:8080 能进\n' +
      '2. 上传 200MB 视频不断\n' +
      '3. 连错 5 次 PIN 后锁 5 分钟\n' +
      '4. 视频能拖进度条（Range 请求）\n', NOW - 2880 * MIN);

    fs['项目资料/会议记录.txt'] = file(
      '2026-11-07  局域网共享方案讨论\n\n' +
      '结论：\n' +
      '  · 走纯标准库，不引 Flask —— 理由是「拷走一个文件就能跑」\n' +
      '  · PIN 用 hmac.compare_digest 比较，避开时序攻击\n' +
      '  · 路径一律过 realpath 校验，挡住 ../ 穿越\n' +
      '  · 会话用 HMAC 签名 cookie，服务端不存 session\n' +
      '  · 上传文件名要白名单校验，Windows 上 os.path.basename\n' +
      '    会把 a:b.txt 截成 b.txt，必须先验原始名\n', NOW - 1440 * MIN);

    fs['项目资料/接口清单.txt'] = file(
      'GET    /api/info              服务信息（端口、共享目录、只读）\n' +
      'GET    /api/files?path=       列目录\n' +
      'POST   /api/login             PIN 登录\n' +
      'POST   /api/logout            退出\n' +
      'POST   /api/upload?path=      上传（multipart）\n' +
      'POST   /api/folder            新建文件夹\n' +
      'POST   /api/file              新建文字文件\n' +
      'GET    /api/read/<path>       读文本\n' +
      'PUT    /api/read/<path>       写文本\n' +
      'DELETE /api/delete            删除\n' +
      'GET    /api/download/<path>   下载（支持 Range）\n' +
      'GET    /api/zip/<dir>         文件夹打包下载\n', NOW - 600 * MIN);

    fs['截图'] = dirNode(NOW - 1200 * MIN);
    fs['截图/放这里.txt'] = file(
      '手机截图、平板截图都丢这个目录，\n同一个 WiFi 下随时能拿，不用再发微信给自己。\n', NOW - 1200 * MIN);

    return fs;
  }

  var fs;
  try {
    var raw = localStorage.getItem(STORE);
    fs = raw ? JSON.parse(raw) : null;
  } catch (e) { fs = null; }
  if (!fs || typeof fs !== 'object' || !Object.keys(fs).length) {
    fs = seed();
    persist();
  }

  function persist() {
    try {
      localStorage.setItem(STORE, JSON.stringify(fs));
      return true;
    } catch (e) {
      // 配额满了（演示环境一般 5MB），提示一次就够
      if (!persist._warned) {
        persist._warned = true;
        alert('演示环境的浏览器存储已满（约 5MB），本次修改不会被保存。\n真实部署时文件是存到磁盘的，没有这个限制。');
      }
      return false;
    }
  }

  /* ================= 工具 ================= */
  function norm(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }
  function baseName(p) {
    var i = p.lastIndexOf('/');
    return i < 0 ? p : p.slice(i + 1);
  }
  function join(a, b) { return a ? a + '/' + b : b; }
  function extOf(name) {
    var i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
  }
  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function stamp(ms) {
    var d = new Date(ms || NOW);
    function p2(x) { return x < 10 ? '0' + x : '' + String(x); }
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
      ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function nodeSize(node) {
    if (!node) return 0;
    if (node.data) return Math.round(node.data.length * 0.72);
    if (node.text != null) return new Blob([node.text]).size;
    return 0;
  }
  function decodeRelPath(encoded) {
    return String(encoded || '').split('/').map(function (s) {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    }).join('/');
  }
  function jsonResp(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  function fail(status, msg) { return jsonResp({ error: msg }, status); }
  function parseJson(body) {
    if (!body) return {};
    if (typeof body === 'string') {
      try { return JSON.parse(body); } catch (e) { return null; }
    }
    return {};
  }
  function pickQuery(qs, key) {
    var re = new RegExp('(?:^|&)' + key + '=([^&]*)');
    var m = re.exec(qs || '');
    if (!m) return '';
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { return m[1]; }
  }

  function childrenOf(dirPath) {
    var prefix = dirPath ? dirPath + '/' : '';
    var out = [];
    Object.keys(fs).forEach(function (p) {
      if (prefix && p.indexOf(prefix) !== 0) return;
      if (!prefix && p.indexOf('/') >= 0) return;
      var rest = p.slice(prefix.length);
      if (!rest || rest.indexOf('/') >= 0) return;
      out.push(p);
    });
    return out;
  }

  function uniquePath(dirPath, name) {
    var target = join(dirPath, name);
    if (!fs[target]) return target;
    var dot = name.lastIndexOf('.');
    var stem = dot > 0 ? name.slice(0, dot) : name;
    var tail = dot > 0 ? name.slice(dot) : '';
    var i = 1;
    while (fs[join(dirPath, stem + ' (' + i + ')' + tail)]) i += 1;
    return join(dirPath, stem + ' (' + i + ')' + tail);
  }

  function badName(name) {
    return /[<>:"/\\|?*]/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name);
  }

  /* ================= 业务路由 ================= */
  function apiList(path) {
    var p = norm(path);
    if (p && !fs[p]) return fail(404, '目录不存在');
    if (p && fs[p].t !== 'dir') return fail(400, '不是目录');
    var items = childrenOf(p).map(function (key) {
      var node = fs[key];
      var name = baseName(key);
      var isDir = node.t === 'dir';
      var size = isDir ? 0 : nodeSize(node);
      return {
        name: name,
        path: key,
        isDirectory: isDir,
        size: size,
        sizeText: isDir ? '' : humanSize(size),
        ext: isDir ? '' : extOf(name),
        updatedAt: stamp(node.m),
        mtime: node.m || NOW,
      };
    });
    return jsonResp({ path: p, items: items });
  }

  function apiRead(path) {
    var node = fs[path];
    if (!node || node.t !== 'file') return fail(404, '文件不存在');
    if (node.data && node.text == null) {
      return fail(415, '二进制文件无法在线编辑，请下载后查看');
    }
    return jsonResp({
      path: path,
      content: node.text == null ? '' : node.text,
      name: baseName(path),
    });
  }

  function apiWrite(path, body) {
    var node = fs[path];
    if (!node || node.t !== 'file') return fail(404, '文件不存在');
    var data = parseJson(body);
    if (!data) return fail(400, '请求格式错误');
    node.text = String(data.content == null ? '' : data.content);
    node.data = null;
    node.m = Date.now();
    persist();
    return jsonResp({ ok: true });
  }

  function apiMkdir(body) {
    var data = parseJson(body);
    if (!data) return fail(400, '请求格式错误');
    var name = String(data.name || '').trim();
    if (!name) return fail(400, '请填写文件夹名称');
    if (badName(name)) return fail(400, '文件夹名称包含非法字符');
    fs[uniquePath(norm(data.path), name)] = dirNode(Date.now());
    persist();
    return jsonResp({ ok: true });
  }

  function apiMkfile(body) {
    var data = parseJson(body);
    if (!data) return fail(400, '请求格式错误');
    var name = String(data.name || '').trim();
    if (!name) return fail(400, '请填写文件名');
    if (badName(name)) return fail(400, '文件名包含非法字符');
    if (name.indexOf('.') < 0) name += '.txt';
    fs[uniquePath(norm(data.path), name)] = file(String(data.content || ''), Date.now());
    persist();
    return jsonResp({ ok: true });
  }

  function apiDelete(body) {
    var data = parseJson(body);
    if (!data) return fail(400, '请求格式错误');
    var p = norm(data.path);
    if (!p || !fs[p]) return fail(404, '文件不存在');
    var prefix = p + '/';
    Object.keys(fs).forEach(function (k) {
      if (k === p || k.indexOf(prefix) === 0) delete fs[k];
    });
    persist();
    return jsonResp({ ok: true });
  }

  function route(url, method, body) {
    var qs = url.indexOf('?') >= 0 ? url.slice(url.indexOf('?') + 1) : '';
    var path = url.split('?')[0];

    if (path === '/api/auth-status') {
      return jsonResp({ authed: true, readOnly: false, lockedFor: 0 });
    }
    if (path === '/api/info') {
      return jsonResp({
        host: '0.0.0.0',
        port: 8080,
        sharedDir: 'shared',
        lanIps: ['192.168.1.93'],
        readOnly: false,
        demo: true,
      });
    }
    if (path === '/api/login') return jsonResp({ ok: true });
    if (path === '/api/logout') return jsonResp({ ok: true });
    if (path === '/api/files') return apiList(pickQuery(qs, 'path'));
    if (path.indexOf('/api/read/') === 0) {
      var rel = decodeRelPath(path.slice('/api/read/'.length));
      return method === 'PUT' ? apiWrite(rel, body) : apiRead(rel);
    }
    if (path === '/api/folder' && method === 'POST') return apiMkdir(body);
    if (path === '/api/file' && method === 'POST') return apiMkfile(body);
    if (path === '/api/delete') return apiDelete(body);
    if (path.indexOf('/api/upload') === 0) return jsonResp({ ok: true, files: [], skipped: [] });
    return fail(404, '演示环境未实现该接口');
  }

  /* ================= 拦截 fetch ================= */
  var realFetch = window.fetch ? window.fetch.bind(window) : null;

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/') !== 0) {
      return realFetch ? realFetch(input, init) : Promise.reject(new Error('no fetch'));
    }
    var method = ((init && init.method) || 'GET').toUpperCase();
    var body = init && init.body;
    try {
      return Promise.resolve(route(url, method, body));
    } catch (e) {
      return Promise.resolve(fail(500, '演示环境出错：' + e.message));
    }
  };

  /* ================= 拦截 XMLHttpRequest（上传走它） ================= */
  function MockXHR() {
    this.upload = {};
    this.status = 0;
    this.responseText = '';
    this.readyState = 0;
    this.onload = null;
    this.onerror = null;
  }
  MockXHR.prototype.open = function (method, url) {
    this._method = method;
    this._url = url;
  };
  MockXHR.prototype.setRequestHeader = function () {};
  MockXHR.prototype.getResponseHeader = function () { return null; };
  MockXHR.prototype.abort = function () {};
  MockXHR.prototype.addEventListener = function () {};
  MockXHR.prototype.send = function (form) {
    var self = this;
    var dirPath = norm(pickQuery((this._url || '').split('?')[1], 'path'));
    var files = [];
    if (form && form.getAll) {
      try { files = form.getAll('file') || []; } catch (e) { files = []; }
    }
    if (!files.length) {
      setTimeout(function () {
        self.status = 400;
        self.responseText = JSON.stringify({ error: '没有收到文件' });
        if (self.onload) self.onload();
      }, 150);
      return;
    }

    var total = files.reduce(function (s, f) { return s + (f.size || 1); }, 0) || 1;
    var progress = 0;
    var timer = setInterval(function () {
      progress = Math.min(1, progress + 0.2);
      if (self.upload && self.upload.onprogress) {
        self.upload.onprogress({
          lengthComputable: true,
          loaded: Math.round(total * progress),
          total: total,
        });
      }
      if (progress >= 1) {
        clearInterval(timer);
        commit();
      }
    }, 80);

    function commit() {
      var saved = [];
      var skipped = [];
      var pending = files.length;

      files.forEach(function (f) {
        var name = f.name || 'file';
        if (badName(name)) {
          skipped.push(name + ': 文件名包含非法字符');
          pending -= 1;
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          var target = uniquePath(dirPath, name);
          fs[target] = { t: 'file', data: reader.result, text: null, m: Date.now() };
          saved.push({ name: baseName(target), size: f.size, sizeText: humanSize(f.size) });
          if (--pending === 0) done();
        };
        reader.onerror = function () {
          skipped.push(name + ': 读取失败');
          if (--pending === 0) done();
        };
        reader.readAsDataURL(f);
      });
      if (pending === 0) done();

      function done() {
        persist();
        self.status = saved.length ? 200 : 400;
        self.responseText = JSON.stringify(saved.length
          ? { ok: true, files: saved, skipped: skipped }
          : { error: skipped[0] || '没有可保存的文件' });
        if (self.onload) self.onload();
      }
    }
  };
  window.XMLHttpRequest = MockXHR;

  /* ================= 下载 / 预览 ================= */
  function dataUrlToBytes(dataUrl) {
    var idx = dataUrl.indexOf(',');
    var meta = dataUrl.slice(0, idx);
    var payload = dataUrl.slice(idx + 1);
    var bin;
    if (meta.indexOf('base64') >= 0) {
      bin = atob(payload);
    } else {
      bin = decodeURIComponent(payload);
    }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function nodeToBytes(node) {
    if (node.data) {
      try { return dataUrlToBytes(node.data); } catch (e) { return new Uint8Array(0); }
    }
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(node.text == null ? '' : node.text);
    }
    var s = node.text == null ? '' : node.text;
    var buf = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i) & 0xff;
    return buf;
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  /* 极简 ZIP（store，无压缩）—— 够用来演示文件夹打包 */
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosTime(ms) {
    var d = new Date(ms || NOW);
    var time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    var date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  function buildZip(entries) {
    var parts = [];
    var central = [];
    var offset = 0;

    entries.forEach(function (item) {
      var nameBytes = new TextEncoder().encode(item.name);
      var data = item.bytes;
      var crc = crc32(data);
      var dt = dosTime(item.m);

      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);   // UTF-8 文件名
      lv.setUint16(8, 0, true);        // store
      lv.setUint16(10, dt.time, true);
      lv.setUint16(12, dt.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      parts.push(local, data);

      var cen = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dt.time, true);
      cv.setUint16(14, dt.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);

      offset += local.length + data.length;
    });

    var centralSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    var all = parts.concat(central, [end]);
    var totalLen = all.reduce(function (s, a) { return s + a.length; }, 0);
    var out = new Uint8Array(totalLen);
    var pos = 0;
    all.forEach(function (a) { out.set(a, pos); pos += a.length; });
    return out;
  }

  function zipFolder(dirPath) {
    var prefix = dirPath + '/';
    var entries = Object.keys(fs).filter(function (k) {
      return k.indexOf(prefix) === 0 && fs[k].t === 'file';
    }).map(function (k) {
      return {
        name: k.slice(prefix.length),
        bytes: nodeToBytes(fs[k]),
        m: fs[k].m,
      };
    });
    if (!entries.length) entries.push({ name: '空文件夹.txt', bytes: new Uint8Array(0), m: Date.now() });
    return buildZip(entries);
  }

  function downloadNode(path) {
    var node = fs[path];
    if (!node) return false;
    var name = baseName(path);
    if (node.t === 'dir') {
      var zipBytes = zipFolder(path);
      saveBlob(new Blob([zipBytes], { type: 'application/zip' }), name + '.zip');
    } else {
      var bytes = nodeToBytes(node);
      saveBlob(new Blob([bytes], { type: 'application/octet-stream' }), name);
    }
    return true;
  }

  function previewNode(path) {
    var node = fs[path];
    if (!node || node.t !== 'file') return false;
    var name = baseName(path);
    var e = extOf(name);
    var mime = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
      pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm',
      mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
    }[e];
    if (!mime) return false;
    var blob = new Blob([nodeToBytes(node)], { type: mime });
    var url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    return true;
  }

  /* 拦 <a download> 的点击：app.js 里下载是创建临时 <a> 再 click() */
  var nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var href = this.getAttribute('href') || '';
    if (href.indexOf('/api/download/') === 0) {
      downloadNode(decodeRelPath(href.slice('/api/download/'.length)));
      return;
    }
    if (href.indexOf('/api/zip/') === 0) {
      downloadNode(decodeRelPath(href.slice('/api/zip/'.length)));
      return;
    }
    return nativeClick.call(this);
  };

  /* 拦 window.open('/shared/...') 的预览 */
  var realOpen = window.open;
  window.open = function (url) {
    if (typeof url === 'string' && url.indexOf('/shared/') === 0) {
      var ok = previewNode(decodeRelPath(url.slice('/shared/'.length)));
      if (ok) return null;
      alert('演示环境里这个文件不支持在线预览，请下载后查看。');
      return null;
    }
    return realOpen.apply(window, arguments);
  };
})();
