// import-cookies.js —— 从用户真实 Chrome 导入 Google 登录态（Cookie）
//
// 背景：Google 会拦截 Electron 内嵌页面的一切登录尝试（accounts.google.com
// 直接跳 /v3/signin/rejected，已控制变量实测 UA / brands / Sec-CH-UA /
// webdriver / 独立 BrowserWindow 全部无效）。但 Google 会话本身靠 Cookie 维持
// （SID / HSID / SSID / SAPISID / APISID …），把用户真 Chrome 里的 Google 域
// Cookie 解密后写进本应用的 persist:pi-browser 分区，右栏内置浏览器直接就是
// 已登录状态 —— 这也是 ChatGPT/Codex 桌面端「从浏览器导入」的真实做法。
//
// 解密链路（macOS，已在真机验证 4/4 解出明文）：
//   1. Cookie 库：~/Library/Application Support/Google/Chrome/<Profile>/Cookies
//      （SQLite；Chrome 关闭时才能稳定读取，有 -wal 也照常读）
//   2. 密钥：钥匙串「Chrome Safe Storage」的口令
//      → PBKDF2-SHA1(口令, salt="saltysalt", iter=1003, dklen=16) = 16 字节 AES 密钥
//   3. encrypted_value：前 3 字节 "v10" → AES-128-CBC（IV = 16 个空格）解密
//      → 去 PKCS7 → 去掉开头 32 字节 sha256(host_key) 域名哈希前缀
//      （Chrome 139+ 格式；Chromium 源码 sqlite_persistent_cookie_store.cc 里
//       EncryptString(SHA256HashString(domain) + value) 可直接对上）
//      → 剩余部分即 cookie 明文
//   4. v20 等其他前缀（app-bound encryption，仅 Windows）跳过并计数
//
// 零依赖：只用 Node 内置模块（node:sqlite 需 Node 22+，Electron 38 自带，
// 已在主进程实测 require('node:sqlite') 可用）。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { session } = require("electron");

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

// 默认白名单：只导入 Google 全家域名（可经 opts.domains 追加）。
// 不无脑全量导入 —— 那会把用户银行 / 内网等敏感 Cookie 也带进来，风险大。
// 匹配规则：host_key（去掉开头点）等于某白名单域，或是其子域。
const GOOGLE_DOMAINS = [
	"google.com",             // 账号体系核心（SID/HSID/SSID/SAPISID 都在 .google.com）
	"youtube.com",
	"youtubeusercontent.com",
	"googleusercontent.com",  // 头像 / 文档内嵌资源
	"gstatic.com",            // 静态资源
	"googleapis.com",
	"ggpht.com",
	"ytimg.com",
	"googlevideo.com",
];

// Chrome samesite 整型（Chromium CookieSameSite 枚举，持久化进 DB 的值）
// → Electron cookies.set 的字符串枚举
const SAMESITE_MAP = {
	"-1": "unspecified",
	"0": "no_restriction",
	"1": "lax",
	"2": "strict",
};

// Chrome 的 expires_utc 是「1601 纪元」的微秒数；转 Unix 秒：先减偏移再除 1e6
const CHROME_EPOCH_OFFSET_US = 11644473600000000n;

// macOS Chrome v10 加密的固定 IV：16 个空格（0x20）
const AES_IV = Buffer.alloc(16, 0x20);

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

// Chrome 是否正在运行（Cookie 库被运行中的 Chrome 独占，必须先退出）
// 测试路径下按目录拼 Cookies 路径（生产路径已在上面算好 cookieFile）
function profileDirCookiesPath(dir) {
	return path.join(dir, "Cookies");
}

function chromeRunning() {
	// 三个变体哪个在跑都算「Chrome 在运行」—— 对应 Cookie 库会带锁/读到不一致状态
	for (const proc of ['"Google Chrome"', '"Google Chrome Beta"', '"Chromium"']) {
		try {
			execSync(`pgrep -x ${proc}`, { stdio: "ignore" });
			return true;
		} catch { /* 这个没在跑，继续试下一个 */ }
	}
	return false;
}

