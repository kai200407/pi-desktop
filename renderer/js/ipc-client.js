/* =========================================================================
   ipc-client.js —— IPC 客户端封装模块

   职责：
   - 封装所有 window.piAPI.xxx 调用（与主进程通信的唯一入口）
   - 统一事件监听注册（pi:event 事件流）
   - 统一错误处理与超时处理
   - 兜底逻辑：主进程未注入时返回 Promise.resolve(null)，保证 UI 不崩

   使用方式：
     var ipc = new IpcClient();
     await ipc.send('hello');
     ipc.bindEvents({ onChunk: fn, onTool: fn, ... });
   ========================================================================= */
(function () {
  'use strict';

  // 默认超时时间（毫秒）
  var DEFAULT_TIMEOUT = 30000;

  // 预加载桥对象（由 preload.js 注入）
  var api = window.piAPI || {};

  /* -----------------------------------------------------------------------
     内部：统一调用入口（带错误处理与超时）
     ----------------------------------------------------------------------- */
  function invoke(name, args, timeout) {
    timeout = timeout || DEFAULT_TIMEOUT;

    return new Promise(function (resolve, reject) {
      // 主进程未注入时的兜底
      if (typeof api[name] !== 'function') {
        console.warn('[IpcClient] API not available:', name);
        resolve(null);
        return;
      }

      var timer = null;
      var settled = false;

      // 超时处理
      if (timeout > 0) {
        timer = setTimeout(function () {
          if (!settled) {
            settled = true;
            console.warn('[IpcClient] Timeout:', name, 'after', timeout, 'ms');
            resolve(null);  // 超时不视为错误，返回 null 让调用方继续
          }
        }, timeout);
      }

      function done(result) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      }

      function fail(err) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        console.error('[IpcClient] Error:', name, err);
        resolve(null);  // 错误不抛出，返回 null 保持调用链简洁
      }

      try {
        var result = api[name].apply(api, args);
        // 处理同步返回值（非 Promise）
        if (result && typeof result.then === 'function') {
          result.then(done).catch(fail);
        } else {
          done(result);
        }
      } catch (err) {
        fail(err);
      }
    });
  }

  /* -----------------------------------------------------------------------
     内部：快速调用（无超时，用于实时性要求高的操作如 bounds 上报）
     ----------------------------------------------------------------------- */
  function invokeFast(name, args) {
    return invoke(name, args, 0);  // timeout=0 表示不启用超时
  }

  /* =======================================================================
     IpcClient 类
     ======================================================================= */
  function IpcClient() {
    // 事件回调注册表
    this._eventCallbacks = {};
    this._eventUnsubscribers = [];
    this._bound = false;
  }

  /* =======================================================================
     一、对话操作
     ======================================================================= */

  /**
   * 发送消息给 pi
   * @param {string} text - 消息内容
   * @returns {Promise<null>}
   */
  IpcClient.prototype.send = function (text) {
    return invoke('send', [text]);
  };

  /**
   * 中止当前对话
   * @returns {Promise<null>}
   */
  IpcClient.prototype.abort = function () {
    return invoke('abort', []);
  };

  /**
   * 压缩上下文
   * @returns {Promise<null>}
   */
  IpcClient.prototype.compact = function () {
    return invoke('compact', []);
  };

  /**
   * 获取会话统计（Token 用量 / 缓存命中 / 成本 / 上下文占用）
   * 中栏底部状态栏用。会话未就绪时主进程返回 null。
   * @returns {Promise<null|{tokens:{input:number,output:number,cacheRead:number,cacheWrite:number,total:number},
   *                          cost:number,
   *                          contextUsage:{tokens:number,contextWindow:number,percent:number}}>}
   */
  IpcClient.prototype.getSessionStats = function () {
    return invoke('getSessionStats', []);
  };

  /**
   * 执行斜杠命令（/compact /tree /session /export /copy /share /clear）
   * 主进程按命令分发到 pi SDK 的真实 API，结果结构化返回：
   *   { ok, kind: 'compact'|'clear'|'copy'|'export'|'share'|'session'|'tree', ... }
   * 失败：{ ok:false, error } 或用户取消 { ok:false, cancelled:true }
   * 注意超时：/share 要导出 HTML + 走 gh gist 网络请求，30s 默认超时可能不够，
   * 这里放宽到 120s。
   * @param {string} command - 完整命令文本（含 / 前缀与参数）
   * @returns {Promise<object|null>}
   */
  IpcClient.prototype.executeCommand = function (command) {
    return invoke('executeCommand', [command], 120000);
  };

  /* =======================================================================
     二、会话管理
     ======================================================================= */

  /**
   * 新建会话
   * @returns {Promise<null>}
   */
  IpcClient.prototype.newSession = function () {
    return invoke('newSession', []);
  };

  /**
   * 新建临时会话（不落盘）
   * @returns {Promise<null>}
   */
  IpcClient.prototype.newEphemeral = function () {
    return invoke('newEphemeral', []);
  };

  /**
   * 切换到指定会话
   * @param {string} id - 会话 ID（文件路径）
   * @returns {Promise<null>}
   */
  IpcClient.prototype.switchSession = function (id) {
    return invoke('switchSession', [id]);
  };

  /**
   * 删除会话
   * @param {string} file - 会话文件路径
   * @returns {Promise<{ok: boolean, err?: string}>}
   */
  IpcClient.prototype.deleteSession = function (file) {
    return invoke('deleteSession', [file]);
  };

  /**
   * 获取会话的分支列表
   * @param {string} file - 会话文件路径
   * @returns {Promise<Array<{fromId: string, summary: string, timestamp: string}>>}
   */
  IpcClient.prototype.listBranches = function (file) {
    return invoke('listBranches', [file]);
  };

  /**
   * 切换到指定分支
   * @param {{file: string, branchFromId: string}} payload
   * @returns {Promise<{ok: boolean, err?: string}>}
   */
  IpcClient.prototype.switchToBranch = function (payload) {
    return invoke('switchToBranch', [payload]);
  };

  /**
   * 获取所有会话（平铺列表）
   * @returns {Promise<Array>}
   */
  IpcClient.prototype.listSessions = function () {
    return invoke('listSessions', []);
  };

  /**
   * 获取按项目分组的会话列表
   * @returns {Promise<Array<{project: string, path: string, sessions: Array, current: boolean}>>}
   */
  IpcClient.prototype.listSessionsGrouped = function () {
    return invoke('listSessionsGrouped', []);
  };

  /* =======================================================================
     三、模型与思考等级
     ======================================================================= */

  /**
   * 获取可用模型列表
   * @returns {Promise<Array<{id: string, name: string, provider: string, reasoning: boolean}>>}
   */
  IpcClient.prototype.getModels = function () {
    return invoke('getModels', []);
  };

  /**
   * 设置当前模型
   * @param {string} id - 模型 ID
   * @returns {Promise<null>}
   */
  IpcClient.prototype.setModel = function (id) {
    return invoke('setModel', [id]);
  };

  /**
   * 获取可用思考等级列表
   * @returns {Promise<Array<string>>}
   */
  IpcClient.prototype.getThinkingLevels = function () {
    return invoke('getThinkingLevels', []);
  };

  /**
   * 设置思考等级
   * @param {string} level - 思考等级（off/minimal/low/medium/high/xhigh）
   * @returns {Promise<null>}
   */
  IpcClient.prototype.setThinking = function (level) {
    return invoke('setThinking', [level]);
  };

  /* =======================================================================
     四、工作区管理
     ======================================================================= */

  /**
   * 获取当前工作区路径
   * @returns {Promise<string>}
   */
  IpcClient.prototype.getCwd = function () {
    return invoke('getCwd', []);
  };

  /**
   * 弹出目录选择器选择工作区
   * @returns {Promise<string|null>}
   */
  IpcClient.prototype.pickCwd = function () {
    return invoke('pickCwd', []);
  };

  /**
   * 获取最近使用的工作区列表
   * @returns {Promise<Array<{name: string, path: string, current: boolean}>>}
   */
  IpcClient.prototype.getRecentCwds = function () {
    return invoke('getRecentCwds', []);
  };

  /**
   * 设置工作区
   * @param {string} dir - 目录路径
   * @returns {Promise<string>} 设置后的完整路径
   */
  IpcClient.prototype.setCwd = function (dir) {
    return invoke('setCwd', [dir]);
  };

  /* =======================================================================
     五、右栏浏览器控制
     ======================================================================= */

  /**
   * 导航到指定 URL
   * @param {string} url
   * @returns {Promise<null>}
   */
  IpcClient.prototype.browserGo = function (url) {
    return invoke('browserGo', [url]);
  };

  /**
   * 后退
   * @returns {Promise<null>}
   */
  IpcClient.prototype.browserBack = function () {
    return invoke('browserBack', []);
  };

  /**
   * 前进
   * @returns {Promise<null>}
   */
  IpcClient.prototype.browserForward = function () {
    return invoke('browserForward', []);
  };

  /**
   * 刷新
   * @returns {Promise<null>}
   */
  IpcClient.prototype.browserReload = function () {
    return invoke('browserReload', []);
  };

  /**
   * 回到主页
   * @returns {Promise<null>}
   */
  IpcClient.prototype.browserHome = function () {
    return invoke('browserHome', []);
  };

  /**
   * 打开开发者工具
   * @returns {Promise<null>}
   */
  IpcClient.prototype.browserDevtools = function () {
    return invoke('browserDevtools', []);
  };

  /**
   * 切换浏览器面板可见性
   * @param {boolean} visible
   * @returns {Promise<null>}
   */
  IpcClient.prototype.browserToggle = function (visible) {
    return invoke('browserToggle', [visible]);
  };

  /**
   * 上报 #browser-slot 位置（用于主进程定位原生 view）
   * 【注意】此调用使用 send 而非 invoke，无返回值
   * @param {{x: number, y: number, width: number, height: number}} rect
   */
  IpcClient.prototype.browserBounds = function (rect) {
    // 特殊处理：browserBounds 使用 send 而非 invoke（fire-and-forget）
    if (typeof api.browserBounds === 'function') {
      try {
        api.browserBounds(rect);
      } catch (err) {
        console.warn('[IpcClient] browserBounds error:', err);
      }
    }
    return Promise.resolve();
  };

  /* ------- 标签页管理 ------- */

  /**
   * 新建标签页
   * @param {string} [url] - 可选初始 URL
   * @returns {Promise<null>}
   */
  IpcClient.prototype.browserTabNew = function (url) {
    return invoke('browserTabNew', [url]);
  };

  /**
   * 关闭标签页
   * @param {string} id - 标签页 ID
   * @returns {Promise<null>}
   */
  IpcClient.prototype.browserTabClose = function (id) {
    return invoke('browserTabClose', [id]);
  };

  /**
   * 激活标签页
   * @param {string} id - 标签页 ID
   * @returns {Promise<null>}
   */
  IpcClient.prototype.browserTabActivate = function (id) {
    return invoke('browserTabActivate', [id]);
  };

  /**
   * 获取标签页列表
   * @returns {Promise<{activeId: string, tabs: Array<{id: string, url: string, title: string}>}>}
   */
  IpcClient.prototype.browserTabList = function () {
    return invoke('browserTabList', []);
  };

  /**
   * 在外部浏览器打开 URL
   * @param {string} url
   * @returns {Promise<null>}
   */
  IpcClient.prototype.browserOpenExternal = function (url) {
    return invoke('browserOpenExternal', [url]);
  };

  /**
   * 获取下载目录最近文件列表
   * @returns {Promise<{items: Array<{name: string, path: string, size: number}>}>}
   */
  IpcClient.prototype.browserListDownloads = function () {
    return invoke('browserListDownloads', []);
  };

  /**
   * 在 Finder 中定位文件
   * @param {string} path - 文件路径
   * @returns {Promise<null>}
   */
  IpcClient.prototype.browserShowInFolder = function (path) {
    return invoke('browserShowInFolder', [path]);
  };

  /* ------- 调试接口（开发用）------- */

  IpcClient.prototype.debugTypeInView = function (a) {
    return invoke('debugTypeInView', [a]);
  };

  IpcClient.prototype.debugViewState = function () {
    return invoke('debugViewState', []);
  };

  IpcClient.prototype.debugEvalInView = function (code) {
    return invoke('debugEvalInView', [code]);
  };

  IpcClient.prototype.debugListGoogleCookies = function () {
    return invoke('debugListGoogleCookies', []);
  };

  IpcClient.prototype.debugClickInView = function (p) {
    return invoke('debugClickInView', [p]);
  };

  IpcClient.prototype.browserCdpInfo = function () {
    return invoke('browserCdpInfo', []);
  };

  /* =======================================================================
     六、真实 Chrome 控制（独立 profile，用于登 Google）
     【注意】此模块当前已下线，保留接口以防未来需要
     ======================================================================= */

  IpcClient.prototype.chromeLaunch = function (url) {
    return invoke('chromeLaunch', [url]);
  };

  IpcClient.prototype.chromeStatus = function () {
    return invoke('chromeStatus', []);
  };

  IpcClient.prototype.chromeGo = function (url) {
    return invoke('chromeGo', [url]);
  };

  IpcClient.prototype.chromeClose = function () {
    return invoke('chromeClose', []);
  };

  /* =======================================================================
     七、Cookie 导入（从真实 Chrome 导入 Google 登录态）
     ======================================================================= */

  /**
   * 从真实 Chrome 导入 Cookie
   * @param {object} [opts] - 可选参数
   * @returns {Promise<{ok: boolean, imported?: number, skipped?: number, failed?: number,
   *                    sessionGoogleCookies?: number, needCloseChrome?: boolean,
   *                    error?: string, message?: string}>}
   */
  IpcClient.prototype.importCookies = function (opts) {
    return invoke('importCookies', [opts || {}]);
  };

  /* =======================================================================
     八、事件监听
     ======================================================================= */

  /**
   * 绑定事件回调
   * @param {object} callbacks - 事件回调映射表
   *   支持的事件类型：
   *   - onAgentStart: agent_start
   *   - onMessageStart: message_start
   *   - onThinkingStart: thinking_start
   *   - onThinkingDelta: thinking_delta (evt.delta)
   *   - onThinkingEnd: thinking_end
   *   - onTextDelta: text_delta (evt.delta)
   *   - onToolStart: tool_start (evt.id, evt.name, evt.args)
   *   - onToolEnd: tool_end (evt.id, evt.ok, evt.output, evt.ms)
   *   - onMessageEnd: message_end
   *   - onAgentEnd: agent_end
   *   - onError: error (evt.message)
   *   - onNotice: notice (evt.text)
   *   - onCompaction: compaction (evt.text, evt.reason, evt.aborted)
   *   - onMenuAction: menu-action (evt.action)
   *   - onSessionCleared: session_cleared
   *   - onSessionRestored: session_restored (evt.messages)
   *   - onSessionInfo: session_info (evt.name, evt.cwd, evt.model, evt.thinkingLevel, evt.sessionId)
   *   - onBrowserUrl: browser_url (evt.url, evt.canBack, evt.canForward, evt.loading, evt.title)
   *   - onBrowserTabs: browser_tabs (evt.activeId, evt.tabs)
   * @returns {function} 解绑函数
   */
  IpcClient.prototype.bindEvents = function (callbacks) {
    var self = this;
    this._eventCallbacks = callbacks || {};

    // 如果已经绑定过，先解绑
    if (this._bound) {
      this.unbindEvents();
    }

    if (typeof api.onEvent !== 'function') {
      console.warn('[IpcClient] onEvent API not available');
      return function () {};
    }

    var handler = function (evt) {
      self._dispatchEvent(evt);
    };

    var unsubscribe = api.onEvent(handler);
    this._eventUnsubscribers.push(unsubscribe);
    this._bound = true;

    return function () {
      self.unbindEvents();
    };
  };

  /**
   * 解绑所有事件监听
   */
  IpcClient.prototype.unbindEvents = function () {
    this._eventUnsubscribers.forEach(function (unsub) {
      if (typeof unsub === 'function') {
        try { unsub(); } catch (e) {}
      }
    });
    this._eventUnsubscribers = [];
    this._eventCallbacks = {};
    this._bound = false;
  };

  /**
   * 事件分发（内部）
   * @private
   */
  IpcClient.prototype._dispatchEvent = function (evt) {
    if (!evt || !evt.type) return;

    var cb = this._eventCallbacks;
    var type = evt.type;

    // 映射事件类型到回调名
    var callbackMap = {
      'agent_start': 'onAgentStart',
      'message_start': 'onMessageStart',
      'thinking_start': 'onThinkingStart',
      'thinking_delta': 'onThinkingDelta',
      'thinking_end': 'onThinkingEnd',
      'text_delta': 'onTextDelta',
      'tool_start': 'onToolStart',
      'tool_end': 'onToolEnd',
      'message_end': 'onMessageEnd',
      'agent_end': 'onAgentEnd',
      'error': 'onError',
      'notice': 'onNotice',
      'compaction': 'onCompaction',
      'menu-action': 'onMenuAction',
      'session_cleared': 'onSessionCleared',
      'session_restored': 'onSessionRestored',
      'session_info': 'onSessionInfo',
      'browser_url': 'onBrowserUrl',
      'browser_tabs': 'onBrowserTabs'
    };

    var callbackName = callbackMap[type];
    if (callbackName && typeof cb[callbackName] === 'function') {
      try {
        cb[callbackName](evt);
      } catch (err) {
        console.error('[IpcClient] Event callback error:', callbackName, err);
      }
    }

    // 通用回调（所有事件都会触发）
    if (typeof cb.onAny === 'function') {
      try {
        cb.onAny(evt);
      } catch (err) {
        console.error('[IpcClient] onAny callback error:', err);
      }
    }
  };

  /**
   * 便捷方法：绑定单个事件
   * @param {string} eventType - 事件类型（如 'agent_start'）
   * @param {function} callback - 回调函数
   * @returns {function} 解绑函数
   */
  IpcClient.prototype.on = function (eventType, callback) {
    var self = this;

    // 如果还未绑定，先建立一个基础绑定
    if (!this._bound) {
      this.bindEvents({});
    }

    var callbackMap = {
      'agent_start': 'onAgentStart',
      'message_start': 'onMessageStart',
      'thinking_start': 'onThinkingStart',
      'thinking_delta': 'onThinkingDelta',
      'thinking_end': 'onThinkingEnd',
      'text_delta': 'onTextDelta',
      'tool_start': 'onToolStart',
      'tool_end': 'onToolEnd',
      'message_end': 'onMessageEnd',
      'agent_end': 'onAgentEnd',
      'error': 'onError',
      'notice': 'onNotice',
      'compaction': 'onCompaction',
      'menu-action': 'onMenuAction',
      'session_cleared': 'onSessionCleared',
      'session_restored': 'onSessionRestored',
      'session_info': 'onSessionInfo',
      'browser_url': 'onBrowserUrl',
      'browser_tabs': 'onBrowserTabs'
    };

    var callbackName = callbackMap[eventType];
    if (!callbackName) {
      console.warn('[IpcClient] Unknown event type:', eventType);
      return function () {};
    }

    // 保存原始回调（如果有）
    var originalCallback = this._eventCallbacks[callbackName];

    // 设置新回调（链式调用）
    this._eventCallbacks[callbackName] = function (evt) {
      if (typeof originalCallback === 'function') {
        try { originalCallback(evt); } catch (e) { console.error(e); }
      }
      try { callback(evt); } catch (e) { console.error(e); }
    };

    return function () {
      self._eventCallbacks[callbackName] = originalCallback;
    };
  };

  /* =======================================================================
     九、工具方法
     ======================================================================= */

  /**
   * 通用调用入口：按名字分发到本类的命名方法。
   *
   * 【背景】browser-ui.js 等模块以字符串形式调用：ipc.call('browserToggle', true)。
   * 历史上 IpcClient 只有命名方法（browserToggle()）没有 call()，导致跨模块
   * 全部 IPC 调用抛 'this.ipc.call is not a function' —— 右栏显隐/bounds 永远
   * 到不了主进程，表现为「按钮点了 view 不显示」。本方法是兼容层，必须保留。
   *
   * @param {string} name - 方法名（必须是本类原型上存在的方法，如 'browserGo'）
   * @param {...*} args - 透传参数
   * @returns {Promise<*>}
   */
  IpcClient.prototype.call = function (name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var fn = (typeof name === 'string') ? this[name] : null;
    if (typeof fn === 'function') {
      try { return Promise.resolve(fn.apply(this, args)); }
      catch (err) { console.error('[IpcClient] call 调用失败:', name, err); return Promise.resolve(null); }
    }
    console.warn('[IpcClient] call: 未知方法', name);
    return Promise.resolve(null);
  };

  /**
   * 检查 API 是否可用（主进程是否已注入桥对象）
   * @returns {boolean}
   */
  IpcClient.prototype.isAvailable = function () {
    return typeof api.send === 'function';
  };

  /**
   * 设置默认超时时间
   * @param {number} ms - 毫秒
   */
  IpcClient.prototype.setDefaultTimeout = function (ms) {
    DEFAULT_TIMEOUT = ms;
  };

  /**
   * 带超时的调用（覆盖默认超时）
   * @param {string} method - 方法名
   * @param {Array} args - 参数数组
   * @param {number} timeout - 超时毫秒数（0 表示不超时）
   * @returns {Promise}
   */
  IpcClient.prototype.callWithTimeout = function (method, args, timeout) {
    return invoke(method, args, timeout);
  };

  /* =======================================================================
     导出：挂载到 window 对象（零构建，全局可用）
     ======================================================================= */
  window.IpcClient = IpcClient;

  // 同时提供一个默认实例，方便直接使用
  window.ipc = new IpcClient();

})();
