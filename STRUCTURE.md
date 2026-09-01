# pi-desktop 代码结构导航

重构完成日期：2026-09-01  
重构方式：9个 kimi-k3 子代理并行拆分模块

---

## 📁 目录结构

```
pi-desktop/
├── src/main/              主进程模块（4个文件）
│   ├── index.js           入口：app生命周期、窗口创建、模块组装
│   ├── pi-engine.js       pi SDK接入：initPi、bindSession、事件转IPC
│   ├── browser.js         浏览器视图：多标签、popup去重、下载、bounds定位
│   ├── session-mgmt.js    会话管理：列表、切换、分支树、重命名删除
│   └── ipc-handlers.js    IPC路由表：44个handler注册
│
├── renderer/
│   ├── index.html         HTML结构
│   ├── styles.css         样式（未拆分）
│   └── js/                渲染层模块（6个文件）
│       ├── main.js        入口：模块初始化、拖拽调宽、折叠按钮、顶层协调
│       ├── state.js       全局状态：26个状态字段、localStorage持久化、事件系统
│       ├── ipc-client.js  IPC客户端：60+方法封装、超时处理、事件监听
│       ├── sidebar.js     左栏：会话列表、搜索、右键菜单、工作区切换
│       ├── conversation.js 中栏：对话流、流式渲染、模型选择器、⌘F查找
│       └── browser-ui.js  右栏：标签栏、地址栏、收藏、新标签页、下载列表
│
├── main.js                ⚠️  已废弃，保留备份（被 src/main/index.js 替代）
├── renderer/app.js        ⚠️  已废弃，保留备份（被 renderer/js/* 替代）
├── preload.js             IPC桥接（未改动）
├── browser-preload.js     浏览器视图注入脚本（未改动）
├── chrome-bridge.js       Chrome控制（已下线功能，保留兼容）
├── import-cookies.js      Cookie导入工具（未改动）
└── probe-login.js         登录检测（独立脚本，未改动）
```

---

## 🎯 改某功能去哪找

| 功能 | 文件 | 关键函数/类 |
|------|------|------------|
| **启动入口** | `src/main/index.js` | `app.whenReady()` |
| **窗口创建** | `src/main/index.js` | `createWindow()` |
| **pi引擎初始化** | `src/main/pi-engine.js` | `PiEngine.initPi()` |
| **会话事件监听** | `src/main/pi-engine.js` | `PiEngine.bindSession()` |
| **浏览器多标签** | `src/main/browser.js` | `BrowserManager.createTab()` / `activateTab()` |
| **popup弹窗去重** | `src/main/browser.js` | `BrowserManager.reuseOrOpenPopup()` |
| **下载管理** | `src/main/browser.js` | `BrowserManager.hookDownloads()` |
| **会话列表** | `src/main/session-mgmt.js` | `SessionManager.listSessionsGrouped()` |
| **会话切换** | `src/main/session-mgmt.js` | `SessionManager.switchSession()` |
| **分支树** | `src/main/session-mgmt.js` | `countBranches()` / `readBranchDetails()` |
| **IPC注册** | `src/main/ipc-handlers.js` | `registerIpcHandlers()` |
| **全局状态** | `renderer/js/state.js` | `AppState` 类（26个状态字段）|
| **IPC调用** | `renderer/js/ipc-client.js` | `IpcClient` 类（60+方法）|
| **会话列表UI** | `renderer/js/sidebar.js` | `Sidebar.renderGroups()` / `buildSessionRow()` |
| **会话搜索** | `renderer/js/sidebar.js` | `Sidebar.setSearchOpen()` |
| **右键菜单** | `renderer/js/sidebar.js` | `Sidebar.openSessionCtxMenu()` |
| **工作区切换** | `renderer/js/sidebar.js` | `Sidebar.toggleWorkspacePicker()` |
| **对话流渲染** | `renderer/js/conversation.js` | `Conversation.appendMessage()` |
| **流式渲染** | `renderer/js/conversation.js` | `Conversation.appendText()` / `appendThinking()` |
| **模型选择器** | `renderer/js/conversation.js` | `Conversation.showModelPicker()` |
| **⌘F查找** | `renderer/js/conversation.js` | `Conversation.setupFindBar()` |
| **工具卡片** | `renderer/js/conversation.js` | `Conversation.buildToolBox()` |
| **bash输出折叠** | `renderer/js/conversation.js` | `Conversation._maybeWrapBashOutput()` |
| **标签栏** | `renderer/js/browser-ui.js` | `BrowserUI.renderTabs()` |
| **地址栏** | `renderer/js/browser-ui.js` | `BrowserUI.setupOmnibox()` |
| **收藏功能** | `renderer/js/browser-ui.js` | `BrowserUI.setupFavorite()` |
| **新标签页** | `renderer/js/browser-ui.js` | `BrowserUI.buildNewTabPage()` |
| **下载列表UI** | `renderer/js/browser-ui.js` | `BrowserUI.renderDownloadPop()` |
| **bounds上报** | `renderer/js/browser-ui.js` | `BrowserUI.reportBounds()` |
| **拖拽调宽** | `renderer/js/main.js` | `bindResizers()` |
| **折叠按钮** | `renderer/js/main.js` | `bindCollapseButtons()` |

