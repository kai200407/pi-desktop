// browser-preload.js —— 注入到右栏浏览器每个页面（不是主界面）的隐身补丁。
//
// 目的：让页面侧的 JS 检测看不出这是 Electron。
// Google 登录页（accounts.google.com）会同时查以下几项，缺一处就判定为
// "嵌入式浏览器"并拒绝登录（提示"此浏览器或应用可能不安全"）：
//   · navigator.userAgentData.brands 必须含 "Google Chrome"（Electron 只报 Chromium）
//   · navigator.webdriver 必须为 false（已由 disable-blink-features 开关处理）
//   · 不能存在 Electron/Node 注入的全局变量
//
// 这里只做"看起来像普通 Chrome"，不改变任何实际行为。

(() => {
	const MAJOR = (navigator.userAgent.match(/Chrome\/(\d+)/) || [, "140"])[1];

	// --- 1. userAgentData：补上 "Google Chrome" 品牌 ---
	try {
		const brands = [
			{ brand: "Not=A?Brand", version: "99" },
			{ brand: "Google Chrome", version: MAJOR },
			{ brand: "Chromium", version: MAJOR },
		];
		const highEntropy = {
			architecture: "arm",
			bitness: "64",
			brands,
			fullVersionList: brands.map((b) => ({ brand: b.brand, version: `${b.version}.0.0.0` })),
			mobile: false,
			model: "",
			platform: "macOS",
			platformVersion: "15.0.0",
			uaFullVersion: `${MAJOR}.0.0.0`,
			wow64: false,
		};

		const fake = Object.create(Object.getPrototypeOf(navigator.userAgentData || {}));
		Object.defineProperties(fake, {
			brands: { get: () => brands, enumerable: true },
			mobile: { get: () => false, enumerable: true },
			platform: { get: () => "macOS", enumerable: true },
			getHighEntropyValues: {
				value: (hints) => {
					const out = { brands, mobile: false, platform: "macOS" };
					for (const h of hints || []) if (h in highEntropy) out[h] = highEntropy[h];
					return Promise.resolve(out);
				},
			},
			toJSON: { value: () => ({ brands, mobile: false, platform: "macOS" }) },
		});

		Object.defineProperty(navigator, "userAgentData", { get: () => fake, configurable: true });
	} catch {}

	// --- 2. 抹掉 Electron / Node 注入的全局痕迹 ---
	try {
		for (const k of ["process", "require", "module", "global", "Buffer", "electron"]) {
			if (k in window) {
				try { delete window[k]; } catch {}
			}
		}
	} catch {}

	// --- 3. window.chrome：真 Chrome 有这几个字段，Electron 里往往不全 ---
	try {
		if (!window.chrome) window.chrome = {};
		if (!window.chrome.runtime) window.chrome.runtime = {};
		if (!window.chrome.csi) window.chrome.csi = () => ({});
		if (!window.chrome.loadTimes) {
			window.chrome.loadTimes = () => ({ commitLoadTime: Date.now() / 1000 });
		}
	} catch {}

	// --- 4. webdriver 兜底（主进程开关已处理，这里双保险）---
	try {
		if (navigator.webdriver) {
			Object.defineProperty(navigator, "webdriver", { get: () => false, configurable: true });
		}
	} catch {}
})();
