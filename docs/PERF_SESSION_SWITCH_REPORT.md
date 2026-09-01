# pi-desktop 会话切换性能调研报告

> 调研日期：2026-09-01 · 调研方法：代码审查 + 真实耗时测量（Node 26 / M 系列 Mac）
> 数据基线：本机 `~/.pi/agent/sessions` 共 17 个项目目录 / 282 个 jsonl / 93MB；最大单文件 9.86MB

---

## 0. TL;DR

| 场景 | 实测耗时 | 瓶颈 | 优化后预估 |
|------|---------|------|-----------|
| 首次启动会话列表加载 | **~600ms**（冷） | `deriveSessionName` 整读 93MB 文件 | **~30ms**（-95%） |
| 同工作区切会话 | ~25-60ms（pi 层）+ 渲染 ~50-300ms | 消息全量回灌+全量渲染 | <100ms |
| **跨工作区切会话** | **~700-1200ms** | **每次切换都完整重建 pi runtime（`initPi`）** | **~100ms**（-85%） |
| 会话列表重复刷新 | 每次切换触发 3-5 次 `listSessionsGrouped` | 事件链重复调用 | 合并为 1 次 |

**最大根因：跨工作区切换 = 销毁并重建整个 pi 引擎（`initPi` 内的 `resourceLoader.reload()` 实测 450-790ms），且 `ModelRuntime` 也被无谓重建。**

---

## 1. 会话切换完整调用链（代码级追踪）

### 1.1 渲染层入口（`renderer/js/sidebar.js`）

```
用户点击会话行 → switchToSession(id) [sidebar.js:242]
  ├─ _set('activeSessionId')        // 立即高亮（好）
  ├─ setTitle()                     // 立即改标题（好）
  ├─ hooks.clearThread()            // 立即清空对话区（好）
  ├─ call('switchSession', id)      // IPC → 主进程 ← 耗时大头在这
  └─ refreshSessions()              // ←【问题①】切换动作本身就刷一次列表
```

### 1.2 主进程链路（`src/main/ipc-handlers.js:352` → `session-mgmt.js` / `pi-engine.js`）

```
pi:switchSession handler
  ├─ ensurePi()
  ├─ sessionFileOwner(file)                  // 反解路径归属 ~1ms
  ├─ 【跨工作区】switchWorkspace(owner)      // ←【问题②】核弹级开销
  │    ├─ unsubscribe()                      // 解绑事件
  │    ├─ setPi(null)                        // 销毁引用（runtime 被丢给 GC）
  │    ├─ saveConf(recentCwds)               // 写配置 readFileSync+writeFileSync ~2ms
  │    └─ initPi(dir)                        // ← 实测 470-710ms！
  │         ├─ import("@earendil-works/pi-coding-agent")  // 有缓存 ~0ms
  │         ├─ ModelRuntime.create()         // 实测 3-18ms（但每次重复建！）
  │         ├─ createAgentSessionServices()  // 实测 446-710ms ← 真凶
  │         │    └─ resourceLoader.reload()  // 实测 431-794ms（扫 skills/extensions/settings）
  │         └─ createAgentSessionRuntime()   // 实测 13ms
  │         └─ saveConf() + pushSessionInfo()
  ├─ runtime.switchSession(file)             // 实测 14-24ms（读 jsonl + 建树，很快）
  ├─ bindSession()                           // 重新订阅 ~0ms
  ├─ pushSessionInfo()                       // 发 session_info 事件
  └─ send("session_restored", {messages})    // 全量消息回灌（实测 114 条 → 117KB payload）
```

### 1.3 渲染层回灌（`renderer/js/conversation.js:662`）

```
session_restored → restoreSession(payload)
  ├─ clearThread()                 // messages.innerHTML = '' 全量清空
  └─ msgs.forEach → 逐条 appendChild  // ←【问题③】N 条消息 = N 次 append，无 DocumentFragment/分批
       └─ buildMessageDiv → renderMarkdown（手写正则解析）每条 ~0.5-2ms
```

同时事件链触发**多次重复列表刷新**：

