# 工作区分组排序优化

## 目标
1. 点击会话不改变分组顺序（不要跳来跳去）
2. 支持固定分组（pin 到顶部）
3. 支持 3 种排序模式：custom（固定+字母序）、alpha（纯字母序）、recent（最近访问）
4. 显式切换工作区（setCwd/pickCwd）才更新 recentCwds

## 改动文件
- `src/main/session-mgmt.js` - switchWorkspace 增加 opts.updateRecent；switchSession/switchToBranch 传 updateRecent:false
- `src/main/ipc-handlers.js` - pi:switchSession / pi:switchToBranch 传 updateRecent:false；pi:setCwd / pi:pickCwd 保持默认（true）
- `renderer/js/sidebar.js` - 排序模式常量/读写、sortProjectGroups、分组右键菜单（固定/排序切换）、renderGroups 应用排序
- `renderer/styles.css` - 固定分组样式、右键菜单 label/active 样式

## 注意点
- 排序在渲染层做（sidebar.js renderGroups），主进程 listSessionsGrouped 保持现有排序（current 优先 + mtime）不变
- 搜索态不应用排序（保持命中顺序）
- 固定分组右键菜单独立于会话右键菜单，直接挂在 document.body 上
- 右键菜单用项目行（.proj-row）的 contextmenu 事件
- 会话点击切工作区走 pi:switchSession → 内部 switchWorkspace(updateRecent:false)
- 显式切工作区走 pi:setCwd → switchWorkspace(updateRecent:true) 默认
- 新建对话（pi:newSession）不触发 switchWorkspace，无需改

## localStorage 键
- pi-project-sort-mode: 'alpha' | 'recent' | 'custom'（默认 custom）
- pi-pinned-projects: ['/path/a', '/path/b']（固定项目，顺序即显示顺序）
