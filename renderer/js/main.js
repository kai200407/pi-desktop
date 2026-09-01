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
	const ipc = window.IpcClient;

	// --- DOM 引用 -----------------------------------------------------------
	const $ = (sel) => document.getElementById(sel);
	const sidebar = $('sidebar');
	const middle = $('middle');
	const browserPane = $('browser-pane');
	const leftResizer = $('left-resizer');
	const rightResizer = $('right-resizer');
	const btnCollapse = $('btn-collapse');
	const btnCollapseR = $('btn-collapse-r');

	// --- 模块实例 -----------------------------------------------------------
	let sidebarModule = null;
	let conversationModule = null;
	let browserUIModule = null;

	// --- 初始化 -------------------------------------------------------------
	function init() {
		// 1. 恢复布局
		restoreLayout();

		// 2. 初始化三大模块
		initSidebar();
		initConversation();
		initBrowserUI();

		// 3. 绑定顶层事件
		bindGlobalEvents();
		bindMenuEvents();
		bindResizers();
		bindCollapseButtons();

		// 4. 主题切换
		applyTheme();
	}

	// --- 模块初始化 ---------------------------------------------------------
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
		conversationModule = new window.Conversation($('center'), state, ipc);
		conversationModule.init({
			onRefreshSessions: () => sidebarModule?.refreshSessions(),
			onClosePopovers: closeAllPopovers,
		});
	}

	function initBrowserUI() {
		browserUIModule = new window.BrowserUI(browserPane, state, ipc);
		browserUIModule.init();
		browserUIModule.hooks = {
			closePopovers: closeAllPopovers,
			onVisibilityChange: (visible) => {
				// 浏览器显隐时无需额外处理，state 已同步
			}
		};
	}

	// --- 布局恢复 -----------------------------------------------------------
	function restoreLayout() {
		// 恢复栏宽
		const widths = state.colWidths || [280, null, 520];
		sidebar.style.width = widths[0] + 'px';
		browserPane.style.width = widths[2] + 'px';

		// 恢复 sidebar 折叠态
		if (state.sidebarHidden) {
			sidebar.classList.add('collapsed');
		}

		// 恢复浏览器折叠态
		if (!state.browserPaneVisible) {
			browserPane.classList.add('collapsed');
		}
	}

	// --- 主题 ---------------------------------------------------------------
	function applyTheme() {
		const theme = state.theme || 'system';
		document.documentElement.setAttribute('data-theme', theme);
	}

	state.on('theme-changed', (newTheme) => {
		applyTheme();
		ipc.invoke('pi:setTheme', { theme: newTheme });
	});

	// --- 全局事件 -----------------------------------------------------------
	function bindGlobalEvents() {
		// IPC 事件流
		ipc.bindEvents({
			onAny: (evt) => {
				// 先让各模块处理
				const handled = 
					sidebarModule?.handleEvent(evt) ||
					conversationModule?.handleEvent(evt) ||
					browserUIModule?.handleEvent(evt);
				
				// 未被处理的事件可以在这里统一记录
				if (!handled) {
					// console.log('[main] Unhandled event:', evt.type);
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
	}

	// --- 菜单事件 -----------------------------------------------------------
	function bindMenuEvents() {
		ipc.on('menu:new-session', () => {
			sidebarModule?.newSession();
		});

		ipc.on('menu:new-ephemeral', () => {
			sidebarModule?.newEphemeral();
		});

		ipc.on('menu:toggle-sidebar', () => {
			toggleSidebar();
		});

		ipc.on('menu:find', () => {
			conversationModule?.openFindBar();
		});
	}

	// --- 折叠按钮 -----------------------------------------------------------
	function bindCollapseButtons() {
		// 左侧折叠按钮（sidebar 开关）
		btnCollapse?.addEventListener('click', () => {
			toggleSidebar();
		});

		// 右侧折叠按钮（browser 开关）
		btnCollapseR?.addEventListener('click', () => {
			browserUIModule?.toggleBrowser();
		});

		// 双击重置宽度
		btnCollapse?.addEventListener('dblclick', () => {
			sidebar.style.width = '280px';
			state.colWidths = [280, null, state.colWidths?.[2] || 520];
		});

		btnCollapseR?.addEventListener('dblclick', () => {
			browserPane.style.width = '520px';
			state.colWidths = [state.colWidths?.[0] || 280, null, 520];
		});
	}

	function toggleSidebar() {
		const hidden = sidebar.classList.toggle('collapsed');
		state.sidebarHidden = hidden;
	}

	// --- 拖拽调宽 -----------------------------------------------------------
	function bindResizers() {
		let startX = 0;
		let startWidth = 0;
		let target = null;

		function onMouseDown(e, side) {
			e.preventDefault();
			startX = e.clientX;
			target = side === 'left' ? sidebar : browserPane;
			startWidth = target.offsetWidth;
			document.addEventListener('mousemove', onMouseMove);
			document.addEventListener('mouseup', onMouseUp);
		}

		function onMouseMove(e) {
			if (!target) return;
			const delta = target === sidebar ? (e.clientX - startX) : (startX - e.clientX);
			const newWidth = Math.max(200, Math.min(800, startWidth + delta));
			target.style.width = newWidth + 'px';
		}

		function onMouseUp() {
			if (target) {
				const widths = state.colWidths || [280, null, 520];
				if (target === sidebar) {
					widths[0] = sidebar.offsetWidth;
				} else {
					widths[2] = browserPane.offsetWidth;
				}
				state.colWidths = widths;
			}
			target = null;
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
		}

		leftResizer?.addEventListener('mousedown', (e) => onMouseDown(e, 'left'));
		rightResizer?.addEventListener('mousedown', (e) => onMouseDown(e, 'right'));
	}

	// --- 弹层协调 -----------------------------------------------------------
	function closeAllPopovers() {
		// 关闭所有模块的弹层
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
			if (pop) pop.hidden = true;
		});
	}

	function positionPopoverXY(popover, anchor, opts = {}) {
		// 简单实现：贴锚点右侧，避免溢出浏览器区域
		const anchorRect = anchor.getBoundingClientRect();
		const browserRect = browserPane.getBoundingClientRect();
		
		let x = anchorRect.right + 8;
		let y = anchorRect.top;

		// 防止溢出右侧（浏览器区域）
		if (x + 300 > browserRect.left) {
			x = anchorRect.left - 300 - 8;
		}

		// 防止溢出下方
		const popHeight = opts.height || 400;
		if (y + popHeight > window.innerHeight) {
			y = window.innerHeight - popHeight - 20;
		}

		popover.style.left = x + 'px';
		popover.style.top = y + 'px';
	}

	// --- 辅助函数 -----------------------------------------------------------
	function relTime(ts) {
		const now = Date.now();
		const diff = now - ts;
		const sec = Math.floor(diff / 1000);
		const min = Math.floor(sec / 60);
		const hour = Math.floor(min / 60);
		const day = Math.floor(hour / 24);

		if (day > 0) return day + '天前';
		if (hour > 0) return hour + '小时前';
		if (min > 0) return min + '分钟前';
		return '刚刚';
	}

	// --- 启动 ---------------------------------------------------------------
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

})();