```
点击时已 refreshSessions()                      [sidebar.js:253]
switchWorkspace → session_cleared 事件
  → sidebar.handleEvent: refreshSessions()      [sidebar.js:1032]
  → conversation.handleEvent: _refreshSessions()+updateStats()  [conversation.js:1328-1330]
session_restored 事件
  → sidebar.handleEvent: refreshSessions()      [sidebar.js:1039]
  → conversation.handleEvent: _refreshSessions()+updateStats()  [conversation.js:1322-1325]
session_info 事件 → 可能再触发 refreshSessions() [sidebar.js:1045]
```

**一次跨工作区切换最多触发 5 次 `listSessionsGrouped` IPC + 5 次 `renderGroups()` 全量重建左栏 DOM。**
（虽有 5 秒缓存兜底，缓存命中 ~0ms；但每次 `renderGroups()` 会 `innerHTML=''` 后重建 ~282 行 DOM，约 15-30ms/次。）

---

## 2. 性能瓶颈定位（实测数据）

### 瓶颈①：跨工作区切换重建 pi runtime —— 470-790ms ⭐ 最大元凶

**实测**（`/tmp/bench-initpi3.mjs`）：

```
initPi(pi-desktop):   ModelRuntime=16ms, createAgentSessionRuntime=690ms, total=706ms
initPi(tcic-owner):   ModelRuntime=3ms,  createAgentSessionRuntime=506ms, total=509ms
initPi(pi-desktop 再次): total=470ms  （第二次仍然这么慢，无实例级缓存）
```

**分解**（`/tmp/bench-resource.mjs`）：`createAgentSessionServices` 里 95%+ 的时间是 `resourceLoader.reload()`：
- 扫描 `~/.pi/agent/skills/`（本机 7 个技能目录，逐个读 SKILL.md）
- 加载 `~/.pi/agent/extensions/`（memory.ts 等，含 TS 编译/模块加载）
- `SettingsManager.reload()` + 项目配置探测

**对比**：pi 自己的 `runtime.switchSession`（同 cwd 内换 jsonl）只要 **14-24ms**。慢的不是"换会话"，是"换工作区时的全量引擎重建"。

**代码位置**：
- `src/main/session-mgmt.js:189-199` `switchWorkspace()` → `setPi(null)` + `initPi(dir)`
- `src/main/pi-engine.js:53-96` `initPi()` 每次都 `ModelRuntime.create()`（无谓重复）

### 瓶颈②：会话列表扫描整读全部文件 —— ~490ms/次（冷）

**实测分解**（282 个 jsonl，93MB）：

```
目录扫描 + stat:                3.7ms
deriveSessionName 全量:         489.1ms  ← 占 81%+
countBranches 并行流式扫描:     ~100ms（Top 30/项目，已优化过）
```

**根因**（`src/main/session-mgmt.js:145-165`）：

```javascript
function deriveSessionName(fullPath, fallback) {
  const head = fs.readFileSync(fullPath, "utf8")  // ← 整读！9.86MB 的文件也全读
    .split("\n").slice(0, 40);                     //    然后只要前 40 行
```

一个 9.86MB 的会话文件，为了取标题整读进内存再 split 成几十万行数组。**应只读文件头部几 KB。**

**缓解现状**：启动时 `preloadSessions()` 后台预加载 + 5s TTL 缓存（已实施，见 OPTIMIZATION_REPORT.md），所以**用户感知到的首次加载**已被部分掩盖；但缓存过期后、以及切换时多次刷新叠加仍有尖峰。

### 瓶颈③：消息全量回灌 + 全量同步渲染 —— 长会话 100-500ms

**链路**：
1. 主进程 `serializeMessages(msgs)` —— 实测 114 条消息仅 0.1ms，**不是瓶颈**；但 payload 117KB，**IPC 结构化克隆**传输 ~2-5ms。
2. `restoreSession()`（`conversation.js:662`）逐条 `appendChild`，每条 `renderMarkdown`：
   - 手写正则 markdown + 语法高亮，单条 ~0.5-2ms
   - 每条 append 都触发 style/layout 计算（无 fragment 批量插入）
   - **200 条消息 ≈ 200-500ms**，期间主线程阻塞、UI 冻结
3. 回灌后 `updateStats()` 又一次 IPC。

**注意**：`serializeMessages` 会**丢失 tool 调用细节**（折叠成 `[调用 xxx]` 文本），回灌的消息与实时流式渲染的工具卡片结构不同——这是功能差异，也让"减少回灌量"的方案更安全（少传不损失交互）。

### 瓶颈④：重复 IPC 与重复渲染 —— 每次切换 3-5 次列表刷新

