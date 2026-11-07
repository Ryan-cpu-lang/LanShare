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

### 方式一：下载 exe 直接用（推荐，不用装 Python）

1. 到 [Releases](https://github.com/Ryan-cpu-lang/lanshare/releases) 下载 `LanShare.exe`
2. 双击它 —— 浏览器会自动打开页面，控制台窗口里能看到 PIN 和手机访问地址
3. 手机连**同一个 WiFi**，用相机或微信扫页面上的二维码，直接进，不用输地址也不用输 PIN

> 换电脑用的话，把这一个 exe 拷过去就行，8.6 MB，免安装。
> `shared/` 文件夹和 `config.json` 会在 exe 旁边自动生成——**想换 PIN 就改 config.json，想放文件就丢进 shared/**。
> 关闭那个黑色窗口 = 停止服务。

### 方式二：跑源码

1. 双击 `启动共享.bat`（或命令行 `python server.py`）
2. 控制台会显示：
   ```
   共享目录 : E:\...\shared
   访问 PIN : 482913
   手机访问 : http://192.168.1.93:8080
   本机访问 : http://localhost:8080
   ```
3. 浏览器打开地址 → 输入 PIN → 进入

> PIN 是首次启动时随机生成的 6 位数字，保存在 `config.json` 里，**可以自己改**。

## 手机怎么连（三种方式，从省事到麻烦）

| 方式 | 操作 | 适合 |
|---|---|---|
| **扫码** | 电脑页面点「📱 手机扫码」→ 手机扫一下 | 默认用这个，一步到位 |
| 输地址 | 手机浏览器敲 `http://192.168.x.x:8080` → 输 PIN | 二维码打不开时兜底 |
| 发链接 | 电脑点「复制地址」，把链接发到微信/QQ 自己点开 | 手机不在身边 |

扫码走的是**一次性票据**：二维码里带的是 `/q/<票据>`，10 分钟内有效、**只能用一次**，
用过或过期都会显示「二维码已失效」，引导去输 PIN。所以截图发给别人也没用
（对方不在同一局域网，压根连不上）。

> 📱 **手机能上传，也能下载**，不是只能看。手机页面上的「上传文件」按钮和电脑上完全一样，
> 拍照、选相册里的照片、选手机里的文件都行，一次能选多个。

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
2. 登录（**邮箱**或**手机号**任选一种，首次自动注册，不用设密码）
3. 「发送」标签页选文件 → 上传 → 页面给出 **6 位取件码**
4. 把取件码发给对方，对方在同网址「取件」页输入即可下载

> 邮箱登录是默认方式，验证码会发到邮箱（没收到就先看垃圾箱）。手机号走短信，
> 平台对单个号码有每日条数上限，自己测的时候别反复点「重发」。

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
| 鉴权 | 6 位 PIN | 邮箱 / 手机号登录（验证码，无密码） |
| 文件保留 | 永久（你自己删） | 到期自动删除 |
| 需要部署 | 需要（有 Python 就行） | 不需要，已上线 |
| 是否需要账号 | 不需要 | 需要（平台存储的硬性限制） |

### 技术实现

`cloud-transfer/` 是纯前端（无构建步骤），后端是**托管云服务**：

```
cloud-transfer/
  index.html        两视图：登录 / 主界面（发送·取件·我的传输）
  app.js            全部业务逻辑（无框架、无打包）
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

登录用平台的 OTP（验证码）能力，邮箱和手机号是**两套独立开关**：

| 方式 | SDK 调用 | 说明 |
| --- | --- | --- |
| 邮箱（默认） | `sendOtp({ email })` → `verifyOtp({ email, … })` | 不受短信限额影响，验证码有延迟、可能进垃圾箱 |
| 手机号 | `sendOtp({ phone })` → `verifyOtp({ phone, … })` | 到得快，但单号码每日有发送条数上限 |
| 微信扫码 | `signInWithOAuth({ provider: 'wechat' })` → `handleWechatWebCallback()` | 需要平台侧配好微信回调域 |

两种 OTP 都必须**先发码、再验证**：`sendOtp` 的返回值（`verificationId` + `isExistingUser`）
要存到组件状态里，提交时原样回传，不能用 `sendOtp` 去做验证。切换登录方式时旧验证码要作废，
避免「拿邮箱的码去提交手机号」这类错配。

### 已知限制

- **收发双方都必须登录**。存储层不认匿名会话（返回 `MISSING_CREDENTIALS`），
  这是平台约束，不是实现选择。所以登录页明确写了「请把取件码发给同样注册了本站的人」。
- **登录支持邮箱和手机号两种方式**，都是 6 位验证码，首次登录自动注册、不用设密码。
  邮箱是默认方式；手机号受平台短信限制——**单个号码每天有发送条数上限**，
  超额会返回 `LimitExceeded.PhoneNumberDailyLimit`，第二天恢复。
- **邮箱验证码可能进垃圾箱**。发件人是平台统一地址，第一次收最好去垃圾箱里翻一下并标为「非垃圾」。
- **分享链接必须带 `?sharecode=`** 参数（首次访问需要，之后靠 Cookie 记住 30 天）。
  直接复制浏览器地址栏的完整 URL 就没问题。

### 重新部署

`cloud-transfer/` 是纯静态文件，改完直接重新发布即可，无需构建：

```bash
# 依赖 @tencent-ai/workbuddy-cloud-sdk 的 CDN 版本，由 index.html 直接 <script> 引入
# 改完 app.js 后重新发布到云端应用
```

---

## 用手机访问（iPhone / 安卓）

**能连，也能传文件。** 手机和电脑连同一个 WiFi 就行，不用装 App、不用连数据线。

### 最省事：扫码

1. 电脑上打开页面，点右上角 **「📱 手机扫码」**
2. 手机用**相机**或**微信「扫一扫」**对准屏幕上的二维码
3. 点弹出的链接 → 直接进首页，**不用输地址，也不用输 PIN**

二维码里带的是 `http://192.168.x.x:8080/q/<一次性票据>`：

- 票据 **10 分钟**内有效，**只能用一次**；用过/过期会显示「二维码已失效」并给出输 PIN 的入口
- 票据只存在服务端内存里，**服务重启即作废**
- 截图发给别人也没用——对方不在同一局域网，连都连不上
- 手机上不显示这个按钮（人已经在手机上了，扫自己没意义）

### 兜底：手输地址

1. 电脑上启动服务，看控制台那行：

   ```
   手机访问 : http://192.168.2.7:8080
   ```

2. 手机连**同一个 WiFi**（2.4G / 5G 无所谓，同一个路由器就行）。
3. 手机浏览器地址栏敲这个地址，输 PIN 登录。

地址里的 IP 每台电脑、每次换网络都可能不同，**别照抄上面的 192.168.2.7**，以自己控制台输出的为准。
登录后页面右上角有个「复制地址」按钮，点一下就能把当前地址复制走（iPhone 上见下面第 2 条）。

### 手机能做什么

跟电脑上一样，没有阉割：

- **上传**：点「上传文件」，拍照 / 相册 / 文件管理里选都行，一次能选多个
- **下载**：点文件行的「下载」
- **在线编辑**：文本文件可以直接点开改，保存后电脑上立刻能看到
- **新建文件夹 / 删除 / 重命名 / 打包 zip 下载**：都有


### 手机端做了哪些适配

| 问题 | 处理 |
| --- | --- |
| iOS 聚焦输入框会自动放大页面，而且不缩回 | 触屏设备上所有输入框字号强制 ≥ 16px |
| 手指点小按钮容易点错 | 触屏下按钮内边距加大（主按钮 43px、列表按钮 39px、文件行 123px 高） |
| iPhone 拖动文件是无效操作 | 触屏下隐藏「拖到这里上传」的提示 |
| 拍照默认 HEIC、录像是 MOV | 补了图标和预览支持，Safari 能直接看，Windows 上的 Chrome 会走下载 |
| 安卓/iPad 横屏宽度超过 640px 但仍是触屏 | 用 `pointer: coarse` 判断，不靠屏幕宽度 |

### 三个「连不上」的常见原因

**1. 防火墙 / 网络类型**

WiFi 被 Windows 认成「公用网络」时，防火墙默认会拦。`放行防火墙.bat` 只对「专用/域」网络放行，
所以要么把 WiFi 改成专用（设置 → 网络和 Internet → WiFi → 属性 → 网络配置文件选「专用」），
要么直接关掉防火墙试一下。查当前状态：

```powershell
Get-NetConnectionProfile          # NetworkCategory 是 Public 就要注意
Get-NetFirewallProfile | Select Name, Enabled
```

**2. iPhone 的「私有 Wi-Fi 地址」和代理**

iOS 默认给每个 WiFi 随机 MAC，正常情况下不影响，但如果路由器做了 MAC 白名单就会连不上：
设置 → 无线局域网 → 点 WiFi 右边的 ⓘ → 关掉「私有无线局域网地址」。

另外**手机上开了代理/VPN 也会连不上局域网 IP**，先在设置里关掉再试。

**3. 「复制地址」没反应**

`navigator.clipboard` 只在 HTTPS 或 localhost 下可用，`http://192.168.x.x` 属于不安全上下文，
iOS Safari 下这个 API 直接是 `undefined`。所以做了兜底：自动复制失败时会弹一个只读输入框，
**长按地址全选 → 拷贝**，这是 iOS 上最稳的办法。

### 已知限制

- **iPhone 不能像 U 盘那样直接「存到文件里」**。`<a download>` 在 iOS 上行为不统一，
  图片/视频建议用「预览」后长按「存储到照片」，其他文件用「下载」再选「存储到文件」。
- 手机上传大文件时页面别切后台，iOS 会冻结标签页导致上传中断。
- 手机端没有多选拖拽，只能点「上传文件」一个一个选（`multiple` 支持一次选多个）。

---

## 常见问题

**其他设备打不开？**

- 确认在同一个局域网
- Windows 防火墙放行：右键 [放行防火墙.bat](放行防火墙.bat) → 以管理员身份运行
- 有虚拟机网卡时可能打印多个 IP，换一个试试
- 手机端见 [用手机访问](#用手机访问iphone--安卓)

**忘记 PIN 了？**

看 `config.json` 里的 `"pin"`，或者删掉它重启（会重新生成，但 `read_only` 等设置也会重置）。

**端口被占用？**

```
set PORT=9000 && python server.py
```

用 exe 的话：

```
set PORT=9000 && LanShare.exe
```

**双击了两次 exe，提示端口被占用？**

说明程序已经在跑了。找找任务栏 / 桌面上那个黑色窗口，直接用它就行。
（Windows 上有个坑：默认允许多个程序绑同一个端口，结果两个服务抢请求，文件列表会一会儿有一会儿没有。
这里已经关掉了这个行为，所以第二次启动会干脆报错，而不是偷偷跑起来。）

**exe 放在 Program Files 里，传的文件找不到？**

那个目录普通权限写不进去。程序会检测到并自动把数据挪到
`%LOCALAPPDATA%\LanShare\`，控制台会打一行提示告诉你新位置。
**建议直接把 exe 放到桌面或 D 盘**，文件就在 exe 旁边的 `shared/` 里，一眼能看到。

**重启后还要重新登录吗？**

不需要，会话密钥存在 `.session_secret`，重启后已有 Cookie 仍然有效，直到 `session_hours` 到期。

## 文件说明

```
server.py           后端（标准库，含 PIN 鉴权、限流、HTTPS、扫码票据）
make_cert.py        生成自签名证书
config.json         PIN 与各项配置（含密码，勿外传）
.session_secret     会话签名密钥（勿外传）
public/
  index.html        文件管理页
  app.js / style.css
  login.html        登录页
  login.js / login.css
  qrcode.js         二维码生成（MIT，纯前端，不经服务器）
shared/             共享目录
site/
  build/make_icon.py  生成 exe 图标
  build/icon.ico      exe 图标
  test_*.js           浏览器端到端测试
cloud-transfer/     ★ 公网快传（纯静态前端 + 托管云服务）
  index.html
  app.js
  style.css
  config.js
启动共享.bat        Windows 双击启动
放行防火墙.bat      一键放行 8080 端口
```

### 打包成 exe

```bash
pip install pyinstaller
python -m PyInstaller --onefile --name LanShare \
  --icon site/build/icon.ico --add-data "public;public" \
  --noconfirm server.py
```

产物在 `dist/LanShare.exe`（约 8.6 MB）。

打包后有两套目录，这个区分很关键：

| 目录 | 打包后位置 | 放什么 |
|---|---|---|
| `RES_DIR` | `sys._MEIPASS`（临时解包目录，只读） | `public/` 静态资源 |
| `DATA_DIR` | exe 所在目录（不可写时退到 `%LOCALAPPDATA%\LanShare`） | `shared/`、`config.json`、`.session_secret` |

**如果把 `shared/` 也打进 exe，用户传的文件会在程序退出时随临时目录一起消失。**


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

**iOS Safari 兼容性**（WebKit 内核 + iPhone 13 视口，走真实局域网 IP 才算数）：

```bash
# 第一次需要装 WebKit 内核
PLAYWRIGHT_BROWSERS_PATH=D:/playwright-browsers npx playwright-core install webkit

node site/test_ios_safari.js http://192.168.2.7:8080   # 17 项布局/交互
node site/test_ios_upload.js  http://192.168.2.7:8080  # 7 项上传下载编辑
```

脚本从 `config.json` 读 PIN（该文件不进仓库），也可以 `SHARE_PIN=xxxxxx` 覆盖。
**一定要用 `192.168.x.x` 而不是 `127.0.0.1`** —— 前者 `isSecureContext=false`，
才能测出 `navigator.clipboard` 不可用这类只在真机上出现的问题。

### 发布到 GitHub Pages

仓库 **Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/docs`**，保存后等一两分钟即可。

## 许可证

[MIT](LICENSE)
