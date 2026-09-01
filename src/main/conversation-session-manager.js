// src/main/conversation-session-manager.js —— Conversation Session 管理器
//
// 职责：
//   - 为每个 conversation 创建独立的 Electron Session（cookies、localStorage、cache 隔离）
//   - 管理 session 生命周期（创建、缓存、清理）
//   - LRU 策略控制内存占用
//
// 设计说明：
//   · 每个 conversation（通常是 cwd 路径）对应一个独立的 session partition
//   · 使用 persist: 前缀持久化到磁盘，重启应用后登录态保留
//   · LRU 缓存最多 5 个 session，超过时淘汰最久未使用的（当前激活的除外）
//   · 切换 conversation 时自动切换浏览器 session，实现登录态隔离

const { session, app } = require('electron');

class ConversationSessionManager {
	/**
	 * @param {object} opts
	 * @param {number} opts.maxCached 最大缓存数量（LRU），默认 5
	 */
	constructor(opts = {}) {
		/**
		 * Session 缓存
		 * Map<conversationId, { session, lastUsed, conversationId, createdAt }>
		 */
		this.sessions = new Map();

		/**
		 * 最大缓存数量（LRU）
		 */
		this.maxCached = opts.maxCached || 5;

		/**
		 * 当前激活的 conversation ID
		 */
		this.activeConversationId = null;

		console.log('[ConvSessionMgr] 初始化, 最大缓存:', this.maxCached);
	}

	/**
	 * 获取或创建 conversation 的 session
	 * @param {string} conversationId - conversation ID（通常是 cwd 路径）
	 * @returns {Electron.Session}
	 */
	getOrCreateSession(conversationId) {
		if (!conversationId || typeof conversationId !== 'string') {
			console.warn('[ConvSessionMgr] 无效的 conversationId:', conversationId);
			// 降级：返回默认 session
			return session.fromPartition('persist:pi-browser-default');
		}

		// 检查缓存
		if (this.sessions.has(conversationId)) {
			const cached = this.sessions.get(conversationId);
			cached.lastUsed = Date.now();
			console.log('[ConvSessionMgr] 命中缓存:', conversationId);
			return cached.session;
		}

		// 创建新 session
		console.log('[ConvSessionMgr] 创建新 session:', conversationId);
		const partition = this._getPartition(conversationId);
		const sess = session.fromPartition(partition);

		// 配置 session
		this._configureSession(sess, conversationId);

		// 缓存
		this.sessions.set(conversationId, {
			session: sess,
			conversationId,
			lastUsed: Date.now(),
			createdAt: Date.now()
		});

		// LRU 淘汰
		this._evictOldSessions();

		return sess;
	}

	/**
	 * 生成 session partition 名称
	 * @private
	 * @param {string} conversationId
	 * @returns {string} partition 名称
	 */
	_getPartition(conversationId) {
		// 使用 persist: 前缀持久化到磁盘
		// 编码 conversationId 避免路径问题（base64 编码并替换特殊字符）
		const encoded = Buffer.from(conversationId).toString('base64')
			.replace(/\//g, '_')
			.replace(/\+/g, '-')
			.replace(/=/g, '');

		return `persist:conv-${encoded}`;
	}

	/**
	 * 配置 session
	 * @private
	 * @param {Electron.Session} sess
	 * @param {string} conversationId
	 */
	_configureSession(sess, conversationId) {
		console.log('[ConvSessionMgr] 配置 session:', conversationId);

		// 设置下载路径
		try {
			sess.setDownloadPath(app.getPath('downloads'));
		} catch (err) {
			console.error('[ConvSessionMgr] 设置下载路径失败:', err);
		}

		// 注意：will-download 钩子由 BrowserManager._hookSessionDownloads 统一挂载
		// 这里不重复挂载，避免重复处理下载事件

		// 其他配置可以在这里添加（权限、UA 等）
		// 注意：UA 和请求头伪装已在 browser.js 的 attachStealth 中统一处理
	}

	/**
	 * LRU 淘汰策略
	 * @private
	 */
	_evictOldSessions() {
		if (this.sessions.size <= this.maxCached) {
			return;
		}

		console.log('[ConvSessionMgr] 触发 LRU 淘汰, 当前数量:', this.sessions.size);

		// 按最后使用时间排序
		const sorted = Array.from(this.sessions.entries())
			.sort((a, b) => a[1].lastUsed - b[1].lastUsed);

		// 淘汰最旧的（排除当前激活的）
		const toRemove = sorted
			.filter(([id]) => id !== this.activeConversationId)
			.slice(0, this.sessions.size - this.maxCached);

		toRemove.forEach(([id, data]) => {
			console.log('[ConvSessionMgr] 淘汰 session:', id, 'age:', Date.now() - data.lastUsed, 'ms');

			// 清理缓存（异步，不阻塞）
			data.session.clearCache().catch(err => {
				console.error('[ConvSessionMgr] 清理缓存失败:', err);
			});

			this.sessions.delete(id);
		});
	}

	/**
	 * 切换激活的 conversation
	 * @param {string} conversationId
	 * @returns {Electron.Session}
	 */
	switchConversation(conversationId) {
		console.log('[ConvSessionMgr] 切换 conversation:', this.activeConversationId, '→', conversationId);

		this.activeConversationId = conversationId;
		return this.getOrCreateSession(conversationId);
	}

	/**
	 * 清理指定 conversation 的 session
	 * @param {string} conversationId
	 */
	clearSession(conversationId) {
		console.log('[ConvSessionMgr] 清理 session:', conversationId);

		const data = this.sessions.get(conversationId);
		if (data) {
			// 异步清理，不阻塞
			data.session.clearCache().catch(err => {
				console.error('[ConvSessionMgr] 清理缓存失败:', err);
			});
			data.session.clearStorageData().catch(err => {
				console.error('[ConvSessionMgr] 清理存储数据失败:', err);
			});
			this.sessions.delete(conversationId);
		}
	}

	/**
	 * 获取当前激活的 session
	 * @returns {Electron.Session | null}
	 */
	getCurrentSession() {
		if (!this.activeConversationId) {
			return null;
		}
		return this.getOrCreateSession(this.activeConversationId);
	}

	/**
	 * 清理所有 session（退出时调用）
	 */
	cleanup() {
		console.log('[ConvSessionMgr] 清理所有 session, 数量:', this.sessions.size);
		// 注意：不清空缓存数据（persist: 前缀的 session 数据需要保留到磁盘）
		// 只清空内存中的 Map
		this.sessions.clear();
		this.activeConversationId = null;
	}
}

module.exports = { ConversationSessionManager };
