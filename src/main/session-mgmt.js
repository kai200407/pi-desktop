// src/main/session-mgmt.js —— 会话管理模块
//
// 从 main.js 抽出的「会话 / 工作区 / 分支树」职责，零构建 CommonJS。
//
// 职责清单：
//   · 工作区切换（switchWorkspace）
//   · 会话列表获取（listSessionsGrouped —— 扫 ~/.pi/agent/sessions 自动发现项目）
//   · 会话分支树（countBranches / readBranchDetails —— 流式逐行扫 jsonl 头部）
//   · 会话操作（重命名、删除、切换分支 switchToBranch）
//   · 辅助函数（getPiAgentDir / decodeSessionDir / sessionFileOwner / deriveSessionName）
//
// 关键事实（与 main.js 头部注释一致的实测结论，勿改）：
//   · pi 的会话统一放在 ~/.pi/agent/sessions/<路径编码>/*.jsonl，
//     编码规则：/Users/a/b  ->  --Users-a-b--（斜杠换连字符、两端各加 "--"）
//   · 目录名本身含连字符时无法完全反解（如 pi-desktop），decodeSessionDir
//     逐步合并候选段、取第一个真实存在的目录。
//   · jsonl 是树形：branch_summary 条目标记分叉点；navigateTree(fromId,
//     {summarize:false}) 只移动 leafId 不落盘，下一条消息才以该节点为父开新分支。
//
// 依赖注入：本模块不直接持有 Electron / pi SDK 引用，构造函数接收一个
// piEngine 适配对象，由调用方（main 入口）把 main.js 里的对应能力接进来：
//   {
//     getPi():            当前 pi 运行时 { runtime, modelRuntime, cwd } 或 null
//     setPi(v):           替换 pi 引用（switchWorkspace 重建时置 null）
//     initPi(cwd, opts):  重建 pi runtime（Promise）
//     ensurePi():         惰性确保 pi 已就绪（Promise）
//     bindSession():      重新订阅当前 session 事件
//     pushSessionInfo():  推送 session_info 给渲染层
//     send(type, extra):  推事件给渲染层
//     loadConf():         读持久化配置（cwd / recentCwds / modelId…）
//     saveConf(patch):    写持久化配置
//     serializeMessages(msgs): pi 消息 -> 渲染层扁平结构
//     getUnsubscribe()/setUnsubscribe(fn): 当前事件订阅解绑函数的读写
//   }

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const readline = require("node:readline");

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

