# pi-desktop 待办清单(源自 Codex 对标探索)

> 按优先级排序。每项完成后打勾并在末尾附一行实测证据(命令输出/截图路径)。
> 项目原则:渲染层零依赖零构建、中文注释、低维护成本。

## P0 —— 体验补全(本批)

- [x] **1. 会话右键菜单** —— 会话条目右键:重命名 / 删除(删 .jsonl 文件+刷新列表) / 复制会话 ID。
  - pi 会话文件在 `~/.pi/agent/sessions/<编码目录>/*.jsonl`,主进程已有 `pi:listSessionsGrouped` 的目录反解逻辑(`decodeSessionDir`)。
  - 需要:主进程加 `pi:renameSession`/`pi:deleteSession` IPC;渲染层在 `buildSessionRow` 上挂 contextmenu,自绘菜单(参考 `#model-pop` 弹层模式,注意 `popoverRightEdge` 别飘进右栏)。
  - 重命名 = 改会话首条 `session_info` 条目(pi 的 SessionManager 有 `appendSessionInfo`;简化实现:列表显示名存本地映射 `localStorage['pi-session-names']` 也可,先跑通再加真改名)。
  - 实测证据(2026-09-01):contextmenu 派发后菜单可见、三项=[重命名/删除/复制 ID];重命名行内输入 Enter 后 localStorage 存入且列表行文本变「P0测试改名」(测后已恢复);复制 ID 弹 notice「已复制会话 ID」;删除链路:造 test-delete-ui.jsonl → 右键删除(confirm stub) → notice「会话已删除」+ 文件消失 + 列表无该行。

- [x] **2. 「在外部浏览器打开」实装** —— `#btn-open-external` 目前是占位。
  - 一行事:`require("electron").shell.openExternal(url)`,拿地址栏当前值。
  - 实测证据(2026-09-01):IPC `browser:openExternal` 对 https://example.com 返回 {ok:true}(系统浏览器真实打开),对 ftp://x 返回 {ok:false,err:'invalid url'}。

- [x] **3. 下载按钮实装** —— `#btn-download` 占位。点开显示本 app 下载目录(`app.getPath("downloads")`)最近的文件列表(macOS 下用 `fs.readdirSync` + mtime 排序,取前 20),每项可点 `shell.showItemInFolder`。session 上挂 `ses.on("will-download")` 把下载也接进内置浏览器(保存到默认下载目录,完成时发 notice)。
  - 实测证据(2026-09-01):弹层列出 20 项、首项 Antigravity.dmg、点击触发 showInFolder;真实下载 data: 文本 → notices=[开始下载/下载完成]、文件以正确名落 ~/Downloads(16B)。坑:不显式 setSavePath 时文件留临时名 .com.github.Electron.XXX,已修。

- [x] **4. 收藏夹面板** —— `#btn-favorite` 已能收藏(localStorage 存 `pi-browser-favorites`),但没法查看。
  - 点 `#btn-more`(⋮)弹层里加「收藏」分组列出所有收藏,点击 → `browserGo`。弹层复用 `#cwd-pop` 模式。
  - 实测证据(2026-09-01):写假收藏后弹层 1 项,popRight=1231 ≤ 右栏左缘 1239(不越界);点击后 debugViewState().url=https://example.com/;✕ 移除后 favs=0、弹层显示空态。

- [x] **5. 新标签页美化** —— 目前 `#browser-empty` 是灰字。改成 Codex 风格:居中大标题 + 常去站点快捷块(google.com / github.com / x.com / youtube.com,从收藏里自动取前 6 个,没收藏用默认),点击直接导航。
  - 实测证据(2026-09-01):启动时 grid=6(Google/GitHub/X/YouTube/Gmail/Gemini)、标题「新标签页」;有收藏时网格换收藏(1 条时显 1 块),点击第一块后 url=https://example.com/ 且网格随后重绘回默认 6 站。

## P1 —— 已探明但工程量中等

- [x] **6. macOS 原生应用菜单** —— Codex 菜单栏:文件(新建聊天/新建临时聊天/关闭窗)、视图(切换侧边栏 ⌘S 类快捷键声明)、窗口、帮助。Electron `Menu.setApplicationMenu` 半小时的事,顺带把快捷键(⌘N 新聊天、⌘F 查找已有、⌘W 关窗)声明成标准 accelerator。
  - 实测证据(2026-09-01):菜单栏枚举=Apple,Electron,文件,编辑,视图,窗口,帮助;点「视图→切换侧边栏」sidebar.collapsed false→true→false;点「文件→新对话」sessionTitle 变「新对话」;点「视图→查找」find-bar hidden→显示;帮助菜单含「pi-desktop GitHub」项。
- [x] **7. 会话分支树导航** —— pi session jsonl 是树形(有 parentId),UI 上在会话条目下展示分支数,点开小浮层列分支。依赖读 jsonl 解析 entry 结构,中等工程量。
  - 实测证据(2026-09-01):主进程 countBranches 流式扫每文件前 600 行;listSessionsGrouped 返回项带 branches;会话行徽标 ⑂N 渲染;点徽标弹层列 branch_summary 摘要;点条目调 pi:switchToBranch(switchSession+navigateTree(branchFromId,{summarize:false})),branch A 回显 4 条、branch B 回显根→A1→B1→回答B1,均 ok:true;jsonl 只被追加 thinking_level_change/plannotator custom 条目(navigateTree 会话装载副作用,未改写历史)。
- [x] **8. 置顶摘要 / 底部面板** —— Codex 视图菜单同款。对应 pi 的 compaction 摘要展示(已有 `compaction_start/end` 事件)与 bash 工具输出的底部收纳条。
  - 实测证据(2026-09-01):compaction_end 改发结构化 {type:'compaction',text}(CompactionResult.summary);横条默认折叠「⚡ 上下文已压缩 · 点击展开」,点开展开显示摘要文本,展开态 localStorage(pi-compact-bar-open)记忆;bash 输出 >15 行收纳「终端 ▸ N 行」默认折叠,点击展开/收起文本互换,30 行实测通过;<15 行及非 bash 工具不收纳。

## P2 —— 已知但暂缓(能力面依赖)

- [ ] 9. 「已安排」页面(定时任务,pi 无原生定时,需要外部调度)
- [ ] 10. 「插件」页面(pi 的 skills/extensions 列表化展示)
- [ ] 11. 通知中心(右上角铃铛,收集 `notice` 事件历史)
- [ ] 12. 页面标注模式(圈选写评论,右栏 canvas 覆盖层)

## 已完成(对照留档)

- [x] 临时聊天(SessionManager.inMemory,实测 190→190 文件数未落盘)
- [x] 对话内查找 ⌘F(实测 2 处命中高亮)
- [x] Ctrl+Space 全局唤起(日志确认注册成功)
- [x] 任务完成通知(失焦+≥5s 弹系统通知)
- [x] Cookie 导入 Google 全家登录态(120 条 0 失败,myaccount 直达)
- [x] omnibox 地址栏(输入 x → google.com/search?q=x)
- [x] ☆ 收藏按钮(实测存取闭环)
- [x] Alt+←/→ 切聊天(实测标题切换)
- [x] OAuth 弹窗独立小窗 + 同根域去重(accounts 弹窗数恒为 1)
- [x] backgroundThrottling 关闭(x.com 失焦 121fps)
- [x] 外置 Chrome 模式拆除(2026-09-01,Cookie 导入取代)
