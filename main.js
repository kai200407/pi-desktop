// main.js —— Electron 主进程
//
// 架构：
//   渲染层（renderer/）只画界面，不碰 Node；
//   主进程内跑 pi SDK 的 AgentSessionRuntime，事件流转成 IPC 推给渲染层；
//   右栏是原生 WebContentsView（完整 Chromium），不是 iframe —— 所以能登 Google。
//
// 已实测确认的关键点（勿改）：
//   1. Electron 必须 >= 37（内置 Node 22+），否则 pi 依赖的 fs.globSync 不存在
//   2. disable-blink-features=AutomationControlled 使 navigator.webdriver=false，Google 登录才不被拦
//   3. persist: 前缀的 partition 让 cookie/localStorage 落盘 —— 密码输一次，以后免登录
//   4. accounts.google.com 在 WebContentsView 里能正常加载（iframe 方案会被 X-Frame-Options 拒）

const {
	app, BrowserWindow, WebContentsView, ipcMain, session,
	dialog, shell, nativeTheme, Menu,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const readline = require("node:readline");
// 「接管真实 Chrome」：内置 WebContentsView 登 Google 被 Google 永久拒绝
// （判据是 Electron 运行时本身，伪装指纹无效，已控制变量实测），
// 所以另开一条路 —— 拉起真实 Chrome 二进制 + 独立 profile。详见 chrome-bridge.js。
const chromeBridge = require("./chrome-bridge");
// 「从 Chrome 导入登录态」：解密真 Chrome 的 Google 域 Cookie 写进内置浏览器分区，
// 绕开 Google 对 Electron 的登录拦截。详见 import-cookies.js 头部注释。
const { doImport } = require("./import-cookies");

// --- 启动开关 ---------------------------------------------------------------
const CDP_PORT = process.env.PI_DESKTOP_CDP_PORT || "9333";
app.commandLine.appendSwitch("remote-debugging-port", CDP_PORT);
app.commandLine.appendSwitch("remote-allow-origins", `http://127.0.0.1:${CDP_PORT}`);
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");

// --- 应用配置持久化（工作区、模型、思考等级、浏览器主页）--------------------
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

let win = null;
let browserView = null;   // 当前【活动】标签的 view（其余代码沿用这个引用）
// 多标签：每个元素 { id, view }。只有活动标签有真 bounds，
// 非活动的缩到 0x0 隐藏（Electron 没有原生“隐藏 view”，bounds 置 0 是标准做法）。
let browserTabs = [];
// OAuth/登录弹窗集合（弱引用用 Map 维护以便集中清理）。
// 弹窗共享 persist:pi-browser session —— 登录态互遇，弹窗里登了主页面立即生效。
const popupWindows = new Map();

// 弹窗去重：同一【根域名】只保留一个弹窗。
// OAuth 流程会连环 window.open（gsi 选择器 → accountchooser → 授权…），
// 若每次都开新窗会越叠越多。同根域的新请求直接复用旧窗导航过去。
function popupRootOf(u) {
	try { return new URL(u).hostname.split(".").slice(-2).join("."); } catch { return u; }
}
function reuseOrOpenPopup(u) {
	const root = popupRootOf(u);
	for (const [oldUrl, pop] of popupWindows) {
		if (pop.isDestroyed()) { popupWindows.delete(oldUrl); continue; }
		if (popupRootOf(oldUrl) === root) {
			// 同根域已有弹窗 → 复用，加载新 URL 并前置（不叠加新窗）
			if (oldUrl !== u) { try { pop.loadURL(u); } catch {} }
			pop.show(); pop.focus();
			popupWindows.delete(oldUrl);
			popupWindows.set(u, pop);
			return;
		}
	}
	popupWindows.set(u, openAuthPopup(u));
}


// 开一个「像真浏览器弹窗」的独立小窗口（X 登 Google、Google One Tap 等）。
// 特点：尺寸小、无地址栏、关窗即终、焦点回主窗。所有弹窗都过 attachStealth。
function openAuthPopup(url) {
	const ses = session.fromPartition("persist:pi-browser");
	const pop = new BrowserWindow({
		width: 480,
		height: 640,
		minWidth: 360,
		minHeight: 420,
		show: false,
		resizable: true,
		title: "",
		autoHideMenuBar: true,
		webPreferences: {
			session: ses,
			preload: path.join(__dirname, "browser-preload.js"),
			contextIsolation: false,
			nodeIntegration: false,
			sandbox: false,
			webSecurity: true,
			backgroundThrottling: false,   // 同主 view：不节流，登录页动画不卡
		},
	});
	// 弹窗自己再 window.open 时（罕见但存在）也走独立弹窗，不进标签页
	pop.webContents.setWindowOpenHandler(({ url: u }) => {
		if (/^https?:/i.test(u)) { reuseOrOpenPopup(u); }
		else { shell.openExternal(u); }
		return { action: "deny" };
	});
	pop.once("ready-to-show", () => pop.show());
	pop.on("closed", () => {
		// 双向清理：按开窗 URL 或当前导航过的任意 key 都删掉
		for (const [k, p] of popupWindows) { if (p === pop || p.isDestroyed()) popupWindows.delete(k); }
		// 弹窗关闭后焦点回主窗（OAuth 完成后用户应回到原页面）
		if (win && !win.isDestroyed()) { win.show(); win.focus(); }
	});
	// 弹窗里的导航同步 UA 补丁（persist session 已设过 UA，这里只挂 stealth）
	attachStealth(pop.webContents);
	pop.loadURL(url);
	return pop;
}
let activeTabId = null;
let tabSeq = 0;
let browserVisible = conf.browserVisible !== false;
let lastBounds = { x: 0, y: 0, width: 0, height: 0 };

// pi 侧运行时
let pi = null;          // { runtime, modelRuntime, cwd }
let unsubscribe = null; // 当前 session 的事件订阅解绑函数
let startedAt = null;   // 本次 agent 任务开始时间（用于完成通知的耗时文案）

const HOME_URL = conf.homeUrl || "https://www.google.com";

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
	win = new BrowserWindow({
		width: conf.winWidth || 1600,
		height: conf.winHeight || 1000,
		minWidth: 940,
		minHeight: 620,
		titleBarStyle: "hiddenInset",
		trafficLightPosition: { x: 16, y: 15 },
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#212121" : "#ffffff",
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			// 同上：主窗口不节流，保证被遮挡时 bounds 上报/消息渲染不被掉到 1Hz
			backgroundThrottling: false,
		},
	});

	win.loadFile(path.join(__dirname, "renderer", "index.html"));
	createBrowserView();

	win.on("resize", () => {
		if (!win) return;
		const [w, h] = win.getSize();
		saveConf({ winWidth: w, winHeight: h });
	});

	win.on("closed", () => {
		win = null;
		browserView = null;
	});

	if (process.argv.includes("--dev")) win.webContents.openDevTools({ mode: "detach" });
}

