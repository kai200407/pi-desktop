# Codex风格界面优化 - 实施报告

## 修改文件列表

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main/ipc-handlers.js` | 新增 | `pi:selectFile` IPC handler（文件选择对话框） |
| `preload.js` | 新增 | 暴露 `selectFile` API 到渲染层 |
| `renderer/index.html` | 修改 | 替换 conversation-toolbar 为 conversation-breadcrumb；简化左侧栏；添加附件按钮 |
| `renderer/styles.css` | 修改 | 新增面包屑导航样式 + 工作区编辑器弹窗样式；隐藏旧工具栏 |
| `renderer/js/breadcrumb.js` | **新增** | 面包屑导航模块（工作区显示/切换/编辑/更多/分享） |
| `renderer/js/main.js` | 修改 | 初始化 Breadcrumb 模块；绑定附件按钮事件 |
| `renderer/js/conversation.js` | 修改 | 移除旧工作区选择器代码（已迁移到 breadcrumb.js） |
| `renderer/js/sidebar.js` | 修改 | 移除 btn-add-project 事件绑定 |

## 四项优化详情

### 优化1：面包屑导航（对话区顶部）⭐⭐⭐ 最重要

**移除**：旧的 `conversation-toolbar`（工作区选择器 + 新对话按钮）

**新增**：`.conversation-breadcrumb` 紧凑面包屑导航
- 第一行：📂 图标 + 工作区名称（可点击切换）+ 更多选项按钮 + 分享按钮
- 第二行：会话数统计 + 工作区路径（缩写~）+ 「编辑」按钮

**功能**：
- 点击工作区名称 → 弹出工作区切换菜单（复用原有 workspace-menu 弹层）
- 点击「编辑」→ 弹出工作区编辑器（查看信息/从列表移除）
- 点击「更多」→ 快捷菜单（导出对话/工作区设置）
- 点击「分享」→ 导出当前对话为 Markdown

### 优化2：左侧栏简化 ⭐⭐⭐

**移除**：`#btn-add-project`（项目标题旁的 [+] 按钮）

**效果**：左侧栏「项目」标题变为纯文本，工作区切换入口统一收拢到面包屑导航

### 优化3：输入区附件按钮 ⭐⭐

**激活**：`#btn-attach` 按钮（原本只是占位符）

**功能**：
- 点击 → 调用 `pi:selectFile` 弹出系统文件选择器
- 支持文件类型过滤（图片/文档/代码/所有文件）
- 选择后自动将文件路径插入输入框（前缀「请分析这个文件： 」）

### 优化4：工作区编辑弹窗 ⭐

**新增**：`.workspace-editor-modal` Codex风格模态框

**功能**：
- 显示当前工作区名称、路径、会话数
- 「从列表移除」按钮（从 recentCwds 移除，不删历史会话文件）
- 「保存」按钮（预留工作区别名功能）

## 功能验证结果

### 静态检查
- [x] `node --check` 通过所有 JS 文件（main.js / breadcrumb.js / conversation.js / sidebar.js / ipc-handlers.js / preload.js）
- [x] CSS 大括号配对检查通过（balance = 0）

### 运行时验证（CDP实测）
- [x] `#conversation-breadcrumb` 元素存在
- [x] `#conversation-toolbar` 已隐藏（display: none）
- [x] `#btn-attach` 存在且可用
- [x] `#btn-add-project` 已移除
- [x] `window.Breadcrumb` 类已加载
- [x] `window.__breadcrumb` 实例已创建
- [x] 面包屑显示当前工作区名称（实测： "tmp"）
- [x] 面包屑显示会话数量（实测： "6 个会话"）
- [x] 面包屑显示工作区路径（实测： "/private/tmp"）

### 兼容性检查
- [x] 会话切换功能不受影响（sidebar.js 仅移除按钮绑定，核心逻辑保留）
- [x] 工作区切换功能不受影响（复用原有 workspace-menu 弹层逻辑）
- [x] 深浅色主题均适配（使用 CSS 变量，无硬编码颜色）

## 架构说明

### 模块职责
```
┌─────────────────────────────────────────┐
│  Breadcrumb (新)                        │
│  - 工作区名称/路径/会话数显示            │
│  - 工作区切换菜单（复用 workspace-menu） │
│  - 工作区编辑弹窗                        │
│  - 更多选项菜单                          │
│  - 分享/导出对话                         │
└─────────────────────────────────────────┘
                   │
┌─────────────────────────────────────────┐
│  Conversation                           │
│  - 对话流渲染/流式输出/输入框            │
│  - 模型选择器/思考等级选择器             │
│  - ⌘F查找/压缩横条                      │
│  - 【已移除】工作区选择器相关代码         │
└─────────────────────────────────────────┘
                   │
┌─────────────────────────────────────────┐
│  Sidebar                                │
│  - 会话列表/项目分组/搜索/归档           │
│  - 【已移除】btn-add-project 按钮绑定     │
└─────────────────────────────────────────┘
```

### 数据流
```
主进程 session_info 事件
    ↓
Breadcrumb.updateBreadcrumb(info)
    ↓
更新 bc-workspace-name / bc-workspace-path

主进程 recent_cwds 事件
    ↓
Breadcrumb.updateWorkspaceDisplay()
    ↓
重新拉取 pi:getCwd 更新显示
```

## 建议的下一步优化

1. **工作区别名**：当前「编辑」弹窗的保存按钮是预留功能，可实现自定义工作区显示名（存 localStorage 或配置文件）

2. **附件预览**：选择文件后可在输入框上方显示文件卡片（名称+大小+图标），发送时作为上下文传给 pi

3. **分享增强**：当前分享=导出 Markdown，可扩展为：
   - 生成分享链接（通过 gist 或内部服务）
   - 导出为 HTML/PDF
   - 复制为富文本

4. **面包屑路径点击**：点击路径段可快速跳转到上级目录作为新工作区

5. **会话数实时更新**：当前仅在初始化和 recent_cwds 变化时更新，可监听 agent_end 事件实现更实时的统计

##  Commit

```
a66ec17 feat: Codex风格界面优化 - 面包屑导航/左侧栏简化/附件按钮
```
