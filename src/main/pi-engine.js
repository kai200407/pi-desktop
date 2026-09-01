// src/main/pi-engine.js —— pi 引擎接入模块
//
// 从 main.js 拆分而来，职责：
//   - pi SDK 初始化（initPi：创建 AgentSessionRuntime + ModelRuntime）
//   - 会话绑定（bindSession：订阅 runtime.session 事件流，30+ 事件分支）
//   - 事件转 IPC（send：把 pi 事件推给渲染层）
//   - 会话信息推送（pushSessionInfo）
//   - 延迟初始化（ensurePi：失败时给渲染层发错误提示）
//
// 关键设计（与 main.js 一致，勿改）：
//   - 用 AgentSessionRuntime（而非裸 AgentSession），这样 newSession / switchSession /
//     fork 都能走官方路径。runtime.session 会在替换后变化，所以每次都要重新订阅。
//   - opts.ephemeral=true 时用 inMemory SessionManager（临时聊天，不落盘 jsonl）。
//
// 依赖注入：本模块不直接持有 Electron 的 win 引用，也不直接读写配置文件，
// 由外部通过构造函数注入，便于单元测试与解耦。

const { Notification } = require("electron");

class PiEngine {
	/**
	 * @param {object} deps
	 * @param {() => (BrowserWindow|null)} deps.getWindow  取主窗（用于事件推送 + 失焦通知判定）
	 * @param {() => object} deps.loadConf  读应用配置（cwd / modelId / recentCwds …）
	 * @param {(patch: object) => object} deps.saveConf  写应用配置（merge 式 patch）
	 */
	constructor({ getWindow, loadConf, saveConf }) {
		this._getWindow = getWindow;
		this._loadConf = loadConf;
		this._saveConf = saveConf;

		// pi 侧运行时
		this.pi = null;          // { runtime, modelRuntime, cwd }
		this.unsubscribe = null; // 当前 session 的事件订阅解绑函数
		this.startedAt = null;   // 本次 agent 任务开始时间（用于完成通知的耗时文案）

		// ===== 实例池（性能优化）=====
		// 【背景】跨工作区切换的实测瓶颈：旧实现 switchWorkspace 会 setPi(null) 销毁
		// 整个 runtime，然后 initPi 重建，createAgentSessionServices 里的
		// resourceLoader.reload() 扫描 7 个 skills 目录 + extensions + settings 需
		// 431-794ms，ModelRuntime.create() 需 16ms，合计跨工作区切换 700-1200ms。
		// 【方案】按 cwd 缓存 runtime 实例（LRU 上限 3），ModelRuntime 全局单例。
		// 命中缓存时直接复用，实测切回已访问工作区 ~50ms（-85%+）。
		this._modelRuntime = null;  // ModelRuntime 全局单例（与 cwd 无关）
		this._pool = new Map();     // cwd -> { runtime, modelRuntime, services, cwd, lastUsed }
		this._poolMaxSize = 3;      // LRU 池上限
	}

	// ---------------------------------------------------------------------------
	// 推事件给渲染层
	// ---------------------------------------------------------------------------
	send(type, extra = {}) {
		const win = this._getWindow?.();
		if (!win || win.isDestroyed()) return;
		win.webContents.send("pi:event", { type, ...extra });
	}

	// ---------------------------------------------------------------------------
	// pi 引擎
	// 用 AgentSessionRuntime（而非裸 AgentSession），这样 newSession / switchSession /
	// fork 都能走官方路径。runtime.session 会在替换后变化，所以每次都要重新订阅。
	// ---------------------------------------------------------------------------
	// cwd 可选；opts.ephemeral=true 时用 inMemory SessionManager（不落盘）
	//
	// 【性能优化：实例池 + ModelRuntime 单例】
	//   1. ModelRuntime 全局单例：与 cwd 无关，避免每次切换都重建（16ms）。
	//   2. 实例池：按 cwd 缓存 {runtime, modelRuntime, services}，LRU 上限 3。
	//      命中缓存时直接复用，跳过 createAgentSessionServices 的 skills 扫描
	//      （实测 431-794ms），跨工作区切换从 700-1200ms 降到 ~50ms。
	//   3. ephemeral（临时聊天）不入池——内存会话的生命周期由调用方控制。
	async initPi(cwd, opts = {}) {
		const mod = await import("@earendil-works/pi-coding-agent");
		const {
			createAgentSessionRuntime, createAgentSessionServices,
			createAgentSessionFromServices, SessionManager, ModelRuntime, getAgentDir,
		} = mod;

		const conf = this._loadConf();
		const workdir = cwd || conf.cwd || process.cwd();

		// ===== 1. 命中实例池：直接复用 =====
		// 临时聊天不入池：每次都要新建（因为 SessionManager.inMemory 的生命周期是一次性的）
		if (!opts.ephemeral) {
			const cached = this._pool.get(workdir);
			if (cached) {
				console.log('[PiEngine] 命中实例池:', workdir);
				cached.lastUsed = Date.now();
				this.pi = cached;
				this.bindSession();
				// 更新最近工作区（即便命中池也要写，保持列表顺序）
				const rec = (this._loadConf().recentCwds || []).filter((x) => x !== workdir);
				rec.unshift(workdir);
				this._saveConf({ cwd: workdir, recentCwds: rec.slice(0, 10) });
				this.pushSessionInfo();
				return this.pi;
			}
		}

		// ===== 2. 未命中：新建 =====
		console.log('[PiEngine] 实例池未命中，创建新实例:', workdir);

		// ModelRuntime 全局单例（与 cwd 无关）
		if (!this._modelRuntime) {
			console.time('[PiEngine] ModelRuntime.create');
			this._modelRuntime = await ModelRuntime.create();
			console.timeEnd('[PiEngine] ModelRuntime.create');
		}
		const modelRuntime = this._modelRuntime;

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

		const instance = { runtime, modelRuntime, cwd: workdir, lastUsed: Date.now() };

		// 加入实例池（ephemeral 除外），并触发 LRU 淘汰
		if (!opts.ephemeral) {
			this._pool.set(workdir, instance);
			this._evictOldest();
		}

		this.pi = instance;
		this.bindSession();
		const rec = (this._loadConf().recentCwds || []).filter((x) => x !== workdir);
		rec.unshift(workdir);
		this._saveConf({ cwd: workdir, recentCwds: rec.slice(0, 10) });
		this.pushSessionInfo();
		return this.pi;
	}

