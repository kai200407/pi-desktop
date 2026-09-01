# Codex 右侧栏架构调研报告

> 调研日期：2026-09-01  
> 目标：分析 Codex（ChatGPT Desktop）右侧栏的技术架构，特别是浏览器 session 隔离和标签页系统

---

## 📋 调研摘要

根据用户描述和 Electron 技术能力分析，Codex 右侧栏的核心特征：

1. **选择页面**：右侧栏默认显示功能选择器（浏览器 or 文件树）
2. **标签页系统**：浏览器标签和文件树标签共存，可切换
3. **浏览器 session 隔离**：不同 conversation 使用不同浏览器实例
4. **统一管理**：标签页可以创建、切换、关闭

---

## 🏗️ 技术架构推理

### 1. 浏览器 Session 隔离 ⭐⭐⭐ 最关键

#### 核心机制：Electron Session Partitioning

```javascript
// Electron 提供 session.fromPartition() 实现存储隔离
const { session } = require('electron');

// 为每个 conversation 创建独立 session
const conversationSession = session.fromPartition(`persist:conv-${conversationId}`);

// 创建 WebContentsView 时指定 session
const browserView = new WebContentsView({
  webPreferences: {
    session: conversationSession,
    // ...
  }
});
```

#### 关键特性

| 特性 | 实现方式 |
|------|----------|
| **存储隔离** | 每个 conversation 有独立的 cookies、localStorage、cache |
| **数据持久化** | `persist:` 前缀保存到磁盘 |
| **独立登录态** | 不同 conversation 可以登录不同账号 |
| **内存优化** | 未激活的 session 可以清理缓存 |

#### 数据结构设计

```javascript
// Session 管理器
class ConversationSessionManager {
  constructor() {
    this.sessions = new Map(); // conversationId -> session
    this.activeSessions = new Set(); // 当前激活的 session
  }
  
  getOrCreateSession(conversationId) {
    if (!this.sessions.has(conversationId)) {
      const partition = `persist:conv-${conversationId}`;
      const sess = session.fromPartition(partition);
      this.sessions.set(conversationId, sess);
    }
    return this.sessions.get(conversationId);
  }
  
  switchConversation(newConversationId) {
    // 切换到新 conversation 的 session
    return this.getOrCreateSession(newConversationId);
  }
  
  clearInactiveSessions() {
    // 清理未激活 conversation 的缓存
    this.sessions.forEach((sess, id) => {
      if (!this.activeSessions.has(id)) {
        sess.clearCache();
      }
    });
  }
}
```

---

### 2. 标签页系统架构

#### 标签页数据模型

```javascript
// 标签页基类
class Tab {
  constructor(id, type, title) {
    this.id = id;
    this.type = type; // 'browser' | 'file-tree'
    this.title = title;
    this.icon = null;
    this.closable = true;
  }
}

// 浏览器标签
class BrowserTab extends Tab {
  constructor(id, conversationId) {
    super(id, 'browser', '新标签页');
    this.conversationId = conversationId;
    this.url = '';
    this.view = null; // WebContentsView
    this.session = null; // Electron Session
  }
}

// 文件树标签
class FileTreeTab extends Tab {
  constructor(id, projectPath) {
    super(id, 'file-tree', '文件');
    this.projectPath = projectPath;
    this.expandedPaths = new Set();
  }
}
```

#### 标签页管理器

```javascript
class SidebarTabManager {
  constructor() {
    this.tabs = []; // Tab[]
    this.activeTabId = null;
    this.browserTabs = new Map(); // conversationId -> BrowserTab[]
  }
  
  // 为 conversation 创建浏览器标签
  createBrowserTab(conversationId) {
    const sessionMgr = this.sessionManager;
    const sess = sessionMgr.getOrCreateSession(conversationId);
    
    const tab = new BrowserTab(generateId(), conversationId);
    tab.session = sess;
    tab.view = new WebContentsView({
      webPreferences: {
        session: sess,
        // ...
      }
    });
    
    this.tabs.push(tab);
    this.activateTab(tab.id);
    return tab;
  }
  
  // 切换 conversation 时切换到对应的标签
  switchConversation(newConversationId) {
    // 隐藏当前 conversation 的所有标签
    const currentTabs = this.getConversationTabs(this.currentConversation);
    currentTabs.forEach(tab => this.hideTab(tab));
    
    // 显示新 conversation 的标签
    const newTabs = this.getConversationTabs(newConversationId);
    if (newTabs.length > 0) {
      this.activateTab(newTabs[0].id);
    } else {
      // 没有标签，显示选择页面
      this.showSelectionPage();
    }
  }
  
  getConversationTabs(conversationId) {
    return this.tabs.filter(tab => 
      tab.type === 'browser' && tab.conversationId === conversationId
    );
  }
}
```

