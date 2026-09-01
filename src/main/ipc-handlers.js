// src/main/ipc-handlers.js —— 所有 IPC handler 集中注册
//
// 从 main.js 的 registerIpc() 原样提取，逻辑零改动。
// 通过 deps 注入主进程其它模块的能力：
//   - piEngine:  { ensurePi, initPi, bindSession, pushSessionInfo, switchWorkspace,
//                  serializeMessages, sessionFileOwner, getPi, send }
// 说明：piEngine 里只要求 getPi() 返回当前 { runtime, modelRuntime, cwd }（可能为 null），
//       因为 handler 执行时的 pi 必须是【最新】引用，不能靠解构捕获旧值。
//   - browserMgr: { getView, go/back/... 之外的状态与操作 }
//       字段：
//         getView()        -> 当前活动标签的 WebContentsView（或 null）
//         getTabs()        -> [{ id, view }]
//         getActiveTabId() -> 当前活动标签 id
//         isVisible()      -> browserVisible
//         setVisible(v)    -> 更新 browserVisible
//         getLastBounds()  -> 最后一次渲染层上报的右栏 rect
//         createBrowserView(initialUrl)
//         closeTab(id)
//         activateTab(id)
//         applyBrowserBounds()
//         pushTabs()
//         HOME_URL
//   - sessionMgr: { countBranches, readBranchDetails, deriveSessionName,
//                   decodeSessionDir, dirExists }
//   - win: 主窗口（dialog.showOpenDialog 的父窗、debug:viewState 用）
//   - conf: 当前配置对象（loadConf() 的结果）
//   - saveConf(patch): 持久化配置
//
// 分组：pi 操作 / 会话管理 / 浏览器控制 / 调试辅助 / Cookie 导入 / 真实 Chrome
// （main.js 里没有独立的"配置读写"通道 —— 配置改动都散在 pi:setModel /
//   pi:setThinking / browser:toggle 等 handler 里通过 saveConf 落盘。）

const { app, ipcMain, session, dialog, shell, clipboard } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