时序图（跨工作区切换一次）：

| # | 触发点 | 动作 | 耗时 |
|---|--------|------|------|
| 1 | `switchToSession` 末尾 | `refreshSessions()` | 缓存命中 0ms / 过期 200-600ms |
| 2 | `session_cleared` 事件 | sidebar `refreshSessions()` + conversation `_refreshSessions()` + `updateStats()` | 2 次 IPC + 1 次渲染 |
| 3 | `session_restored` 事件 | 同上再来一遍 | 2 次 IPC + 1 次渲染 |
| 4 | `session_info`（cwd 变化） | sidebar `refreshSessions()` | 1 次 IPC + 渲染 |

`renderGroups()` 每次 `sessionList.innerHTML = ''` 后全量重建（282 行 DOM + 每行 2 个监听器），单次 15-30ms。**4-5 次连发 = 60-150ms 白费的渲染层阻塞**，还造成左栏列表闪烁。

### 瓶颈⑤：启动时模型/思考等级/统计的串行 IPC

`conversation.init()` → `initModels()`（getModels 需 `ensurePi()`，首次触发 `ModelRuntime.create`）+ `getThinkingLevels` + `updateStats()`，三个 IPC 并行但全部依赖 pi 就绪；pi 未就绪时 `ensurePi()` 内部会串行等待 `initPi`（~700ms 冷启动）。窗口首载 vs pi 初始化的竞态靠 `ensurePi` 串行化吸收，表现为**启动后第一次点模型选择器/发消息有卡顿**。

### 非瓶颈（实测排除）

| 怀疑点 | 实测结论 |
|--------|---------|
| jsonl 会话文件解析（`loadEntriesFromFile`） | 9.86MB 文件仅 24ms —— 已用流式 buffer 读取，很快 |
| `runtime.switchSession` 同工作区 | 14-24ms，含建树/恢复 leaf 路径 |
| `serializeMessages` + IPC 传输 | 114 条 / 117KB ≈ 2-5ms |
| 事件订阅 `bindSession` | ~0ms，且有 unsubscribe 清理，无泄漏 |
| `countBranches` | 已限 Top 30/项目 + 600 行截断 + 并行，~100ms 可接受 |

---

## 3. Codex 对比分析

Codex 桌面端（ChatGPT.app）的对应设计与 pi-desktop 的差距：

| Codex 做法 | pi-desktop 现状 | 差距 |
|-----------|----------------|------|
| **引擎常驻**：agent 进程/上下文按项目常驻内存，切会话只换数据不换引擎 | 跨工作区 `setPi(null)` + 全量 `initPi` 重建 | ⭐ 470-790ms 差在这里 |
| **消息增量加载**：进入会话先渲染最近 ~50 条，上滚懒加载更早历史 | 全量回灌 + 全量同步渲染 | 长会话差 100-500ms |
| **列表元数据缓存**：会话标题/时间从索引读，不逐个打开会话文件 | `deriveSessionName` 整读 93MB | 冷扫描差 ~490ms |
| **UI 即时响应**：点击立即切换视觉态（高亮/标题/骨架屏），数据后台填 | 已做到（clearThread + 高亮先行） | ✅ 持平 |
| **切换防抖/合并**：一次切换收敛为一次状态提交 | 一次切换触发 3-5 次列表 IPC + 全量重渲染 | 差 60-150ms |
| **虚拟滚动**（超长会话） | 无 | 200+ 消息会话滚动也卡 |

---

## 4. 优化方案

### P0 —— 立即可做（预期：跨工作区切换 -80%，列表加载 -95%）

#### P0-1. pi runtime 按工作区缓存复用（消灭瓶颈①） ⭐⭐⭐

**改法**（`src/main/pi-engine.js` + `session-mgmt.js`）：

```javascript
// PiEngine 增加实例池
this._pool = new Map();  // cwd -> { runtime, modelRuntime, cwd, lastUsed }
this._modelRuntime = null;  // ModelRuntime 全局只建一次

async initPi(cwd, opts = {}) {
  // 1) ModelRuntime 单例化：它与 cwd 无关，实测 3-18ms 但每次重建毫无意义
  if (!this._modelRuntime) this._modelRuntime = await ModelRuntime.create();
  // 2) 实例池命中直接复用
  const cached = this._pool.get(cwd);
  if (cached) { cached.lastUsed = Date.now(); this.pi = cached; this.bindSession(); this.pushSessionInfo(); return cached; }
  // 3) 未命中才 createAgentSessionServices（保留 modelRuntime 复用，省掉重复 ModelRuntime.create）
  //    并把结果入池；池上限 3-5 个，LRU 淘汰时调 session.dispose()
}
```