---

### 3. 选择页面（初始状态）

#### UI 结构

```
┌─────────────────────────────┐
│      选择功能              │
│                             │
│   ┌────────┐  ┌────────┐  │
│   │ 🌐     │  │ 📁     │  │
│   │ 浏览器 │  │ 文件   │  │
│   └────────┘  └────────┘  │
│                             │
└─────────────────────────────┘
```

#### 实现方式

```javascript
// 选择页面是一个特殊的 HTML view
class SelectionPage {
  constructor() {
    this.view = new WebContentsView({
      webPreferences: {
        // 使用独立的 session，不影响其他功能
        partition: 'in-memory:selection'
      }
    });
    
    this.view.webContents.loadFile('renderer/selection.html');
  }
  
  show() {
    // 设置 bounds 显示
    this.view.setBounds({
      x: sidebarX,
      y: sidebarY,
      width: sidebarWidth,
      height: sidebarHeight
    });
  }
  
  hide() {
    // 隐藏
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
}
```

---

### 4. 文件树实现

#### 两种可能的实现方式

**方案A：HTML 文件树（推荐）**

```javascript
class FileTreeTab extends Tab {
  constructor(id, projectPath) {
    super(id, 'file-tree', '文件');
    this.projectPath = projectPath;
    
    // 使用 WebContentsView 渲染 HTML 文件树
    this.view = new WebContentsView({
      webPreferences: {
        partition: 'in-memory:file-tree',
        preload: path.join(__dirname, 'preload-file-tree.js')
      }
    });
    
    this.view.webContents.loadFile('renderer/file-tree.html');
    
    // 通过 IPC 传递文件列表
    this.view.webContents.on('did-finish-load', () => {
      this.loadFiles(projectPath);
    });
  }
  
  async loadFiles(dirPath) {
    const files = await this.scanDirectory(dirPath);
    this.view.webContents.send('files-loaded', files);
  }
  
  async scanDirectory(dirPath) {
    // 递归扫描目录，返回文件树结构
    // ...
  }
}
```

**方案B：原生文件选择器（简化版）**

使用 Electron 的 `dialog.showOpenDialog` 选择文件，但不推荐，因为无法嵌入侧边栏。

---

## 📊 与 pi-desktop 的对比

### 当前 pi-desktop 实现

| 方面 | 当前实现 | 问题 |
|------|----------|------|
| **Session** | 单一共享 `persist:pi-browser` | 所有 conversation 共享 cookies |
| **标签页** | 只有浏览器标签 | 无文件树功能 |
| **切换 conversation** | 不改变浏览器状态 | 登录态混乱 |
| **初始状态** | 空白页面 | 无功能选择器 |

### Codex 的优势

| 方面 | Codex 实现 | 优势 |
|------|-----------|------|
| **Session 隔离** | 每个 conversation 独立 session | 登录态隔离，避免冲突 |
| **多功能标签** | 浏览器 + 文件树共存 | 功能丰富 |
| **清晰入口** | 选择页面 | 用户体验好 |
| **状态持久化** | conversation 切换保持标签 | 连续性好 |

---

## 🚀 实施建议

### 阶段1：Session 隔离（核心，1-2天）

**目标**：实现浏览器按 conversation 隔离

**步骤**：
1. 创建 `ConversationSessionManager`
2. 修改 `BrowserManager` 支持动态 session
3. 监听 conversation 切换事件
4. 切换时销毁/创建对应的 BrowserView

**关键代码**：
```javascript
// src/main/browser.js
class BrowserManager {
  constructor() {
    this.sessionManager = new ConversationSessionManager();
    this.viewsByConversation = new Map(); // conversationId -> WebContentsView[]
  }
  
  onConversationSwitch(newConversationId) {
    // 1. 隐藏当前 conversation 的所有 views
    if (this.currentConversationId) {
      const currentViews = this.viewsByConversation.get(this.currentConversationId) || [];
      currentViews.forEach(v => v.setBounds({x:0, y:0, width:0, height:0}));
    }
    
    // 2. 切换 session
    const newSession = this.sessionManager.getOrCreateSession(newConversationId);
    
    // 3. 获取或创建新 conversation 的 views
    let newViews = this.viewsByConversation.get(newConversationId);
    if (!newViews || newViews.length === 0) {
      // 首次访问，创建默认标签
      const view = this.createView(newSession);
      newViews = [view];
      this.viewsByConversation.set(newConversationId, newViews);
    }
    
    // 4. 显示新 conversation 的第一个 view
    this.showView(newViews[0]);
    this.currentConversationId = newConversationId;
  }
}
```

### 阶段2：选择页面（1天）

**目标**：右侧栏初始显示功能选择器

**步骤**：
1. 创建 `renderer/selection.html`
2. 实现选择逻辑（点击浏览器/文件树）
3. 集成到右侧栏显示流程

