// renderer/js/main.js —— 渲染层入口
//
// 重构自 renderer/app.js（2416行），职责：
//   - 模块初始化与组装
//   - 顶层事件协调（菜单快捷键、全局键盘事件、跨模块交互）
//   - 三栏拖拽调宽
//   - 折叠按钮（sidebar/browser 开关）
//
// 架构：
//   原 app.js 拆成了 6 个模块：
//     - state.js      - 全局状态管理（26个状态）
//     - ipc-client.js - IPC客户端封装
//     - sidebar.js    - 左栏会话列表
//     - conversation.js - 中栏对话流
//     - browser-ui.js - 右栏浏览器UI
//     - main.js（本文件）- 入口与协调

(function() {
	'use strict';

	// --- 依赖模块 -----------------------------------------------------------
	const state = window.AppState;
	const ipc = window.ipc || new window.IpcClient();

	// --- DOM 引用（与 index.html 中的实际 ID 对应） -------------------------
	const $ = (sel) => document.getElementById(sel);
	const sidebar = $('sidebar');
	const center = $('center');
	const browserPane = $('browser-pane');
	const shell = $('shell');
	const resizeLeft = $('resize-left');
	const resizeRight = $('resize-right');
	const btnShowSidebar = $('btn-show-sidebar');
	const btnShowBrowser = $('btn-show-browser');

	// --- 模块实例 -----------------------------------------------------------
	let sidebarModule = null;
	let conversationModule = null;
	let browserUIModule = null;

	// --- 布局常量（与 app.js 一致） ------------------------------------------
	const WIDTH_KEY = 'pi-col-widths';
	const SIDEBAR_DEFAULT = 260;
	const BROWSER_DEFAULT = 480;
	const SIDEBAR_MIN = 200, SIDEBAR_MAX = 420;
	const BROWSER_MIN = 320, BROWSER_MAX = 900;
	const CENTER_MIN = 420;

	// 当前栏宽（从 localStorage 恢复）
	const colW = { sidebar: SIDEBAR_DEFAULT, browser: BROWSER_DEFAULT };

	// --- 初始化 -------------------------------------------------------------
	function init() {
		console.time('[main] 总初始化时间');
		
		// 1. 先初始化主题（原 app.js 在主题事件绑定前就调用）
		initTheme();

		// 2. 恢复布局（栏宽 + 折叠态）
		loadWidths();
		restoreCollapsedStates();

		// 3. 初始化三大模块（注意顺序：browser-ui 最后，因为它需要上报 bounds）
		initSidebar();
		initConversation();
		initBrowserUI();

		// 4. 绑定顶层事件
		bindGlobalEvents();
		bindMenuEvents();
		bindResizers();
		bindCollapseButtons();

		// 5. 应用主题到 document
		applyTheme();

		console.timeEnd('[main] 总初始化时间');
		console.log('[main] init() 完成（数据异步加载中）');
	}

	// --- 主题 ---------------------------------------------------------------
	// 主题三态：'light' | 'dark' | 'system'
	//   - light / dark：用户显式选中，持久化到 localStorage，重启后保持
	//   - system：跟随 macOS 的 prefers-color-scheme，动态监听系统主题变化
	//
	// 切换流程：
	//   点击按钮 → 计算下一个主题 → state.theme = next（触发 theme-changed）
	//     → applyTheme() 写入 <html data-theme> → CSS 变量切换 → 图标切换
	//
	// 为什么不需要额外的 _themeRaw 字段：
	//   state.theme 的 setter 会把值写进 localStorage 并派发事件。
	//   「system」本身也是合法持久值，applyTheme() 内部判断一下
	//   是不是 system 再决定要不要走 matchMedia，不需要额外字段。
	function initTheme() {
		// 默认暗色（跟 Codex 一致），手动切过就记住用户选择
		// 注意：这里用 _theme 直写内部字段，避免在 init 阶段就发 theme-changed 事件
		// （那时监听者还没就位，事件会丢）
		const theme = localStorage.getItem('pi-theme') || 'dark';
		state._theme = theme;
		console.log('[theme] initTheme: 读取 localStorage →', theme);
	}

	// 把状态里的 'system' 解析成实际生效的 'light' | 'dark'
	// 只有 system 模式才走 matchMedia；其余原样返回
	function resolveTheme(theme) {
		if (theme !== 'system') return theme;
		const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
		const resolved = prefersDark ? 'dark' : 'light';
		console.log('[theme] system 模式 → 解析为', resolved);
		return resolved;
	}

	// 把主题写到 <html data-theme>，同时切换按钮上的太阳/月亮图标
	// 调用时机：init 时一次 + 每次 theme-changed 事件
	function applyTheme() {
		const raw = state.theme || 'dark';       // 用户选的：light / dark / system
		const effective = resolveTheme(raw);      // 实际生效的：light / dark
		console.log('[theme] applyTheme: raw=', raw, 'effective=', effective);
		document.documentElement.setAttribute('data-theme', effective);

		// 图标切换：CSS 已根据 [data-theme] 控制 .icon-sun/.icon-moon 的显隐，
		// 这里不需要额外 DOM 操作。但留一个调试钩子，方便 DevTools 验证。
		const btnTheme = $('btn-theme');
		if (btnTheme) {
			btnTheme.setAttribute('data-active-theme', effective);
			btnTheme.title = raw === 'system'
				? ('切换主题（当前：跟随系统=' + effective + '）')
				: ('切换主题（当前：' + (effective === 'dark' ? '暗色' : '亮色') + '）');
		}
	}

	// 监听主题变化：state.theme 的 setter 会派发 theme-changed
	// 这里只负责把新值写到 DOM，持久化已由 state.js 处理
	state.on('theme-changed', (newTheme) => {
		console.log('[theme] theme-changed 事件 →', newTheme);
		try {
			applyTheme();
		} catch (e) {
			// 防御性捕获：主题应用失败不应让其他初始化崩溃
			console.error('[theme] applyTheme 失败:', e);
		}
	});

	// 系统主题变化监听：只在 system 模式下才有意义
	// macOS 用户在系统设置里切外观时，跟着刷新界面
	if (window.matchMedia) {
		const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
		// 新版 API：addEventListener('change', ...)；老板本是 addListener
		const onSystemThemeChange = () => {
			if (state.theme === 'system') {
				console.log('[theme] 系统主题变化，重新应用 system 模式');
				applyTheme();
			}
		};
		if (mediaQuery.addEventListener) {
			mediaQuery.addEventListener('change', onSystemThemeChange);
		} else if (mediaQuery.addListener) {
			mediaQuery.addListener(onSystemThemeChange);
		}
	}

	// --- 布局恢复 -----------------------------------------------------------
	function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

	function applyWidths() {
		document.documentElement.style.setProperty('--sidebar-width', colW.sidebar + 'px');
		document.documentElement.style.setProperty('--browser-width', colW.browser + 'px');
	}

	function loadWidths() {
		try {
			const saved = JSON.parse(localStorage.getItem(WIDTH_KEY) || 'null');
			if (saved) {
				if (saved.sidebar) colW.sidebar = clamp(saved.sidebar, SIDEBAR_MIN, SIDEBAR_MAX);
				if (saved.browser) colW.browser = clamp(saved.browser, BROWSER_MIN, BROWSER_MAX);
			}
		} catch (e) { /* 存的值坏了就用默认 */ }
		applyWidths();
	}

	function saveWidths() {
		try {
			localStorage.setItem(WIDTH_KEY, JSON.stringify(colW));
		} catch (e) {}
	}

	function restoreCollapsedStates() {
		// 恢复 sidebar 折叠态
		if (state.sidebarHidden) {
			sidebar.classList.add('collapsed');
			if (shell) shell.classList.add('sidebar-hidden');
			document.documentElement.style.setProperty('--sidebar-track', '0px');
		}

		// 恢复浏览器折叠态
		if (!state.browserPaneVisible) {
			browserPane.classList.add('collapsed');
			if (shell) shell.classList.add('browser-hidden');
			document.documentElement.style.setProperty('--browser-track', '0px');
		}
	}

	// --- 模块初始化 ---------------------------------------------------------
	// 【日志约定】各阶段打印 [main] 前缀日志，出问题先看控制台调用链。
	function initSidebar() {
		sidebarModule = new window.Sidebar({
			state: state,
			ipc: ipc,
			els: {
				sidebar: sidebar,
				sessionList: $('session-list'),
				sessionTitle: $('session-title'),
				searchRow: $('search-row'),
				sessionSearch: $('session-search'),
				btnSearch: $('btn-search'),
				btnSearchClear: $('btn-search-clear'),
				searchStat: $('search-stat'),
				btnNew: $('btn-new'),
				sessionCtxMenu: $('session-ctx-menu'),
				cwdPop: $('cwd-pop'),
				btnAddProject: $('btn-add-project'),
				branchPop: $('branch-pop'),
				browserPane: browserPane,
			},
			hooks: {
				clearThread: () => conversationModule?.clearThread(),
				showNotice: (msg) => conversationModule?.showNotice(msg),
				closePopovers: closeAllPopovers,
				positionPopoverXY: positionPopoverXY,
				relTime: relTime,
			}
		});
		sidebarModule.init();
	}

	function initConversation() {
		conversationModule = new window.Conversation(center, state, ipc);
		conversationModule.init();
	}

	// 初始化右栏浏览器模块。
	// 注意顺序：【先注入 hooks 再 init()】—— init() 末尾的 restoreVisibility()
	// 会同步右栏显隐并触发 onVisibilityChange 回调，晚注入会丢第一帧通知。
	function initBrowserUI() {
		console.log('[main] initBrowserUI()');
		if (!browserPane) {
			console.error('[main] #browser-pane 不存在，浏览器模块无法初始化');
			return;
		}
		if (typeof window.BrowserUI !== 'function') {
			console.error('[main] window.BrowserUI 未加载（js/browser-ui.js 缺失或报错）');
			return;
		}
		browserUIModule = new window.BrowserUI(browserPane, state, ipc);
		browserUIModule.hooks = {
			closePopovers: closeAllPopovers,
			onVisibilityChange: (visible) => {
				console.log('[main] 浏览器面板显隐变更:', visible);
			}
		};
		browserUIModule.init();
		// 暴露调试句柄：DevTools Console 里可手动 window.__browserUI.toggleBrowser()
		window.__browserUI = browserUIModule;
		console.log('[main] BrowserUI 初始化完成');
	}

	// --- 全局事件 -----------------------------------------------------------
	function bindGlobalEvents() {
		// IPC 事件流：使用 onAny 转发给各模块
		ipc.bindEvents({
			onAny: (evt) => {
				// 按优先级让各模块处理
				// 1. 先让 conversation 处理（它处理大部分流式事件）
				if (conversationModule?.handleEvent) {
					conversationModule.handleEvent(evt);
				}
				// 2. 再让 sidebar 处理（session_info 等）
				if (sidebarModule?.handleEvent) {
					sidebarModule.handleEvent(evt);
				}
				// 3. 最后让 browser-ui 处理（browser_url / browser_tabs）
				if (browserUIModule?.handleEvent) {
					browserUIModule.handleEvent(evt);
				}
			}
		});

		// 全局键盘事件
		document.addEventListener('keydown', (e) => {
			// Esc 关闭所有弹层
			if (e.key === 'Escape') {
				closeAllPopovers();
			}

			// Alt + ← / → 切换会话（由 sidebar 处理）
			if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
				// sidebar 已绑定，这里不重复处理
			}
		});

		// ===== 主题切换按钮（三态轮换：dark → light → system → dark） =====
		// 点击后计算下一个主题，写入 state.theme，由 setter 自动：
		//   1) 持久化到 localStorage('pi-theme')
		//   2) 派发 theme-changed 事件 → applyTheme()
		// 按钮不存在时只告警，不抛错（避免阻塞其他初始化）
		const btnTheme = $('btn-theme');
		if (btnTheme) {
			btnTheme.addEventListener('click', () => {
				try {
					const current = state.theme || 'dark';
					// 三态轮换顺序：dark → light → system → dark
					// 默认是 dark（Codex 风格），点一下变 light，再点变 system，依此循环
					const order = ['dark', 'light', 'system'];
					const idx = order.indexOf(current);
					// 防御：当前值不在表里（例如旧版本存了非法值）→ 回到 dark
					const next = idx === -1 ? 'dark' : order[(idx + 1) % order.length];
					console.log('[theme] 按钮点击：', current, '→', next);
					state.theme = next;
				} catch (e) {
					console.error('[theme] 切换主题失败:', e);
				}
			});
			console.log('[main] 主题切换按钮已绑定 (#btn-theme)');
		} else {
			console.warn('[main] #btn-theme 未找到，主题切换不可用');
		}
	}

	// --- 菜单事件（menu-action） ---------------------------------------------
	function bindMenuEvents() {
		// 监听 menu-action 事件（macOS 原生菜单转发）
		ipc.on('menu-action', (evt) => {
			switch (evt.action) {
				case 'new':
					sidebarModule?.newSession();
					break;
				case 'new-ephemeral':
					sidebarModule?.newEphemeral();
					break;
				case 'toggle-sidebar':
					toggleSidebar();
					break;
				case 'toggle-browser':
					browserUIModule?.toggleBrowser();
					break;
				case 'find':
					conversationModule?.openFindBar();
					break;
			}
		});
	}

	// --- 折叠按钮 -----------------------------------------------------------
	function bindCollapseButtons() {
		// 左栏折叠按钮（#shell 左上角，红绿灯右侧）
		// 注意：此按钮恒挂 #shell 左上角，位置永不随栏开关变化
		if (btnShowSidebar) {
			btnShowSidebar.addEventListener('click', () => {
				console.log('[main] btn-show-sidebar clicked');
				toggleSidebar();
			});
			console.log('[main] btn-show-sidebar 已绑定');
		} else {
			console.warn('[main] btn-show-sidebar 未找到！');
		}

		// 【重要】右栏开关 #btn-show-browser 不在此绑定：
		// BrowserUI.init() 已经绑过一次，重复绑定会让一次点击触发两次 toggle
		// 互相抵消，表现为「按钮点了没反应」（历史踩过）。这里只做存在性检查。
		if (!btnShowBrowser) {
			console.warn('[main] #btn-show-browser 不存在，右栏将无法通过按钮开关');
		}

		// 注意：#btn-browser（左栏底部）和 #btn-toggle-browser-inline（中栏上下文行）
		// 已在 index.html 中隐藏，不再绑定事件，避免多个入口造成状态不同步
	}

	// 切换左栏显隐：只负责状态翻转，具体设置交给 setSidebarHidden
	function toggleSidebar() {
		if (!sidebar) {
			console.warn('[main] toggleSidebar: #sidebar 不存在，无法折叠');
			return;
		}
		const hidden = !sidebar.classList.contains('collapsed');
		console.log('[main] toggleSidebar:', hidden);
		setSidebarHidden(hidden);
	}

	// 设置左栏显隐：统一处理 class、CSS 变量、状态持久化、bounds 上报
	// 【实测坑】Chromium grid 折叠不能只 display:none（轨道会错位残留），
	// 必须「轨道变量归零 + visibility 隐藏」双管齐下，见 styles.css #shell 注释。
	function setSidebarHidden(hidden) {
		if (!sidebar) {
			console.warn('[main] setSidebarHidden: #sidebar 不存在');
			return;
		}
		console.log('[main] setSidebarHidden:', hidden);

		// 1. 切换折叠 class（控制 visibility 和 pointer-events）
		sidebar.classList.toggle('collapsed', hidden);

		// 2. 设置轨道宽度变量（grid-template-columns 使用，0px 表示折叠；
		//    展开时置空 = 移除该属性，让 var(--sidebar-track, --sidebar-width) 走回退值）
		if (hidden) {
			document.documentElement.style.setProperty('--sidebar-track', '0px');
		} else {
			document.documentElement.style.removeProperty('--sidebar-track');
		}

		// 3. 同步 shell class（用于兄弟选择器隐藏拖拽手柄）
		if (shell) shell.classList.toggle('sidebar-hidden', hidden);

		// 4. 持久化到 localStorage（state.js setter 会自动处理）
		state.sidebarHidden = hidden;

		// 5. 上报 bounds（中栏宽度变了，浏览器 slot 位置也要变）
		reportBoundsNow();
	}

	// --- 拖拽调宽 -----------------------------------------------------------
	function bindResizers() {
		let startX = 0;
		let startW = 0;
		let dragging = false;
		let currentSide = null;

		function onPointerDown(e, side) {
			if (e.button !== 0) return;
			dragging = true;
			currentSide = side;
			startX = e.clientX;
			startW = side === 'sidebar' ? colW.sidebar : colW.browser;
			e.target.classList.add('dragging');
			document.body.classList.add('resizing');
			try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* 合成指针 */ }
			e.preventDefault();
		}

		function onPointerMove(e) {
			if (!dragging) return;
			const dx = e.clientX - startX;
			const raw = currentSide === 'sidebar' ? (startW + dx) : (startW - dx);
			const next = currentSide === 'sidebar'
				? clamp(raw, SIDEBAR_MIN, SIDEBAR_MAX)
				: clamp(raw, BROWSER_MIN, BROWSER_MAX);

			// 中栏不能被挤得比 CENTER_MIN 还窄
			const w = { sidebar: colW.sidebar, browser: colW.browser };
			w[currentSide] = next;
			if (centerWidth(w.sidebar, w.browser) < CENTER_MIN && next > colW[currentSide]) return;
			if (next === colW[currentSide]) return;

			colW[currentSide] = next;
			applyWidths();
			reportBoundsNow();
		}

		function endDrag(e) {
			if (!dragging) return;
			dragging = false;
			e.target.classList.remove('dragging');
			document.body.classList.remove('resizing');
			try { e.target.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
			saveWidths();
			reportBoundsNow();
		}

		if (resizeLeft) {
			resizeLeft.addEventListener('pointerdown', (e) => onPointerDown(e, 'sidebar'));
			resizeLeft.addEventListener('pointermove', onPointerMove);
			resizeLeft.addEventListener('pointerup', endDrag);
			resizeLeft.addEventListener('pointercancel', endDrag);
			resizeLeft.addEventListener('dblclick', () => {
				colW.sidebar = SIDEBAR_DEFAULT;
				applyWidths();
				saveWidths();
				reportBoundsNow();
			});
		}

		if (resizeRight) {
			resizeRight.addEventListener('pointerdown', (e) => onPointerDown(e, 'browser'));
			resizeRight.addEventListener('pointermove', onPointerMove);
			resizeRight.addEventListener('pointerup', endDrag);
			resizeRight.addEventListener('pointercancel', endDrag);
			resizeRight.addEventListener('dblclick', () => {
				colW.browser = BROWSER_DEFAULT;
				applyWidths();
				saveWidths();
				reportBoundsNow();
			});
		}
	}

	function centerWidth(sidebarW, browserW) {
		const total = shell ? shell.clientWidth : window.innerWidth;
		const s = sidebar.classList.contains('collapsed') ? 0 : sidebarW;
		const b = browserPane.classList.contains('collapsed') ? 0 : browserW;
		return total - s - b;
	}

	// --- Bounds 上报 ----------------------------------------------------------
	// 【唯一上报点】浏览器区域尺寸上报统一由 BrowserUI 模块负责（rAF 节流 +
	// 同步版双路径，详见 browser-ui.js）。这里只保留一个转发器，供左栏折叠 /
	// 栏宽拖拽等 main.js 侧的布局变化调用 —— 中栏宽度变了，slot 位置也会变。
	function reportBoundsNow() {
		browserUIModule?.reportBoundsNow();
	}

	// --- 弹层协调 -----------------------------------------------------------
	function closeAllPopovers() {
		const popovers = [
			$('model-pop'),
			$('thinking-pop'),
			$('cwd-pop'),
			$('more-pop'),
			$('download-pop'),
			$('session-ctx-menu'),
			$('branch-pop'),
		];
		popovers.forEach(pop => {
			if (pop) pop.classList.add('hidden');
		});
	}

	// 弹层定位（坐标版）：sidebar 模块以 (pop, clientX, clientY) 调用。
	// 【历史踩坑】此 hook 旧签名为 (popover, anchorEl, opts)，而 sidebar.js
	// 传入的是鼠标坐标数字 → anchor.getBoundingClientRect() 抛 TypeError，
	// 整个右键菜单在显示前就被异常中断（表现为「右键没反应」）。
	// 现在统一为坐标语义：先显示（去 hidden）量尺寸，再夹紧到可视区内。
	function positionPopoverXY(popover, x, y) {
		if (!popover) {
			console.warn('[main] positionPopoverXY: popover 不存在');
			return;
		}
		console.log('[main] positionPopoverXY:', popover.id || popover.className, x, y);

		// 1. 先显示再量尺寸（hidden 时 offsetWidth/Height 为 0）
		popover.classList.remove('hidden');
		const w = popover.offsetWidth || 200;
		const h = popover.offsetHeight || 200;

		// 2. 右边界：浏览器面板可见时以它的左缘为界（原生 view 永远盖在 DOM 之上），
		//    否则贴窗口右缘。坐标非法（非数字）时兜底到左上角安全位。
		let right = window.innerWidth - 12;
		if (browserPane && !browserPane.classList.contains('collapsed')) {
			const paneLeft = browserPane.getBoundingClientRect().left;
			if (paneLeft > 0) right = paneLeft - 8;
		}
		const px = (typeof x === 'number' && isFinite(x)) ? x : 8;
		const py = (typeof y === 'number' && isFinite(y)) ? y : 8;
		const left = Math.max(8, Math.min(px, right - w));
		const top = Math.max(8, Math.min(py, window.innerHeight - h - 8));

		popover.style.left = left + 'px';
		popover.style.top = top + 'px';
	}

	// --- 辅助函数 -----------------------------------------------------------
	function relTime(ts) {
		if (!ts) return '';
		const diff = Date.now() - ts;
		if (diff < 0) return '';
		const m = Math.floor(diff / 60000);
		if (m < 1) return '刚刚';
		if (m < 60) return m + ' 分钟前';
		const h = Math.floor(m / 60);
		if (h < 24) return h + ' 小时前';
		const d = Math.floor(h / 24);
		if (d === 1) return '昨天';
		if (d < 7) return d + ' 天前';
		const dt = new Date(ts);
		const md = (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
		return dt.getFullYear() === new Date().getFullYear() ? md : (dt.getFullYear() + '年' + md);
	}

	// --- 启动 ---------------------------------------------------------------
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();
