# pi-desktop 问题诊断报告

## 问题1：点击会话后内容不显示

### 代码链路分析

**当前实现（已确认完整）：**

1. **sidebar.js `buildSessionRow`**（第 282-331 行）
   - 点击事件已绑定：`b.addEventListener('click', function () { ... })`
   - 点击后调用 `self.call('switchSession', s.id)`

2. **ipc-client.js `switchSession`**（第 141-143 行）
   - 调用 `invoke('switchSession', [id])` → `window.piAPI.switchSession(id)`

3. **preload.js**（第 21 行）
   - `switchSession: (id) => ipcRenderer.invoke("pi:switchSession", id)`

4. **src/main/ipc-handlers.js `pi:switchSession`**（第 350-366 行）
   - 调用 `runtime.switchSession(file)`
   - 发送 `session_restored` 事件：`send("session_restored", { messages: serializeMessages(msgs) })`

5. **main.js `bindGlobalEvents`**（第 253-267 行）
   - `ipc.bindEvents({ onAny: (evt) => { ... } })` 转发事件到各模块

6. **conversation.js `handleEvent`**（第 1321-1325 行）
   - `case 'session_restored': this.restoreSession(evt);`

7. **conversation.js `restoreSession`**（第 662-677 行）
   - 重建消息 DOM

### 潜在问题点

**P1: `isActiveSession` 判断可能误拦截**

```javascript
// sidebar.js 第 319-322 行
b.addEventListener('click', function () {
  console.log('[Sidebar] 会话点击:', s.id);
  if (self._get('running') || self.isActiveSession(s)) {
    console.log('[Sidebar] 忽略点击（运行中或已激活）');
    return;
  }
  // ...
});
```

`isActiveSession` 判断逻辑：
```javascript
Sidebar.prototype.isActiveSession = function (s) {
  return s.id === this._get('activeSessionId') ||
    (!this._get('activeSessionId') && s.id === this._get('currentSessionId'));
};
```

**问题场景**：如果 `activeSessionId` 为 `null` 且 `currentSessionId` 等于点击的会话 ID，点击会被忽略。这发生在：
- 应用启动后，当前会话自动恢复，但用户想重新加载该会话

**P2: `session_cleared` 事件时序问题**

跨项目切换时，主进程流程：
1. `switchWorkspace(owner)` → 广播 `session_cleared`
2. `runtime.switchSession(file)` → 广播 `session_restored`

sidebar.js 的 `handleEvent` 对 `session_cleared` 的处理：
```javascript
case 'session_cleared':
  if (!this._switchingTo) {
    this._set('activeSessionId', null);
  }
  this._set('currentSessionId', null);
  this.refreshSessions();
  return false;
```

**问题**：`_markSwitching` 在点击时设置，但 `session_cleared` 可能在 `switchSession` IPC 调用完成前到达。如果时序不对，`_switchingTo` 可能还没设置，`activeSessionId` 被清空。

**P3: `serializeMessages` 可能返回空数组**

如果 `runtime.session.messages` 为空或序列化失败，`session_restored` 事件的 `messages` 为空数组，`restoreSession` 不会渲染任何内容。

### 修复建议

**修复1：放宽 `isActiveSession` 判断，允许强制刷新**

```javascript
// sidebar.js
b.addEventListener('click', function () {
  console.log('[Sidebar] 会话点击:', s.id);
  if (self._get('running')) {
    console.log('[Sidebar] 忽略点击（运行中）');
    return;
  }
  // 即使已是活动会话也允许重新加载（强制刷新）
  var forceReload = self.isActiveSession(s);
  if (forceReload) {
    console.log('[Sidebar] 强制重新加载会话:', s.id);
  }
  self._set('activeSessionId', s.id);
  self.setTitle(self.sessionDisplayName(s));
  self.hooks.clearThread();
  self._markSwitching(s.id);
  self.call('switchSession', s.id);
  self.refreshSessions();
});
```

**修复2：确保 `_markSwitching` 在 IPC 调用前设置**

当前代码已正确：`_markSwitching` 在 `this.call('switchSession', ...)` 之前调用。

**修复3：添加错误处理**

```javascript
// sidebar.js
this.call('switchSession', s.id)
  .then(function(result) {
    console.log('[Sidebar] switchSession 成功:', s.id);
  })
  .catch(function(err) {
    console.error('[Sidebar] switchSession 失败:', err);
    self.hooks.showNotice('加载会话失败');
  });
```