// 从 macOS 钥匙串取「Chrome Safe Storage」口令并派生 16 字节 AES 密钥。
// 首次执行会弹系统授权框，用户点「始终允许」后不再打扰。
function getKeyFromKeychain() {
	const out = execSync(
		'security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"',
		{ timeout: 180000, stdio: ["ignore", "pipe", "ignore"] }
	);
	const password = out.toString("utf8").trim();
	if (!password) throw new Error("钥匙串返回了空口令");
	return crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

// host_key 是否命中域名列表（兼容开头带点的域 cookie 形式）
function hostMatches(hostKey, domains) {
	const h = String(hostKey || "").replace(/^\./, "").toLowerCase();
	if (!h) return false;
	return domains.some((d) => {
		const dd = String(d || "").replace(/^\./, "").toLowerCase();
		if (!dd) return false;
		return h === dd || h.endsWith("." + dd);
	});
}

// 解密一条 v10 cookie。成功返回明文，失败（padding 错 / 域名哈希对不上）返回 null。
function decryptV10(enc, key, hostKey) {
	const data = enc.subarray(3); // 去掉 "v10" 前缀
	if (data.length === 0 || data.length % 16 !== 0) return null;
	const decipher = crypto.createDecipheriv("aes-128-cbc", key, AES_IV);
	decipher.setAutoPadding(false); // 手工校验 PKCS7：失败要计成 failed 而不是抛异常
	let plain;
	try {
		plain = Buffer.concat([decipher.update(data), decipher.final()]);
	} catch {
		return null;
	}
	// PKCS7 校验：最后一个字节 n ∈ [1,16]，且末尾 n 个字节都等于 n
	const pad = plain[plain.length - 1];
	if (pad < 1 || pad > 16 || plain.length < pad) return null;
	for (let i = plain.length - pad; i < plain.length; i++) {
		if (plain[i] !== pad) return null;
	}
	const body = plain.subarray(0, plain.length - pad);
	if (body.length < 32) return null;
	// Chrome 139+：明文开头 32 字节 = sha256(host_key)（域名校验前缀）
	const expect = crypto.createHash("sha256").update(String(hostKey), "utf8").digest();
	if (!expect.equals(body.subarray(0, 32))) return null;
	return body.subarray(32).toString("utf8");
}

// 打开 Cookies 库。有 -wal 时拷贝主库+wal+shm 到临时目录再读 ——
// SQLite 官方建议：WAL 库直接只读打开会因无法恢复日志而失败，
// 拷到可写位置打开（顺带完成 wal 恢复）就没问题。返回 { db, cleanup }。
function openCookieDb(cookieFile) {
	const wal = cookieFile + "-wal";
	if (!fs.existsSync(wal)) {
		const db = new DatabaseSync(cookieFile, { readOnly: true });
		return { db, cleanup: () => { try { db.close(); } catch {} } };
	}
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chrome-cookies-"));
	const tmpDb = path.join(tmpDir, "Cookies");
	const rmTmp = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };
	try {
		fs.copyFileSync(cookieFile, tmpDb);
		try { fs.copyFileSync(wal, tmpDb + "-wal"); } catch {}                 // wal 一定在
		try { fs.copyFileSync(cookieFile + "-shm", tmpDb + "-shm"); } catch {} // shm 可能没有，SQLite 会自建
		const db = new DatabaseSync(tmpDb); // 可写副本：允许 SQLite 做 wal 恢复
		return { db, cleanup: () => { try { db.close(); } catch {} rmTmp(); } };
	} catch (e) {
		rmTmp();
		throw e;
	}
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

// opts：
//   profile   Chrome profile 名（默认 "Default"，也可传 "Profile 1" 等）
//   domains   追加的域名白名单（默认只有 GOOGLE_DOMAINS）
//   chromeDir 测试参数：伪造的 Chrome 用户数据根目录（传入即跳过「Chrome 在运行」检查）
//   keyHex    测试参数：直接给 16 字节 AES 密钥的 hex（生产留空走钥匙串）
// 返回：{ ok, imported, skipped, failed, domains, sessionGoogleCookies }
//       或 { ok:false, needCloseChrome:true } / { ok:false, error, message }
async function doImport(opts = {}) {
	try {
		return await runImport(opts);
	} catch (e) {
		return { ok: false, error: "internal", message: (e && e.message) ? e.message : String(e) };
	}
}

async function runImport(opts) {
	// ---- 1. 定位 profile 目录 & Chrome 运行检查 ----
	// 测试模式（显式传 chromeDir）跳过运行检查，避免测试时杀用户 Chrome
	const testMode = !!opts.chromeDir;
	let profileDir;
	if (testMode) {
		profileDir = path.join(String(opts.chromeDir), opts.profile || "Default");
	} else {
		// 运行检查：三个变体哪个在跑都不行（对应变体的库会带锁/不一致）
		if (chromeRunning()) {
			return { ok: false, needCloseChrome: true };
		}
		// 生产路径探测：用户日常浏览器可能是 Chrome / Chrome Beta / Chromium，
		// 挑「存在且 Cookies 文件最新」的那个 —— 登录态通常在最近常用的那份里。
		const root = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
		const betaRoot = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome Beta");
		const chromiumRoot = path.join(os.homedir(), "Library", "Application Support", "Chromium");
		const prof = opts.profile || "Default";
		const candidates = [root, betaRoot, chromiumRoot]
			.map((r) => path.join(r, prof, "Cookies"))
			.filter((p) => fs.existsSync(p));
		if (!candidates.length) {
			return { ok: false, error: "noCookies", message: "未找到 Chrome / Chrome Beta / Chromium 的 Cookie 库" };
		}
		// 按 mtime 降序取最新的（最近用过的浏览器，登录态最可能是活的）
		candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		const cookieFile = candidates[0];
		profileDir = path.dirname(cookieFile);
		// 【用户实测坑】普通 Chrome 里可能存着一份早已过期的 Google 会话（创建后从未访问），
		// 而日常用的 Chrome Beta 里才是活的。mtime 取新的就是为了踩掉这个坑。
	} 
	const cookieFile = testMode ? path.join(profileDir, "Cookies") : profileDirCookiesPath(profileDir);
	if (!fs.existsSync(cookieFile)) {
		return { ok: false, error: "noCookies", message: `未找到 Chrome Cookie 库：${cookieFile}` };
	}

	// ---- 2. 解密密钥 ----
	let key;
	if (opts.keyHex) {
		key = Buffer.from(String(opts.keyHex), "hex");
		if (key.length !== 16) {
			return { ok: false, error: "keyHex", message: "keyHex 必须是 16 字节（32 个 hex 字符）" };
		}
	} else {
		try {
			key = getKeyFromKeychain();
		} catch (e) {
			return {
				ok: false,
				error: "keychain",
				message: "读取钥匙串失败（" + (e && e.message ? e.message : e) +
					"）。请在弹出的钥匙串窗口中输入密码并点「始终允许」后重试。",
			};
		}
	}

	// ---- 3. 读 SQLite（expires_utc 是 1.3e16 量级，必须开 BigInt 读取）----
	let rows;
	let opened;
	try {
		opened = openCookieDb(cookieFile);
	} catch (e) {
		return { ok: false, error: "sqlite", message: "打开 Cookie 数据库失败：" + (e && e.message ? e.message : e) };
	}
	try {
		const stmt = opened.db.prepare(
			"SELECT host_key, name, value, encrypted_value, path, expires_utc, " +
			"is_secure, is_httponly, samesite FROM cookies"
		);
		stmt.setReadBigInts(true);
		rows = stmt.all();
	} catch (e) {
		return { ok: false, error: "sqlite", message: "读取 Cookie 数据库失败：" + (e && e.message ? e.message : e) };
	} finally {
		opened.cleanup();
	}

	// ---- 4. 逐条解密、过滤 ----
	const whitelist = GOOGLE_DOMAINS.concat(
		Array.isArray(opts.domains) ? opts.domains.map(String) : []
	);
	const nowSec = Math.floor(Date.now() / 1000);
	let imported = 0, skipped = 0, failed = 0;
	const pending = [];

	for (const row of rows) {
		const host = String(row.host_key || "");
		if (!hostMatches(host, whitelist)) { skipped++; continue; }   // 非白名单域名

		// expires_utc = 0 是会话 cookie（Chrome 重启即失）；已过期的导入无意义
		let expSec = 0;
		try {
			const raw = row.expires_utc == null ? 0n : BigInt(row.expires_utc);
			expSec = Number((raw - CHROME_EPOCH_OFFSET_US) / 1000000n);
		} catch { expSec = 0; }
		if (!expSec || expSec <= nowSec) { skipped++; continue; }

		// 明文来源：新版 Chrome 全走加密列；老数据可能还在明文 value 列
		const enc = row.encrypted_value ? Buffer.from(row.encrypted_value) : null;
		let value = null;
		if (enc && enc.length > 0) {
			const prefix = enc.subarray(0, 3).toString("latin1");
			if (prefix !== "v10") { skipped++; continue; }             // v20 等 app-bound 前缀，不处理
			value = decryptV10(enc, key, host);
			if (value === null) { failed++; continue; }                // 解密失败或域名校验不过
		} else if (row.value) {
			value = String(row.value);
		} else {
			skipped++; continue;                                       // 空值
		}

		const sameSiteInt = row.samesite == null ? -1 : Number(row.samesite);
		pending.push({
			host,
			name: String(row.name || ""),
			value,
			path: String(row.path || "/") || "/",
			secure: Number(row.is_secure) === 1,
			httpOnly: Number(row.is_httponly) === 1,
			expSec,
			sameSite: SAMESITE_MAP[String(sameSiteInt)] || "unspecified",
		});
	}

	// ---- 5. 写进内置浏览器分区（persist:pi-browser，与右栏 view 同一 session）----
	const ses = session.fromPartition("persist:pi-browser");
	for (const c of pending) {
		const hostNoDot = c.host.replace(/^\./, "");
		const details = {
			url: "https://" + hostNoDot + c.path, // url 的 host 决定 cookie 归属
			name: c.name,
			value: c.value,
			path: c.path,
			secure: c.secure,
			httpOnly: c.httpOnly,
			expirationDate: c.expSec,             // Unix 秒
			sameSite: c.sameSite,
		};
		// host_key 带开头点 = 域 cookie（含子域），显式传 domain；
		// 不带点 = host-only cookie，不传 domain、由 url 推导 —— 传了会被 Electron
		// 规范化成带点的域 cookie，覆盖范围就变宽了，语义不对
		if (c.host.startsWith(".")) details.domain = c.host;
		try {
			await ses.cookies.set(details);
			imported++;
		} catch {
			// SameSite=None 按 Cookie 规范必须同时 Secure；个别老 cookie 不满足，
			// 降级成 unspecified 再试一次，仍失败才计 failed
			if (details.sameSite === "no_restriction" && !details.secure) {
				try {
					await ses.cookies.set({ ...details, sameSite: "unspecified" });
					imported++;
					continue;
				} catch { /* 落到 failed */ }
			}
			failed++;
		}
	}

	// ---- 6. 回读验证：当前分区里 Google 域 cookie 总数 ----
	let sessionGoogleCookies = 0;
	try {
		const all = await ses.cookies.get({});
		sessionGoogleCookies = all.filter((c) => hostMatches(c.domain, whitelist)).length;
	} catch { /* 统计失败不影响导入结果 */ }

	return { ok: true, imported, skipped, failed, domains: whitelist, sessionGoogleCookies };
}

module.exports = { doImport, GOOGLE_DOMAINS };
