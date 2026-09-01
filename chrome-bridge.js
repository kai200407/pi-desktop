// chrome-bridge.js —— 「接管真实 Chrome」能力
//
// 【为什么需要它】
// Electron 的 WebContentsView / BrowserWindow 登录 Google 一律被拒（跳
// accounts.google.com/v3/signin/rejected）。已用控制变量法实测：改 UA、改
// navigator.userAgentData.brands、补 Sec-CH-UA、置 navigator.webdriver=false、
// 关掉 CDP 远程调试端口 —— 全部无效。Google 的判据是 Electron 运行时本身，
// 不是指纹，所以【不要再尝试伪装】。
// 而真实 Chrome 二进制 + CDP 实测可以走到 /signin/challenge/pwd（rejected:false）。
// ChatGPT 桌面端就是这么做的（Chrome 扩展 + native host + open-chrome-window.js）。
//
// 【为什么用独立 profile 而不接管用户日常 Chrome 的 Default】
//   1. 用户日常 Chrome 通常正在运行，Chrome 的 process singleton 会拒绝第二个
//      实例带 --remote-debugging-port 复用同一个 user-data-dir —— 想接管必须先
//      让用户关掉全部 Chrome 窗口，体验极差；
//   2. Default profile 里有邮箱 / 内网 / 银行等【全部】登录态，一旦挂上 CDP，
//      agent 就等于拿到了这些账号的完整控制权，风险不可接受；
//   3. 独立 profile 一样能满足「以后可以登录」的诉求 —— 它是落盘持久的，
//      用户在里面登一次 Google，之后永久保持（Chrome 自己管 cookie/账号）。
// 综上：profile 固定放 <userData>/chrome-profile，与日常 Chrome 完全隔离。
//
// 【零依赖】只用 node 内置模块（child_process / net / http / fs / path）。

const { spawn, execFile } = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// 候选可执行文件：Chrome 优先，其次 Chromium、Edge（都是 Chromium 内核，
// CDP 协议一致；Google 登录只认「不是 Electron」，Edge 同样能过）。
const CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const PORT_FROM = 9555;   // 起始探测端口。不写死单个值，避免和用户已开的调试端口撞车
const PORT_TO = 9600;