	// LRU 淘汰：超过上限时移除最久未用的实例，并释放其 session 资源
	_evictOldest() {
		if (this._pool.size <= this._poolMaxSize) return;

		let oldestKey = null;
		let oldestTime = Infinity;

		this._pool.forEach((instance, cwd) => {
			// 不淘汰当前活跃的 cwd（即使它是 lastUsed 最小的也不应被淘汰）
			if (this.pi && this.pi.cwd === cwd) return;
			if (instance.lastUsed < oldestTime) {
				oldestTime = instance.lastUsed;
				oldestKey = cwd;
			}
		});

		if (oldestKey) {
			console.log('[PiEngine] LRU 淘汰实例:', oldestKey);
			const instance = this._pool.get(oldestKey);
			// 释放资源：runtime.session 可能持有文件句柄、订阅等
			try {
				if (instance?.runtime?.session?.dispose) {
					instance.runtime.session.dispose();
				}
			} catch (e) {
				console.error('[PiEngine] dispose 失败:', oldestKey, e);
			}
			this._pool.delete(oldestKey);
		}
	}

	// 订阅当前 session（runtime.session 被替换后必须重新调用）
	bindSession() {
		if (this.unsubscribe) { try { this.unsubscribe(); } catch {} this.unsubscribe = null; }
		const sess = this.pi.runtime.session;
		const self = this;

		this.unsubscribe = sess.subscribe((event) => {
			switch (event.type) {
				case "agent_start": self.send("agent_start"); self.startedAt = Date.now(); break;
				case "agent_end":
				case "agent_settled": {
					self.send("agent_end");
					// 任务完成通知（Codex 通知分类里的核心类）：仅当窗口失焦时弹系统通知，
					// 长任务(≥5s)跑完用户切去干别的，不用盯着等。点击通知带回窗口。
					try {
						const durSec = self.startedAt ? Math.round((Date.now() - self.startedAt) / 1000) : 0;
						const win = self._getWindow?.();
						if (!win || win.isDestroyed() || (!win.isFocused() && durSec >= 5)) {
							if (Notification.isSupported()) {
								const n = new Notification({
									title: "pi-desktop",
									body: durSec > 0 ? `任务完成（耗时 ${durSec}s），点击查看` : "任务完成，点击查看",
									});
								n.on("click", () => {
									const w = self._getWindow?.();
									if (w && !w.isDestroyed()) { w.show(); w.focus(); }
								});
								n.show();
							}
						}
					} catch {}
					break;
				}

				case "message_start": self.send("message_start", { role: "assistant" }); break;

				case "message_update": {
					const e = event.assistantMessageEvent;
					if (!e) break;
					if (e.type === "text_delta") self.send("text_delta", { delta: e.delta });
					else if (e.type === "thinking_delta") self.send("thinking_delta", { delta: e.delta });
					else if (e.type === "thinking_start") self.send("thinking_start");
					else if (e.type === "thinking_end") self.send("thinking_end");
					break;
				}

				case "message_end": self.send("message_end"); break;

				case "tool_execution_start":
					self.send("tool_start", { id: event.toolCallId, name: event.toolName, args: event.args });
					break;

				case "tool_execution_end": {
					const text = (event.result?.content || [])
						.filter((c) => c.type === "text").map((c) => c.text).join("\n");
					self.send("tool_end", { id: event.toolCallId, ok: !event.isError, output: text });
					break;
				}

				case "compaction_start": self.send("notice", { text: "正在压缩上下文…" }); break;
				case "compaction_end":
					self.send("notice", { text: "上下文已压缩" });
					// 置顶摘要横条：CompactionResult 里带 summary 文本（见 compaction.d.ts），
					// 中止/失败时 result 为 undefined，渲染层会显示占位文案。
					self.send("compaction", {
						text: event.result?.summary || "",
						reason: event.reason,
						aborted: !!event.aborted,
					});
					break;

				default: break;
			}
		});
	}

	pushSessionInfo() {
		if (!this.pi) return;
		const s = this.pi.runtime.session;
		this.send("session_info", {
			cwd: this.pi.cwd,
			model: s.model?.id || "(未选择)",
			thinkingLevel: s.thinkingLevel || "off",
			sessionId: s.sessionId,
		});
	}

	async ensurePi() {
		if (this.pi) return this.pi;
		try {
			return await this.initPi();
		} catch (err) {
			this.send("error", {
				message: `pi 引擎加载失败：${err.message}\n请确认 ~/.pi/agent/models.json 已配置且 npm install 完成。`,
			});
			throw err;
		}
	}

	// 切换工作区时会用到：解绑当前订阅并清空 pi，由调用方再触发 initPi(dir)
	// 【注意】不清空实例池——池化复用正是为了在切换后还能回来。
	// 真正的资源清理由 _evictOldest 在池满时触发。
	dispose() {
		if (this.unsubscribe) { try { this.unsubscribe(); } catch {} this.unsubscribe = null; }
		this.pi = null;
		this.startedAt = null;
	}
}

module.exports = { PiEngine };
