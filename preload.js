// preload.js —— 渲染层与主进程之间唯一的桥。
// 渲染层拿不到 Node，只能用这里白名单式暴露的方法（contextIsolation 打开）。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("piAPI", {
	// ---- 对话 ----
	send: (text) => ipcRenderer.invoke("pi:send", text),
	abort: () => ipcRenderer.invoke("pi:abort"),
	compact: () => ipcRenderer.invoke("pi:compact"),

	// ---- 会话 ----
	newSession: () => ipcRenderer.invoke("pi:newSession"),
	newEphemeral: () => ipcRenderer.invoke("pi:newEphemeral"),
	switchSession: (id) => ipcRenderer.invoke("pi:switchSession", id),
	deleteSession: (file) => ipcRenderer.invoke("pi:deleteSession", file),
	listBranches: (file) => ipcRenderer.invoke("pi:listBranches", file),
	switchToBranch: (payload) => ipcRenderer.invoke("pi:switchToBranch", payload),
	listSessions: () => ipcRenderer.invoke("pi:listSessions"),
	listSessionsGrouped: () => ipcRenderer.invoke("pi:listSessionsGrouped"),

	// ---- 模型 / 思考等级 ----
	getModels: () => ipcRenderer.invoke("pi:getModels"),
	setModel: (id) => ipcRenderer.invoke("pi:setModel", id),
	getThinkingLevels: () => ipcRenderer.invoke("pi:getThinkingLevels"),
	setThinking: (level) => ipcRenderer.invoke("pi:setThinking", level),

	// ---- 工作区 ----
	getCwd: () => ipcRenderer.invoke("pi:getCwd"),
	pickCwd: () => ipcRenderer.invoke("pi:pickCwd"),
	getRecentCwds: () => ipcRenderer.invoke("pi:getRecentCwds"),
	setCwd: (dir) => ipcRenderer.invoke("pi:setCwd", dir),

	// ---- 右栏浏览器 ----
	browserGo: (url) => ipcRenderer.invoke("browser:go", url),
	browserBack: () => ipcRenderer.invoke("browser:back"),
	browserForward: () => ipcRenderer.invoke("browser:forward"),
	browserReload: () => ipcRenderer.invoke("browser:reload"),
	browserHome: () => ipcRenderer.invoke("browser:home"),
	browserDevtools: () => ipcRenderer.invoke("browser:devtools"),
	browserToggle: (visible) => ipcRenderer.invoke("browser:toggle", visible),
	debugTypeInView: (a) => ipcRenderer.invoke("debug:typeInView", a),
	debugViewState: () => ipcRenderer.invoke("debug:viewState"),
	debugEvalInView: (code) => ipcRenderer.invoke("debug:evalInView", code),
	debugListGoogleCookies: () => ipcRenderer.invoke("debug:listGoogleCookies"),
	debugClickInView: (p) => ipcRenderer.invoke("debug:clickInView", p),
	browserTabNew: (url) => ipcRenderer.invoke("browser:tabNew", url),
	browserTabClose: (id) => ipcRenderer.invoke("browser:tabClose", id),
	browserTabActivate: (id) => ipcRenderer.invoke("browser:tabActivate", id),
	browserTabList: () => ipcRenderer.invoke("browser:tabList"),
	browserCdpInfo: () => ipcRenderer.invoke("browser:cdpInfo"),
	browserOpenExternal: (url) => ipcRenderer.invoke("browser:openExternal", url),
	browserListDownloads: () => ipcRenderer.invoke("browser:listDownloads"),
	browserShowInFolder: (path) => ipcRenderer.invoke("browser:showInFolder", path),

	// ---- 真实 Chrome（独立 profile，用于登 Google）----
	// 内置 Electron 浏览器登 Google 被永久拒，这条路拉真 Chrome 二进制。
	chromeLaunch: (url) => ipcRenderer.invoke("chrome:launch", url),
	chromeStatus: () => ipcRenderer.invoke("chrome:status"),
	chromeGo: (url) => ipcRenderer.invoke("chrome:go", url),
	chromeClose: () => ipcRenderer.invoke("chrome:close"),
	// 从用户真实 Chrome 导入 Google 登录态（Cookie）
	importCookies: (opts) => ipcRenderer.invoke("import:cookies", opts),
	// 渲染层上报 #browser-slot 的位置，主进程据此定位原生 view
	browserBounds: (rect) => ipcRenderer.send("browser:bounds", rect),

	// ---- 主进程 -> 渲染层 事件流 ----
	onEvent: (cb) => {
		const handler = (_e, payload) => cb(payload);
		ipcRenderer.on("pi:event", handler);
		return () => ipcRenderer.removeListener("pi:event", handler);
	},
});
