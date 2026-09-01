# 会话切换性能优化报告（第二轮）

日期：2026-02-27
前置：`docs/PERF_SESSION_SWITCH_REPORT.md`（第一轮 P0 优化已完成：文件头读取 / DocumentFragment / 刷新防抖 / runtime 池化）

## 背景

第一轮 P0 优化落地后，用户仍反馈「点击会话有延迟，切换有卡顿」。
第一轮优化把**跨工作区切换**（700-1200ms → ~50ms）和**列表扫描**（600ms → ~100ms）解决了，
但「点击 → 看到会话内容」这条链路上仍有 4 个可感知延迟点，本轮逐一处理。

## 本轮诊断出的剩余瓶颈

| # | 瓶颈 | 位置 | 量级（实测/估算） |
|---|------|------|------|
| A | 点击后**零反馈**：高亮等 IPC 事件回流才生效，对话区白等 | sidebar.js 点击链路 | 用户感知最明显 |
| B | `restoreSession` **全量同步渲染**所有消息（含 renderMarkdown 正则解析 + 语法高亮） | conversation.js:745 | 200 条 ≈ 200-500ms 主线程冻结 |
| C | 主进程 `runtime.switchSession` **读 jsonl 全文 + 反序列化**，UI 必须等它完成才能回灌 | session-mgmt.js switchSession | 9.4MB 会话 ≈ 29ms（实测），更大文件更慢 |
| D | `session_restored` 事件在 conversation 和 sidebar **双端各触发一次列表刷新**，且 `session_cleared` 会把乐观 UI 铺的骨架屏闪掉 | conversation.js handleEvent | 多一次 renderGroups 全量重建 15-30ms |

## 优化方案与实施

### 1. 增量渲染（瓶颈 B）⭐ 收益最大

`renderer/js/conversation.js` — `restoreSession` 改为两段式：

- **首屏**：只同步渲染**最近 20 条**消息（DocumentFragment 一次插入）+ 滚到底部。
  用户点击后在 ~20-50ms 内看到会话内容，可立即阅读/输入。
- **存量**：更早的历史用 `requestIdleCallback`（50ms 兜底超时）**每批 20 条 prepend 到顶部**。
  向上 prepend 不影响底部视口，滚动位置天然稳定，无需 scrollHeight 补偿。
  首屏渲染完先让出 60ms 一帧，避免历史批次抢占主线程。
- **作废机制**：`_lazyRestoreToken` 标记 + `clearThread`/`showLoadingSkeleton` 入口统一调
  `_cancelLazyRestore()`，快速连点切换会话时旧任务全部作废，不会串会话。

涉及方法：`restoreSession` / `_renderMessageBatch` / `_renderOlderLazily` / `_cancelLazyRestore`。

### 2. 乐观 UI 更新（瓶颈 A）⭐ 感知最强

`renderer/js/sidebar.js` — 新增 `_optimisticSwitch(s)`，点击瞬间不等 IPC 返回就完成三件事：

1. **高亮移动**（局部 class 补丁，见优化 3）；
2. **标题更新**（`setTitle`）；
3. **对话区清空并铺骨架屏**（新增 `hooks.showLoadingSkeleton` → `conversation.showLoadingSkeleton()`：
   3 条呼吸动画占位条，样式在 `styles.css` 的 `.loading-skeleton` 系列）。

之后异步调 `pi:switchSession`，`session_restored` 到达时 `restoreSession → clearThread`
整体替换骨架屏。两条点击链路（`switchToSession` / `buildSessionRow` 的 click 回调）
统一收敛到 `_optimisticSwitch`，消除重复代码。

失败回滚：switchSession IPC 失败时 showNotice 提示（主进程 error 事件也会落到
conversation.showError，用户能看到具体原因）。

### 3. 高亮局部补丁（瓶颈 A 的子项）

`renderer/js/sidebar.js` — 新增 `_patchActiveRow(prevId, nextId)`：
只对**旧激活行 + 新激活行**各做一次 `querySelector('.session-item[data-sid="..."]')`
+ class 切换，不重跑 `renderGroups` 全量重建（282 行 DOM，15-30ms）。
选择器值过 `cssEscape()`（`CSS.escape` 优先，引号/反斜杠兜底转义）——
会话 id 是 jsonl 绝对路径，含 `/` 等字符必须转义。
列表结构刷新由既有 `scheduleRefreshSessions` 防抖兜底（高亮态以 `activeSessionId` 为准）。

### 4. hover 预加载（瓶颈 C）⭐ 消除主进程等待

三层联动：

- **渲染层**（sidebar.js `buildSessionRow`）：`mouseenter` 300ms 后调 `preloadSession(s.id)`，
  `mouseleave` 取消计时；运行中或已是活动会话时不预取。
