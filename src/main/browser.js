// src/main/browser.js —— 浏览器视图管理模块（BrowserManager）
//
// 职责边界（从 main.js 抽出的右栏内置浏览器相关全部逻辑）：
//   1. 多标签管理：browserTabs 数组、createBrowserView / activateTab / closeTab / pushTabs
//   2. popup 弹窗去重：popupWindows Map、popupRootOf / reuseOrOpenPopup / openAuthPopup
//   3. 下载管理：hookDownloads（conversation 分区的 will-download 接管）
//   4. bounds 定位：applyBrowserBounds（活动标签贴渲染层上报的 rect，其余缩 0x0）
//   5. WebContentsView 创建与配置：attachStealth（UA/Sec-CH-UA/userAgentData 三处伪装）
//   6. 【新增】Session 隔离：ConversationSessionManager 按 conversation（cwd）隔离 cookies/storage
//
// 设计说明：
//   · 零构建、纯 CommonJS，与 main.js 保持一致的风格。
//   · 主窗口 win 会被 createWindow() 反复重建，不能缓存引用 —— 通过 deps.getWin()
//     惰性取当前窗口，避免持有失效对象。
//   · 推送渲染层走 deps.send(type, extra)（main.js 里的 send 实现：pi:event 通道）。
//   · 主页 / 可见性等配置项通过 deps.loadConf() / deps.saveConf() 读写 pi-desktop.json。
//   · 本模块不碰 pi 引擎、会话管理、IPC 注册 —— 那些仍留在 main.js。
//
// Session 隔离架构（方案 A）：
//   · 每个 conversation（通常是 cwd 路径）对应独立的 Electron Session
//   · cookies、localStorage、cache 完全隔离，登录态互不干扰
//   · LRU 缓存最多 5 个 session，超过时淘汰最久未使用的
//   · 切换 conversation 时自动切换浏览器 session
//
// 已实测确认的关键点（勿改）：
//   1. persist:conv-* 分区让 cookie/localStorage 落盘 —— 密码输一次，以后免登录
//   2. Google 会拒绝「嵌入式浏览器」登录，破绽有三处缺一不可（UA / userAgentData.brands
//      / Sec-CH-UA 请求头），下面统一伪装成与本机真实 Chrome 一致的形态
//   3. backgroundThrottling:false 关掉后台节流 —— 否则窗口不在前台时 Chromium 把页面
//      定时器/rAF/加载降到 1Hz，重 JS 站（X 等）直接"卡死"
//   4. addChildView 必须确认真的挂上，否则 children.length 仍为 1，view 有正确 bounds
//      但 capturePage() 返回空图，表现为右栏全黑
//   5. Electron 38 的 session.setPreloads() 对运行时新建的 webContents（弹窗 / agent
//      经 CDP 新开的 tab）不可靠，实测会退回 Chromium —— 所以每次导航还要 executeJavaScript
//      注入一次 stealth 补丁
//   6. Electron 38 session persist 分区的 will-download 钩子必须显式 item.setSavePath()，
//      否则文件留在下载目录的临时名（.com.github.Electron.XXX）上，done 后也不改名