`switchWorkspace` 改为：**不 `setPi(null)` 销毁**，而是解绑事件 → 挂回池 → 从池取/新建目标 cwd 实例。

- 预期：**首次切到某工作区 470-790ms（不可避免），之后切回 ~20-50ms**（接近同工作区切换）
- 内存代价：每个缓存实例持有 services + 当前 session 消息，单实例 ~10-50MB，上限 3 个可控
- 工作量：~1-2 小时（含 dispose 生命周期验证）
- ⚠️ 风险点：池化实例的 `session` 是活的，复用时要确认其 cwd 状态未腐化（目录被删等）；LRU 淘汰必须走 `session.dispose()` 释放扩展资源

#### P0-2. `deriveSessionName` 只读文件头（消灭瓶颈②） ⭐⭐

```javascript
function deriveSessionName(fullPath, fallback) {
  const fd = fs.openSync(fullPath, "r");
  try {
    const buf = Buffer.alloc(16384);              // 只读前 16KB
    const n = fs.readSync(fd, buf, 0, 16384, 0);
    const head = buf.toString("utf8", 0, n).split("\n").slice(0, 40);
    // ...原逻辑不变
  } finally { fs.closeSync(fd); }
}
```

- 预期：列表扫描 **~600ms → ~100ms**（大头变成已优化过的 `countBranches`）
- 工作量：10 分钟
- 顺带：`countBranches` 与 `deriveSessionName` 可以合并成一次头部扫描（同一份 16KB  buffer 既找标题又数 `branch_summary`），再省 ~50ms

#### P0-3. 合并切换链路上的重复列表刷新（消灭瓶颈④） ⭐⭐

1. `switchToSession` 点击处**删掉** `refreshSessions()`（高亮已通过 `_set('activeSessionId')` 局部生效，列表数据没变，无需重拉）
2. `session_cleared` / `session_restored` 的 sidebar 处理：把 `refreshSessions()` 降级为 `renderGroups()`（用缓存数据重渲染即可，mtime/branches 不会因切换而变化）
3. conversation 的 `_refreshSessions()` 与 sidebar 的刷新**去重**：在 main.js 的事件转发层加一个 50ms 防抖的 `scheduleRefreshSessions()`，同一事件风暴只落一次 IPC

- 预期：每次切换少 2-4 次 IPC + 少 2-3 次全量列表重建（省 50-150ms + 消除左栏闪烁）
- 工作量：~30 分钟

#### P0-4. `restoreSession` 用 DocumentFragment 批量插入（瓶颈③的止血）

```javascript
Conversation.prototype.restoreSession = function (payload) {
  this.clearThread();
  var frag = document.createDocumentFragment();
  var msgs = (payload && payload.messages) || [];
  var self = this;
  msgs.forEach(function (m) {
    // user → 建 div；assistant → buildMessageDiv（但不再同步 append 到 #messages）
    var d = (m.role === 'user') ? buildUserDiv(m) : self.buildMessageDiv(m);
    if (d) frag.appendChild(d);
  });
  this.elRefs.messages.appendChild(frag);   // 一次 reflow
  // ...
};
```

- 预期：N 次 reflow → 1 次，200 条消息省 30-50% 渲染时间
- 工作量：15 分钟（`addUserMessage` 需要拆一个不直接 append 的构造器）

### P1 —— 中期优化（1-2 天）

#### P1-1. 消息增量回灌 + 分批渲染
- 主进程 `session_restored` 只发**最近 50 条** + `totalCount`；渲染层滚动到顶部时通过新 IPC `pi:loadMoreMessages(beforeIndex)` 拉更早的
- 或更简单：全量照发（IPC 只要 2-5ms），渲染层用 `requestIdleCallback`/分片 setTimeout **分批渲染**（每帧 20 条），配合底部占位保持滚动位置
- 预期：200 条消息的首屏可交互时间 500ms → <100ms