function dirExists(p) {
	try { return fs.statSync(p).isDirectory(); } catch { return false; }
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

// 从会话文件里取一个像样的标题：优先第一条用户消息
// 【性能优化】只读前 16KB 而非整文件——实测 93MB 文件整读进内存需 ~490ms，
// 而读前 16KB 仅需 ~5ms，性能提升约 100 倍。
function deriveSessionName(fullPath, fallback) {
	try {
		// 只读前 16KB：绝大多数会话的用户首条消息都在前 40 行内，
		// 16KB 足够覆盖几十行 JSONL（一行平均 200-500 字节）
		const fd = fs.openSync(fullPath, 'r');
		const buf = Buffer.alloc(16384);
		const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
		fs.closeSync(fd);
		
		const head = buf.toString('utf8', 0, bytesRead).split('\n').slice(0, 40);
		
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
	return String(fallback || "").replace(/\.jsonl$/, "").slice(0, 40);
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------
class SessionManager {
	/**
	 * @param {object} piEngine 见文件头部「依赖注入」说明
	 */
	constructor(piEngine) {
		if (!piEngine) throw new Error("SessionManager 需要 piEngine 适配对象");
		this.engine = piEngine;
		// 会话列表缓存（避免重复扫描文件系统）
		this._sessionListCache = null;
		this._cacheTime = 0;
		this.CACHE_TTL = 5000;  // 5秒缓存有效期
	}

	// --- 便捷访问注入的能力 -------------------------------------------------
	get pi() { return this.engine.getPi(); }
	get loadConf() { return this.engine.loadConf; }
	get saveConf() { return this.engine.saveConf; }
	get send() { return this.engine.send; }

	// --- 工作区 ------------------------------------------------------------

	// 切换工作区：重建 pi runtime，并把路径记入“最近工作区”（仿 Codex）。
	// 【性能优化】不再 setPi(null) 销毁旧 runtime —— PiEngine 的实例池会按 cwd
	// 缓存 runtime 实例（LRU 上限 3），切回已访问工作区只需 ~50ms 而不是 700-1200ms。
	// 这里只需解绑当前 session 事件订阅（由 getUnsubscribe 返回的函数完成），
	// 实际的实例复用/新建/淘汰都由 initPi 内部处理。
	//
	// opts.updateRecent（默认 true）：是否把 dir 提到 recentCwds 首位。
	// 点击会话切工作区（switchSession/switchToBranch 内部）传 false，
	// 避免分组顺序随点击跳动；显式切换工作区（setCwd/pickCwd）保持 true。
	async switchWorkspace(dir, opts = {}) {
		console.time('[SessionManager] switchWorkspace');
		console.log('[SessionManager] switchWorkspace:', this.pi?.cwd, '→', dir, 'updateRecent:', opts.updateRecent !== false);
		const unsub = this.engine.getUnsubscribe?.();
		if (unsub) { try { unsub(); } catch {} this.engine.setUnsubscribe?.(null); }
		// 【已移除】this.engine.setPi(null) —— 让实例池接管生命周期
		if (opts.updateRecent !== false) {
			const list = (this.loadConf().recentCwds || []).filter((x) => x !== dir);
			list.unshift(dir);
			this.saveConf({ recentCwds: list.slice(0, 10) });
		} else {
			console.log('[SessionManager] 跳过更新 recentCwds（点击会话不改变分组顺序）');
		}
		await this.engine.initPi(dir, { updateRecent: opts.updateRecent !== false });
		this.send("session_cleared");
		this.send("recent_cwds", { list: (this.loadConf().recentCwds || []) });
		console.timeEnd('[SessionManager] switchWorkspace');
	}

	// --- 会话列表 ----------------------------------------------------------

	// 预加载会话列表到缓存（启动时调用，不等待）
	preloadSessions() {
		console.log('[SessionManager] 预加载会话列表...');
		console.time('[SessionManager] 预加载耗时');
		this.listSessionsGrouped()
			.then(() => {
				console.timeEnd('[SessionManager] 预加载耗时');
				console.log('[SessionManager] 预加载完成');
			})
			.catch(err => {
				console.timeEnd('[SessionManager] 预加载耗时');
				console.error('[SessionManager] 预加载失败:', err);
			});
	}

	// 按项目（工作区目录）分组的会话列表 —— 左栅用。
	//
	// pi 的会话不在 <cwd>/.pi/sessions，而是统一放在
	// ~/.pi/agent/sessions/<路径编码>/*.jsonl，编码规则实测为：
	//   /Users/arden/Desktop/tcic-owner  ->  --Users-arden-Desktop-tcic-owner--
	// 即斜杠换连字符、两端各加 "--"。
	// 直接扫这个目录就能自动发现历史上所有项目，
	// 不靠 recentCwds 慢慢累积。
	async listSessionsGrouped() {
		// 检查缓存是否有效
		const now = Date.now();
		if (this._sessionListCache && (now - this._cacheTime) < this.CACHE_TTL) {
			console.log('[SessionManager] 返回缓存的会话列表（缓存时间:', now - this._cacheTime, 'ms）');
			return this._sessionListCache;
		}

		console.time('[SessionManager] 扫描会话列表');
		try {
			const cur = this.pi?.cwd || this.loadConf().cwd || process.cwd();
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
			
			const result = groups.slice(0, 20);
			
			// 更新缓存
			this._sessionListCache = result;
			this._cacheTime = Date.now();
			console.timeEnd('[SessionManager] 扫描会话列表');
			console.log('[SessionManager] 会话列表已缓存，共', result.length, '个项目');
			
			return result;
		} catch (err) {
			console.timeEnd('[SessionManager] 扫描会话列表');
			console.error('[SessionManager] 扫描会话列表失败:', err);
			return [];
		}
	}

	// --- 会话操作 ----------------------------------------------------------

	// 切换会话：装载指定 jsonl 文件，必要时先把工作区切到会话归属的项目。
	async switchSession(file) {
		try {
			await this.engine.ensurePi();
			// 会话可能属于另一个项目（左栅能看到所有项目）。
			// 先把工作区切到那个项目，否则工具会在错的目录下执行。
			// 【分组稳定性】点击会话切工作区不传 updateRecent，避免分组顺序跳动。
			const owner = sessionFileOwner(file);
			if (owner && owner !== this.pi.cwd) await this.switchWorkspace(owner, { updateRecent: false });
			const { runtime } = await this.engine.ensurePi();
			await runtime.switchSession(file);
			this.engine.bindSession();
			this.engine.pushSessionInfo();
			// 回灌历史消息，让界面能重建对话
			const msgs = runtime.session.messages || [];
			this.send("session_restored", { messages: this.engine.serializeMessages(msgs) });
		} catch (err) {
			this.send("error", { message: `切换会话失败：${err.message}` });
		}
	}

	// 删除会话：删掉对应 .jsonl 文件并刷新列表。
	// 删除前确认文件存在且确实位于 sessions 目录下（防误删任意路径）。
	async deleteSession(file) {
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
	}

	// 重命名会话：jsonl 源文件不改（pi 自己的格式），
	// 维护一份 sidecar 映射 <agent>/session-names.json：{ [filePath]: 显示名 }。
	// 渲染层读取列表时可优先用这里的名字覆盖 deriveSessionName 的结果。
	async renameSession(file, name) {
		try {
			if (!file || typeof file !== "string") return { ok: false, err: "bad arg" };
			const root = path.join(getPiAgentDir(), "sessions");
			const rp = path.resolve(file);
			if (!rp.startsWith(root + path.sep) || !rp.endsWith(".jsonl")) {
				return { ok: false, err: "不在会话目录内" };
			}
			if (!fs.existsSync(rp)) return { ok: false, err: "文件不存在" };
			const mapFile = path.join(getPiAgentDir(), "session-names.json");
			let map = {};
			try { map = JSON.parse(fs.readFileSync(mapFile, "utf8")); } catch {}
			const trimmed = String(name || "").trim();
			if (trimmed) map[rp] = trimmed.slice(0, 40);
			else delete map[rp]; // 传空名 = 恢复自动命名
			fs.writeFileSync(mapFile, JSON.stringify(map, null, 2));
			return { ok: true, name: trimmed || null };
		} catch (err) {
			return { ok: false, err: err.message };
		}
	}

	// 列出某会话文件里的 branch_summary 条目（弹层用）。
	// 安全：与 deleteSession 同款校验 —— 只允许读 sessions 目录下的 .jsonl。
	async listBranches(file) {
		try {
			const root = path.join(getPiAgentDir(), "sessions");
			const rp = path.resolve(String(file || ""));
			if (!rp.startsWith(root + path.sep) || !rp.endsWith(".jsonl")) return [];
			if (!fs.existsSync(rp)) return [];
			return await readBranchDetails(rp);
		} catch {
			return [];
		}
	}

	// 切到某个分叉点继续对话。
	// API 语义调研结论（dist/core/agent-session.js navigateTree 实现）：
	//   · summarize:false 时只移动 SessionManager.leafId 并重建 agent.state.messages，
	//     不落 jsonl（不落 branch_summary）；下一条消息才以该节点为父开新分支。
	//   · summarize:true 才会 append branch_summary 条目。我们传 false，不写文件。
	//   · 该调用要求当前 session 就是目标 session（得先 switchSession 装载）。
	// 完整链路：switchSession(file) 装载 → navigateTree(branchFromId, {summarize:false})
	//   → 回灌该分支的历史（session.messages 是 leaf 到 root 的路径消息）。
	async switchToBranch(payload) {
		const { file, branchFromId } = payload || {};
		try {
			if (!file || !branchFromId) return { ok: false, err: "bad arg" };
			await this.engine.ensurePi();
			// 会话可能属于另一个项目：先切工作区（与 switchSession 同款逻辑）
			// 【分组稳定性】点击会话切工作区不传 updateRecent，避免分组顺序跳动。
			const owner = sessionFileOwner(file);
			if (owner && owner !== this.pi.cwd) await this.switchWorkspace(owner, { updateRecent: false });
			const { runtime } = await this.engine.ensurePi();
			await runtime.switchSession(file);
			this.engine.bindSession();
			const r = await runtime.session.navigateTree(branchFromId, { summarize: false });
			if (r && r.cancelled) return { ok: false, err: "cancelled" };
			this.engine.pushSessionInfo();
			// 回灌当前 leaf 路径的消息，让界面重建这条分支的对话
			const msgs = runtime.session.messages || [];
			this.send("session_restored", { messages: this.engine.serializeMessages(msgs) });
			return { ok: true };
		} catch (err) {
			return { ok: false, err: err.message };
		}
	}

	// pi 官方 SessionManager.listSessions 的薄封装（当前 cwd 的 .pi/sessions）。
	// 保留与 main.js 原 pi:listSessions 一致的行为。
	async listSessions() {
		try {
			const { cwd } = await this.engine.ensurePi();
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
	}

	// --- 纯函数能力的实例化透出（便于测试与外部复用） -------------------------
	getPiAgentDir() { return getPiAgentDir(); }
	decodeSessionDir(enc) { return decodeSessionDir(enc); }
	sessionFileOwner(file) { return sessionFileOwner(file); }
	deriveSessionName(fullPath, fallback) { return deriveSessionName(fullPath, fallback); }
	countBranches(file) { return countBranches(file); }
	readBranchDetails(file) { return readBranchDetails(file); }
}

module.exports = {
	SessionManager,
	// 同时导出纯函数，方便不实例化也能用（如 ipc-handlers 里做参数校验）
	getPiAgentDir,
	decodeSessionDir,
	sessionFileOwner,
	deriveSessionName,
	countBranches,
	readBranchDetails,
	dirExists,
	BRANCH_SCAN_MAX_LINES,
};
