# 局域网文件共享（带 PIN 保护）

用 Python 标准库写的文件共享小工具，支持**文件上传下载、在线编辑文字、新建文件夹**，带 **PIN 访问密码**、**防暴力破解**和**只读模式**。不需要安装任何第三方依赖。

本项目提供**两种传输模式**，按场景选：

| 模式 | 场景 | 需要什么 |
| --- | --- | --- |
| 🏠 **局域网版**（本仓库主体） | 两台设备在同一个 WiFi / 同一个网络里 | 有 Python 就能跑，零依赖、零配置、数据不出内网 |
| 🌐 **公网快传**（`cloud-transfer/`） | 两个人在不同城市、不同网络，隔着互联网 | 已部署好，直接开网址用；每天有免费额度 |

> 🌐 **官网 / 在线演示**：https://ryan-cpu-lang.github.io/LanShare/
> 官网里嵌了一个**真的能点的演示版**——新建、编辑、上传、下载、打包 zip 全部可用，数据存在你自己的浏览器里（localStorage），不需要部署后端。
>
> 📡 **公网快传**：https://lanshare-relay.app.workbuddy.host/?sharecode=DUCZ4LTDLO
> 不在同一个局域网时用这个，上传拿 6 位取件码发给对方即可。

## 快速开始

1. 双击 `启动共享.bat`（或命令行 `python server.py`）
2. 控制台会显示：
   ```
   访问 PIN : 482913
   本机访问 : http://localhost:8080
   局域网   : http://192.168.1.93:8080
   ```
3. 浏览器打开地址 → 输入 PIN → 进入

> PIN 是首次启动时随机生成的 6 位数字，保存在 `config.json` 里，**可以自己改**。

## 修改 PIN

打开 `config.json`，改 `"pin"` 字段后重启服务：

```json
{
  "pin": "你的新密码",
  "session_hours": 12,
  "max_attempts": 5,
  "lock_seconds": 300,
  "read_only": false,
  "cookie_secure": false,
  "trust_proxy": false,
  "https": false
}
```

| 字段 | 说明 |
| --- | --- |
| `pin` | 访问密码，支持任意字符串（6~64 位都行） |
| `session_hours` | 登录后多久需要重新输入 PIN（小时） |
| `max_attempts` | 连续输错几次后锁定 |
| `lock_seconds` | 锁定时长（秒） |
| `read_only` | `true` 时只能浏览下载，不能上传/编辑/删除 |
| `cookie_secure` | 走 HTTPS 时设为 `true` |
| `trust_proxy` | 放在 Nginx / Cloudflare 后面时设为 `true` |
| `https` | 是否直接以 HTTPS 运行（需要证书） |

也可以用环境变量临时覆盖 PIN：`set SHARE_PIN=abc123 && python server.py`

## 安全机制

- **PIN 登录**：未登录时任何页面都跳转到登录页，所有接口返回 401
- **防暴力破解**：默认连错 5 次锁定 5 分钟（按 IP 统计）
- **签名会话**：登录凭证是 HMAC 签名的 HttpOnly Cookie，**伪造无效**
- **原子比较**：PIN 校验用 `hmac.compare_digest`，避免时序攻击
- **路径隔离**：所有文件操作限制在 `shared/` 内，`../` 越界会被拒绝
- **只读模式**：适合把资料公开给很多人看，但不想被改

## 功能

| 功能 | 说明 |
| --- | --- |
| 上传文件 | 点「上传文件」多选，或直接把文件拖进页面 |
| 下载文件 | 单个下载；文件夹打包成 zip |
| 新建文件夹 | 支持多级目录、中文名 |
| 新建 / 编辑文字 | 在线写 txt / md，Ctrl+S 保存 |
| 预览 | 图片、PDF、音频、视频浏览器直接打开 |
| 搜索 | 顶部搜索框过滤当前目录 |

文件都放在 `shared/` 目录，直接拷进去也会即时显示。

---

## ⚠️ 要放到公网？请务必读完

这个服务本身是**给局域网设计的**。直接暴露到公网有三个风险，必须处理：

### 1. HTTP 是明文的

PIN 和文件内容在网络上裸奔，同一个 WiFi、同一个运营商链路、任何中间节点都能看到。

**必须套 HTTPS。** 两种做法：

**做法 A：用 Cloudflare Tunnel（最省事，推荐）**

不用开路由器端口、不用公网 IP，还自带 HTTPS 和额外一层访问控制：

```bash
# 安装 cloudflared 后
cloudflared tunnel --url http://localhost:8080
```

它会给你一个 `https://xxxx.trycloudflare.com` 地址。然后把 `config.json` 里 `"trust_proxy": true`、`"cookie_secure": true` 打开，重启服务。

更安全的做法是在 Cloudflare 后台开 **Access**，要求邮箱验证，这样连 PIN 都不用暴露。