### 阶段3：标签页系统重构（2-3天）

**目标**：支持浏览器标签 + 文件树标签共存

**步骤**：
1. 设计标签页数据结构
2. 实现 `SidebarTabManager`
3. UI 层标签页切换
4. 标签页关闭逻辑

### 阶段4：文件树功能（2-3天）

**目标**：实现文件树标签

**步骤**：
1. 创建 `FileTreeTab` 类
2. HTML 文件树 UI（`renderer/file-tree.html`）
3. 目录扫描和监听
4. 文件点击处理

---

## ⚠️ 技术风险

### 风险1：Session 切换性能

**问题**：频繁切换 conversation 时，创建/销毁 WebContentsView 可能有延迟

**缓解**：
- 缓存最近 3-5 个 conversation 的 views
- 使用 LRU 策略清理旧的 views
- 预加载机制（hover conversation 时预创建）

### 风险2：内存占用

**问题**：每个 conversation 独立 session 会增加内存占用

**缓解**：
- 定期清理非激活 session 的缓存
- 限制同时激活的 session 数量
- 提供"清理浏览器数据"功能

### 风险3：状态同步

**问题**：conversation 切换时，标签页状态需要正确保存/恢复

**缓解**：
- 状态持久化到 localStorage
- conversation 切换时保存当前标签页
- 恢复时按优先级加载（最近使用的优先）

---

## 📝 示例代码

### 完整的 Session 隔离实现

```javascript
// src/main/conversation-session-manager.js
const { session } = require('electron');

class ConversationSessionManager {
  constructor() {
    this.sessions = new Map();
    this.maxCached = 5; // 最多缓存 5 个 session
  }
  
  getOrCreateSession(conversationId) {
    console.log('[SessionMgr] getOrCreateSession:', conversationId);
    
    if (!this.sessions.has(conversationId)) {
      const partition = `persist:conv-${conversationId}`;
      const sess = session.fromPartition(partition);
      
      // 配置 session
      this.configureSession(sess, conversationId);
      
      this.sessions.set(conversationId, {
        session: sess,
        lastUsed: Date.now()
      });
      
      // LRU 清理
      this.evictOldSessions();
    } else {
      // 更新最后使用时间
      this.sessions.get(conversationId).lastUsed = Date.now();
    }
    
    return this.sessions.get(conversationId).session;
  }
  
  configureSession(sess, conversationId) {
    // 设置下载路径
    sess.setDownloadPath(app.getPath('downloads'));
    
    // 监听下载
    sess.on('will-download', (event, item) => {
      console.log('[SessionMgr] Download in conversation:', conversationId);
      // ...
    });
    
    // 其他配置...
  }
  
  evictOldSessions() {
    if (this.sessions.size <= this.maxCached) return;
    
    // 按最后使用时间排序
    const sorted = Array.from(this.sessions.entries())
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    
    // 清理最旧的
    const toRemove = sorted.slice(0, sorted.length - this.maxCached);
    toRemove.forEach(([id, data]) => {
      console.log('[SessionMgr] Evicting session:', id);
      data.session.clearCache();
      this.sessions.delete(id);
    });
  }
  
  clearSession(conversationId) {
    const data = this.sessions.get(conversationId);
    if (data) {
      data.session.clearCache();
      data.session.clearStorageData();
      this.sessions.delete(conversationId);
    }
  }
}

module.exports = { ConversationSessionManager };
```

---

## 🎯 总结

### 核心技术要点

1. **Session 隔离**：`session.fromPartition('persist:conv-${id}')` 实现存储隔离
2. **View 管理**：按 conversation 分组管理 WebContentsView
3. **标签页系统**：统一的标签页抽象，支持多种类型（浏览器、文件树）
4. **状态持久化**：conversation 切换时保存/恢复标签页状态

### 实施优先级

1. **P0（核心）**：Session 隔离 - 解决登录态混乱问题
2. **P1（重要）**：选择页面 - 改善初次体验
3. **P2（增强）**：标签页系统 - 支持多标签管理
4. **P3（扩展）**：文件树 - 新功能

### 预计工作量

- **Session 隔离**：1-2 天
- **选择页面**：1 天
- **标签页系统**：2-3 天
- **文件树**：2-3 天
- **总计**：6-9 天

---

## 📚 参考资源

- [Electron Session API](https://www.electronjs.org/docs/latest/api/session)
- [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
- [Session Partitioning Best Practices](https://www.electronjs.org/docs/latest/api/session#sessionfrompartitionpartition-options)

---

**调研结论**：Codex 的右侧栏架构基于 Electron 的 Session Partitioning 机制实现浏览器隔离，这是一个成熟且可行的技术方案。pi-desktop 完全可以实现相同的功能，预计工作量 6-9 天。