---

## 🔗 模块依赖关系

### 主进程
```
index.js (入口)
  ├─→ pi-engine.js        (pi SDK)
  ├─→ browser.js          (浏览器管理)
  ├─→ session-mgmt.js     (会话管理)
  └─→ ipc-handlers.js     (IPC路由，依赖上述3个模块)
```

### 渲染层
```
main.js (入口)
  ├─→ state.js           (全局状态，零依赖)
  ├─→ ipc-client.js      (IPC客户端，零依赖)
  ├─→ sidebar.js         (依赖 state + ipc)
  ├─→ conversation.js    (依赖 state + ipc)
  └─→ browser-ui.js      (依赖 state + ipc)
```

---

## 📝 重构前后对比

| 指标 | 重构前 | 重构后 | 改善 |
|------|--------|--------|------|
| **主进程** | `main.js` 1499行 | 5个文件 共约1600行 | ✅ 职责分离 |
| **渲染层** | `app.js` 2416行 | 6个文件 共约2500行 | ✅ 模块化 |
| **单文件最大行数** | 2416行 | 1174行 | ✅ -51% |
| **可测试性** | ❌ 全局变量耦合 | ✅ 依赖注入 | ✅ 可单元测试 |
| **可维护性** | ❌ 功能定位困难 | ✅ 按模块快速定位 | ✅ 维护成本降低 |
| **零构建原则** | ✅ 保持 | ✅ 保持 | ✅ 无构建工具 |

---

## ⚙️ 配置文件

| 文件 | 说明 |
|------|------|
| `package.json` | `"main": "src/main/index.js"` 已修改为新入口 |
| `renderer/index.html` | 已改为加载6个模块化脚本（按依赖顺序） |
| `preload.js` | 未改动，IPC桥接保持不变 |

---

## 🧪 验证清单

重构完成后需验证的功能点：

### 主进程
- [ ] app 启动（`npm start`）
- [ ] 窗口创建
- [ ] pi引擎初始化
- [ ] 会话事件流（agent_start/text_delta/tool等）
- [ ] 浏览器多标签切换
- [ ] 下载功能
- [ ] IPC通信（44个handler）
- [ ] macOS菜单与快捷键

### 渲染层
- [ ] 对话发送与流式渲染
- [ ] 会话列表加载
- [ ] 会话切换
- [ ] 会话搜索
- [ ] 右键菜单（重命名/删除/复制ID）
- [ ] 工作区切换
- [ ] 模型选择器
- [ ] 思考等级选择
- [ ] ⌘F 对话内查找
- [ ] 浏览器地址栏
- [ ] 浏览器标签切换
- [ ] 收藏功能
- [ ] 新标签页
- [ ] 下载列表
- [ ] 三栏拖拽调宽
- [ ] sidebar/browser 折叠

---

## 🚀 后续维护建议

### 添加新功能时
1. **确定职责归属**：功能属于哪个模块？
2. **优先扩展现有模块**：在对应文件中添加方法
3. **需要新模块的信号**：单个模块超过1000行 / 职责不再单一
4. **跨模块通信**：通过 state 事件系统 或 hooks 回调

### 修改现有功能时
1. **查看本文档**快速定位到对应文件
2. **阅读文件头部注释**了解模块职责
3. **保持依赖注入**：不引入全局变量
4. **同步修改文档**：功能变更时更新本文档

### 调试技巧
- **主进程**：DevTools → Sources → `src/main/*.js`
- **渲染层**：DevTools → Sources → `renderer/js/*.js`
- **IPC调用**：`ipc-client.js` 中所有调用都有超时日志
- **状态变化**：`state.on('field-changed', console.log)` 监听
- **事件流**：`ipc.bindEvents({ onAny: console.log })` 查看所有pi事件

---

## 📚 相关文档

- [README.md](../README.md) - 项目概览、运行方式、功能全景
- [TODO.md](../TODO.md) - 功能清单、完成状态、实测证据
- [docs/browser-lessons.md](../docs/browser-lessons.md) - 内置浏览器开发经验

---

## 🤝 贡献指南

### 提交代码前
1. 确保 `npm start` 正常启动
2. 验证改动相关的功能点
3. 更新本文档（如有结构性变更）
4. 提交时附上测试证据（截图/日志）

### 代码规范
- **缩进**：Tab（主进程）/ 2空格（渲染层）- 保持各文件原有风格
- **注释**：中文，清晰说明意图
- **命名**：驼峰式，语义化
- **模块导出**：主进程用 `module.exports`，渲染层用 `window.X`

---

生成时间：2026-09-01  
重构耗时：约15分钟（9个子代理并行工作）