// ---------------------------------------------------------------------------
// 右栏浏览器：真实 Chromium + 持久 profile（免重复登录的关键）
// ---------------------------------------------------------------------------
// Google 会拒绝「嵌入式浏览器」登录（提示"此浏览器或应用可能不安全"）。
// 实测破绽有三处，缺一不可：
//   1. UA 里的 Electron/appName 标识
//   2. navigator.userAgentData.brands 缺少 "Google Chrome"（Electron 只报 Chromium）
//   3. Sec-CH-UA 请求头同样缺 "Google Chrome"
// 下面对这三处统一伪装成与本机真实 Chrome 一致的形态。
// 隐身补丁源码：除了当 preload 挂在初始 view 上，还要在每次导航时
// 用 executeJavaScript 注入一次 —— Electron 38 的 session.setPreloads() 对运行时
// 新建的 webContents（弹窗 / agent 经 CDP 新开的 tab）不可靠，实测会退回 Chromium。
let STEALTH_SRC = "";
try {
	STEALTH_SRC = fs.readFileSync(path.join(__dirname, "browser-preload.js"), "utf8");
} catch {}

// 给任意 webContents 挂上“导航即注入”。documentStart 阶段执行，
// 早于页面自己的检测脚本。
function attachStealth(wc) {
	if (!STEALTH_SRC || wc.__stealthAttached) return;
	wc.__stealthAttached = true;
	const inject = () => {
		wc.executeJavaScript(STEALTH_SRC, true).catch(() => {});
	};
	wc.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => {
		if (isMainFrame) inject();
	});
	wc.on("dom-ready", inject);
	inject();
}

const CHROME_MAJOR = process.versions.chrome ? process.versions.chrome.split(".")[0] : "140";
const CHROME_FULL = `${CHROME_MAJOR}.0.0.0`;
const SEC_CH_UA = `"Not=A?Brand";v="99", "Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}"`;

// session 级初始化（UA / 请求头 / 权限）只能做一次，
// 否则多标签时 onBeforeSendHeaders 会被重复注册。
let sessionReady = false;