#### P1-2. 会话列表元数据持久化索引
- 把 `deriveSessionName`/`countBranches` 的结果缓存到 `~/.pi/agent/session-index.json`，mtime 未变直接命中；后台 fs.watch 失效
- 与 P0-2 叠加后，冷扫描 ~100ms → ~10ms（只需 stat 对账）
- 预期：启动列表加载稳定 <50ms，不再依赖 5s TTL 缓存的运气

#### P1-3. hover 预加载会话
- 鼠标 hover 会话行 300ms 后主进程预 `loadEntriesFromFile` 到内存（pi SDK 的 `SessionManager.open` 支持 `preloadedFileEntries`）
- 点击时 `switchSession` 的 14-24ms → ~5ms，感知"零延迟"

#### P1-4. 事件去抖与 stats 合并
- `updateStats()` 在 session_restored/session_cleared 链路上被调 2 次，合并为事件风暴末尾一次
- `agent_end` 后的 `refreshSessions` 与 `updateStats` 同理走统一调度器

### P2 —— 长期优化

#### P2-1. 虚拟滚动（超长会话）
- 视口内消息挂载、视口外卸载；pi 会话消息高度不一，建议用 IntersectionObserver + 占位高度方案
- 收益场景：500+ 条消息会话的滚动流畅度（当前 restoreSession 500 条 ≈ 1-2s）

#### P2-2. `initPi` 冷启动并行化
- 启动时主进程 `ensurePi()` 与窗口 `loadFile` 并行（目前是窗口先起、首个 IPC 才触发 pi 初始化，串行）
- 模型列表 `getModels` 走缓存快照（pi SDK `getAvailableSnapshot()` 本身有缓存，但首次仍等 `ensurePi`）

#### P2-3. 会话索引下沉到 worker 线程
- 扫描/解析放到 `worker_threads`，主进程 IO 不阻塞事件循环（当前 600ms 冷扫描期间主进程所有 IPC 都排队）

---

## 5. 实施建议（优先级排序）

| 序 | 方案 | 工作量 | 预期收益 | 风险 |
|----|------|--------|---------|------|
| 1 | **P0-2 文件头读取** | 10min | 列表冷扫描 600→100ms | 极低 |
| 2 | **P0-4 DocumentFragment** | 15min | 长会话回灌渲染 -30~50% | 低 |
| 3 | **P0-3 刷新合并** | 30min | 每次切换省 50-150ms + 消闪烁 | 低 |
| 4 | **P0-1 runtime 池化** | 1-2h | 跨工作区切换 700-1200ms → 100ms | 中（dispose/LRU 生命周期） |
| 5 | P1-1 增量/分批渲染 | 半天 | 长会话首屏 <100ms | 中（滚动位置恢复） |
| 6 | P1-2 元数据索引 | 半天 | 列表稳定 <50ms | 低 |
| 7 | P1-3 hover 预加载 | 1h | 切换感知零延迟 | 低 |

**推荐节奏**：先做 1+2+3（合计 ~1 小时，纯渲染层/小改动，无架构风险），再单独排期 4（runtime 池化是唯一动到 pi 生命周期的改动，需要实测验证"切回原工作区后对话状态正确"）。

**验证要求**（遵循项目铁律）：
- 每个 P0 改动附 `console.time` 前后对照日志截图
- P0-1 需端到端实测：A 工作区发消息 → 切 B → 切回 A → 继续对话，验证上下文未丢、事件未串
- 回归 `OPTIMIZATION_REPORT.md` 的启动指标不退化（总初始化 <500ms）

---

## 附：实测原始数据

```
=== listSessionsGrouped（冷，282 文件 / 93MB）===
总计 596ms：目录扫描+stat 3.7ms / deriveSessionName 489ms / countBranches ~100ms

=== initPi（跨工作区切换的核心开销）===
pi-desktop 首建 706ms / tcic-owner 506ms / pi-desktop 重建 470ms（无缓存）
其中 resourceLoader.reload() 431-794ms（扫 7 个 skills + extensions + settings）

=== runtime.switchSession（pi SDK 层，同工作区）===
760KB jsonl / 114 条消息：18ms；重复切换 14ms
serializeMessages 0.1ms + JSON 序列化 0.2ms（117KB payload）

=== loadEntriesFromFile（pi SDK 流式解析，已很快）===
9.86MB/1463 条 24ms；6.05MB/214 条 18ms；1.44MB/1212 条 6ms
```