- **IPC**（ipc-client.js / ipc-handlers.js）：新增 `pi:preloadSession` 通道。
- **主进程**（pi-engine.js + session-mgmt.js）：
  - `PiEngine.readMessagesCached(file, serialize)`：用 SDK `SessionManager.open(file)`
    只读打开 jsonl（不动当前 runtime 状态），`buildSessionContext().messages` 拿到
    content-block 结构的消息数组（与 `runtime.session.messages` 同构），过
    `serializeMessages` 后缓存。LRU 上限 10 条，TTL 60s。
  - `SessionManager.preloadSession(file)`：静默失败（预取只是优化，读不了不阻塞点击路径）。
  - `SessionManager.switchSession`：**命中缓存时仍调用 `runtime.switchSession(file)`**
    （引擎内部状态必须真实切换，否则后续发消息会写错会话），但广播 `session_restored`
    直接用缓存数据——实测 9.4MB 会话的 jsonl 读取+反序列化约 29ms 被完全省掉。
  - `switchToBranch` 不用缓存（navigateTree 会改变消息集，必须走 runtime 最新数据）。

SDK API 实测验证（node 直接跑）：`SessionManager.open` 是同步静态方法，
9.40MB / 124 条消息的会话 `open + buildSessionContext` 耗时 28.7ms。

### 5. 事件链去重 + 骨架屏防闪（瓶颈 D）

`renderer/js/conversation.js`：

- `session_restored` 分支**删掉 `_refreshSessions()`**——列表刷新由 sidebar 的
  `session_restored` 分支统一防抖调度，双端重复调用只会多一次全量重建。
- `session_cleared` 分支**切换期内跳过 `clearThread()`**（判据：`state.activeSessionId`
  非空 = 用户刚点了某个会话 = 正在乐观切换中）。跨工作区切换时主进程
  `switchWorkspace` 会先广播 `session_cleared`，若此时清空会把刚铺的骨架屏闪掉
  （白屏一闪）；骨架本就会被紧随的 `restoreSession` 整体替换，跳过清空无副作用。
  真正的「新对话 / /clear」路径 `activeSessionId` 为 null，清空照常执行。

`renderer/js/main.js`：

- `initConversation` 里设置 `conversationModule.onRefreshSessions =
  () => sidebarModule.scheduleRefreshSessions()`——conversation 侧的刷新请求
  （agent_end / session_cleared）统一走 sidebar 的 50ms 防抖合并，
  不再各自裸调 `refreshSessions`。

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `renderer/js/conversation.js` | restoreSession 增量渲染 + `_renderMessageBatch`/`_renderOlderLazily`/`_cancelLazyRestore` + `showLoadingSkeleton` + session_restored 去重 + session_cleared 防闪 |
| `renderer/js/sidebar.js` | `_optimisticSwitch` / `_patchActiveRow` / `_setActiveUI` + `cssEscape` + 两条点击链路收敛 + hover 预取 + switchToBranch 骨架屏 |
| `renderer/js/ipc-client.js` | 新增 `preloadSession` 方法 |
| `renderer/js/main.js` | hooks 注入 `showLoadingSkeleton`；`conversationModule.onRefreshSessions` 接 sidebar 防抖 |
| `renderer/styles.css` | `.loading-skeleton` / `.skeleton-item` 骨架屏样式（呼吸动画只碰合成层，不触 layout） |
| `src/main/pi-engine.js` | `_msgCache`（LRU 10 / TTL 60s）+ `readMessagesCached` + `takeMessagesCache` |
| `src/main/session-mgmt.js` | `switchSession` 命中缓存直接广播 + 新增 `preloadSession` + `switchToBranch` 保持 runtime 数据 |
| `src/main/ipc-handlers.js` | 注册 `pi:preloadSession` |
| `src/main/index.js` | initModules 注入 `readMessagesCached` / `takeMessagesCache` |

## 验证方法

1. **性能日志**（DevTools Console）：
   - `[Perf] 点击到 IPC 返回` —— 点击 → switchSession IPC resolve 的耗时
   - `[Conversation] restoreSession(首屏)` —— 首屏 20 条渲染耗时（目标 < 50ms）
   - `[Conversation] 历史延迟渲染完成，共 N 条` —— 存量回灌完成
   - `[PiEngine] 会话消息预取` / `消息缓存命中` —— hover 预取是否生效

2. **用户感知验收**：
   - 点击会话行 → **立即**看到高亮移动 + 标题变化 + 骨架屏（不等 IPC）
   - 100ms 内骨架屏出现；300ms 内看到最近 20 条消息
   - 快速连点多个会话 → 不串会话内容（旧延迟任务全部作废）
   - 向上滚动 → 更早历史已在空闲时补齐，无缺失

3. **回归点**：
   - 新对话 / `/clear` → 对话区正常清空（activeSessionId 为 null，session_cleared 照常 clear）
   - 切分支（branch-badge）→ 正常回灌分支消息（不走缓存）
   - 搜索态点击命中会话 → 高亮/切换正常
   - 跨工作区点会话 → 不再有白屏一闪

## 未做（有意取舍）

- **虚拟滚动**（P2）：500+ 条超长会话的滚动流畅度问题仍在，但增量渲染后
  首屏已快，滚动卡顿留给后续 IntersectionObserver 占位方案。
- **Markdown 渲染 Web Worker 化**：增量渲染把同步渲染量压到 20 条以内，
  Worker 的序列化开销（每条消息一次 postMessage）得不偿失，暂不引入。
- **IPC payload 分页**（只传最近 50 条）：`session_restored` 是全量回灌语义，
  改成分页要动主进程 + 渲染层双方协议，而 117KB payload 实测仅 2-5ms，不是瓶颈。