function createBrowserView(initialUrl) {
	const ses = session.fromPartition("persist:pi-browser");

	// (1) UA：去掉 Electron / 应用名，并把 Chrome 版本规整成 x.0.0.0（真 Chrome 的形态）
	const ua = ses.getUserAgent()
		.replace(/ pi-desktop\/[\d.]+/gi, "")
		.replace(/ Electron\/[\d.]+/gi, "")
		.replace(/Chrome\/[\d.]+/i, `Chrome/${CHROME_FULL}`);
	if (!sessionReady) {
		sessionReady = true;
		ses.setUserAgent(ua);

		// (3) 请求头：补上 Sec-CH-UA 三件套，去掉 Electron 痕迹
		ses.webRequest.onBeforeSendHeaders((details, cb) => {
			const h = details.requestHeaders;
			h["User-Agent"] = ua;
			h["sec-ch-ua"] = SEC_CH_UA;
			h["sec-ch-ua-mobile"] = "?0";
			h["sec-ch-ua-platform"] = '"macOS"';
			cb({ requestHeaders: h });
		});

		// 权限请求：摄像头/麦克风/通知一律拒，地理位置放行（登录风控有时要）
		ses.setPermissionRequestHandler((_wc, permission, cb) => {
			cb(["geolocation", "clipboard-read", "clipboard-sanitized-write"].includes(permission));
		});
	}

	browserView = new WebContentsView({
		webPreferences: {
			session: ses,
			// (2) 页面侧隐身补丁：改写 userAgentData.brands 等，详见 browser-preload.js
			preload: path.join(__dirname, "browser-preload.js"),
			contextIsolation: false, // 补丁要直接改页面 window，必须关隔离
			nodeIntegration: false,
			sandbox: false, // preload 需要在页面上下文里执行
			webSecurity: true,
			// 【性能关键】关掉后台节流：否则窗口不在前台时 Chromium 把页面的
			// 定时器/rAF/加载全部降到 1Hz，重 JS 站（X 等）直接“卡死”。
			// Codex 桌面端同理不节流 —— 内嵌浏览器必须始终满血。
			backgroundThrottling: false,
		},
	});

	// 挂到窗口的 contentView 上。注意：必须确认真的挂上了 ——
	// 实测过一个坑：若 addChildView 未生效，children.length 仍为 1，
	// view 有正确 bounds 但 capturePage() 返回空图，表现为右栏全黑。
	const view = browserView;   // 本函数内统一用 view 指代新建的这个
	win.contentView.addChildView(view);
	if (!win.contentView.children.includes(view)) {
		// 兼容写法：部分版本需要在窗口就继后再挂
		win.once("ready-to-show", () => {
			try { win.contentView.addChildView(view); } catch {}
			applyBrowserBounds();
		});
	}
	view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

	// 登记为一个标签并设为活动
	const tabId = `t${++tabSeq}`;
	if (process.env.PI_DESKTOP_DEBUG_BOUNDS) console.log(`[tab] 创建 ${tabId} -> ${initialUrl || HOME_URL}`);
	browserTabs.push({ id: tabId, view });
	activeTabId = tabId;
	view.webContents.loadURL(initialUrl || HOME_URL);

	const wc = view.webContents;
	attachStealth(wc);

	const pushUrl = () => {
		if (!win || win.isDestroyed()) return;
		// 只有活动标签才更新地址栏，否则后台标签加载完会抢地址栏
		if (tabId === activeTabId) {
			send("browser_url", {
				url: wc.getURL(),
				title: wc.getTitle(),
				canBack: wc.navigationHistory.canGoBack(),
				canForward: wc.navigationHistory.canGoForward(),
				loading: wc.isLoading(),
			});
		}
		pushTabs();
	};
	for (const ev of ["did-navigate", "did-navigate-in-page", "page-title-updated",
		"did-start-loading", "did-stop-loading"]) {
		wc.on(ev, pushUrl);
	}

	// 页面里的 target=_blank / window.open → 分流：
	// · OAuth / 登录 / 支付类弹窗（X 登 Google、Google One Tap 等都会 window.open
	//   小窗）→ 开【独立小 BrowserWindow】共享同一 session，窗口尺寸/居中像真弹窗，
	//   关窗即结束，不打标签页、不抢多标签切换 —— 否则登录流程会被拉成整页标签，
	//   体感就是「卡、怪」；且 OAuth 弹窗需要关窗后焦点回原页，标签页做不到。
	// · 普通链接 → 开新标签（原行为）。
	wc.setWindowOpenHandler(({ url, features }) => {
		if (!/^https?:/i.test(url)) {
			shell.openExternal(url);
			return { action: "deny" };
		}
		// 弹窗特征：URL 是账号/OAuth 域，或 features 带 popup/width/height
		const isPopupUrl = /accounts\.google\.com\/(gsi|ooauth|signin)|\/oauth|signin|accounts\.|login|auth\?|\bsession\b/i.test(url)
				&& /google|x\.com|twitter|appleid|github|facebook|login|account/i.test(url);
		const wantsPopup = /popup/i.test(features || "") || /(?:^|,)width\s*=/i.test(features || "");
		if (isPopupUrl || wantsPopup) {
			// 【关键修复】OAuth/登录弹窗必须返回 action:"allow" —— deny 后自己开窗会丢
			// window.opener 关系，Google gsi 弹窗靠 postMessage 和 opener 通信，
			// 拿不到 opener 就永远白屏（实测：X 的「通过 Google 继续」弹窗空内容）。
			// allow + overrideBrowserWindowOptions 让 Electron 原生开弹窗（自动继承
			// opener、同 session），我们只覆盖尺寸与样式。
			return {
				action: "allow",
				overrideBrowserWindowOptions: {
					width: 480,
					height: 640,
					minWidth: 360,
					minHeight: 420,
					resizable: true,
					autoHideMenuBar: true,
					webPreferences: {
						// 与主 view 同 session：登录态互遇；不节流；保留 stealth preload
						session: wc.session,
						preload: path.join(__dirname, "browser-preload.js"),
						contextIsolation: false,
						nodeIntegration: false,
						sandbox: false,
						webSecurity: true,
						backgroundThrottling: false,
					},
				},
				createWindow: (opts) => {
					// 自建窗口以拿到引用（关窗时焦点回主窗；退出时统一清理）
					const pop = new BrowserWindow({ ...opts, show: true });
					pop.on("closed", () => {
						for (const [k, p] of popupWindows) { if (p === pop || p.isDestroyed()) popupWindows.delete(k); }
						if (win && !win.isDestroyed()) { win.show(); win.focus(); }
					});
					popupWindows.set(url, pop);
					return pop;
				},
			};
		}
		// 普通链接：开新标签（deny + 自建 view 的老路径，多标签逻辑不变）
		createBrowserView(url);
		applyBrowserBounds();
		pushTabs();
		return { action: "deny" };
	});

	// 右键菜单：复制/粘贴/后退/刷新/开发者工具
	wc.on("context-menu", (_e, params) => {
		const items = [];
		if (params.linkURL) {
			items.push({ label: "复制链接", click: () => require("electron").clipboard.writeText(params.linkURL) });
		}
		if (params.selectionText) {
			items.push({ label: "复制", role: "copy" });
			items.push({
				label: `搜索 "${params.selectionText.slice(0, 18)}"`,
				click: () => wc.loadURL(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`),
			});
		}
		if (params.isEditable) items.push({ label: "粘贴", role: "paste" });
		items.push({ type: "separator" });
		items.push({ label: "后退", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
		items.push({ label: "刷新", click: () => wc.reload() });
		items.push({ type: "separator" });
		items.push({ label: "检查元素", click: () => wc.inspectElement(params.x, params.y) });
		Menu.buildFromTemplate(items).popup();
	});
}


// 把当前标签列表推给渲染层（画标签栏）
function pushTabs() {
	if (!win || win.isDestroyed()) return;
	send("browser_tabs", {
		activeId: activeTabId,
		tabs: browserTabs.map((t) => {
			let url = "", title = "", loading = false;
			try {
				url = t.view.webContents.getURL();
				title = t.view.webContents.getTitle();
				loading = t.view.webContents.isLoading();
			} catch {}
			return { id: t.id, url, title, loading };
		}),
	});
}

// 切换活动标签：把目标 view 提到最上层并给它真 bounds
function activateTab(id) {
	const t = browserTabs.find((x) => x.id === id);
	if (!t) return false;
	activeTabId = id;
	browserView = t.view;
	// 重新 addChildView 等于提升 z 序，确保活动标签在最上面
	try { win.contentView.addChildView(t.view); } catch {}
	applyBrowserBounds();
	const wc = t.view.webContents;
	send("browser_url", {
		url: wc.getURL(), title: wc.getTitle(),
		canBack: wc.navigationHistory.canGoBack(),
		canForward: wc.navigationHistory.canGoForward(),
		loading: wc.isLoading(),
	});
	pushTabs();
	return true;
}

// 关闭标签：销毁 view 并释放进程（不能只从数组里抽走，会泄漏）
function closeTab(id) {
	const i = browserTabs.findIndex((x) => x.id === id);
	if (i < 0) return;
	const t = browserTabs[i];
	browserTabs.splice(i, 1);
	try { win.contentView.removeChildView(t.view); } catch {}
	try { t.view.webContents.close(); } catch {}

	if (!browserTabs.length) {
		// 关完最后一个就新开一个空白页，避免右栏变死区
		createBrowserView(HOME_URL);
		applyBrowserBounds();
		pushTabs();
		return;
	}
	if (activeTabId === id) activateTab(browserTabs[Math.max(0, i - 1)].id);
	else pushTabs();
}

function applyBrowserBounds() {
	// 非活动标签一律缩到 0x0（Electron 无原生隐藏 API）
	for (const t of browserTabs) {
		if (t.id !== activeTabId) {
			try { t.view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); } catch {}
		}
	}
	if (!browserView) return;
	if (!browserVisible) {
		browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
		return;
	}
	const b = lastBounds;
	if (process.env.PI_DESKTOP_DEBUG_BOUNDS) {
		console.log(`[bounds] visible=${browserVisible} rect=`, JSON.stringify(b));
	}
	browserView.setBounds({
		x: Math.round(b.x),
		y: Math.round(b.y),
		width: Math.max(0, Math.round(b.width)),
		height: Math.max(0, Math.round(b.height)),
	});
}

// ---------------------------------------------------------------------------
// 推事件给渲染层
// ---------------------------------------------------------------------------
function send(type, extra = {}) {
	if (!win || win.isDestroyed()) return;
	win.webContents.send("pi:event", { type, ...extra });
}

// ---------------------------------------------------------------------------
// pi 引擎
// 用 AgentSessionRuntime（而非裸 AgentSession），这样 newSession / switchSession /
// fork 都能走官方路径。runtime.session 会在替换后变化，所以每次都要重新订阅。
// ---------------------------------------------------------------------------
// cwd 可选；opts.ephemeral=true 时用 inMemory SessionManager（不落盘）
async function initPi(cwd, opts = {}) {
	const mod = await import("@earendil-works/pi-coding-agent");
	const {
		createAgentSessionRuntime, createAgentSessionServices,
		createAgentSessionFromServices, SessionManager, ModelRuntime, getAgentDir,
	} = mod;

	const workdir = cwd || conf.cwd || process.cwd();
	const modelRuntime = await ModelRuntime.create();

	// 选模型：优先上次用的，否则按偏好列表挑第一个能用的
	const all = modelRuntime.getModels?.() || [];
	const wanted = conf.modelId;
	const prefer = ["glm-5.3-ioa", "kimi-k3-ioa", "glm-5.2-ioa"];
	let model =
		(wanted && all.find((m) => m.id === wanted)) ||
		prefer.map((k) => all.find((m) => m.id === k)).find(Boolean) ||
		undefined;

	const createRuntime = async ({ cwd: c, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ cwd: c });
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, modelRuntime, model })),
			services,
			diagnostics: services.diagnostics,
		};
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: workdir,
		agentDir: getAgentDir(),
		// 临时聊天：inMemory 不写 jsonl 文件，newSession 也会保持不落盘
		sessionManager: opts.ephemeral
			? SessionManager.inMemory(workdir)
			: SessionManager.create(workdir),
	});

	pi = { runtime, modelRuntime, cwd: workdir };
	bindSession();
	const rec = (loadConf().recentCwds || []).filter((x) => x !== workdir);
	rec.unshift(workdir);
	saveConf({ cwd: workdir, recentCwds: rec.slice(0, 10) });
	pushSessionInfo();
	return pi;
}

// 订阅当前 session（runtime.session 被替换后必须重新调用）
function bindSession() {
	if (unsubscribe) { try { unsubscribe(); } catch {} unsubscribe = null; }
	const sess = pi.runtime.session;

	unsubscribe = sess.subscribe((event) => {
		switch (event.type) {
			case "agent_start": send("agent_start"); startedAt = Date.now(); break;
			case "agent_end":
			case "agent_settled": {
				send("agent_end");
				// 任务完成通知（Codex 通知分类里的核心类）：仅当窗口失焦时弹系统通知，
				// 长任务(≥5s)跑完用户切去干别的，不用盯着等。点击通知带回窗口。
				try {
					const durSec = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
					if (!win || win.isDestroyed() || (!win.isFocused() && durSec >= 5)) {
						const { Notification } = require("electron");
						if (Notification.isSupported()) {
							const n = new Notification({
								title: "pi-desktop",
								body: durSec > 0 ? `任务完成（耗时 ${durSec}s），点击查看` : "任务完成，点击查看",
								});
							n.on("click", () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
							n.show();
						}
					}
				} catch {}
				break;
			}

			case "message_start": send("message_start", { role: "assistant" }); break;

			case "message_update": {
				const e = event.assistantMessageEvent;
				if (!e) break;
				if (e.type === "text_delta") send("text_delta", { delta: e.delta });
				else if (e.type === "thinking_delta") send("thinking_delta", { delta: e.delta });
				else if (e.type === "thinking_start") send("thinking_start");
				else if (e.type === "thinking_end") send("thinking_end");
				break;
			}

			case "message_end": send("message_end"); break;

			case "tool_execution_start":
				send("tool_start", { id: event.toolCallId, name: event.toolName, args: event.args });
				break;

			case "tool_execution_end": {
				const text = (event.result?.content || [])
					.filter((c) => c.type === "text").map((c) => c.text).join("\n");
				send("tool_end", { id: event.toolCallId, ok: !event.isError, output: text });
				break;
			}

			case "compaction_start": send("notice", { text: "正在压缩上下文…" }); break;
			case "compaction_end":
				send("notice", { text: "上下文已压缩" });
				// 置顶摘要横条：CompactionResult 里带 summary 文本（见 compaction.d.ts），
				// 中止/失败时 result 为 undefined，渲染层会显示占位文案。
				send("compaction", {
					text: event.result?.summary || "",
					reason: event.reason,
					aborted: !!event.aborted,
				});
				break;

			default: break;
		}
	});
}

function pushSessionInfo() {
	if (!pi) return;
	const s = pi.runtime.session;
	send("session_info", {
		cwd: pi.cwd,
		model: s.model?.id || "(未选择)",
		thinkingLevel: s.thinkingLevel || "off",
		sessionId: s.sessionId,
	});
}

async function ensurePi() {
	if (pi) return pi;
	try {
		return await initPi();
	} catch (err) {
		send("error", {
			message: `pi 引擎加载失败：${err.message}\n请确认 ~/.pi/agent/models.json 已配置且 npm install 完成。`,
		});
		throw err;
	}
}


// 切换工作区：重建 pi runtime，并把路径记入“最近工作区”（仿 Codex）。
async function switchWorkspace(dir) {
	if (unsubscribe) { try { unsubscribe(); } catch {} unsubscribe = null; }
	pi = null;
	const list = (loadConf().recentCwds || []).filter((x) => x !== dir);
	list.unshift(dir);
	saveConf({ recentCwds: list.slice(0, 10) });
	await initPi(dir);
	send("session_cleared");
	send("recent_cwds", { list: (loadConf().recentCwds || []) });
}


// ~/.pi/agent 目录（会话、模型、凭证都在这里）
function getPiAgentDir() {
	return process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

// 把会话目录名反解回绝对路径：--Users-a-b-- -> /Users/a/b
// 注意：目录名本身含连字符时无法完全反解（如 pi-desktop），
// 所以逐步合并候选段，取第一个真存在的目录。
function decodeSessionDir(enc) {
	const body = enc.replace(/^--/, "").replace(/--$/, "");
	const parts = body.split("-");
	// 从最粗粒度开始试：把相邻段逐渐用 "-" 重新拼回去
	const tryPath = (segs) => "/" + segs.join("/");
	let best = tryPath(parts);
	if (dirExists(best)) return best;
	for (let joinCount = 1; joinCount < parts.length; joinCount++) {
		for (let i = 0; i + joinCount < parts.length; i++) {
			const segs = parts.slice(0, i)
				.concat([parts.slice(i, i + joinCount + 1).join("-")])
				.concat(parts.slice(i + joinCount + 1));
			const cand = tryPath(segs);
			if (dirExists(cand)) return cand;
		}
	}
	return best;
}

function dirExists(p) {
	try { return fs.statSync(p).isDirectory(); } catch { return false; }
}


// 从会话文件路径反推它属于哪个工作区
// ~/.pi/agent/sessions/--Users-a-b--/xxx.jsonl  ->  /Users/a/b
function sessionFileOwner(file) {
	try {
		const enc = path.basename(path.dirname(file));
		if (!/^--.*--$/.test(enc)) return null;
		const p = decodeSessionDir(enc);
		return dirExists(p) ? p : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
	// ==== 对话 ====
	ipcMain.handle("pi:send", async (_e, text) => {
		const { runtime } = await ensurePi();
		const s = runtime.session;
		try {
			if (s.isStreaming) await s.prompt(text, { streamingBehavior: "steer" });
			else await s.prompt(text);
		} catch (err) {
			send("error", { message: err.message });
		}
		// 收尾时把可能的引擎级错误（如 429 限流）显式抛给界面
		const em = s.agent?.state?.errorMessage;
		if (em) send("error", { message: String(em).slice(0, 600) });
	});

	ipcMain.handle("pi:abort", async () => {
		if (pi) await pi.runtime.session.abort();
	});

	// ==== 会话 ====
	// 临时聊天：不落盘的会话。当前已是 inMemory 时直接 newSession
	// （pi 的 newSession 会检查 isPersisted() 并保持 inMemory，不会意外落盘）。
	ipcMain.handle("pi:newEphemeral", async () => {
		const { runtime } = await ensurePi();
		// 若当前是持久会话，换用 inMemory 的 SessionManager 重建 runtime
		if (runtime.session.sessionManager.isPersisted()) {
			const mod = await import("@earendil-works/pi-coding-agent");
			const sm = mod.SessionManager.inMemory(runtime.cwd || pi.cwd);
			await runtime.switchToManager?.(sm);          // 若 runtime 不提供该入口则走重初始化
			if (!runtime.switchToManager) {
				// 重初始化：dispose 旧 runtime，用 inMemory manager 新建（沿用原工厂参数）
				await initPi(pi.cwd, { ephemeral: true });
			}
		} else {
			await runtime.newSession();
		}
		bindSession();
		pushSessionInfo();
		send("session_cleared", { ephemeral: true });
	});

	ipcMain.handle("pi:newSession", async () => {
		const { runtime } = await ensurePi();
		await runtime.newSession();
		bindSession();
		pushSessionInfo();
		send("session_cleared");
	});

	ipcMain.handle("pi:switchSession", async (_e, file) => {
		try {
			await ensurePi();
			// 会话可能属于另一个项目（左栅能看到所有项目）。
			// 先把工作区切到那个项目，否则工具会在错的目录下执行。
			const owner = sessionFileOwner(file);
			if (owner && owner !== pi.cwd) await switchWorkspace(owner);
			const { runtime } = await ensurePi();
			await runtime.switchSession(file);
			bindSession();
			pushSessionInfo();
			// 回灌历史消息，让界面能重建对话
			const msgs = runtime.session.messages || [];
			send("session_restored", { messages: serializeMessages(msgs) });
		} catch (err) {
			send("error", { message: `切换会话失败：${err.message}` });
		}
	});

	// 按项目（工作区目录）分组的会话列表 —— 左栅用。
	//
	// pi 的会话不在 <cwd>/.pi/sessions，而是统一放在
	// ~/.pi/agent/sessions/<路径编码>/*.jsonl，编码规则实测为：
	//   /Users/arden/Desktop/tcic-owner  ->  --Users-arden-Desktop-tcic-owner--
	// 即斜杠换连字符、两端各加 "--"。
	// 直接扫这个目录就能自动发现历史上所有项目，
	// 不靠 recentCwds 慢慢累积。
	ipcMain.handle("pi:listSessionsGrouped", async () => {
		try {
			const cur = pi?.cwd || conf.cwd || process.cwd();
			const root = path.join(getPiAgentDir(), "sessions");
			const groups = [];

			if (fs.existsSync(root)) {
				for (const enc of fs.readdirSync(root)) {
					const dir = path.join(root, enc);
					try {
						if (!fs.statSync(dir).isDirectory()) continue;
					} catch { continue; }

					const proj = decodeSessionDir(enc);
					const sessions = [];
					for (const f of fs.readdirSync(dir)) {
						if (!f.endsWith(".jsonl")) continue;
						const fp = path.join(dir, f);
						try {
							const st = fs.statSync(fp);
							if (st.size < 8) continue; // 空会话不列
							sessions.push({ id: fp, file: fp, name: deriveSessionName(fp, f), mtime: st.mtimeMs });
						} catch {}
					}
					// 分支徽标（P1-7）：先按 mtime 排序（与展示一致），再并行流式扫描
					// Top 30（每文件最多前 600 行），单文件失败兜底 0，绝不拖垮列表加载。
					sessions.sort((a, b) => b.mtime - a.mtime);
					await Promise.all(sessions.slice(0, 30).map(async (s) => {
						s.branches = await countBranches(s.file);
					}));
					if (!sessions.length && proj !== cur) continue; // 无会话的历史项目不展示
					// 目录已不存在（旧路径、临时目录被清）则跳过，
					// 否则左栅会出现 "1" "2" 这种无意义项
					if (proj !== cur && !dirExists(proj)) continue;
					groups.push({
						project: path.basename(proj) || proj,
						path: proj,
						current: proj === cur,
						sessions,
					});
				}
			}

			// 当前工作区即使还没会话也要出现
			if (!groups.some((g) => g.current)) {
				groups.unshift({ project: path.basename(cur), path: cur, current: true, sessions: [] });
			}

			groups.sort((a, b) => {
				if (a.current !== b.current) return a.current ? -1 : 1;
				return (b.sessions[0]?.mtime || 0) - (a.sessions[0]?.mtime || 0);
			});
			return groups.slice(0, 20);
		} catch {
			return [];
		}
	});

	// 删除会话：删掉对应 .jsonl 文件并刷新列表。
	// 删除前确认文件存在且确实位于 sessions 目录下（防误删任意路径）。
	ipcMain.handle("pi:deleteSession", async (_e, file) => {
		try {
			if (!file || typeof file !== "string") return { ok: false, err: "bad arg" };
			const root = path.join(getPiAgentDir(), "sessions");
			const rp = path.resolve(file);
			if (!rp.startsWith(root + path.sep) || !rp.endsWith(".jsonl")) {
				return { ok: false, err: "不在会话目录内" };
			}
			if (!fs.existsSync(rp)) return { ok: false, err: "文件不存在" };
			fs.unlinkSync(rp);
			return { ok: true };
		} catch (err) {
			return { ok: false, err: err.message };
		}
	});

	// ==== 会话分支（P1-7）====
	// 列出某会话文件里的 branch_summary 条目（弹层用）。
	// 安全：与 deleteSession 同款校验 —— 只允许读 sessions 目录下的 .jsonl。
	ipcMain.handle("pi:listBranches", async (_e, file) => {
		try {
			const root = path.join(getPiAgentDir(), "sessions");
			const rp = path.resolve(String(file || ""));
			if (!rp.startsWith(root + path.sep) || !rp.endsWith(".jsonl")) return [];
			if (!fs.existsSync(rp)) return [];
			return await readBranchDetails(rp);
		} catch {
			return [];
		}
	});

	// 切到某个分叉点继续对话。
	// API 语义调研结论（dist/core/agent-session.js navigateTree 实现）：
	//   · summarize:false 时只移动 SessionManager.leafId 并重建 agent.state.messages，
	//     不落 jsonl（不落 branch_summary）；下一条消息才以该节点为父开新分支。
	//   · summarize:true 才会 append branch_summary 条目。我们传 false，不写文件。
	//   · 该调用要求当前 session 就是目标 session（得先 switchSession 装载）。
	// 完整链路：switchSession(file) 装载 → navigateTree(branchFromId, {summarize:false})
	//   → 回灌该分支的历史（session.messages 是 leaf 到 root 的路径消息）。
	ipcMain.handle("pi:switchToBranch", async (_e, payload) => {
		const { file, branchFromId } = payload || {};
		try {
			if (!file || !branchFromId) return { ok: false, err: "bad arg" };
			await ensurePi();
			// 会话可能属于另一个项目：先切工作区（与 pi:switchSession 同款逻辑）
			const owner = sessionFileOwner(file);
			if (owner && owner !== pi.cwd) await switchWorkspace(owner);
			const { runtime } = await ensurePi();
			await runtime.switchSession(file);
			bindSession();
			const r = await runtime.session.navigateTree(branchFromId, { summarize: false });
			if (r && r.cancelled) return { ok: false, err: "cancelled" };
			pushSessionInfo();
			// 回灌当前 leaf 路径的消息，让界面重建这条分支的对话
			const msgs = runtime.session.messages || [];
			send("session_restored", { messages: serializeMessages(msgs) });
			return { ok: true };
		} catch (err) {
			return { ok: false, err: err.message };
		}
	});

	ipcMain.handle("pi:listSessions", async () => {
		try {
			const { cwd } = await ensurePi();
			// pi 的会话默认落在 <cwd>/.pi/sessions
			const dirs = [path.join(cwd, ".pi", "sessions")];
			const out = [];
			for (const d of dirs) {
				if (!fs.existsSync(d)) continue;
				for (const f of fs.readdirSync(d)) {
					if (!f.endsWith(".jsonl")) continue;
					const p = path.join(d, f);
					const st = fs.statSync(p);
					out.push({ id: p, name: deriveSessionName(p, f), mtime: st.mtimeMs });
				}
			}
			return out.sort((a, b) => b.mtime - a.mtime).slice(0, 60);
		} catch {
			return [];
		}
	});

	// ==== 模型 / 思考等级 ====
	ipcMain.handle("pi:getModels", async () => {
		try {
			const { modelRuntime } = await ensurePi();
			// 只返回【可用】模型（有凭证/鉴权通过的）。
			// 1341 个全部展示没意义 —— 用不了的占绝大多数，找模型像海底捞针。
			// getAvailableSnapshot() 是 pi 官方的可用性快照（凭证过滤后）。
			const usable = modelRuntime.getAvailableSnapshot?.() || [];
			const all = usable.length ? usable : (modelRuntime.getModels?.() || []);
			// 只暴露 id/name/provider，避免把 headers 等敏感配置送进渲染层
			return all.map((m) => ({
				id: m.id,
				name: m.name || m.id,
				provider: m.provider || "",
				reasoning: !!m.reasoning,
			}));
		} catch {
			return [];
		}
	});

	ipcMain.handle("pi:setModel", async (_e, id) => {
		try {
			const { runtime, modelRuntime } = await ensurePi();
			const m = (modelRuntime.getModels?.() || []).find((x) => x.id === id);
			if (!m) return send("error", { message: `未找到模型 ${id}` });
			await runtime.session.setModel(m);
			saveConf({ modelId: id });
			pushSessionInfo();
		} catch (err) {
			send("error", { message: err.message });
		}
	});

	ipcMain.handle("pi:setThinking", async (_e, level) => {
		try {
			const { runtime } = await ensurePi();
			runtime.session.setThinkingLevel(level);
			saveConf({ thinkingLevel: level });
			pushSessionInfo();
		} catch (err) {
			send("error", { message: err.message });
		}
	});

	ipcMain.handle("pi:getThinkingLevels", async () => {
		// pi 的档位固定为这几档；渲染层只做展示
		return ["off", "minimal", "low", "medium", "high", "xhigh"];
	});

	// ==== 工作区 ====
	ipcMain.handle("pi:getCwd", async () => pi?.cwd || conf.cwd || process.cwd());

	ipcMain.handle("pi:getRecentCwds", async () => {
		const list = loadConf().recentCwds || [];
		const cur = pi?.cwd || process.cwd();
		// 只返回仍存在的目录，并把当前工作区标出来
		return list.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
			.map((d) => ({ path: d, name: path.basename(d), current: d === cur }));
	});

	ipcMain.handle("pi:setCwd", async (_e, dir) => {
		try {
			if (!fs.statSync(dir).isDirectory()) throw new Error("不是目录");
			await switchWorkspace(dir);
			return dir;
		} catch (err) {
			send("error", { message: `切换工作区失败：${err.message}` });
			return null;
		}
	});

	ipcMain.handle("pi:pickCwd", async () => {
		const r = await dialog.showOpenDialog(win, {
			properties: ["openDirectory", "createDirectory"],
			defaultPath: pi?.cwd || os.homedir(),
			title: "选择工作区",
		});
		if (r.canceled || !r.filePaths[0]) return null;
		const next = r.filePaths[0];
		await switchWorkspace(next);
		return next;
	});

	// ==== 压缩上下文 ====
	ipcMain.handle("pi:compact", async () => {
		try {
			const { runtime } = await ensurePi();
			await runtime.session.compact();
		} catch (err) {
			send("error", { message: err.message });
		}
	});

	// ==== 右栏浏览器 ====
	ipcMain.handle("browser:go", (_e, url) => {
		if (!browserView) return;
		let t = String(url || "").trim();
		if (!t) return;
		if (!/^[a-z]+:\/\//i.test(t)) {
			t = /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(t)
				? `https://${t}`
				: `https://www.google.com/search?q=${encodeURIComponent(t)}`;
		}
		browserView.webContents.loadURL(t);
	});
	ipcMain.handle("browser:back", () => {
		const h = browserView?.webContents.navigationHistory;
		if (h?.canGoBack()) h.goBack();
	});
	ipcMain.handle("browser:forward", () => {
		const h = browserView?.webContents.navigationHistory;
		if (h?.canGoForward()) h.goForward();
	});
	ipcMain.handle("browser:reload", () => browserView?.webContents.reload());
	ipcMain.handle("browser:home", () => browserView?.webContents.loadURL(HOME_URL));
	ipcMain.handle("browser:devtools", () => browserView?.webContents.openDevTools({ mode: "detach" }));

	// 在外部浏览器打开当前地址栏 URL
	ipcMain.handle("browser:openExternal", (_e, url) => {
		const u = String(url || "").trim();
		if (!/^https?:\/\//i.test(u)) return { ok: false, err: "invalid url" };
		shell.openExternal(u);
		return { ok: true };
	});

	// 列出下载目录最近 20 个文件（mtime 降序）
	ipcMain.handle("browser:listDownloads", () => {
		try {
			const dir = app.getPath("downloads");
			const items = [];
			for (const name of fs.readdirSync(dir)) {
				if (name.startsWith(".")) continue;   // 跳过隐藏文件
				const fp = path.join(dir, name);
				try {
					const st = fs.statSync(fp);
					if (st.isDirectory()) continue;
					items.push({ name, path: fp, mtime: st.mtimeMs, size: st.size });
				} catch {}
			}
			items.sort((a, b) => b.mtime - a.mtime);
			return { ok: true, items: items.slice(0, 20) };
		} catch (err) {
			return { ok: false, err: err.message, items: [] };
		}
	});

	// 在 Finder/文件管理器里定位文件
	ipcMain.handle("browser:showInFolder", (_e, file) => {
		if (typeof file === "string" && file) shell.showItemInFolder(file);
		return { ok: true };
	});

	ipcMain.handle("browser:toggle", (_e, visible) => {
		if (process.env.PI_DESKTOP_DEBUG_BOUNDS) console.log("[toggle] ->", visible);
		browserVisible = !!visible;
		saveConf({ browserVisible });
		applyBrowserBounds();
		return browserVisible;
	});

	ipcMain.on("browser:bounds", (_e, rect) => {
		if (rect && typeof rect.width === "number") {
			lastBounds = rect;
			applyBrowserBounds();
		}
	});

	// 给 agent 用：右栏浏览器的 CDP 端口
	// 调试用：导出右栏 view 的真实状态（排查“黑屏”类问题）
	// 调试/辅助用：用【真实键鼠事件】向右栏页面输入文本。
	// 为何需要：实测发现 Google 登录页会拦截用 executeJavaScript
	// 直接改 input.value 的行为（判为“软件自动控制”），而 sendInputEvent
	// 走 Chromium 真实输入管线，不会被拦。
	ipcMain.handle("debug:typeInView", async (_e, { selector, text, submit }) => {
		if (!browserView) return { err: "no view" };
		const wc = browserView.webContents;
		const box = await wc.executeJavaScript(
			`(()=>{const i=document.querySelector(${JSON.stringify(selector)});
			 if(!i)return null;const r=i.getBoundingClientRect();
			 return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`
		);
		if (!box) return { err: "selector 未命中" };
		wc.focus();
		wc.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
		wc.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
		await new Promise((r) => setTimeout(r, 400));
		for (const ch of String(text)) {
			wc.sendInputEvent({ type: "char", keyCode: ch });
			await new Promise((r) => setTimeout(r, 50));
		}
		if (submit) {
			await new Promise((r) => setTimeout(r, 700));
			wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
			wc.sendInputEvent({ type: "char", keyCode: "\r" });
			wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
		}
		return { ok: true, typed: String(text).length };
	});

	// 在活动 view 里点指定坐标（调试用：真实鼠标事件，Google 等站点只认这个）
	ipcMain.handle("debug:clickInView", async (_e, { x, y }) => {
		if (!browserView) return { ok: false, err: "no view" };
		const wc = browserView.webContents;
		wc.focus();
		wc.sendInputEvent({ type: "mouseMove", x, y });
		await new Promise((r) => setTimeout(r, 150));
		wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
		wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
		return { ok: true };
	});

	// 列出内置浏览器分区里的 Google cookie 名单（调试/验收用）
	ipcMain.handle("debug:listGoogleCookies", async () => {
		const ses = session.fromPartition("persist:pi-browser");
		const all = await ses.cookies.get({});
		return all.filter((c) => /google|youtube|gstatic|ggpht|ytimg/.test(c.domain))
			.map((c) => `${c.domain} ${c.name} secure=${c.secure?"1":"0"} httpOnly=${c.httpOnly?"1":"0"}`);
	});

	// 在当前活动 view 里执行 JS（调试用：读登录态等页面内证据）
	ipcMain.handle("debug:evalInView", async (_e, code) => {
		if (!browserView) return { err: "no view" };
		try {
			const v = await browserView.webContents.executeJavaScript(code, true);
			return { ok: true, value: v };
		} catch (e) { return { ok: false, err: e.message }; }
	});

	ipcMain.handle("debug:viewState", async () => {
		if (!browserView) return { err: "no view" };
		const wc = browserView.webContents;
		let shot = null;
		try {
			const img = await wc.capturePage();
			shot = { empty: img.isEmpty(), size: img.getSize() };
		} catch (e) { shot = { err: e.message }; }
		return {
			bounds: browserView.getBounds(),
			url: wc.getURL(),
			loading: wc.isLoading(),
			crashed: wc.isCrashed(),
			visible: wc.isPainting ? undefined : undefined,
			browserVisible,
			lastBounds,
			shot,
			childCount: win ? win.contentView.children.length : -1,
		};
	});

	// ---- 浏览器多标签 ----
	ipcMain.handle("browser:tabNew", (_e, url) => {
		if (process.env.PI_DESKTOP_DEBUG_BOUNDS) console.log("[tab] tabNew 请求:", url);
		createBrowserView(url && /^https?:/i.test(url) ? url : HOME_URL);
		applyBrowserBounds();
		pushTabs();
		return activeTabId;
	});
	ipcMain.handle("browser:tabClose", (_e, id) => { closeTab(id); return true; });
	ipcMain.handle("browser:tabActivate", (_e, id) => activateTab(id));
	ipcMain.handle("browser:tabList", () => ({
		activeId: activeTabId,
		tabs: browserTabs.map((t) => {
			let url = "", title = "";
			try { url = t.view.webContents.getURL(); title = t.view.webContents.getTitle(); } catch {}
			return { id: t.id, url, title };
		}),
	}));

	// ==== 从 Chrome 导入登录态（Google Cookie）====
	ipcMain.handle("import:cookies", (_e, opts) => doImport(opts || {}));

	ipcMain.handle("browser:cdpInfo", () => ({ port: CDP_PORT }));

	// ==== 真实 Chrome（独立 profile）====
	// 这些是「浏览器来源 = Chrome」模式的后端。与右栏内置 view 完全并行，
	// 互不影响：内置 view 登普通站点没问题（实测 GitHub OK），保留不动。
	ipcMain.handle("chrome:launch", (_e, url) => chromeBridge.launchChrome(url));
	ipcMain.handle("chrome:status", () => chromeBridge.chromeStatus());
	ipcMain.handle("chrome:go", (_e, url) => chromeBridge.chromeGo(url));
	ipcMain.handle("chrome:close", () => chromeBridge.closeChrome());
}

// ---------------------------------------------------------------------------
// 会话分支（P1-7）：jsonl 是树形，branch_summary 条目标记分叉点。
// 全部【流式逐行】读，每个文件最多扫前 600 行（分支多集中在头部），
// 几 MB 的 jsonl 不整读进内存；列表只关心「有几个分支」，失败一律兜底 0。
// ---------------------------------------------------------------------------
const BRANCH_SCAN_MAX_LINES = 600;

// 只数 branch_summary 条数（列表徽标用）
function countBranches(file) {
	return new Promise((resolve) => {
		let n = 0;
		let lines = 0;
		try {
			const rl = readline.createInterface({
				input: fs.createReadStream(file, { encoding: "utf8" }),
				crlfDelay: Infinity,
			});
			rl.on("line", (line) => {
				lines++;
				// 快速粗筛：不含关键字的行直接跳（避免每行都 JSON.parse）
				if (line.indexOf('"branch_summary"') >= 0) {
					try {
						const o = JSON.parse(line);
						if (o && o.type === "branch_summary") n++;
					} catch {}
				}
				if (lines >= BRANCH_SCAN_MAX_LINES) rl.close();
			});
			rl.on("close", () => resolve(n));
			rl.on("error", () => resolve(0));
		} catch {
			resolve(0);
		}
	});
}

// 摘出分支详情（点徽标弹层用）：branch_summary 条目的 id / 摘要 / 时间
function readBranchDetails(file) {
	return new Promise((resolve) => {
		const out = [];
		let lines = 0;
		try {
			const rl = readline.createInterface({
				input: fs.createReadStream(file, { encoding: "utf8" }),
				crlfDelay: Infinity,
			});
			rl.on("line", (line) => {
				lines++;
				if (line.indexOf('"branch_summary"') >= 0) {
					try {
						const o = JSON.parse(line);
						if (o && o.type === "branch_summary") {
							out.push({
								id: o.id,
								fromId: o.fromId,
								summary: String(o.summary || "").replace(/\s+/g, " ").trim().slice(0, 120),
								timestamp: o.timestamp || "",
							});
						}
					} catch {}
				}
				if (lines >= BRANCH_SCAN_MAX_LINES) rl.close();
			});
			rl.on("close", () => resolve(out));
			rl.on("error", () => resolve(out));
		} catch {
			resolve(out);
		}
	});
}

// 把 pi 的消息结构压成渲染层能直接渲染的扁平结构
function serializeMessages(msgs) {
	const out = [];
	for (const m of msgs) {
		if (m.role === "user") {
			const text = typeof m.content === "string"
				? m.content
				: (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
			if (text.trim()) out.push({ role: "user", text });
		} else if (m.role === "assistant") {
			const blocks = Array.isArray(m.content) ? m.content : [];
			const text = blocks.filter((c) => c.type === "text").map((c) => c.text).join("");
			const tools = blocks
				.filter((c) => c.type === "toolCall" || c.type === "tool_call")
				.map((c) => ({ name: c.toolName || c.name, args: c.args }));
			if (text.trim() || tools.length) out.push({ role: "assistant", text, tools });
		}
	}
	return out;
}

// 从会话文件里取一个像样的标题：优先第一条用户消息
function deriveSessionName(fullPath, fallback) {
	try {
		const head = fs.readFileSync(fullPath, "utf8").split("\n").slice(0, 40);
		for (const line of head) {
			if (!line.trim()) continue;
			const o = JSON.parse(line);
			const msg = o.message || o;
			if (msg?.role === "user") {
				const t = typeof msg.content === "string"
					? msg.content
					: (msg.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
				const s = String(t).replace(/\s+/g, " ").trim();
				if (s) return s.slice(0, 40);
			}
			if (o.name) return String(o.name).slice(0, 40);
		}
	} catch {}
	return fallback.replace(/\.jsonl$/, "").slice(0, 40);
}

// ---------------------------------------------------------------------------
// macOS 原生应用菜单（P1-6）
// 设计原则：
//   · 转发到渲染层的动作统一走 pi:event 通道的 menu-action 事件
//     （send() 的实现就是 win.webContents.send('pi:event', {...})，渲染层
//     handleEvent 里新增 case 即可，不用新 IPC 通道）；
//   · 纯系统能力（编辑 / 窗口）直接用 role，零成本；
//   · 刷新页面只刷【当前活动的右栏 view】，不刷主窗口（主窗口 reload 会丢对话流）。
// ---------------------------------------------------------------------------
function buildMenu() {
	const menuAction = (action) => () => send("menu-action", { action });
	const template = [
		// ---- pi（应用菜单）----
		{
			label: app.name || "pi-desktop",
			submenu: [
				{ label: "关于 pi-desktop", role: "about" },
				{ type: "separator" },
				{ label: "隐藏 pi-desktop", role: "hide" },
				{ label: "隐藏其他", role: "hideOthers" },
				{ label: "显示全部", role: "unhide" },
				{ type: "separator" },
				{ label: "退出 pi-desktop", role: "quit", accelerator: "Command+Q" },
			],
		},
		// ---- 文件 ----
		{
			label: "文件",
			submenu: [
				{ label: "新对话", accelerator: "Command+N", click: menuAction("new") },
				{ label: "新建临时聊天", accelerator: "Shift+Command+N", click: menuAction("new-ephemeral") },
				{ type: "separator" },
				{ label: "关闭窗口", role: "close", accelerator: "Command+W" },
			],
		},
		// ---- 编辑（全 role，免费）----
		{
			label: "编辑",
			submenu: [
				{ label: "撤销", role: "undo" },
				{ label: "重做", role: "redo" },
				{ type: "separator" },
				{ label: "剪切", role: "cut" },
				{ label: "复制", role: "copy" },
				{ label: "粘贴", role: "paste" },
				{ label: "全选", role: "selectAll" },
			],
		},
		// ---- 视图 ----
		{
			label: "视图",
			submenu: [
				{ label: "切换侧边栏", accelerator: "Command+B", click: menuAction("toggle-sidebar") },
				{ label: "切换浏览器面板", accelerator: "Command+/", click: menuAction("toggle-browser") },
				{ label: "查找", accelerator: "Command+F", click: menuAction("find") },
				{
					label: "刷新页面",
					accelerator: "Command+R",
					click: () => { try { browserView?.webContents.reload(); } catch {} },
				},
				{ type: "separator" },
				{
					label: "开发者工具",
					accelerator: "Shift+Command+I",
					click: () => {
						if (!win || win.isDestroyed()) return;
						if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
						else win.webContents.openDevTools({ mode: "detach" });
					},
				},
			],
		},
		// ---- 窗口 ----
		{
			label: "窗口",
			submenu: [
				{ label: "最小化", role: "minimize" },
				{ label: "缩放", role: "zoom" },
				{ type: "separator" },
				{ label: "全部置于顶层", role: "front" },
			],
		},
		// ---- 帮助 ----
		{
			label: "帮助",
			role: "help",
			submenu: [
				{
					label: "pi-desktop GitHub",
					click: () => shell.openExternal("https://github.com/earendil-works/pi-coding-agent"),
				},
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
app.on("web-contents-created", (_e, wc) => {
	// 只管右栅浏览器那个 partition，不碰主界面
	try {
		if (wc.session === session.fromPartition("persist:pi-browser")) attachStealth(wc);
	} catch {}
});

// 下载接管：persist:pi-browser 分区里的下载统一落到系统下载目录，
// 开始/完成各发一条 notice 给渲染层（中栏灰字提示）。
let downloadHooked = false;
function hookDownloads() {
	if (downloadHooked) return;
	downloadHooked = true;
	const ses = session.fromPartition("persist:pi-browser");
	ses.on("will-download", (_e, item) => {
		const file = item.getFilename();
		// 显式指定保存路径：不显式 setSavePath 时 Electron 38 实测会把文件留在
		// 下载目录的临时名（.com.github.Electron.XXX）上，done 后也不改名。
		try { item.setSavePath(path.join(app.getPath("downloads"), file)); } catch {}
		send("notice", { text: `开始下载：${file}` });
		item.once("done", (_ev, state) => {
			send("notice", {
				text: state === "completed" ? `下载完成：${file}` : `下载失败：${file}（${state}）`,
			});
		});
	});
}

app.whenReady().then(() => {
	// 菜单栏应用名：package.json 的 productName 是 "pi"（electron-builder 打包时生效），
	// 开发态（npx electron .）进程名是 Electron，这里显式统一成 pi。
	try { app.setName("pi"); } catch {}
	// Chrome 独立 profile 落在 <userData>/chrome-profile —— 与用户日常 Chrome 的
	// Default profile 完全隔离（不碰用户的邮箱 / 内网 / 银行登录态）。
	chromeBridge.initChromeBridge(app.getPath("userData"));
	hookDownloads();
	registerIpc();
	buildMenu();
	createWindow();

	// 全局唤起快捷键（Codex 的 Launcher）：Ctrl+Space（macOS 上也是它，避开 ⌘+Space 系统冲突）。
	// 行为：窗口隐藏⇄显示+聚焦，和 Spotlight 一样的肌肉记忆。
	// 注册失败（如被其他 app 占用）不阻断启动，只在日志里留痕。
	try {
		const { globalShortcut } = require("electron");
		const ok = globalShortcut.register("Control+Space", () => {
			if (!win) return;
			if (win.isVisible() && win.isFocused()) {
				win.hide();                    // 再按一次藏起来，Spotlight 式切换
			} else {
				win.show();
				win.focus();
			}
		});
		// 无条件打日志：注册成功与否都留痕，便于验证
		console.log(`[pi-desktop] Ctrl+Space 注册${ok ? "成功" : "失败（可能被占用）"}`);
	} catch (e) {
		console.warn("[pi-desktop] 快捷键注册异常:", e.message);
	}

	console.log(`[pi-desktop] 就绪。右栏浏览器 CDP: agent-browser --cdp ${CDP_PORT}`);

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

// 退出清理：把我们拉起来的那个 Chrome 一起收掉，不留孤儿进程。
// 【实测坑】before-quit 在 SIGTERM / 强杀时不会触发，所以额外挂
// 进程信号（SIGTERM/SIGINT/SIGHUP）与 will-quit 两道保险。
let cleanedUp = false;
function cleanupOnExit() {
	if (cleanedUp) return;
	cleanedUp = true;
	if (unsubscribe) { try { unsubscribe(); } catch {} }
	try { pi?.runtime?.session?.dispose(); } catch {}
	try { chromeBridge.closeChrome(); } catch {}
	// 关掉所有登录弹窗，不留孤儿窗口
	for (const [, pop] of popupWindows) { try { pop.destroy(); } catch {} }
	popupWindows.clear();
}

app.on("before-quit", cleanupOnExit);
app.on("will-quit", cleanupOnExit);
// 退出时必须注销全局快捷键，否则会残留到系统里
app.on("will-quit", () => { try { require("electron").globalShortcut.unregisterAll(); } catch {} });
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
	process.on(sig, () => { cleanupOnExit(); app.exit(0); });
}