---

## 问题2：左上角折叠按钮不工作

### 代码链路分析

**当前实现（已确认完整）：**

1. **index.html**（第 346-351 行）
   ```html
   <button id="btn-show-sidebar" class="icon-btn pane-toggle-btn left" type="button" title="切换侧边栏">
   ```

2. **main.js `bindCollapseButtons`**（第 357-376 行）
   ```javascript
   if (btnShowSidebar) {
     btnShowSidebar.addEventListener('click', () => {
       console.log('[main] btn-show-sidebar clicked');
       toggleSidebar();
     });
   }
   ```

3. **main.js `toggleSidebar`**（第 379-387 行）
   ```javascript
   function toggleSidebar() {
     if (!sidebar) { ... }
     const hidden = !sidebar.classList.contains('collapsed');
     setSidebarHidden(hidden);
   }
   ```

4. **main.js `setSidebarHidden`**（第 389-420 行）
   ```javascript
   function setSidebarHidden(hidden) {
     sidebar.classList.toggle('collapsed', hidden);
     if (hidden) {
       document.documentElement.style.setProperty('--sidebar-track', '0px');
     } else {
       document.documentElement.style.removeProperty('--sidebar-track');
     }
     if (shell) shell.classList.toggle('sidebar-hidden', hidden);
     state.sidebarHidden = hidden;
     reportBoundsNow();
   }
   ```

5. **styles.css**（第 2073-2084 行）
   ```css
   .pane-toggle-btn {
     position: absolute;
     top: 12px;
     z-index: 30;
     /* ... */
   }
   .pane-toggle-btn.left { left: 78px; }
   ```

### 潜在问题点

**P1: CSS 选择器优先级问题**

`.pane-toggle-btn` 定义在 styles.css 第 2073 行，但可能与其他样式冲突。

**P2: `z-index` 不足**

按钮 `z-index: 30`，但可能被其他元素遮挡。

**P3: 按钮被 `-webkit-app-region: drag` 区域遮挡**

`.sb-tools`（第 457-466 行）有 `-webkit-app-region: drag`，但按钮在 `#shell` 内，不在 `.sb-tools` 内。

**P4: `pointer-events` 问题**

检查是否有父元素设置了 `pointer-events: none`。

### 修复建议

**修复1：提高 `z-index` 并确保按钮可点击**

```css
.pane-toggle-btn {
  z-index: 100;  /* 从 30 提高到 100 */
  pointer-events: auto !important;  /* 确保可点击 */
}
```

**修复2：添加调试日志验证按钮状态**

在 `bindCollapseButtons` 中添加：
```javascript
if (btnShowSidebar) {
  console.log('[main] btn-show-sidebar 找到，绑定点击事件');
  console.log('[main] btn-show-sidebar 样式:', {
    display: getComputedStyle(btnShowSidebar).display,
    visibility: getComputedStyle(btnShowSidebar).visibility,
    zIndex: getComputedStyle(btnShowSidebar).zIndex,
    pointerEvents: getComputedStyle(btnShowSidebar).pointerEvents
  });
  // ...
}
```

**修复3：检查父元素是否遮挡**

在 DevTools 中检查按钮的父元素链，确认没有元素覆盖按钮。

---

## 综合修复方案

### 文件1：renderer/js/sidebar.js

1. 修改点击事件处理，允许强制重新加载当前会话
2. 添加 IPC 调用错误处理

### 文件2：renderer/styles.css

1. 提高 `.pane-toggle-btn` 的 `z-index`
2. 确保按钮 `pointer-events: auto`

### 文件3：renderer/js/main.js

1. 添加更多调试日志
2. 确保 `bindCollapseButtons` 在 DOM 完全加载后执行

---

## 验证步骤

1. **会话点击测试**
   - 打开 DevTools Console
   - 点击会话列表中的会话
   - 查看日志：`[Sidebar] 会话点击:` → `[Sidebar] switchSession 成功:` → `session_restored` 事件
   - 确认对话内容显示

2. **折叠按钮测试**
   - 点击左上角折叠按钮
   - 查看日志：`[main] btn-show-sidebar clicked` → `[main] toggleSidebar:` → `[main] setSidebarHidden:`
   - 确认左栏折叠/展开
   - 检查 `document.documentElement.style.getPropertyValue('--sidebar-track')` 变化
