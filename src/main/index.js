// src/main/index.js —— Electron 主进程入口
//
// 重构自 main.js，职责：
//   - 应用生命周期管理（app ready/quit/activate）
//   - 窗口创建与配置
//   - 模块组装（pi引擎 + 浏览器管理 + 会话管理 + IPC路由）
//   - 全局快捷键与菜单
//
// 架构：
//   原 main.js 的 1500 行拆成了 5 个模块（4个业务模块 + 本入口文件），
//   每个模块职责单一，便于维护和测试。

const {
	app, BrowserWindow, WebContentsView, ipcMain, session,
	dialog, shell, nativeTheme, Menu, globalShortcut,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// 业务模块
const { PiEngine } = require("./pi-engine");
const { BrowserManager, attachStealth } = require("./browser");
const { SessionManager, getPiAgentDir, decodeSessionDir, dirExists } = require("./session-mgmt");
const { registerIpcHandlers } = require("./ipc-handlers");

// 辅助模块（Cookie导入、Chrome控制）
const chromeBridge = require("../../chrome-bridge");
const { doImport } = require("../../import-cookies");

// --- 启动开关 ---------------------------------------------------------------
const CDP_PORT = process.env.PI_DESKTOP_CDP_PORT || "9333";
app.commandLine.appendSwitch("remote-debugging-port", CDP_PORT);
app.commandLine.appendSwitch("remote-allow-origins", `http://127.0.0.1:${CDP_PORT}`);
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");

// --- 应用配置持久化 ----------------------------------------------------------
const CONF_DIR = path.join(app.getPath("userData"));
const CONF_FILE = path.join(CONF_DIR, "pi-desktop.json");

function loadConf() {
	try {
		return JSON.parse(fs.readFileSync(CONF_FILE, "utf8"));
	} catch {
		return {};
	}
}

function saveConf(patch) {
	const next = { ...loadConf(), ...patch };
	try {
		fs.mkdirSync(CONF_DIR, { recursive: true });
		fs.writeFileSync(CONF_FILE, JSON.stringify(next, null, 2));
	} catch {}
	return next;
}

let conf = loadConf();

// --- 模块实例 ---------------------------------------------------------------
let win = null;
let piEngine = null;
let browserMgr = null;
let sessionMgr = null;

// --- 窗口创建 ---------------------------------------------------------------
function createWindow() {
	win = new BrowserWindow({
		width: conf.width || 1400,
		height: conf.height || 900,
		titleBarStyle: "hiddenInset",
		trafficLightPosition: { x: 12, y: 16 },
		webPreferences: {
			preload: path.join(__dirname, "..", "..", "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	win.loadFile("renderer/index.html");

	// 窗口尺寸记忆
	win.on("resize", () => {
		const [w, h] = win.getSize();
		saveConf({ width: w, height: h });
	});

	win.on("closed", () => {
		win = null;
	});

	// 应用主题
	if (conf.theme) {
		nativeTheme.themeSource = conf.theme;
	}

	return win;
}

// --- 模块初始化 -------------------------------------------------------------
function initModules() {
	// 1. pi 引擎
	piEngine = new PiEngine({
		getWindow: () => win,
		loadConf,
		saveConf,
	});

	// 2. 浏览器管理器
	browserMgr = new BrowserManager({
		getWin: () => win,
		send: piEngine.send.bind(piEngine),
		loadConf,
		saveConf,
	});

	// 3. 会话管理器
	sessionMgr = new SessionManager({
		getPi: () => piEngine.pi,
		setPi: (val) => { piEngine.pi = val; },
		initPi: piEngine.initPi.bind(piEngine),
		ensurePi: piEngine.ensurePi.bind(piEngine),
		bindSession: piEngine.bindSession.bind(piEngine),
		pushSessionInfo: piEngine.pushSessionInfo.bind(piEngine),
		send: piEngine.send.bind(piEngine),
		loadConf,
		saveConf,
		serializeMessages: serializeMessages,
		// 【性能优化】hover 预取消息缓存（渲染层 preloadSession → 点击命中）
		readMessagesCached: piEngine.readMessagesCached.bind(piEngine),
		takeMessagesCache: piEngine.takeMessagesCache.bind(piEngine),
		getUnsubscribe: () => piEngine.unsubscribe,
		setUnsubscribe: (fn) => { piEngine.unsubscribe = fn; },
	});

	// 4. 注册 IPC 处理器
	registerIpcHandlers({
		piEngine: {
			ensurePi: piEngine.ensurePi.bind(piEngine),
			initPi: piEngine.initPi.bind(piEngine),
			bindSession: piEngine.bindSession.bind(piEngine),
			pushSessionInfo: piEngine.pushSessionInfo.bind(piEngine),
			send: piEngine.send.bind(piEngine),
			getPi: () => piEngine.pi,
			// switchWorkspace 是 SessionManager 的方法，但 ipc-handlers 从 piEngine 解构
			switchWorkspace: sessionMgr.switchWorkspace.bind(sessionMgr),
			// ipc-handlers 还从 piEngine 解构这些（原 main.js 里是全局函数）
			serializeMessages,
			sessionFileOwner: sessionMgr.sessionFileOwner.bind(sessionMgr),
			getPiAgentDir: sessionMgr.getPiAgentDir.bind(sessionMgr),
		},
		browserMgr: {
			createBrowserView: browserMgr.createBrowserView.bind(browserMgr),
			closeTab: browserMgr.closeTab.bind(browserMgr),
			activateTab: browserMgr.activateTab.bind(browserMgr),
			applyBrowserBounds: browserMgr.applyBrowserBounds.bind(browserMgr),
			pushTabs: browserMgr.pushTabs.bind(browserMgr),
			getView: () => browserMgr.browserView,
			getTabs: () => browserMgr.browserTabs,
			getActiveTabId: () => browserMgr.activeTabId,
			isVisible: () => browserMgr.browserVisible,
			setVisible: browserMgr.setVisible.bind(browserMgr),
			getLastBounds: () => browserMgr.lastBounds,
			setLastBounds: (b) => { browserMgr.lastBounds = b; },
			HOME_URL: browserMgr.HOME_URL,
			// 新增：浏览器 conversation 切换
			switchConversation: browserMgr.switchConversation.bind(browserMgr),
		},
		sessionMgr: {
			switchWorkspace: sessionMgr.switchWorkspace.bind(sessionMgr),
			// countBranches / readBranchDetails / deriveSessionName / decodeSessionDir
			// 是 SessionManager 的实例方法（内部委托给模块级纯函数），bind 即可
			countBranches: sessionMgr.countBranches.bind(sessionMgr),
			readBranchDetails: sessionMgr.readBranchDetails.bind(sessionMgr),
			deriveSessionName: sessionMgr.deriveSessionName.bind(sessionMgr),
			decodeSessionDir: sessionMgr.decodeSessionDir.bind(sessionMgr),
			// dirExists 是纯函数（模块级导出），SessionManager 上没有此实例方法，
			// 不能 .bind(sessionMgr)，直接从 session-mgmt 模块导入传递
			dirExists,
			listSessionsGrouped: sessionMgr.listSessionsGrouped.bind(sessionMgr),
			listSessions: sessionMgr.listSessions.bind(sessionMgr),
			switchSession: sessionMgr.switchSession.bind(sessionMgr),
			deleteSession: sessionMgr.deleteSession.bind(sessionMgr),
			renameSession: sessionMgr.renameSession.bind(sessionMgr),
			listBranches: sessionMgr.listBranches.bind(sessionMgr),
			switchToBranch: sessionMgr.switchToBranch.bind(sessionMgr),
		},
		win: () => win,
		conf,
		saveConf,
		loadConf,
		chromeBridge,
		doImport,
		CDP_PORT,
	});

	// 5. CDP 新建 tab 时给它也打隐身补丁（与主标签页一致）
	app.on("web-contents-created", (_, wc) => {
		attachStealth(wc);
	});

	// ===== 已回滚：不再初始化 conversation session =====
	// 浏览器统一使用 persist:pi-browser 单一共享分区，不随工作区切换。

	// 6. 创建首个浏览器标签（加载主页）。
	// 【背景】旧 main.js 在 createWindow() 里调 createBrowserView()；重构后丢了这个调用，
	// 导致 browserMgr.browserView 永远为 null —— 渲染层地址栏/标签栏全空，
	// 「打开浏览器面板」后没有任何 view 可贴。必须在窗口创建后调用一次。
	browserMgr.createBrowserView();
	browserMgr.hookDownloads();

	// 7. 预加载会话列表（不等待，后台异步执行）
	sessionMgr.preloadSessions();
}

// --- 辅助函数（从 main.js 迁移） -------------------------------------------
function serializeMessages(msgs) {
	return msgs.map(m => {
		if (m.role === "user") {
			// conversation.restoreSession 期望 m.text 字段（不是 m.content）
			const text = typeof m.content === "string" ? m.content
				: (m.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
			return { role: "user", text };
		}
		if (m.role === "assistant") {
			// conversation.buildMessageDiv 期望 m.text + m.tools 字段
			let text = "";
			const tools = [];
			if (typeof m.content === "string") {
				text = m.content;
			} else if (Array.isArray(m.content)) {
				m.content.forEach(b => {
					if (b.type === "text") text += (text ? "\n" : "") + b.text;
					else if (b.type === "tool_use") tools.push({ name: b.name, args: b.input });
				});
			}
			return { role: "assistant", text, tools };
		}
		// 其他角色（tool 等）原样透传，conversation 不处理
		return m;
	});
}

// --- macOS 原生菜单 ---------------------------------------------------------
function buildMenu() {
	const template = [
		{
			label: app.name,
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "文件",
			submenu: [
				{
					label: "新对话",
					accelerator: "CmdOrCtrl+N",
					click: () => win?.webContents.send("menu:new-session"),
				},
				{
					label: "新建临时聊天",
					accelerator: "CmdOrCtrl+Shift+N",
					click: () => win?.webContents.send("menu:new-ephemeral"),
				},
				{ type: "separator" },
				{ role: "close" },
			],
		},
		{
			label: "编辑",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "视图",
			submenu: [
				{
					label: "切换侧边栏",
					accelerator: "CmdOrCtrl+B",
					click: () => win?.webContents.send("menu:toggle-sidebar"),
				},
				{
					label: "查找",
					accelerator: "CmdOrCtrl+F",
					click: () => win?.webContents.send("menu:find"),
				},
				{ type: "separator" },
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
			],
		},
		{
			label: "窗口",
			submenu: [
				{ role: "minimize" },
				{ role: "zoom" },
				{ type: "separator" },
				{ role: "front" },
			],
		},
		{
			label: "帮助",
			submenu: [
				{
					label: "pi-desktop GitHub",
					click: () => shell.openExternal("https://github.com/kai200407/pi-desktop"),
				},
			],
		},
	];

	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- 清理 -------------------------------------------------------------------
function cleanupOnExit() {
	if (piEngine?.unsubscribe) {
		piEngine.unsubscribe();
	}
	if (browserMgr) {
		browserMgr.cleanup();
	}
}

// --- 应用生命周期 -----------------------------------------------------------
app.whenReady().then(() => {
	createWindow();
	initModules();
	buildMenu();

	// 全局快捷键：Ctrl+Space 唤起窗口
	try {
		globalShortcut.register("Control+Space", () => {
			if (win) {
				if (win.isMinimized()) win.restore();
				win.show();
				win.focus();
			}
		});
	} catch (err) {
		console.warn("全局快捷键注册失败:", err.message);
	}

	// macOS 点击 Dock 图标时重建窗口
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
			initModules();
		}
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("will-quit", () => {
	globalShortcut.unregisterAll();
	cleanupOnExit();
});
