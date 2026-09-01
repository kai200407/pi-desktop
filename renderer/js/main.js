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
	function initTheme() {
		// 默认暗色（跟 Codex 一致），手动切过就记住用户选择
		const theme = localStorage.getItem('pi-theme') || 'dark';
		state._theme = theme;  // 直接设置内部值，避免触发事件
	}

	function applyTheme() {
		const theme = state.theme || 'dark';
		document.documentElement.setAttribute('data-theme', theme);
	}

	state.on('theme-changed', (newTheme) => {
		applyTheme();
		// 主题仅存渲染层 localStorage（state.js setter 已处理），主进程无感知需求
	});

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
				btnEphemeral: $('btn-ephemeral'),
				sessionCtxMenu: $('session-ctx-menu'),
				cwdPop: $('cwd-pop'),
				navMore: $('nav-more'),
				btnAddProject: $('btn-add-project'),
				branchPop: $('branch-pop'),
				ctxCwd: $('ctx-cwd'),
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

		// 主题切换按钮
		const btnTheme = $('btn-theme');
		if (btnTheme) {
			btnTheme.addEventListener('click', () => {
				const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
				state.theme = next;  // 通过 setter 触发事件和持久化
			});
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
		if (btnShowSidebar) {
			btnShowSidebar.addEventListener('click', () => {
				toggleSidebar();
			});
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

	function toggleSidebar() {
		const hidden = !sidebar.classList.contains('collapsed');
		setSidebarHidden(hidden);
	}

	function setSidebarHidden(hidden) {
		sidebar.classList.toggle('collapsed', hidden);
		document.documentElement.style.setProperty('--sidebar-track', hidden ? '0px' : '');
		if (shell) shell.classList.toggle('sidebar-hidden', hidden);
		state.sidebarHidden = hidden;  // 持久化到 localStorage
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

	function positionPopoverXY(popover, anchor, opts = {}) {
		const anchorRect = anchor.getBoundingClientRect();
		const browserRect = browserPane.getBoundingClientRect();
		
		let x = anchorRect.right + 8;
		let y = anchorRect.top;

		if (x + 300 > browserRect.left) {
			x = anchorRect.left - 300 - 8;
		}

		const popHeight = opts.height || 400;
		if (y + popHeight > window.innerHeight) {
			y = window.innerHeight - popHeight - 20;
		}

		popover.style.left = x + 'px';
		popover.style.top = y + 'px';
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
