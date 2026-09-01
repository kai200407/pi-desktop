# pi-desktop

Codex / ChatGPT 桌面端风格的三栏 GUI，**引擎是 pi**（不是 OpenAI 后端），
所以模型不受限 —— pi 里配好的 provider 全部可用（本机 1341 个模型）。

```
┌────────────────────────────────────────────────────────────┐
│ 顶栏 46px   模型选择器 · 思考等级 · 主题 · 浏览器开关       │
├──────────┬──────────────────────────┬──────────────────────┤
│ 左：会话  │ 中：对话流                │ 右：内置浏览器        │
│  新对话   │  ·内容居中 40rem          │  真实 Chromium       │
│  历史列表 │  ·思考块 / 工具卡片        │  能登 Google         │
│  工作区   │  ·流式渲染                │  登一次永久有效       │
└──────────┴──────────────────────────┴──────────────────────┘
```

## 运行

```bash
cd ~/Desktop/pi-desktop
npm start            # 开发运行
npm run dev          # 带 DevTools
npm run pack         # 打成 release/mac-arm64/pi.app（未签名，本机自用够了）
```

## 已实测确认的事实（改代码前先读，避免踩回去）

| 结论 | 证据 |
|---|---|
| **Electron 必须 ≥ 37** | pi 依赖 `fs.globSync`，需 Node ≥22.19。Electron 33 = Node 20.18，会报 `does not provide an export named 'globSync'`。当前用 38.8.6 = Node 22.22 |
| **右栏必须是 `WebContentsView`，不能是 iframe** | `accounts.google.com` 发 `X-Frame-Options: DENY`，iframe 必定白屏；`WebContentsView` 实测加载成功（标题「登录 - Google 账号」） |
| **必须加 `disable-blink-features=AutomationControlled`** | 不加则 `navigator.webdriver === true`，Google 登录会被风控拦；加了变 `false`（已实测） |
| **`persist:` partition 让登录持久** | 写 localStorage → 关闭 → 重开 → 读回成功。密码输一次，以后免登录 |
| **默认模型不要用 `claude-fable-5`** | 实测被限流 429。默认改成 `glm-5.3-ioa`，备选 `kimi-k3-ioa` |

## 架构与维护面

```
main.js        主进程：窗口 / 原生浏览器 view / pi 引擎接入 / IPC   ← 你维护
preload.js     IPC 白名单桥                                        ← 你维护
renderer/      纯静态 HTML+CSS+JS，零依赖零构建                    ← 你维护
node_modules/  pi 引擎、Electron                                    ← 上游维护
```

要维护的只有 4 个文件。升级 Electron 大版本时唯一要盯的是 `WebContentsView` 的
API（Electron 30 才从 `BrowserView` 换过来，相对新），它被隔离在
`createBrowserView()` 一个函数里，真要改只动那一处。

### 右栏浏览器的定位机制（重要）

右栏那个浏览器是**主进程管理的原生 view**，不受 CSS 布局影响。
渲染层用 `ResizeObserver` + `requestAnimationFrame` 把 `#browser-slot` 的
`getBoundingClientRect()` 上报给主进程，主进程据此 `setBounds()`。

因此：
- 改右栏布局时，别删 `renderer/app.js` 里的 `reportBounds()` 相关逻辑
- 任何浮层（模型下拉面板等）**不能飘到右栏区域**，因为原生 view 永远在最上层，会遮住浮层

## agent 操作内置浏览器

主进程启动时开了 CDP 端口 9333（`PI_DESKTOP_CDP_PORT` 可覆盖）：

```bash
agent-browser --cdp 9333 tab            # 列出标签
agent-browser --cdp 9333 snapshot -i    # a11y 树带 ref（很省 token）
agent-browser --cdp 9333 click @e3
```

也可以用 playwright `connectOverCDP('http://127.0.0.1:9333')`。

> 安全提示：CDP 端口对本机任意进程开放，等于把浏览器控制权暴露给本地程序。
> 只在本机自用；不要在共享机器上跑。

## 配置存放

- 应用配置（工作区 / 模型 / 思考等级 / 窗口尺寸 / 浏览器主页）：
  `~/Library/Application Support/pi-desktop/pi-desktop.json`
- 浏览器 profile（cookie、登录态）：同目录下的 `Partitions/pi-browser/`
- 会话记录：走 pi 自己的机制，落在工作区的 `.pi/sessions/`
- 模型与凭证：复用 `~/.pi/agent/`（**不在本项目内，凭证不入库**）

## 已知限制

- 会话切换只回灌线性主干，pi 的树形分支（`/tree`）没做
- 没有 Annotation mode（Codex 那个「页面上圈选写评论」），需要时再加
- 未做代码签名，首次打开要在「系统设置 → 隐私与安全性」放行

## 文档索引

- [`TODO.md`](TODO.md) —— 功能清单与完成状态(19 项已完成,每项附实测证据)
- [`docs/browser-lessons.md`](docs/browser-lessons.md) —— 内置浏览器开发经验沉淀:
  Google 登录绕过方案(Cookie 导入)、OAuth 弹窗 opener 陷阱、backgroundThrottling、
  grid 折叠、addChildView 静默失败、调试方法论等,改浏览器相关代码前必读

## 当前功能全景(2026-09-01)

**对话**:多模型(仅显示有凭证的 51 个可用)、思考等级、临时聊天(不落盘)、会话分支树
⑂ 导航(真切换)、压缩上下文+摘要横条、bash 输出收纳、⌘F 对话内查找、Alt+←/→ 切会话、
会话右键(重命名/删除/复制ID)、跨项目会话列表

**内置浏览器**:多标签、omnibox 地址栏(输词即搜)、Google 全家登录态(Cookie 导入,
120 条 0 失败)、OAuth 弹窗(opener 关系正确,X 登录实测通过)、☆收藏+收藏面板、
新标签页快捷站点、下载管理、外部打开、⌘R 刷新

**壳**:三栏拖拽调宽(双击重置)、永恒位置折叠按钮(红绿灯旁,不随栏状态跳动)、
Ctrl+Space 全局唤起、macOS 原生菜单(⌘N/⌘F/⌘B/⌘/)、任务完成通知(失焦弹系统通知)、
暗色主题