**做法 B：自建 HTTPS**

用 `make_cert.py` 生成自签名证书（测试用），或买/申请正式证书：

```bash
python make_cert.py 你的域名
```

然后 `config.json` 里 `"https": true`，重启。自签名证书浏览器会警告，正式对外请用 Let's Encrypt 或 mkcert。

**做法 C：Nginx / Caddy 反向代理**

Caddy 最简单，自动申请证书：

```
你的域名 {
    reverse_proxy 127.0.0.1:8080
}
```

同样记得把 `trust_proxy` 和 `cookie_secure` 设为 `true`。

### 2. PIN 只有 6 位数字的话，公网扛不住

6 位数字只有 100 万种组合，分布式撞库是能撞开的。公网使用时：

- 把 PIN 改成**长随机字符串**，例如 `config.json` 里写 `"pin": "k7Qm2xP9vL4nR8tW"`
- 或者用做法 A 的 Cloudflare Access，直接用人身份验证替代 PIN
- 保持 `max_attempts` 较小（5 次），锁定时间可以调长

### 3. 默认是所有人可读写

公网上别人登进来能删你的文件。如果只是分享资料：

- 把 `"read_only": true` 打开
- 或者干脆用网盘的分享链接功能

### 不建议的做法

- ❌ 直接在路由器上把 8080 端口映射到公网，且用 6 位 PIN
- ❌ 用 HTTP + 简单的 PIN 分享私人文件
- ❌ 把 `config.json`、`.session_secret` 提交到公开仓库（已在 `.gitignore` 里）

---

## 公网快传（跨网络传输）

上面那套是**局域网**方案——两台设备必须在同一个网络里。如果对方在另一个城市、
另一个运营商，甚至只是不在同一个 WiFi，就需要这条公网链路。

### 怎么用

1. 打开 https://lanshare-relay.app.workbuddy.host/?sharecode=DUCZ4LTDLO
2. 手机号登录（首次自动注册，不用设密码）
3. 「发送」标签页选文件 → 上传 → 页面给出 **6 位取件码**
4. 把取件码发给对方，对方在同网址「取件」页输入即可下载

### 额度限制

每天有免费额度，次日零点（北京时间）重置：

| 项目 | 额度 |
| --- | --- |
| 每日总流量 | 500 MB |
| 每日传输次数 | 20 次 |
| 单文件大小 | 100 MB |
| 单次文件数 | 20 个 |
| 默认有效期 | 7 天（可主动撤销，到期自动清理） |

超过额度会返回明确错误（`daily_bytes` / `daily_count` / `too_large` / `too_many_files`），
页面会直接告诉你还差多少、什么时候重置。

### 和局域网版的区别

| | 局域网版 | 公网快传 |
| --- | --- | --- |
| 网络要求 | 同一局域网 | 任意网络 |
| 数据落地 | 你自己的电脑 `shared/` | 云端对象存储 |
| 鉴权 | 6 位 PIN | 手机号登录 |
| 文件保留 | 永久（你自己删） | 到期自动删除 |
| 需要部署 | 需要（有 Python 就行） | 不需要，已上线 |
| 是否需要账号 | 不需要 | 需要（平台存储的硬性限制） |

### 技术实现

`cloud-transfer/` 是纯前端（无构建步骤），后端是**托管云服务**：

```
cloud-transfer/
  index.html        两视图：登录 / 主界面（发送·取件·我的传输）
  app.js            全部业务逻辑（842 行，无框架、无打包）
  style.css         深色主题
  config.js         ★ publicConfig：端点、OAuth 中转、publishable key（可公开）
```

后端（PostgreSQL + 对象存储）关键设计：

| 组件 | 作用 |
| --- | --- |
| `transfers` / `transfer_files` | 传输单与文件清单，RLS 只允许本人读写 |
| `transfer_usage` | 按 `(owner_id, day)` 记账，主键天然唯一 |
| `create_transfer()` | `SECURITY DEFINER`，函数内**原子**完成校验 + 扣额度 + 发取件码 |
| `get_transfer()` | 凭取件码读取，跨用户可读（不走 RLS，走函数） |
| `bump_download()` | 下载计数，与取件解耦 |
| `my_transfer_usage()` | 返回当日已用 / 上限，驱动页面额度条 |
| `ls_uid()` | ★ 过滤平台自动签发的**匿名 JWT**（见下） |

两个踩过的坑，写下来给以后的人省时间：

1. **跨用户下载必须用 `shared/<uid>/` 路径。** `users/<uid>/` 只有 owner 能签名，
   接收方生成下载链接会 403。存储 SDK 里是 `cloud.storage.sharedPath()`。