const {
	BrowserWindow, WebContentsView, session, shell, Menu, app,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { ConversationSessionManager } = require("./conversation-session-manager");

// ---------------------------------------------------------------------------
// UA / 指纹伪装常量
// ---------------------------------------------------------------------------
// CHROME_MAJOR 取 Electron 内置 Chromium 主版本，伪装成同版本真 Chrome。
const CHROME_MAJOR = process.versions.chrome ? process.versions.chrome.split(".")[0] : "140";
const CHROME_FULL = `${CHROME_MAJOR}.0.0.0`;
const SEC_CH_UA = `"Not=A?Brand";v="99", "Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}"`;

// 隐身补丁源码：除了当 preload 挂在初始 view 上，还要在每次导航时
// 用 executeJavaScript 注入一次（见文件头实测点 5）。
let STEALTH_SRC = "";
try {
	STEALTH_SRC = fs.readFileSync(path.join(__dirname, "..", "..", "browser-preload.js"), "utf8");
} catch {}

// 给任意 webContents 挂上"导航即注入"。documentStart 阶段执行，
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

// ---------------------------------------------------------------------------
// BrowserManager
// ---------------------------------------------------------------------------
class BrowserManager {
	/**
	 * @param {object} deps
	 * @param {() => BrowserWindow|null} deps.getWin     惰性取当前主窗口（win 会被重建，不能缓存）
	 * @param {(type: string, extra?: object) => void} deps.send  推事件给渲染层（pi:event 通道）
	 * @param {() => object} deps.loadConf               读 pi-desktop.json
	 * @param {(patch: object) => object} deps.saveConf  写 pi-desktop.json
	 */
	constructor(deps) {
		if (!deps || typeof deps.getWin !== "function" || typeof deps.send !== "function") {
			throw new Error("BrowserManager 需要 deps.getWin / deps.send");
		}
		this._getWin = deps.getWin;
		this._send = deps.send;
		this._loadConf = deps.loadConf || (() => ({}));
		this._saveConf = deps.saveConf || (() => ({}));

		// ---- 状态 ----
		this.browserView = null;        // 当前【活动】标签的 view（其余代码沿用这个引用）
		// 多标签：每个元素 { id, view }。只有活动标签有真 bounds，
		// 非活动的缩到 0x0 隐藏（Electron 没有原生"隐藏 view"，bounds 置 0 是标准做法）。
		this.browserTabs = [];
		this.activeTabId = null;
		this.tabSeq = 0;
		this.browserVisible = this._loadConf().browserVisible !== false;
		this.lastBounds = { x: 0, y: 0, width: 0, height: 0 };

		// ===== 新增：Session 隔离管理器 =====
		this.sessionManager = new ConversationSessionManager({
			maxCached: 5  // 最多缓存 5 个 conversation 的 session
		});

		// ===== 新增：当前 conversation ID（通常是 cwd 路径）=====
		this.currentConversationId = null;

		console.log('[BrowserManager] 初始化, Session 隔离已启用');

		// OAuth/登录弹窗集合（用 Map 维护以便集中清理）。
		// 弹窗共享 persist:pi-browser session —— 登录态互遇，弹窗里登了主页面立即生效。
		this.popupWindows = new Map();

		// 主页（默认 Google，可在设置里改）
		this.HOME_URL = this._loadConf().homeUrl || "https://www.google.com";

		// session 级初始化（UA / 请求头 / 权限）只能做一次，
		// 否则多标签时 onBeforeSendHeaders 会被重复注册。
		// 【修改】按 session 追踪：每个 conversation 的 session 独立配置
		this._sessionReadySet = new Set();  // 已配置过的 session 对象集合
		// 下载钩子也只挂一次（但 hook 所有 session）
		this._downloadHooked = false;
	}

	// -----------------------------------------------------------------------
	// 弹窗去重：同一【根域名】只保留一个弹窗。
	// OAuth 流程会连环 window.open（gsi 选择器 → accountchooser → 授权…），
	// 若每次都开新窗会越叠越多。同根域的新请求直接复用旧窗导航过去。
	// -----------------------------------------------------------------------
	popupRootOf(u) {
		try { return new URL(u).hostname.split(".").slice(-2).join("."); } catch { return u; }
	}

	reuseOrOpenPopup(u) {
		const root = this.popupRootOf(u);
		for (const [oldUrl, pop] of this.popupWindows) {
			if (pop.isDestroyed()) { this.popupWindows.delete(oldUrl); continue; }
			if (this.popupRootOf(oldUrl) === root) {
				// 同根域已有弹窗 → 复用，加载新 URL 并前置（不叠加新窗）
				if (oldUrl !== u) { try { pop.loadURL(u); } catch {} }
				pop.show(); pop.focus();
				this.popupWindows.delete(oldUrl);
				this.popupWindows.set(u, pop);
				return;
			}
		}
		this.popupWindows.set(u, this.openAuthPopup(u));
	}

	// 开一个「像真浏览器弹窗」的独立小窗口（X 登 Google、Google One Tap 等）。
	// 特点：尺寸小、无地址栏、关窗即终、焦点回主窗。所有弹窗都过 attachStealth。
	openAuthPopup(url) {
		// 使用当前 conversation 的 session（如果有），否则用默认
		const ses = this.currentConversationId
			? this.sessionManager.getOrCreateSession(this.currentConversationId)
			: session.fromPartition('persist:pi-browser-default');
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
				preload: path.join(__dirname, "..", "..", "browser-preload.js"),
				contextIsolation: false,
				nodeIntegration: false,
				sandbox: false,
				webSecurity: true,
				backgroundThrottling: false,   // 同主 view：不节流，登录页动画不卡
			},
		});
		// 弹窗自己再 window.open 时（罕见但存在）也走独立弹窗，不进标签页
		pop.webContents.setWindowOpenHandler(({ url: u }) => {
			if (/^https?:/i.test(u)) { this.reuseOrOpenPopup(u); }
			else { shell.openExternal(u); }
			return { action: "deny" };
		});
		pop.once("ready-to-show", () => pop.show());
		pop.on("closed", () => {
			// 双向清理：按开窗 URL 或当前导航过的任意 key 都删掉
			for (const [k, p] of this.popupWindows) { if (p === pop || p.isDestroyed()) this.popupWindows.delete(k); }
			// 弹窗关闭后焦点回主窗（OAuth 完成后用户应回到原页面）
			const win = this._getWin();
			if (win && !win.isDestroyed()) { win.show(); win.focus(); }
		});
		// 弹窗里的导航同步 UA 补丁（persist session 已设过 UA，这里只挂 stealth）
		attachStealth(pop.webContents);
		pop.loadURL(url);
		return pop;
	}

	// -----------------------------------------------------------------------
	// Conversation 切换：切换浏览器 session 到指定 conversation
	// -----------------------------------------------------------------------
	switchConversation(conversationId) {
		console.log('[BrowserManager] switchConversation:', this.currentConversationId, '→', conversationId);

		// 如果 conversationId 没变，直接返回（避免无谓重建）
		if (this.currentConversationId === conversationId) {
			console.log('[BrowserManager] conversation 未变化，跳过重重建');
			return this.sessionManager.getOrCreateSession(conversationId);
		}

		// 切换 session
		const newSession = this.sessionManager.switchConversation(conversationId);
		this.currentConversationId = conversationId;

		// 确保新 session 的下载钩子已挂载
		if (this._downloadHooked) {
			this._hookSessionDownloads(newSession);
		}

		// 【关键修复】销毁所有旧标签页并用新 session 重建，实现真正的登录态隔离
		// 背景：WebContentsView 在创建时绑定 session，事后切换 currentConversationId
		// 不会改变已存在 view 的 session，导致 cookies 仍然共享 → 登录态串号
		if (this.browserTabs.length > 0) {
			console.log('[BrowserManager] 销毁', this.browserTabs.length, '个旧标签页，用新 session 重建');

			// 记录旧标签页的 URL 以便恢复
			const oldUrls = this.browserTabs.map(t => {
				try { return t.view.webContents.getURL(); } catch { return null; }
			});

			// 销毁所有旧 view
			const win = this._getWin();
			for (const t of this.browserTabs) {
				try { win && win.contentView.removeChildView(t.view); } catch {}
				try { t.view.webContents.close(); } catch {}
			}
			this.browserTabs = [];
			this.activeTabId = null;
			this.browserView = null;

			// 用新 session 重建第一个标签页（恢复之前的活动 URL 或主页）
			const firstUrl = oldUrls.find(u => u && /^https?:/i.test(u)) || this.HOME_URL;
			this.createBrowserView(firstUrl);
			this.applyBrowserBounds();
			this.pushTabs();
		}

		return newSession;
	}

	// -----------------------------------------------------------------------
	// 多标签：创建 / 切换 / 关闭 / 推送列表
	// -----------------------------------------------------------------------
	createBrowserView(initialUrl) {
		const win = this._getWin();
		if (!win) return;
		// 【防挂空】窗口 webContents 尚未完成首载时 addChildView 不可靠：
		// view 能拿到正确 bounds 但 capturePage() 返回空图，表现为右栏全黑
		//（历史实测踩过）。等 dom-ready 再建，已就绪就直接建。
		// 【防挂空/防死锁】只在「窗口刚创建、首载尚未完成」这一次延迟建 view：
		//   - did-finish-load 触发 → 立即建（最干净的时序）
		//   - 800ms 保险丝 → 强制建（防 did-finish-load 丢失；过短会在 renderer
		//     未稳时挂空 —— 实测 300ms 偶发 capturePage 空图，800ms 稳定）
		// 判断依据用 didFinishLoad 一次性标志，而不是 isLoading() —— 后者在
		// dom-ready 之后页面继续拉资源时仍为 true，会反复推迟造成「永远建不上」。
		const wc0 = win.webContents;
		if (wc0 && !wc0.isDestroyed() && !this._winFirstLoadDone) {
			let retried = false;
			const retry = (why) => {
				if (retried) return;
				retried = true;
				this._winFirstLoadDone = true;   // 只走一次，后续建标签不再延迟
				if (process.env.PI_DESKTOP_DEBUG_BOUNDS) console.log("[tab] 触发建 view:", why);
				this.createBrowserView(initialUrl);
			};
			if (process.env.PI_DESKTOP_DEBUG_BOUNDS) console.log("[tab] 等待窗口首载完成再建 view");
			wc0.once("did-finish-load", () => retry("did-finish-load"));
			setTimeout(() => retry("fallback-800ms"), 800);
			return;
		}
		if (process.env.PI_DESKTOP_DEBUG_BOUNDS) console.log("[tab] createBrowserView 继续，win ready");

		// ===== 修改：使用 conversation 的 session（如果有）=====
		let ses;
		if (this.currentConversationId) {
			ses = this.sessionManager.getOrCreateSession(this.currentConversationId);
			console.log('[BrowserManager] 使用 conversation session:', this.currentConversationId);
		} else {
			// 降级：使用默认 session（兼容性）
			console.warn('[BrowserManager] 未设置 conversationId，使用默认 session');
			ses = session.fromPartition('persist:pi-browser-default');
		}

		// (1) UA：去掉 Electron / 应用名，并把 Chrome 版本规整成 x.0.0.0（真 Chrome 的形态）
		const ua = ses.getUserAgent()
			.replace(/ pi-desktop\/[\d.]+/gi, "")
			.replace(/ Electron\/[\d.]+/gi, "")
			.replace(/Chrome\/[\d.]+/i, `Chrome/${CHROME_FULL}`);

		// 【修改】按 session 配置：每个 session 独立配置 UA / 请求头 / 权限
		if (!this._sessionReadySet.has(ses)) {
			this._sessionReadySet.add(ses);
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

			console.log('[BrowserManager] session 配置完成:', this.currentConversationId || 'default');
		}

		this.browserView = new WebContentsView({
			webPreferences: {
				session: ses,
				// (2) 页面侧隐身补丁：改写 userAgentData.brands 等，详见 browser-preload.js
				preload: path.join(__dirname, "..", "..", "browser-preload.js"),
				contextIsolation: false, // 补丁要直接改页面 window，必须关隔离
				nodeIntegration: false,
				sandbox: false, // preload 需要在页面上下文里执行
				webSecurity: true,
				// 【性能关键】关掉后台节流：否则窗口不在前台时 Chromium 把页面的
				// 定时器/rAF/加载全部降到 1Hz，重 JS 站（X 等）直接"卡死"。
				// Codex 桌面端同理不节流 —— 内嵌浏览器必须始终满血。
				backgroundThrottling: false,
			},
		});

		// 挂到窗口的 contentView 上。注意：必须确认真的挂上了 ——
		// 实测过一个坑：若 addChildView 未生效，children.length 仍为 1，
		// view 有正确 bounds 但 capturePage() 返回空图，表现为右栏全黑。
		const view = this.browserView;   // 本函数内统一用 view 指代新建的这个
		const attachNow = () => {
			const w = this._getWin();
			if (!w || w.isDestroyed()) return false;
			try { w.contentView.addChildView(view); } catch {}
			return w.contentView.children.includes(view);
		};
		// 【挂载确认】用 view 自己的 dom-ready + 截屏轮询双保险：
		// children.includes(view) 为 true 不代表截屏管线 ready（实测 includes 通过
		// 但 capturePage 仍空图的情况存在，尤其启动竞态）。页面就绪后做一次截屏
		// 自检，空图就重挂一次，彻底杜绝「右栏全黑但所有状态看着都对」。
		view.webContents.once("dom-ready", () => {
			attachNow();
			this.applyBrowserBounds();
			setTimeout(async () => {
				try {
					const img = await view.webContents.capturePage();
					if (img.isEmpty() && this.browserVisible) {
						if (process.env.PI_DESKTOP_DEBUG_BOUNDS) console.log("[tab] 截屏空图，重挂 view 自检修复");
						attachNow();
						this.applyBrowserBounds();
					}
				} catch {}
			}, 400);
		});
		// 立即挂一次（多数情况已能挂上；挂不上由 dom-ready 兜底）
		attachNow();
		view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

		// 登记为一个标签并设为活动
		const tabId = `t${++this.tabSeq}`;
		if (process.env.PI_DESKTOP_DEBUG_BOUNDS) console.log(`[tab] 创建 ${tabId} -> ${initialUrl || this.HOME_URL}`);
		this.browserTabs.push({ id: tabId, view });
		this.activeTabId = tabId;
		view.webContents.loadURL(initialUrl || this.HOME_URL);

		const wc = view.webContents;
		attachStealth(wc);

		const pushUrl = () => {
			const w = this._getWin();
			if (!w || w.isDestroyed()) return;
			// 只有活动标签才更新地址栏，否则后台标签加载完会抢地址栏
			if (tabId === this.activeTabId) {
				this._send("browser_url", {
					url: wc.getURL(),
					title: wc.getTitle(),
					canBack: wc.navigationHistory.canGoBack(),
					canForward: wc.navigationHistory.canGoForward(),
					loading: wc.isLoading(),
				});
			}
			this.pushTabs();
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
							preload: path.join(__dirname, "..", "..", "browser-preload.js"),
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
							for (const [k, p] of this.popupWindows) { if (p === pop || p.isDestroyed()) this.popupWindows.delete(k); }
							const w = this._getWin();
							if (w && !w.isDestroyed()) { w.show(); w.focus(); }
						});
						this.popupWindows.set(url, pop);
						return pop;
					},
				};
			}
			// 普通链接：开新标签（deny + 自建 view 的老路径，多标签逻辑不变）
			this.createBrowserView(url);
			this.applyBrowserBounds();
			this.pushTabs();
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
	pushTabs() {
		const win = this._getWin();
		if (!win || win.isDestroyed()) return;
		this._send("browser_tabs", {
			activeId: this.activeTabId,
			tabs: this.browserTabs.map((t) => {
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
	activateTab(id) {
		const t = this.browserTabs.find((x) => x.id === id);
		if (!t) return false;
		this.activeTabId = id;
		this.browserView = t.view;
		// 重新 addChildView 等于提升 z 序，确保活动标签在最上面
		const win = this._getWin();
		try { win.contentView.addChildView(t.view); } catch {}
		this.applyBrowserBounds();
		const wc = t.view.webContents;
		this._send("browser_url", {
			url: wc.getURL(), title: wc.getTitle(),
			canBack: wc.navigationHistory.canGoBack(),
			canForward: wc.navigationHistory.canGoForward(),
			loading: wc.isLoading(),
		});
		this.pushTabs();
		return true;
	}

	// 关闭标签：销毁 view 并释放进程（不能只从数组里抽走，会泄漏）
	closeTab(id) {
		const i = this.browserTabs.findIndex((x) => x.id === id);
		if (i < 0) return;
		const t = this.browserTabs[i];
		this.browserTabs.splice(i, 1);
		const win = this._getWin();
		try { win.contentView.removeChildView(t.view); } catch {}
		try { t.view.webContents.close(); } catch {}

		if (!this.browserTabs.length) {
			// 关完最后一个就新开一个空白页，避免右栏变死区
			this.createBrowserView(this.HOME_URL);
			this.applyBrowserBounds();
			this.pushTabs();
			return;
		}
		if (this.activeTabId === id) this.activateTab(this.browserTabs[Math.max(0, i - 1)].id);
		else this.pushTabs();
	}

	// -----------------------------------------------------------------------
	// bounds 定位
	// -----------------------------------------------------------------------
	applyBrowserBounds() {
		// 非活动标签一律缩到 0x0（Electron 无原生隐藏 API）
		for (const t of this.browserTabs) {
			if (t.id !== this.activeTabId) {
				try { t.view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); } catch {}
			}
		}
		if (!this.browserView) return;
		if (!this.browserVisible) {
			this.browserView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
			return;
		}
		const b = this.lastBounds;
		if (process.env.PI_DESKTOP_DEBUG_BOUNDS) {
			console.log(`[bounds] visible=${this.browserVisible} rect=`, JSON.stringify(b));
		}
		this.browserView.setBounds({
			x: Math.round(b.x),
			y: Math.round(b.y),
			width: Math.max(0, Math.round(b.width)),
			height: Math.max(0, Math.round(b.height)),
		});
	}

	// 渲染层通过 browser:bounds IPC 上报 #browser-slot 的 getBoundingClientRect
	setBounds(rect) {
		if (rect && typeof rect.width === "number") {
			this.lastBounds = rect;
			this.applyBrowserBounds();
		}
	}

	// 切换右栏显隐（Command+/ 或左栏开关）
	setVisible(visible) {
		if (process.env.PI_DESKTOP_DEBUG_BOUNDS) console.log("[toggle] ->", visible);
		this.browserVisible = !!visible;
		this._saveConf({ browserVisible: this.browserVisible });
		this.applyBrowserBounds();
		return this.browserVisible;
	}

	// -----------------------------------------------------------------------
	// 下载管理：conversation 分区的下载统一落到系统下载目录，
	// 开始/完成各发一条 notice 给渲染层（中栏灰字提示）。
	// -----------------------------------------------------------------------
	hookDownloads() {
		if (this._downloadHooked) return;
		this._downloadHooked = true;

		// 【兼容性】hook 所有可能的 session（默认 + 各个 conversation）
		// 默认 session
		const defaultSes = session.fromPartition("persist:pi-browser-default");
		this._hookSessionDownloads(defaultSes);

		// 当前 conversation session
		if (this.currentConversationId) {
			const convSes = this.sessionManager.getOrCreateSession(this.currentConversationId);
			this._hookSessionDownloads(convSes);
		}

		// 注意：后续新创建的 conversation session 会在 switchConversation 时
		// 由 ConversationSessionManager 创建，这里需要确保新 session 也被 hook
	}

	// 给指定 session 挂上下载钩子（带去重，避免重复挂载）
	_hookSessionDownloads(ses) {
		// 检查是否已经 hook 过（避免重复）
		if (ses.__downloadHooked) return;
		ses.__downloadHooked = true;

		ses.on("will-download", (_e, item) => {
			const file = item.getFilename();
			// 显式指定保存路径：不显式 setSavePath 时 Electron 38 实测会把文件留在
			// 下载目录的临时名（.com.github.Electron.XXX）上，done 后也不改名。
			try { item.setSavePath(path.join(app.getPath("downloads"), file)); } catch {}
			this._send("notice", { text: `开始下载：${file}` });
			item.once("done", (_ev, state) => {
				this._send("notice", {
					text: state === "completed" ? `下载完成：${file}` : `下载失败：${file}（${state}）`,
				});
			});
		});
	}

	// 退出清理：关掉所有登录弹窗，不留孤儿窗口
	cleanup() {
		for (const [, pop] of this.popupWindows) { try { pop.destroy(); } catch {} }
		this.popupWindows.clear();

		// 清理 session 管理器
		if (this.sessionManager) {
			this.sessionManager.cleanup();
		}
	}
}

module.exports = { BrowserManager, attachStealth };
