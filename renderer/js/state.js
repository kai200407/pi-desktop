/* =========================================================================
   pi-desktop 全局状态管理模块
   -------------------------------------------------------------------------
   从 renderer/app.js 抽取的所有顶层全局可变状态（let / var 声明），
   集中到一个 AppState 实例上：
     - 统一 getter / setter，方便后续替换实现（如换成 Proxy / Redux）
     - setter 内自动处理 localStorage 持久化（带 pi-* 前缀的键）
     - 内置极简事件系统 on / off / emit，供 UI 订阅状态变化

   使用方式（零构建，直接挂 window）：
     <script src="js/state.js"></script>
     window.AppState.model = 'glm-5.3-ioa';
     window.AppState.on('model-changed', function (id) { ... });

   注意：本文件只声明状态与读写逻辑，不操作 DOM；
   DOM 元素引用（el.sidebar / el.middle / el.browserSlot 等）不属于
   全局「状态」，仍由 app.js 的 el 表持有。
   ========================================================================= */
(function () {
  'use strict';

  /* -----------------------------------------------------------------------
     localStorage 键名常量（与 app.js 中现有键完全一致，避免迁移期数据丢失）
     ----------------------------------------------------------------------- */
  var LS_KEYS = {
    theme:          'pi-theme',
    colWidths:      'pi-col-widths',
    browserVisible: 'pi-browser-visible',
    sidebarHidden:  'pi-sidebar-hidden',
    favorites:      'pi-browser-favorites',
    compactBarOpen: 'pi-compact-bar-open',
    sessionNames:   'pi-session-names'
    // 注：model / thinkingLevel 当前由 session_info 事件驱动，不落盘；
    // 如未来需要记住上次选择，可在此加 'pi-model' / 'pi-thinking'。
  };

  function lsGet(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* 隐私模式等场景容错 */ }
  }
  function lsGetJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function lsSetJSON(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
  }

  /* -----------------------------------------------------------------------
     AppState 类
     ----------------------------------------------------------------------- */
  function AppState() {
    /* ===== 主题 / 布局 ===== */
    this._theme = lsGet(LS_KEYS.theme, 'dark');         // 'dark' | 'light'
    this._colWidths = lsGetJSON(LS_KEYS.colWidths, null) || {
      sidebar: 260,
      browser: 480
    };
    this._sidebarHidden = lsGet(LS_KEYS.sidebarHidden, '0') === '1';
    this._browserPaneVisible = lsGet(LS_KEYS.browserVisible, '1') !== '0';

    /* ===== 对话 / 模型 ===== */
    this._currentModelId = '';        // 由 session_info 事件同步
    this._thinkingLevel = 'off';      // off | minimal | low | medium | high | xhigh
    this._thinkingLevels = [];        // 当前模型支持的可选等级列表
    this._models = [];                // [{id, name, provider, reasoning}]

    /* ===== 会话列表 ===== */
    this._activeSessionId = null;     // 用户在列表里点中的会话
    this._currentSessionId = null;    // session_info 同步的当前会话 id
    this._expandedProjects = {};      // path -> true，已点「展开显示」
    this._sessionGroups = [];         // listSessionsGrouped 的分组缓存
    this._searchQuery = '';           // 会话搜索关键词（已 toLowerCase）
    this._currentCwd = '';            // 当前工作区路径

    /* ===== 流式对话状态 ===== */
    this._running = false;            // 是否正在生成
    this._stickToBottom = true;       // 用户手动上滚后不再强行拉回
    // 当前流式游标：{msg, text, think, tools:{id->{node,body,t0}}}
    this._streamCursor = { msg: null, text: null, think: null, tools: {} };

    /* ===== 浏览器（右栏内置 WebContentsView） ===== */
    this._browserTabs = { activeId: null, tabs: [] };  // 与主进程 browser_tabs 事件对齐
    this._pageBlank = false;          // 当前 URL 是否空页（browser_url 事件推导）
    this._blankOverride = false;      // 「+ 新建标签页」手动置的空页标记
    this._favorites = lsGetJSON(LS_KEYS.favorites, []); // [{url, title}]

    /* ===== 上下文压缩条 ===== */
    this._compactBarOpen = lsGet(LS_KEYS.compactBarOpen, '0') === '1';

    /* ===== 对话内查找 ===== */
    this._findBarVisible = false;
    this._findPos = -1;

    /* ===== Cookie 导入模态框 ===== */
    this._importModalOpen = false;
    this._importing = false;

    /* ===== 事件总线 ===== */
    this._listeners = Object.create(null);
  }

  /* =======================================================================
     事件系统
     ======================================================================= */
  AppState.prototype.on = function (event, fn) {
    if (typeof fn !== 'function') return this;
    (this._listeners[event] || (this._listeners[event] = [])).push(fn);
    return this;
  };

  AppState.prototype.off = function (event, fn) {
    var list = this._listeners[event];
    if (!list) return this;
    if (!fn) { delete this._listeners[event]; return this; }
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i] === fn) list.splice(i, 1);
    }
    return this;
  };

  AppState.prototype.emit = function (event, data) {
    var list = this._listeners[event];
    if (!list || !list.length) return this;
    // 拷贝一份再遍历，防止回调里 on/off 改数组
    var snapshot = list.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i](data); } catch (e) { console.error('[AppState] listener error:', e); }
    }
    return this;
  };

  /* =======================================================================
     通用 helper：定义一个带持久化 + 事件派发的属性
     ======================================================================= */
  function defineProp(proto, publicName, privateName, opts) {
    opts = opts || {};
    var lsKey = opts.lsKey;                  // localStorage 键名（可空）
    var serialize = opts.serialize || function (v) { return v; };
    var eventName = opts.event || (publicName.replace(/^_/, '') + '-changed');

    Object.defineProperty(proto, publicName, {
      enumerable: true,
      configurable: false,
      get: function () { return this[privateName]; },
      set: function (val) {
        var old = this[privateName];
        if (old === val && !opts.alwaysEmit) return;
        this[privateName] = val;
        if (lsKey) {
          if (opts.json) lsSetJSON(lsKey, val);
          else lsSet(lsKey, serialize(val));
        }
        this.emit(eventName, val);
      }
    });
  }

  /* =======================================================================
     主题 / 布局
     ======================================================================= */
  defineProp(AppState.prototype, 'theme', '_theme', {
    lsKey: LS_KEYS.theme,
    event: 'theme-changed'
  });

  defineProp(AppState.prototype, 'colWidths', '_colWidths', {
    lsKey: LS_KEYS.colWidths,
    json: true,
    event: 'col-widths-changed',
    alwaysEmit: true   // 对象引用可能复用，强制派发
  });

  defineProp(AppState.prototype, 'sidebarHidden', '_sidebarHidden', {
    lsKey: LS_KEYS.sidebarHidden,
    serialize: function (v) { return v ? '1' : '0'; },
    event: 'sidebar-hidden-changed'
  });

  defineProp(AppState.prototype, 'browserPaneVisible', '_browserPaneVisible', {
    lsKey: LS_KEYS.browserVisible,
    serialize: function (v) { return v ? '1' : '0'; },
    event: 'browser-pane-visible-changed'
  });

  /* 【兼容别名】browser-ui.js 模块历史上用 paneVisible 这个短名读写右栏显隐。
     共享单例（本文件）的正式名是 browserPaneVisible —— 两个名字必须指向同一个
     底层字段 _browserPaneVisible，否则 BrowserUI 读写 paneVisible 会落到
     undefined 上（toggle 永远算出同一个值，按钮表现为「点了没反应」）。
     这里用 defineProperty 做纯转发，不走 defineProp（避免重复持久化/发事件）。 */
  Object.defineProperty(AppState.prototype, 'paneVisible', {
    enumerable: true,
    configurable: false,
    get: function () { return this._browserPaneVisible; },
    set: function (v) { this.browserPaneVisible = !!v; }   // 走正式 setter → 持久化 + 派发
  });

  /* =======================================================================
     对话 / 模型（不落盘，由 session_info 事件驱动）
     ======================================================================= */
  defineProp(AppState.prototype, 'currentModelId', '_currentModelId', {
    event: 'model-changed'
  });
  defineProp(AppState.prototype, 'thinkingLevel', '_thinkingLevel', {
    event: 'thinking-level-changed'
  });
  defineProp(AppState.prototype, 'thinkingLevels', '_thinkingLevels', {
    event: 'thinking-levels-changed',
    alwaysEmit: true
  });
  defineProp(AppState.prototype, 'models', '_models', {
    event: 'models-changed',
    alwaysEmit: true
  });

  /* =======================================================================
     会话列表
     ======================================================================= */
  defineProp(AppState.prototype, 'activeSessionId', '_activeSessionId', {
    event: 'active-session-changed'
  });
  defineProp(AppState.prototype, 'currentSessionId', '_currentSessionId', {
    event: 'current-session-changed'
  });
  defineProp(AppState.prototype, 'expandedProjects', '_expandedProjects', {
    event: 'expanded-projects-changed',
    alwaysEmit: true
  });
  defineProp(AppState.prototype, 'sessionGroups', '_sessionGroups', {
    event: 'session-groups-changed',
    alwaysEmit: true
  });
  defineProp(AppState.prototype, 'searchQuery', '_searchQuery', {
    event: 'search-query-changed'
  });
  defineProp(AppState.prototype, 'currentCwd', '_currentCwd', {
    event: 'current-cwd-changed'
  });

  /* =======================================================================
     流式对话
     ======================================================================= */
  defineProp(AppState.prototype, 'running', '_running', {
    event: 'running-changed'
  });
  defineProp(AppState.prototype, 'stickToBottom', '_stickToBottom', {
    event: 'stick-to-bottom-changed'
  });
  defineProp(AppState.prototype, 'streamCursor', '_streamCursor', {
    event: 'stream-cursor-changed',
    alwaysEmit: true
  });
  // 流式游标的细粒度 reset（高频操作，免事件）
  AppState.prototype.resetStreamCursor = function () {
    this._streamCursor = { msg: null, text: null, think: null, tools: {} };
    return this._streamCursor;
  };

  /* =======================================================================
     浏览器
     ======================================================================= */
  defineProp(AppState.prototype, 'browserTabs', '_browserTabs', {
    event: 'browser-tabs-changed',
    alwaysEmit: true
  });

  /* 【兼容别名】browser-ui.js 用 tabsState 这个名字保存 {activeId, tabs}。
     与 browserTabs 指向同一份数据，转发到正式 setter 以派发事件。 */
  Object.defineProperty(AppState.prototype, 'tabsState', {
    enumerable: true,
    configurable: false,
    get: function () { return this._browserTabs; },
    set: function (v) { this.browserTabs = v; }
  });
  defineProp(AppState.prototype, 'pageBlank', '_pageBlank', {
    event: 'page-blank-changed'
  });
  defineProp(AppState.prototype, 'blankOverride', '_blankOverride', {
    event: 'blank-override-changed'
  });
  defineProp(AppState.prototype, 'favorites', '_favorites', {
    lsKey: LS_KEYS.favorites,
    json: true,
    event: 'favorites-changed',
    alwaysEmit: true
  });
  // 便捷方法：判断 URL 是否已收藏
  AppState.prototype.isFavorite = function (url) {
    return this._favorites.some(function (f) { return f.url === url; });
  };
  AppState.prototype.toggleFavorite = function (url, title) {
    var list = this._favorites.slice();
    var i = list.findIndex(function (f) { return f.url === url; });
    if (i >= 0) list.splice(i, 1);
    else list.push({ url: url, title: title || url });
    this.favorites = list;  // 走 setter → 自动持久化 + 派发
    return i < 0;
  };

  /* =======================================================================
     上下文压缩条
     ======================================================================= */
  defineProp(AppState.prototype, 'compactBarOpen', '_compactBarOpen', {
    lsKey: LS_KEYS.compactBarOpen,
    serialize: function (v) { return v ? '1' : '0'; },
    event: 'compact-bar-open-changed'
  });

  /* =======================================================================
     对话内查找
     ======================================================================= */
  defineProp(AppState.prototype, 'findBarVisible', '_findBarVisible', {
    event: 'find-bar-visible-changed'
  });
  defineProp(AppState.prototype, 'findPos', '_findPos', {
    event: 'find-pos-changed'
  });

  /* =======================================================================
     Cookie 导入
     ======================================================================= */
  defineProp(AppState.prototype, 'importModalOpen', '_importModalOpen', {
    event: 'import-modal-open-changed'
  });
  defineProp(AppState.prototype, 'importing', '_importing', {
    event: 'importing-changed'
  });

  /* =======================================================================
     批量快照 / 调试用
     ======================================================================= */
  AppState.prototype.snapshot = function () {
    var out = {};
    for (var k in this) {
      if (k.charAt(0) === '_' && k !== '_listeners' && Object.prototype.hasOwnProperty.call(this, k)) {
        out[k.slice(1)] = this[k];
      }
    }
    return out;
  };

  /* =======================================================================
     导出（零构建：挂 window 全局单例）
     ======================================================================= */
  window.AppState = new AppState();
  window.AppStateClass = AppState;   // 便于测试 / 多实例场景

})();
