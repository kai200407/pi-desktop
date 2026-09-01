# pi-desktop 内置浏览器开发经验沉淀

> 2026-09-01 建档。开发右栏内置浏览器(原生 `WebContentsView`)过程中踩过的坑与结论,
> 每条都经过控制变量实验验证。新功能开发前先过一遍这份文档,能省掉重复踩坑。

## 一、架构选型结论(为什么是现在这样)

| 决策 | 结论 | 原因 |
|---|---|---|
| 浏览器内核 | Electron `WebContentsView` | iframe 被 `X-Frame-Options: DENY` 挡;`<webview>` 已废弃;view 是唯一正路 |
| 隔离 | partition `persist:pi-browser` | 与主窗口 session 隔离,Cookie 持久化在 `Partitions/pi-browser/` |
| 多标签 | 主进程 `browserTabs[]` 管多个 view,非活动的 bounds 缩 0x0 | Electron 没有原生"隐藏 view" |
| CDP 调试口 | 固定 9333(`remote-debugging-port`) | 供 `agent-browser --cdp 9333` 外部自动化 |
| Electron 版本 | ≥37(现 38.8.6) | pi 需要 Node ≥22.19(`fs.globSync`) |

## 二、Google/网站登录 —— 最重要的经验

### 结论 1:Electron 登录 Google **无解**,但可以完全绕过
- **判据是 Electron 运行时本身**,不是 UA/指纹/CDP 端口。控制变量实验:
  - 改 UA 去 Electron 字样 + brands 加 "Google Chrome" + Sec-CH-UA 三件套 → ❌ rejected
  - 关 CDP 端口 → ❌;开 CDP → ❌;独立 `BrowserWindow`(非嵌入)→ ❌
  - `sendInputEvent` 真实键鼠 → 仍然 ❌(URL 真前进了才确认,不是 Enter 没提交的假阳性)
  - **真 Chrome 二进制 + 独立 profile + JS 填表(最机器人的方式)→ ✅ 通过**
- 所以:Codex 的"内置浏览器能登 Google"真相 = **从用户 Chrome 导入 Cookie**(它设置页有「从浏览器导入:已保存的密码/Cookie/浏览历史」),登录流程根本不发生

### 结论 2:Cookie 导入是正解(import-cookies.js)
- Chrome Cookie 库: `~/Library/Application Support/Google/<变体>/<Profile>/Cookies`(SQLite)
- **三变体自动探测**:Chrome / Chrome Beta / Chromium,按 Cookies 文件 mtime 取最新
  —— 用户日常可能用 Beta,普通 Chrome 里存的是死会话(实测踩过:普通 Chrome 的 Google cookie 创建后从未访问,CheckCookie 返回注销页)
- 解密链(macOS,全 Node 零依赖):
  ```
  钥匙串 security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"
  → PBKDF2-SHA1(口令, "saltysalt", 1003, 16B)
  → encrypted_value 去 "v10" 前缀 → AES-128-CBC(IV=16空格) 解密
  → 去 PKCS7 → 去【前 32 字节 sha256(host_key)】(Chrome 139+ 新格式防篡改前缀)→ 明文
  ```
- 写入用 `ses.cookies.set()`;`expires_utc` 是 1601 纪元微秒;v20(app-bound)跳过
- Chrome 运行中不能读库(锁),返回 `needCloseChrome:true` 让 UI 提示 ⌘Q
- **验收方法**:导入后 `accounts.google.com` 应直接 302 到 `myaccount.google.com` 并显示账号名

### 结论 3:OAuth 弹窗必须 `action:"allow"`
- **deny 后自己开 BrowserWindow = 丢 `window.opener`** → Google gsi 弹窗靠 postMessage 与
  opener 通信 → 拿不到 opener 永远白屏(实测:X 的「通过 Google 继续」弹窗 innerText 全空)
- 正确做法:`setWindowOpenHandler` 返回 `{action:"allow", overrideBrowserWindowOptions:{...}}`,
  只覆盖尺寸/样式,opener 关系自动保留。实测:弹窗显示账号选择 → 点账号 → 自动关闭 → X 主页时间线加载成功
- 弹窗判定:URL 匹配账号/OAuth 域 **或** features 带 popup/width
- OAuth 流程会连环 window.open(gsi→accountchooser→consent),同根域要复用旧窗而不是开新窗(否则越叠越多)

## 三、性能

### backgroundThrottling 必须关(主窗口 + 每个 view 都要)
- 不关:窗口稍失焦,Chromium 把页面定时器/rAF/加载全压到 1Hz,重 JS 站(X)体感"卡死"
- 关掉后实测:x.com 失焦状态 121fps、滚动 0 卡顿;这是"内置浏览器没有 Codex 丝滑"的头号根因
```js
new WebContentsView({ webPreferences: { backgroundThrottling: false, ... } })
```

### 窗口被遮挡时 rAF 会被饿死
- `document.visibilityState === 'hidden'` 时 Chromium 完全不跑 `requestAnimationFrame`
- 任何布局变化后的 bounds 上报必须提供**同步版** `reportBoundsNow()`,不能只靠 rAF 节流版
- 拖拽调栏宽要逐帧跟手,同样走同步版