2. **平台会给未登录访客自动签发匿名 JWT**，`auth.uid()` 返回字符串 `'anon'`
   而不是 `NULL`，导致所有 `IF uid IS NULL` 判断失效。所以单独写了 `ls_uid()`
   同时检查 `'anon'` 和 claims 里的 `is_anonymous`。

此外「每日额度」是**在数据库函数里用行锁扣减**的，不是前端算的——
前端只负责显示，改前端数值骗不过去。

### 已知限制

- **收发双方都必须登录**。存储层不认匿名会话（返回 `MISSING_CREDENTIALS`），
  这是平台约束，不是实现选择。所以登录页明确写了「请把取件码发给同样注册了本站的人」。
- **分享链接必须带 `?sharecode=`** 参数（首次访问需要，之后靠 Cookie 记住 30 天）。
  直接复制浏览器地址栏的完整 URL 就没问题。

### 重新部署

`cloud-transfer/` 是纯静态文件，改完直接重新发布即可，无需构建：

```bash
# 依赖 @tencent-ai/workbuddy-cloud-sdk 的 CDN 版本，由 index.html 直接 <script> 引入
# 改完 app.js 后重新发布到云端应用
```

---

## 常见问题

**其他设备打不开？**

- 确认在同一个局域网
- Windows 防火墙放行：右键 [放行防火墙.bat](放行防火墙.bat) → 以管理员身份运行
- 有虚拟机网卡时可能打印多个 IP，换一个试试

**忘记 PIN 了？**

看 `config.json` 里的 `"pin"`，或者删掉它重启（会重新生成，但 `read_only` 等设置也会重置）。

**端口被占用？**

```bash
set PORT=9000 && python server.py
```

**重启后还要重新登录吗？**

不需要，会话密钥存在 `.session_secret`，重启后已有 Cookie 仍然有效，直到 `session_hours` 到期。

## 文件说明

```
server.py           后端（标准库，含 PIN 鉴权、限流、HTTPS）
make_cert.py        生成自签名证书
config.json         PIN 与各项配置（含密码，勿外传）
.session_secret     会话签名密钥（勿外传）
public/
  index.html        文件管理页
  app.js / style.css
  login.html        登录页
  login.js / login.css
shared/             共享目录
cloud-transfer/     ★ 公网快传（纯静态前端 + 托管云服务）
  index.html
  app.js
  style.css
  config.js
启动共享.bat        Windows 双击启动
放行防火墙.bat      一键放行 8080 端口
```

## 官网与在线演示（GitHub Pages）

仓库里的 `docs/` 目录就是 GitHub Pages 站点根目录：

```
docs/
  index.html        官网落地页（介绍 + 内嵌演示）
  demo/             在线演示版（纯静态，无后端）
    index.html      由 public/index.html 改写而来
    app.js          与原版完全相同的业务逻辑
    style.css       原样式
    mock-api.js     ★ 关键：在浏览器里模拟整个后端
```

`docs/demo/` **不是手写的第二份代码**，而是从 `public/` 构建出来的：

```bash
python site/build_demo.py
```

构建脚本做三件事：

1. 复制 `public/index.html`，把 `/style.css`、`/app.js` 改成相对路径；
2. 在 `app.js` 之前插入 `site/demo-assets/mock-api.js`；
3. 注入一条「在线演示」提示条，并生成 `docs/.nojekyll`（绕过 Jekyll）。

### mock-api.js 是怎么让静态页面「跑起来」的

它不改 `app.js` 一行代码，只在网络层做替换：

| 原版依赖 | 演示版接管方式 |
| --- | --- |
| `fetch('/api/...')` | 覆写 `window.fetch`，路由到内存中的虚拟文件系统 |
| `XMLHttpRequest`（上传进度） | 覆写 `window.XMLHttpRequest`，用定时器模拟进度事件 |
| `<a href="/api/download/...">` 的 `click()` | 覆写 `HTMLAnchorElement.prototype.click`，改成生成 blob 下载 |
| `/api/zip/...` 打包 | 纯 JS 现算 ZIP（CRC32 + local/central directory + EOCD），无第三方库 |
| `window.open('/shared/...')` 预览 | 覆写 `window.open`，用 blob URL 打开 |

虚拟文件系统存在 `localStorage`，所以刷新不丢。文件名校验规则（非法字符、Windows 保留名 `CON`/`NUL` 等）与服务端保持一致。

### 本地预览官网

```bash
python -m http.server 18100 --directory docs
# 打开 http://127.0.0.1:18100/
```

### 自动化测试

`site/test_demo.js` 用 Playwright 真跑一遍 15 项交互（新建/编辑/搜索/删除/上传/下载/打包/刷新持久化/控制台无报错）。需要 `playwright-core`：

```bash
node site/test_demo.js http://127.0.0.1:18100/demo/
```

### 发布到 GitHub Pages

仓库 **Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/docs`**，保存后等一两分钟即可。

## 许可证

[MIT](LICENSE)