function registerIpcHandlers(deps) {
	const {
		piEngine,
		browserMgr,
		sessionMgr,
		win,
		conf,
		saveConf,
		loadConf,
		chromeBridge,
		doImport,
		CDP_PORT,
	} = deps;

	// ---- 便捷别名（保持原 handler 体的写法不变）----
	const { ensurePi, initPi, bindSession, pushSessionInfo, switchWorkspace } = piEngine;
	const { serializeMessages, sessionFileOwner, getPiAgentDir, send } = piEngine;
	const { countBranches, readBranchDetails, deriveSessionName } = sessionMgr;
	const { decodeSessionDir, dirExists } = sessionMgr;
	const {
		createBrowserView, closeTab, activateTab,
		applyBrowserBounds, pushTabs,
		switchConversation: switchBrowserConversation,  // 新增：浏览器 conversation 切换
	} = browserMgr;
	const HOME_URL = browserMgr.HOME_URL;
	// 这些是可变量，每次都要取最新值，不能解构固定
	const pi = () => piEngine.getPi();
	const browserView = () => browserMgr.getView();
	// deps.win 可能是函数（惰性取当前窗口，防窗口重建后持有失效引用），统一解析
	const getWin = () => (typeof win === "function" ? win() : win);

	// ===== 获取可用 skills =====
	// 从 pi runtime 的 resourceLoader 获取当前工作区已加载的 skills。
	// 工作区切换后 skills 会变，渲染层通过 IPC 动态拉取。
	ipcMain.handle("pi:getAvailableSkills", async () => {
		console.log('[IPC] getAvailableSkills');
		try {
			const p = pi();
			if (!p || !p.runtime || !p.runtime.session) {
				console.log('[IPC] pi 未初始化，返回空 skills');
				return { ok: true, skills: [] };
			}
			const sess = p.runtime.session;
			// resourceLoader 挂在 session 上（见 agent-session.d.ts）
			const loader = sess.resourceLoader;
			if (!loader || typeof loader.getSkills !== 'function') {
				console.log('[IPC] resourceLoader 不可用');
				return { ok: true, skills: [] };
			}
			const result = loader.getSkills();
			const skills = (result.skills || []).map(s => ({
				name: s.name,
				description: s.description || '',
				filePath: s.filePath || '',
				baseDir: s.baseDir || '',
				disableModelInvocation: !!s.disableModelInvocation,
			}));
			console.log('[IPC] getAvailableSkills 成功:', skills.length, '个 skills');
			return { ok: true, skills };
		} catch (err) {
			console.error('[IPC] getAvailableSkills 失败:', err);
			return { ok: false, error: err.message, skills: [] };
		}
	});

	// ===== pi 操作 =====
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
		const p = pi();
		if (p) await p.runtime.session.abort();
	});

	ipcMain.handle("pi:newSession", async () => {
		const { runtime } = await ensurePi();
		await runtime.newSession();
		bindSession();
		pushSessionInfo();
		send("session_cleared");
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

	// ==== 工作区 ====
	ipcMain.handle("pi:getCwd", async () => pi()?.cwd || conf.cwd || process.cwd());

	ipcMain.handle("pi:getRecentCwds", async () => {
		const list = loadConf().recentCwds || [];
		const cur = pi()?.cwd || process.cwd();
		// 只返回仍存在的目录，并把当前工作区标出来
		return list.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
			.map((d) => ({ path: d, name: path.basename(d), current: d === cur }));
	});

	ipcMain.handle("pi:setCwd", async (_e, dir) => {
		try {
			if (!fs.statSync(dir).isDirectory()) throw new Error("不是目录");
			await switchWorkspace(dir);

			// ===== 新增：通知浏览器管理器切换 conversation =====
			if (switchBrowserConversation) {
				switchBrowserConversation(dir);
				console.log('[IPC] 浏览器 conversation 已切换:', dir);
			}

			return dir;
		} catch (err) {
			send("error", { message: `切换工作区失败：${err.message}` });
			return null;
		}
	});

	ipcMain.handle("pi:pickCwd", async () => {
		const r = await dialog.showOpenDialog(getWin(), {
			properties: ["openDirectory", "createDirectory"],
			defaultPath: pi()?.cwd || os.homedir(),
			title: "选择工作区",
		});
		if (r.canceled || !r.filePaths[0]) return null;
		const next = r.filePaths[0];
		await switchWorkspace(next);

		// ===== 新增：通知浏览器管理器切换 conversation =====
		if (switchBrowserConversation) {
			switchBrowserConversation(next);
			console.log('[IPC] 浏览器 conversation 已切换:', next);
		}

		return next;
	});

	// 工作区管理：从最近工作区列表移除某项。
	// 只动 recentCwds 配置；不删 sessions 目录下的历史会话文件（用户数据）。
	// 不允许移除「当前工作区」（会把当前会话现场弄丢），调用方需先切换到别处。
	ipcMain.handle("pi:removeRecentCwd", async (_e, dir) => {
		try {
			if (!dir || typeof dir !== "string") return { ok: false, err: "bad arg" };
			const cur = pi()?.cwd || conf.cwd || process.cwd();
			if (dir === cur) return { ok: false, err: "不能移除当前工作区" };
			const list = (loadConf().recentCwds || []).filter((x) => x !== dir);
			saveConf({ recentCwds: list });
			// 通知渲染层最近列表变了（sidebar / conversation 都会刷新各自的弹层）
			send("recent_cwds", { list });
			return { ok: true, list };
		} catch (err) {
			return { ok: false, err: err.message };
		}
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

	// ==== 会话统计（Token 用量 / 缓存命中 / 成本 / 上下文占用）====
	// 供中栏底部状态栏实时展示。pi SDK 的 session.getSessionStats() 是同步方法，
	// 返回 { tokens:{input,output,cacheRead,cacheWrite,total}, cost,
	//        contextUsage:{tokens,contextWindow,percent} }。
	// 会话尚未就绪（pi 未初始化）或调用异常时返回 null，渲染层据此隐藏状态栏。
	ipcMain.handle("pi:getSessionStats", async () => {
		try {
			const p = pi();
			if (!p || !p.runtime || !p.runtime.session) return null;
			const sess = p.runtime.session;
			if (typeof sess.getSessionStats !== "function") return null;
			const stats = sess.getSessionStats();
			if (process.env.PI_DESKTOP_DEBUG_STATS) console.log("[IPC] getSessionStats:", stats);
			return stats || null;
		} catch (err) {
			console.error("[IPC] getSessionStats 失败:", err && err.message);
			return null;
		}
	});

	// ==== 斜杠命令（/compact /tree /session /export /copy /share /clear）====
	// 渲染层输入框检测到以 / 开头的文本时走这里。pi SDK 并没有一个统一的
	// runtime.executeCommand 入口（交互式 CLI 的斜杠命令都是直接调 session 方法
	// 然后画 TUI），所以这里按命令分发到对应的真实 API，把结果以结构化数据返回，
	// 由渲染层决定如何展示（文本/树/统计卡片）。
	ipcMain.handle("pi:executeCommand", async (_e, payload) => {
		const command = String((payload && payload.command) || "").trim();
		if (!command) return { ok: false, error: "空命令" };
		const parts = command.split(/\s+/);
		const name = parts[0].toLowerCase();
		const argString = command.slice(parts[0].length).trim();

		try {
			const { runtime } = await ensurePi();
			const sess = runtime.session;
			const sm = sess.sessionManager;

			switch (name) {
				case "/compact": {
					// 与 CLI 一致：支持 /compact [自定义指令]
					const r = await sess.compact(argString || undefined);
					return { ok: true, kind: "compact", aborted: !!(r && r.aborted) };
				}

				case "/clear": {
					await runtime.newSession();
					bindSession();
					pushSessionInfo();
					send("session_cleared");
					return { ok: true, kind: "clear" };
				}

				case "/copy": {
					const text = sess.getLastAssistantText && sess.getLastAssistantText();
					if (!text) return { ok: false, error: "还没有助手消息可复制" };
					clipboard.writeText(text);
					return { ok: true, kind: "copy", length: text.length };
				}

				case "/session": {
					const stats = sess.getSessionStats();
					return {
						ok: true, kind: "session",
						info: {
							name: (sm.getSessionName && sm.getSessionName()) || null,
							file: stats.sessionFile || "内存会话",
							id: stats.sessionId,
							cwd: runtime.cwd || (pi() && pi().cwd) || "",
							totalMessages: stats.totalMessages,
							userMessages: stats.userMessages,
							assistantMessages: stats.assistantMessages,
							toolCalls: stats.toolCalls,
							tokens: stats.tokens,
							cost: stats.cost,
						},
					};
				}

				case "/tree": {
					const tree = sm.getTree && sm.getTree();
					const leafId = sm.getLeafId && sm.getLeafId();
					return { ok: true, kind: "tree", tree: serializeSessionTree(tree, leafId) };
				}

				case "/export": {
					// /export [file]：无参数弹保存框；.jsonl 结尾走 exportToJsonl，其余走 HTML。
					// 带引号或空格的路径参数沿用 CLI 的解析语义（取第一个 token，支持引号包裹）。
					let target = parsePathArgument(argString);
					if (!target) {
						const ts = Date.now();
						const { filePath, canceled } = await dialog.showSaveDialog(getWin(), {
							title: "导出会话",
							defaultPath: `session-${ts}.html`,
							filters: [
								{ name: "HTML", extensions: ["html"] },
								{ name: "JSONL", extensions: ["jsonl"] },
							],
						});
						if (canceled || !filePath) return { ok: false, error: "已取消导出", cancelled: true };
						target = filePath;
					}
					let out;
					if (/\.jsonl$/i.test(target)) out = sess.exportToJsonl(target);
					else out = await sess.exportToHtml(target);
					return { ok: true, kind: "export", filePath: out };
				}

				case "/share": {
					// 沿用 CLI 的 gist 路径（Radius 网关是内部能力，桌面端不保证可用）。
					// 需要本机已安装并登录 GitHub CLI (gh)。
					const { spawnSync } = require("node:child_process");
					const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
					if (auth.status !== 0) {
						return { ok: false, error: "GitHub CLI 未登录，请先在终端运行 gh auth login" };
					}
					const tmpHtml = path.join(os.tmpdir(), `pi-share-${Date.now()}.html`);
					try {
						await sess.exportToHtml(tmpHtml);
						const r = spawnSync("gh", ["gist", "create", "--public=false", tmpHtml], { encoding: "utf-8" });
						if (r.status !== 0) {
							return { ok: false, error: (r.stderr || "创建 gist 失败").trim() };
						}
						const gistUrl = String(r.stdout || "").trim();
						return { ok: true, kind: "share", url: gistUrl };
					} finally {
						try { fs.unlinkSync(tmpHtml); } catch {}
					}
				}

				default:
					return { ok: false, error: "未知命令: " + name + "（支持 /compact /tree /session /export /copy /share /clear）" };
			}
		} catch (err) {
			console.error("[IPC] executeCommand 失败:", command, err);
			return { ok: false, error: (err && err.message) || String(err) };
		}
	});

	// ===== 会话管理 =====
	// 临时聊天：不落盘的会话。当前已是 inMemory 时直接 newSession
	// （pi 的 newSession 会检查 isPersisted() 并保持 inMemory，不会意外落盘）。
	ipcMain.handle("pi:newEphemeral", async () => {
		const { runtime } = await ensurePi();
		// 若当前是持久会话，换用 inMemory 的 SessionManager 重建 runtime
		if (runtime.session.sessionManager.isPersisted()) {
			const mod = await import("@earendil-works/pi-coding-agent");
			const sm = mod.SessionManager.inMemory(runtime.cwd || pi()?.cwd);
			await runtime.switchToManager?.(sm);          // 若 runtime 不提供该入口则走重初始化
			if (!runtime.switchToManager) {
				// 重初始化：dispose 旧 runtime，用 inMemory manager 新建（沿用原工厂参数）
				await initPi(pi()?.cwd, { ephemeral: true });
			}
		} else {
			await runtime.newSession();
		}
		bindSession();
		pushSessionInfo();
		send("session_cleared", { ephemeral: true });
	});

	// hover 预取：渲染层悬停会话行 300ms 后调用，主进程提前把目标 jsonl
	// 的消息读出来并序列化缓存（piEngine._msgCache，LRU 10 条 / TTL 60s）。
	// 点击时 switchSession 命中缓存直接广播，跳过 jsonl 读取+反序列化。
	// 静默失败：预取只是优化，出错不影响点击路径。
	ipcMain.handle("pi:preloadSession", async (_e, file) => {
		try {
			await sessionMgr.preloadSession(file);
			return { ok: true };
		} catch {
			return { ok: false };
		}
	});

	ipcMain.handle("pi:switchSession", async (_e, file) => {
		try {
			await ensurePi();
			// 会话可能属于另一个项目（左栅能看到所有项目）。
			// 先把工作区切到那个项目，否则工具会在错的目录下执行。
			// 【分组稳定性】点击会话切工作区传 updateRecent:false，避免分组顺序跳动。
			const owner = sessionFileOwner(file);
			if (owner && owner !== pi()?.cwd) await switchWorkspace(owner, { updateRecent: false });
			const { runtime } = await ensurePi();
			await runtime.switchSession(file);
			bindSession();
			pushSessionInfo();

			// ===== 新增：通知浏览器管理器切换 conversation =====
			const currentCwd = pi()?.cwd;
			if (currentCwd && switchBrowserConversation) {
				switchBrowserConversation(currentCwd);
				console.log('[IPC] 浏览器 conversation 已切换:', currentCwd);
			}

			// 回灌历史消息，让界面能重建对话
			const msgs = runtime.session.messages || [];
			console.log('[IPC] pi:switchSession 回灌消息数:', msgs.length, 'file:', file);
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
			const cur = pi()?.cwd || conf.cwd || process.cwd();
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
			// 【分组稳定性】点击会话切工作区传 updateRecent:false，避免分组顺序跳动。
			const owner = sessionFileOwner(file);
			if (owner && owner !== pi()?.cwd) await switchWorkspace(owner, { updateRecent: false });
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

	// ===== 会话导出 =====
	// 支持三种格式：
	//   - markdown: 纯文本，适合阅读/分享/归档，自实现
	//   - html:     带样式的网页，适合展示/打印，pi SDK 原生 /export 命令
	//   - jsonl:    原始数据，适合程序处理/导入其他系统，pi SDK 原生 /export 命令
	ipcMain.handle("pi:exportSession", async (_e, { sessionId, format }) => {
		console.log('[IPC] exportSession:', sessionId, format);
		
		// 校验参数
		if (!sessionId || typeof sessionId !== 'string') {
			return { ok: false, error: '无效的会话 ID' };
		}
		if (!['markdown', 'html', 'jsonl'].includes(format)) {
			return { ok: false, error: '不支持的导出格式: ' + format };
		}

		const p = pi();
		if (!p || !p.runtime) {
			return { ok: false, error: 'pi 引擎未初始化' };
		}

		try {
			let content;
			let ext;
			const timestamp = Date.now();

			if (format === 'html' || format === 'jsonl') {
				// 使用 pi SDK 原生 /export 命令
				const tempFile = path.join(os.tmpdir(), `pi-export-${timestamp}.${format}`);
				await p.runtime.executeCommand(`/export ${tempFile}`);
				content = fs.readFileSync(tempFile, 'utf8');
				fs.unlinkSync(tempFile);
				ext = format;
			} else if (format === 'markdown') {
				// 自定义 Markdown 导出：从当前会话消息构建可读文本
				const messages = p.runtime.session.getMessages();
				content = exportToMarkdown(messages, sessionId);
				ext = 'md';
			}

			// 弹出保存对话框
			const { filePath } = await dialog.showSaveDialog(getWin(), {
				title: '导出会话',
				defaultPath: `session-${timestamp}.${ext}`,
				filters: [
					{ name: format === 'markdown' ? 'Markdown' : format.toUpperCase(), extensions: [ext] },
					{ name: '所有文件', extensions: ['*'] }
				]
			});

			if (!filePath) {
				return { ok: false, error: '用户取消导出' };
			}

			fs.writeFileSync(filePath, content, 'utf8');
			console.log('[IPC] 导出成功:', filePath);
			return { ok: true, filePath };

		} catch (err) {
			console.error('[IPC] 导出失败:', err);
			return { ok: false, error: err.message || '导出过程发生未知错误' };
		}
	});

	// ===== 浏览器控制 =====
	// ==== 右栏浏览器 ====
	ipcMain.handle("browser:go", (_e, url) => {
		const view = browserView();
		if (!view) return;
		let t = String(url || "").trim();
		if (!t) return;
		if (!/^[a-z]+:\/\//i.test(t)) {
			t = /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(t)
				? `https://${t}`
				: `https://www.google.com/search?q=${encodeURIComponent(t)}`;
		}
		view.webContents.loadURL(t);
	});
	ipcMain.handle("browser:back", () => {
		const h = browserView()?.webContents.navigationHistory;
		if (h?.canGoBack()) h.goBack();
	});
	ipcMain.handle("browser:forward", () => {
		const h = browserView()?.webContents.navigationHistory;
		if (h?.canGoForward()) h.goForward();
	});
	ipcMain.handle("browser:reload", () => browserView()?.webContents.reload());
	ipcMain.handle("browser:home", () => browserView()?.webContents.loadURL(HOME_URL));
	ipcMain.handle("browser:devtools", () => browserView()?.webContents.openDevTools({ mode: "detach" }));

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

	// 配置读写：browserVisible 开关
	ipcMain.handle("browser:toggle", (_e, visible) => {
		if (process.env.PI_DESKTOP_DEBUG_BOUNDS) console.log("[toggle] ->", visible);
		const v = !!visible;
		browserMgr.setVisible(v);
		saveConf({ browserVisible: v });
		applyBrowserBounds();
		return v;
	});

	ipcMain.on("browser:bounds", (_e, rect) => {
		if (rect && typeof rect.width === "number") {
			browserMgr.setLastBounds(rect);
			applyBrowserBounds();
		}
	});

	// 给 agent 用：右栏浏览器的 CDP 端口
	ipcMain.handle("browser:cdpInfo", () => ({ port: CDP_PORT }));

	// ---- 浏览器多标签 ----
	ipcMain.handle("browser:tabNew", (_e, url) => {
		if (process.env.PI_DESKTOP_DEBUG_BOUNDS) console.log("[tab] tabNew 请求:", url);
		createBrowserView(url && /^https?:/i.test(url) ? url : HOME_URL);
		applyBrowserBounds();
		pushTabs();
		return browserMgr.getActiveTabId();
	});
	ipcMain.handle("browser:tabClose", (_e, id) => { closeTab(id); return true; });
	ipcMain.handle("browser:tabActivate", (_e, id) => activateTab(id));
	ipcMain.handle("browser:tabList", () => ({
		activeId: browserMgr.getActiveTabId(),
		tabs: browserMgr.getTabs().map((t) => {
			let url = "", title = "";
			try { url = t.view.webContents.getURL(); title = t.view.webContents.getTitle(); } catch {}
			return { id: t.id, url, title };
		}),
	}));

	// ===== 调试辅助（保留：不影响生产路径，排查黑屏/登录拦截时必备）=====
	// 调试用：导出右栏 view 的真实状态（排查“黑屏”类问题）
	// 调试/辅助用：用【真实键鼠事件】向右栏页面输入文本。
	// 为何需要：实测发现 Google 登录页会拦截用 executeJavaScript
	// 直接改 input.value 的行为（判为“软件自动控制”），而 sendInputEvent
	// 走 Chromium 真实输入管线，不会被拦。
	ipcMain.handle("debug:typeInView", async (_e, { selector, text, submit }) => {
		const view = browserView();
		if (!view) return { err: "no view" };
		const wc = view.webContents;
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
		const view = browserView();
		if (!view) return { ok: false, err: "no view" };
		const wc = view.webContents;
		wc.focus();
		wc.sendInputEvent({ type: "mouseMove", x, y });
		await new Promise((r) => setTimeout(r, 150));
		wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
		wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
		return { ok: true };
	});

	// 列出内置浏览器分区里的 Google cookie 名单（调试/验收用）
	// 【修改】支持 conversation 隔离：列出所有 conversation session 的 cookies
	ipcMain.handle("debug:listGoogleCookies", async () => {
		// 获取所有已缓存的 session
		const sessions = [];
		if (browserMgr.sessionManager && browserMgr.sessionManager.sessions) {
			for (const [convId, data] of browserMgr.sessionManager.sessions) {
				sessions.push({ convId, session: data.session });
			}
		}
		// 如果没有 conversation session，至少列出默认 session
		if (sessions.length === 0) {
			sessions.push({
				convId: 'default',
				session: session.fromPartition("persist:pi-browser-default")
			});
		}

		// 收集所有 session 的 Google cookies
		const allCookies = [];
		for (const { convId, session: sess } of sessions) {
			const cookies = await sess.cookies.get({});
			const googleCookies = cookies
				.filter((c) => /google|youtube|gstatic|ggpht|ytimg/.test(c.domain))
				.map((c) => `[${convId}] ${c.domain} ${c.name} secure=${c.secure?"1":"0"} httpOnly=${c.httpOnly?"1":"0"}`);
			allCookies.push(...googleCookies);
		}
		return allCookies;
	});

	// 在当前活动 view 里执行 JS（调试用：读登录态等页面内证据）
	ipcMain.handle("debug:evalInView", async (_e, code) => {
		const view = browserView();
		if (!view) return { err: "no view" };
		try {
			const v = await view.webContents.executeJavaScript(code, true);
			return { ok: true, value: v };
		} catch (e) { return { ok: false, err: e.message }; }
	});

	ipcMain.handle("debug:viewState", async () => {
		const view = browserView();
		if (!view) return { err: "no view" };
		const wc = view.webContents;
		let shot = null;
		try {
			const img = await wc.capturePage();
			shot = { empty: img.isEmpty(), size: img.getSize() };
		} catch (e) { shot = { err: e.message }; }
		const w = getWin();
		return {
			bounds: view.getBounds(),
			url: wc.getURL(),
			loading: wc.isLoading(),
			crashed: wc.isCrashed(),
			visible: wc.isPainting ? undefined : undefined,
			browserVisible: browserMgr.isVisible(),
			lastBounds: browserMgr.getLastBounds(),
			shot,
			childCount: w ? w.contentView.children.length : -1,
		};
	});

	// ===== Cookie 导入 =====
	// ==== 从 Chrome 导入登录态（Google Cookie）====
	ipcMain.handle("import:cookies", (_e, opts) => doImport(opts || {}));

	// ===== 真实 Chrome（独立 profile）====
	// 这些是「浏览器来源 = Chrome」模式的后端。与右栏内置 view 完全并行，
	// 互不影响：内置 view 登普通站点没问题（实测 GitHub OK），保留不动。
	ipcMain.handle("chrome:launch", (_e, url) => chromeBridge.launchChrome(url));
	ipcMain.handle("chrome:status", () => chromeBridge.chromeStatus());
	ipcMain.handle("chrome:go", (_e, url) => chromeBridge.chromeGo(url));
	ipcMain.handle("chrome:close", () => chromeBridge.closeChrome());
}

/* ---------------- 斜杠命令辅助函数 ---------------- */

/**
 * 解析 /export 的路径参数（与 CLI getPathCommandArgument 同语义）
 * 支持：裸路径（第一个空白前截断）/ 单双引号包裹（允许含空格）
 * @param {string} argsString 命令名之后的原始参数串
 * @returns {string|undefined}
 */
function parsePathArgument(argsString) {
	if (!argsString) return undefined;
	const s = String(argsString).trimStart();
	if (!s) return undefined;
	const firstChar = s[0];
	if (firstChar === '"' || firstChar === "'") {
		const closing = s.indexOf(firstChar, 1);
		if (closing < 0) return undefined;
		return s.slice(1, closing);
	}
	const ws = s.search(/\s/);
	return ws < 0 ? s : s.slice(0, ws);
}

/**
 * 把 SessionManager.getTree() 的嵌套节点序列化成可跨 IPC 传输的纯文本树。
 * SessionTreeNode = { entry, children, label }，entry 上挂着原始消息对象，
 * 直接 IPC 会带上巨量无用字段（甚至不可序列化的引用），这里只抽取展示所需：
 *   每个节点一行 ASCII：缩进 + 类型图标 + 摘要文本 + 当前分支标记
 * @param {object|object[]} node  getTree() 返回的根节点数组（也可能为 null）
 * @param {string|null} leafId 当前 leaf（用于标 ← 当前位置）
 * @returns {{lines: string[], total: number}}
 */
function serializeSessionTree(node, leafId) {
	const lines = [];
	let total = 0;

	function summarize(entry) {
		switch (entry.type) {
			case "message": {
				const m = entry.message || {};
				const role = m.role || "?";
				let text = "";
				if (typeof m.content === "string") text = m.content;
				else if (Array.isArray(m.content)) {
					text = m.content
						.filter((b) => b && b.type === "text")
						.map((b) => b.text || "")
						.join(" ");
				}
				text = text.replace(/\s+/g, " ").trim();
				if (text.length > 50) text = text.slice(0, 50) + "…";
				const icon = role === "user" ? "👤" : role === "assistant" ? "🤖" : "🔧";
				return icon + " " + role + (text ? ": " + text : "");
			}
			case "compaction": return "⚡ 压缩";
			case "branch_summary": return "🌿 分支摘要";
			case "model_change": return "🧠 模型 → " + (entry.modelId || "?");
			case "thinking_level_change": return "💭 思考 → " + (entry.thinkingLevel || "?");
			case "session_info": return entry.name ? "🏷 命名: " + entry.name : "🏷 会话信息";
			case "label": return "🔖 " + (entry.label || "标签");
			default: return "• " + entry.type;
		}
	}

	function walk(n, depth, isLast, prefix) {
		if (!n || !n.entry) return;
		total++;
		const connector = depth === 0 ? "" : (isLast ? "└── " : "├── ");
		const cur = n.entry.id === leafId ? "  ← 当前" : "";
		const label = n.label ? ` [${n.label}]` : "";
		lines.push(prefix + connector + summarize(n.entry) + label + cur);
		const kids = n.children || [];
		const childPrefix = depth === 0 ? "" : prefix + (isLast ? "    " : "│   ");
		kids.forEach((k, i) => walk(k, depth + 1, i === kids.length - 1, childPrefix));
	}

	const roots = Array.isArray(node) ? node : (node ? [node] : []);
	roots.forEach((r) => walk(r, 0, true, ""));
	return { lines, total };
}

/* ---------------- 会话导出辅助函数 ---------------- */

/**
 * 将会话消息导出为 Markdown 格式
 * 用途：生成纯文本的会话记录，适合阅读、分享、归档、版本控制
 * @param {Array} messages - pi 会话的消息数组
 * @param {string} sessionId - 会话 ID（用于元信息）
 * @returns {string} Markdown 格式的文本
 */
function exportToMarkdown(messages, sessionId) {
	const lines = [];
	
	// 文档头部：标题 + 元信息
	lines.push('# 会话导出');
	lines.push('');
	lines.push(`- 导出时间: ${new Date().toLocaleString()}`);
	lines.push(`- 会话 ID: ${sessionId || 'unknown'}`);
	lines.push(`- 消息数量: ${messages.length}`);
	lines.push('');
	lines.push('---');
	lines.push('');

	// 逐条处理消息
	messages.forEach((msg, i) => {
		const msgNum = i + 1;
		
		if (msg.role === 'user') {
			lines.push(`## 用户 (${msgNum})`);
			lines.push('');
			// 用户消息可能是纯文本或 content blocks
			const text = extractTextContent(msg);
			lines.push(text);
			lines.push('');
			
		} else if (msg.role === 'assistant') {
			lines.push(`## 助手 (${msgNum})`);
			lines.push('');
			
			// 助手消息可能包含 text 和 tool_use blocks
			if (typeof msg.content === 'string') {
				lines.push(msg.content);
			} else if (Array.isArray(msg.content)) {
				msg.content.forEach(block => {
					if (block.type === 'text') {
						lines.push(block.text);
					} else if (block.type === 'tool_use') {
						lines.push(`> [工具调用: ${block.name}]`);
						if (block.input) {
							lines.push('> ```json');
							lines.push('> ' + JSON.stringify(block.input, null, 2).replace(/\n/g, '\n> '));
							lines.push('> ```');
						}
						lines.push('');
					} else if (block.type === 'thinking') {
						// 思考过程默认折叠，用 details 标签
						lines.push('<details>');
						lines.push('<summary>思考过程</summary>');
						lines.push('');
						lines.push(block.thinking || '');
						lines.push('');
						lines.push('</details>');
						lines.push('');
					}
				});
			}
			lines.push('');
			
		} else if (msg.role === 'tool') {
			// 工具返回结果
			lines.push(`### 工具结果 (${msgNum})`);
			lines.push('');
			const text = extractTextContent(msg);
			// 工具结果通常是代码输出，用代码块包裹
			if (text.includes('\n') || text.length > 80) {
				lines.push('```');
				lines.push(text);
				lines.push('```');
			} else {
				lines.push(text);
			}
			lines.push('');
		}
		
		// 消息之间的分隔线
		if (i < messages.length - 1) {
			lines.push('---');
			lines.push('');
		}
	});

	return lines.join('\n');
}

/**
 * 从消息对象中提取纯文本内容
 * 处理 string 和 content blocks 两种格式
 */
function extractTextContent(msg) {
	if (typeof msg.content === 'string') {
		return msg.content;
	}
	if (Array.isArray(msg.content)) {
		return msg.content
			.filter(block => block.type === 'text')
			.map(block => block.text)
			.join('\n');
	}
	return '[无法解析的消息内容]';
}

module.exports = { registerIpcHandlers };