let state = {
	child: null,     // spawn 出来的 Chrome 子进程（复用已有实例时为 null）
	port: null,      // 实际生效的 CDP 端口
	exec: null,      // 实际使用的可执行文件
	profile: null,   // user-data-dir
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function findExec() {
	for (const p of CANDIDATES) {
		try {
			fs.accessSync(p, fs.constants.X_OK);
			return p;
		} catch {}
	}
	return null;
}

// 端口是否空闲。用真实 listen 判定，比「连一下看通不通」可靠
// （连不通不代表能 bind，比如被别的协议族占了）。
function isPortFree(port) {
	return new Promise((res) => {
		const srv = net.createServer();
		srv.once("error", () => res(false));
		srv.once("listening", () => srv.close(() => res(true)));
		srv.listen(port, "127.0.0.1");
	});
}

async function pickPort() {
	for (let p = PORT_FROM; p <= PORT_TO; p++) {
		if (await isPortFree(p)) return p;
	}
	return null;
}

// 探活：CDP 的 /json/version 通了就说明这个端口后面真有个 Chromium 在跑
function probe(port, timeout = 1200) {
	return new Promise((res) => {
		if (!port) return res(null);
		const req = http.get(
			{ host: "127.0.0.1", port, path: "/json/version", timeout },
			(r) => {
				let buf = "";
				r.on("data", (c) => (buf += c));
				r.on("end", () => {
					try { res(JSON.parse(buf)); } catch { res(null); }
				});
			}
		);
		req.on("error", () => res(null));
		req.on("timeout", () => { req.destroy(); res(null); });
	});
}

// Chrome 带 --remote-debugging-port 启动时会在 user-data-dir 下写
// DevToolsActivePort（第一行端口，第二行 ws 路径）。
// 这是跨进程、跨 app 重启找回「这个 profile 的 Chrome 在哪个端口」的官方途径 ——
// 但【实测 Chrome 152：显式指定 --remote-debugging-port 时它不写这个文件】，
// 所以不能当唯一依据，只当「有则用」的额外路径（主要为了拿 wsPath）。
function readDevToolsPort(profile) {
	try {
		const raw = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8");
		const lines = raw.split("\n");
		const port = parseInt(lines[0], 10);
		return Number.isFinite(port) ? { port, wsPath: (lines[1] || "").trim() } : null;
	} catch {
		return null;
	}
}

// app 重启后找回「这个 profile 的 Chrome 在哪个端口」的可靠办法（上面那个
// 文件实测不一定存在）：扫 ps 完整命令行，同时匹配我们的 user-data-dir
// 与 --remote-debugging-port。用 execFile（不过 shell），避开路径里的空格转义。
function scanPortByPs(profile) {
	return new Promise((res) => {
		execFile("/bin/ps", ["-eo", "command="], { maxBuffer: 8 << 20 }, (err, out) => {
			if (err || !out) return res(null);
			for (const line of out.split("\n")) {
				if (line.indexOf(`--user-data-dir=${profile}`) < 0) continue;
				const m = /--remote-debugging-port=(\d+)/.exec(line);
				if (m) return res(parseInt(m[1], 10));
			}
			res(null);
		});
	});
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

// 初始化：把 profile 目录定下来（main.js 在 app ready 后调一次）
function initChromeBridge(userDataDir) {
	state.profile = path.join(userDataDir, "chrome-profile");
	return state.profile;
}

function profileDir() {
	return state.profile;
}

// 已经在跑的话返回 {port, ...}，否则返回 null。
// 顺序：本进程记的端口 → DevToolsActivePort → 扫 ps（app 重启后的场景）。
// 三道都经 CDP /json/version 探活确认，避免拿到陈旧端口。
async function detectRunning() {
	const tries = [];
	if (state.port) tries.push(state.port);
	const f = state.profile && readDevToolsPort(state.profile);
	if (f && f.port && !tries.includes(f.port)) tries.push(f.port);
	if (state.profile) {
		const scanned = await scanPortByPs(state.profile);
		if (scanned && !tries.includes(scanned)) tries.push(scanned);
	}

	for (const p of tries) {
		const info = await probe(p);
		if (info) {
			state.port = p;
			return { port: p, info };
		}
	}
	return null;
}

// 启动（或复用）独立 profile 的真实 Chrome。
// url 可选：首次启动时直接打开它。
async function launchChrome(url) {
	if (!state.profile) return { ok: false, err: "chrome-bridge 未初始化" };

	// 1) 已在跑就直接复用，绝不重复启动
	const live = await detectRunning();
	if (live) {
		if (url) await chromeGo(url);
		return {
			ok: true, reused: true, port: live.port,
			exec: state.exec || findExec(),
			browser: live.info.Browser || "",
		};
	}

	// 2) 找可执行文件
	const exec = findExec();
	if (!exec) {
		return {
			ok: false,
			err: "未找到 Chrome / Chromium / Edge。请安装 Google Chrome 后重试。",
		};
	}
	state.exec = exec;

	// 3) 选端口（从 9555 起找第一个空闲的，不写死）
	const port = await pickPort();
	if (!port) return { ok: false, err: `端口 ${PORT_FROM}-${PORT_TO} 全被占用` };

	try { fs.mkdirSync(state.profile, { recursive: true }); } catch {}

	// 4) 拉起来。注意参数【保持素净】：只给必要的几个开关，
	//    绝不加 --disable-blink-features / 自动化相关 flag —— 越像普通 Chrome 越好。
	const args = [
		`--user-data-dir=${state.profile}`,
		`--remote-debugging-port=${port}`,
		"--no-first-run",
		"--no-default-browser-check",
	];
	if (url) args.push(url);

	const child = spawn(exec, args, {
		detached: false,      // 跟随本 app 生命周期，退出时能一起收掉
		stdio: "ignore",      // Chrome 的 stderr 极吵，全丢弃
	});
	child.on("error", () => {});
	child.on("exit", () => { if (state.child === child) { state.child = null; state.port = null; } });
	state.child = child;
	state.port = port;

	// 5) 等 CDP 端口真的起来（Chrome 冷启动大约 0.5~2s）
	for (let i = 0; i < 40; i++) {
		const info = await probe(port, 500);
		if (info) {
			return {
				ok: true, reused: false, port, exec,
				browser: info.Browser || "", profile: state.profile,
			};
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return { ok: false, err: `Chrome 已启动但 CDP 端口 ${port} 未就绪`, port, exec };
}

// 让已运行的 Chrome 打开某 URL，并把窗口带到前台。
// 实现选型：不用 CDP 的 Target.createTarget，而是【再 spawn 一次同 user-data-dir 的
// Chrome】—— Chrome 的 process singleton 会把 URL 转交给已有实例并激活其窗口，
// 之后新进程立刻自行退出。比走 WebSocket CDP 少一个协议实现，也顺带解决了「带到前台」。
async function chromeGo(url) {
	if (!state.profile) return { ok: false, err: "chrome-bridge 未初始化" };
	const exec = state.exec || findExec();
	if (!exec) return { ok: false, err: "未找到 Chrome 可执行文件" };

	let target = String(url || "").trim();
	if (target && !/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !/^about:/i.test(target)) {
		target = /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(target)
			? `https://${target}`
			: `https://www.google.com/search?q=${encodeURIComponent(target)}`;
	}

	const live = await detectRunning();
	if (!live) return launchChrome(target || undefined);   // 没在跑就当成启动

	const args = [`--user-data-dir=${state.profile}`, "--no-first-run", "--no-default-browser-check"];
	if (target) args.push(target);
	try {
		const p = spawn(exec, args, { detached: false, stdio: "ignore" });
		p.on("error", () => {});
	} catch (e) {
		return { ok: false, err: e.message };
	}
	return { ok: true, port: live.port, url: target || null };
}

async function chromeStatus() {
	const live = await detectRunning();
	const f = state.profile && readDevToolsPort(state.profile);
	return {
		running: !!live,
		port: live ? live.port : null,
		exec: state.exec || findExec(),
		wsUrl: live && f && f.wsPath ? `ws://127.0.0.1:${live.port}${f.wsPath}` : null,
		browser: live ? (live.info.Browser || "") : "",
		profile: state.profile,
	};
}

// 退出清理。两条路：
//   有子进程引用 → 直接 kill；
//   没有（比如 Chrome 是上一次 app 运行留下的）→ 按 user-data-dir 精确 pkill，
//   这个 pattern 只可能命中我们自己的 profile，不会误杀用户日常 Chrome。
function closeChrome() {
	const child = state.child;
	state.child = null;
	const port = state.port;
	state.port = null;

	if (child && !child.killed) {
		try { child.kill("SIGTERM"); } catch {}
		return { ok: true, killed: "child", port };
	}
	if (state.profile) {
		try {
			execFile("/usr/bin/pkill", ["-f", "--", `--user-data-dir=${state.profile}`], () => {});
		} catch {}
		return { ok: true, killed: "pkill", port };
	}
	return { ok: true, killed: "none", port };
}

module.exports = {
	initChromeBridge, launchChrome, closeChrome, chromeStatus, chromeGo,
	profileDir, findExec,
};