## 四、布局与渲染

### `#browser-slot` 位置上报是命脉
- view 的 bounds 完全由渲染层上报的 `getBoundingClientRect()` 决定
  (rAF 节流 + ResizeObserver;主进程 `applyBrowserBounds()` 缓存 lastBounds)
- **原生 view 永远在所有 DOM 之上** → 一切弹层/模态框不能飘进右栏区域:
  - 弹层用 `popoverRightEdge()` 以右栏左缘为界
  - 全屏模态(如 Cookie 导入框)显示时必须 `browserToggle(false)` 把 view 缩 0,关闭时恢复

### `addChildView` 会静默失败
- 在 `loadFile` 之后立刻 `addChildView` 可能不生效:`children.length` 仍为 1,
  view 有正确 bounds 但 `capturePage()` 返回空图(右栏全黑)
- 修法:挂载后校验 `win.contentView.children.includes(view)`,失败用
  `win.once("ready-to-show")` 兜底重挂 + `applyBrowserBounds()`

### CSS grid 折叠三栏的正确姿势
- **不能用 `display:none` 折叠 grid item**:Chromium 会把 item 从轨道剔除但塌缩错位
  (实测:侧栏折叠后轨道仍占 672px,中栏被挤,右半屏死区)
- 正确:轨道宽度归零(`--sidebar-track: 0px`)+ `visibility:hidden` + `overflow:hidden`,
  item 保留 grid 身份
- 折叠/展开按钮要**永恒挂 `#shell` 四角**(left:78px 紧贴红绿灯 / right:16px),
  位置不随栏状态变化 —— 放在栏里会跟着栏消失,放中栏会位置跳动(Codex 同款行为)

### 首次运行右栏默认展开
- `localStorage.getItem(KEY) !== '0'`(只有显式关过才折叠),用 `=== '1'` 会导致
  首次运行"DOM 展开、view 缩 0"的黑框假死

## 五、调试方法论

| 手段 | 用法 | 陷阱 |
|---|---|---|
| `debug:viewState` IPC | 返回 bounds/url/loading/crashed/shot/childCount | `shot.empty=true` 说明 view 没真渲染 |
| `debug:evalInView` | 在活动 view 里执行 JS 读页面证据 | 多标签时操作的是**活动** tab |
| `debug:typeInView` | `sendInputEvent` 真实键鼠填表 | Google 等站点只认这个,`executeJavaScript` 改 value 会被判机器人 |
| `debug:clickInView` | 真实鼠标点击指定坐标 | 坐标要先从 DOM rect 算 |
| `agent-browser --cdp 9333` | 外部自动化 UI 页 | **tab 编号会漂移**,必须循环探测哪个有 `window.piAPI`;长 JS 写临时文件再 eval;eval 必须包 IIFE |
| 主进程 `capturePage()` | 截图取证 | CDP 的 screenshot 只截 DOM 层截不到原生 view |
| macOS 注意 | 无 `timeout` 命令;`osascript` 前台切换不可靠(常截到用户 Chrome),优先用 IPC 数据证据;IMK 报错是系统噪音 | |

### 验证防假阳性铁律
- 登录/提交类测试必须**对比提交前后 URL 确认页面真的前进了**,再看结果
  (踩过:Enter 没触发提交,URL 停在 identifier,`rejected:false` 是假阳性)
- "登录成功"的判定要找页面内证据(账号名可见/登录按钮消失),不能只看无报错

## 六、其他已沉淀的实现细节

- **omnibox 地址栏**:非 URL 输入直接 Google 搜索(判定:协议头 / localhost:port / 无空格的 a.b 形态)
- **隐身补丁三件套**(browser-preload.js):UA 去 Electron 并规整 Chrome 版本号、
  `userAgentData.brands` 补 "Google Chrome"、Sec-CH-UA 三件套 —— 对普通网站仍有意义
- **`session.setPreloads()` 在 Electron 38 不可靠**:改用 `app.on("web-contents-created")` +
  `attachStealth(wc)`(`did-start-navigation` / `dom-ready` 时 `executeJavaScript` 注入)
- **下载必须显式 `setSavePath`**:否则 Electron 38 把文件留在 `.com.github.Electron.XXX` 临时名
- **模型列表用 `getAvailableSnapshot()`**:只展示有凭证的可用模型(1341→51),
  避免海底捞针;renderer 搜索过滤纯本地零 IPC
- **Electron 安装坑**:npm 拦 postinstall → package.json 加 `"allowScripts"`;
  dist <200MB 需手动解压 zip + 写 path.txt

## 七、测试启动固定套路

```bash
pkill -f "pi-desktop"; sleep 2
cd ~/Desktop/pi-desktop && (npx electron . > /tmp/x.log 2>&1 &)
sleep 27    # 必须等够
# 找 UI tab(编号会漂移):
for t in t1 t2 t3 t4; do agent-browser --cdp 9333 tab $t >/dev/null 2>&1
  if agent-browser --cdp 9333 eval "(()=>!!window.piAPI)()" 2>/dev/null|grep -q true; then UI=$t; break; fi; done
agent-browser --cdp 9333 tab $UI >/dev/null 2>&1
# 跑完必清理:
pkill -f "pi-desktop"
```
