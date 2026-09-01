/* =========================================================================
   browser-ui.js —— 右栏内置浏览器 UI 模块

   职责（从 renderer/app.js 提取的右栏全部逻辑）：
     - 右栏显隐（#btn-show-browser 唯一入口；DOM 折叠 + 通知主进程缩/贴 view）
     - #browser-slot bounds 上报（ResizeObserver + rAF 节流 + 同步版双路径）
     - 标签栏渲染与切换（真多标签，主进程每标签一个 WebContentsView）
     - 地址栏 omnibox（URL/搜索分流，对齐 Chrome 语义）
     - 收藏按钮 + 收藏弹层（localStorage 简易收藏夹）
     - 新标签页空状态网格（收藏 ≥1 时置换默认站点）
     - 下载按钮 + 下载列表弹层
     - 「从 Chrome 导入登录态」模态框（打开期间把原生 view 缩 0，避免盖住模态框）

   依赖：
     - window.piAPI       —— preload 注入的 IPC 桥（本模块用 IpcClient 薄封装）
     - window.IpcClient   —— ipc-client.js 提供；缺失时用本文件内的最小兜底
     - state              —— 共享 AppState 单例（state.js）或本文件内的轻量 AppState
     - window.AppUtils.escapeHtml —— 可选；缺失时用本地实现兜底

   【关键约定】state 字段名：
     本模块读写 state.paneVisible / state.tabsState 等短名；共享 AppState 单例
     （state.js）通过 defineProperty 别名把它们映射到正式字段 browserPaneVisible /
     browserTabs —— 两侧命名必须保持映射，否则会出现「读写 undefined，按钮点了
     没反应」的静默失效（历史踩过，勿删 state.js 里的别名胜）。
   ========================================================================= */
(function () {
  'use strict';

  var TAG = '[BrowserUI]';   // 日志统一前缀

  /* ---------------------------------------------------------------------
     IpcClient 兜底：正常由 ipc-client.js 提供功能完整的版本；
     本文件只在它缺失时（如纯浏览器里打开调试）挂一个最小实现，
     所有调用返回 resolved(null)，保证 UI 不崩。
     --------------------------------------------------------------------- */
  if (!window.IpcClient) {
    function IpcClientFallback(api) {
      this.api = api || window.piAPI || {};
    }
    IpcClientFallback.prototype.call = function (name) {
      var args = Array.prototype.slice.call(arguments, 1);
      if (typeof this.api[name] === 'function') {
        try { return Promise.resolve(this.api[name].apply(this.api, args)); }
        catch (e) { console.warn(TAG, 'IPC 调用失败:', name, e); return Promise.resolve(null); }
      }
      console.warn(TAG, 'IPC 方法不存在:', name);
      return Promise.resolve(null);
    };
    window.IpcClient = IpcClientFallback;
  }

  /* ---------------------------------------------------------------------
     轻量 AppState 兜底：调用方未传共享 state 时内部自管一份，
     字段与 state.js 的别名层保持同名（paneVisible / tabsState …）。
     --------------------------------------------------------------------- */
  function LocalBrowserState() {
    this.paneVisible = false;
    // 主进程创建 view 时就直接 loadURL(HOME_URL)，首个 browser_url 事件可能比
    // 渲染层注册监听更早（丢包）。初值取【乐观】：先当作已有页面，
    // 宁可多显一帧真页面，也不要出现「空状态盖住已加载页面」的死锁。
    this.pageBlank = false;
    this.blankOverride = false;
    this.importModalOpen = false;
    this.tabsState = { activeId: null, tabs: [] };
  }

  /* ---------------------------------------------------------------------
     本地兜底 escapeHtml（AppUtils 缺失时用）
     --------------------------------------------------------------------- */
  function escapeHtml(s) {
    if (window.AppUtils && typeof window.AppUtils.escapeHtml === 'function') {
      return window.AppUtils.escapeHtml(s);
    }
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  void escapeHtml; // 预留给弹层内需要转义的扩展点

  /* ---------------------------------------------------------------------
     小工具：安全绑定点击事件（元素缺失时告警而不是抛异常中断 init）
     --------------------------------------------------------------------- */
  function onClick(el, name, fn) {
    if (!el) { console.warn(TAG, '元素缺失，跳过绑定:', name); return; }
    el.addEventListener('click', fn);
  }

  /* =====================================================================
     常量
     ===================================================================== */
  var BROWSER_KEY = 'pi-browser-visible';   // 右栏显隐的 localStorage 键（与 app.js 一致）
  var FAV_KEY = 'pi-browser-favorites';     // 收藏夹 localStorage 键
  var FAV_MAX = 50;                         // 收藏上限，防无限膨胀
  var TAB_TITLE_MAX = 14;                   // 标签标题截断长度
  var TAB_BLANK = '新标签页';
  var FAV_POLL_MS = 800;                    // 地址栏轮询间隔（刷新收藏态）

  var BE_DEFAULT_SITES = [
    { url: 'https://www.google.com', name: 'Google' },
    { url: 'https://github.com', name: 'GitHub' },
    { url: 'https://x.com', name: 'X' },
    { url: 'https://www.youtube.com', name: 'YouTube' },
    { url: 'https://mail.google.com', name: 'Gmail' },
    { url: 'https://gemini.google.com', name: 'Gemini' }
  ];

  /* =====================================================================
     BrowserUI 构造
     @param container 右栏根元素（#browser-pane）
     @param state     共享 AppState 单例（可选；缺省内部 new LocalBrowserState）
     @param ipc       IpcClient 实例（可选；缺省用 window.piAPI 包一个）
     ===================================================================== */
  function BrowserUI(container, state, ipc) {
    this.el = container;
    this.state = state || new LocalBrowserState();
    this.ipc = ipc || new window.IpcClient();

    var $ = function (id) { return document.getElementById(id); };
    // 右栏内部元素 + 跨栏协作元素（统一在这里取一次，缺失的在 setup 时告警）
    this.ui = {
      browserPane: container,
      browserSlot: $('browser-slot'),
      browserEmpty: $('browser-empty'),
      tabBar: $('tab-bar'),
      tabStrip: $('tab-strip'),
      btnTabNew: $('btn-tab-new'),
      btnShowBrowser: $('btn-show-browser'),
      urlInput: $('url-input'),
      urlLock: $('url-lock'),
      btnBack: $('btn-back'),
      btnForward: $('btn-forward'),
      btnReload: $('btn-reload'),
      btnHome: $('btn-home'),
      btnOpenExternal: $('btn-open-external'),
      btnDownload: $('btn-download'),
      btnMore: $('btn-more'),
      btnFavorite: $('btn-favorite'),
      btnDevtools: $('btn-devtools'),
      downloadPop: $('download-pop'),
      morePop: $('more-pop'),
      beGrid: $('be-grid'),
      // Cookie 导入模态框
      btnImport: $('btn-import'),
      importOverlay: $('import-overlay'),
      importCancel: $('import-cancel'),
      importConfirm: $('import-confirm'),
      importResult: $('import-result'),
      // 跨栏协作元素
      shell: $('shell'),
      btnBrowser: $('btn-browser')
      // 已移除：btnBrowserInline（#btn-toggle-browser-inline 已随 #context-bar 删除）
    };

    // bounds 上报去重状态
    this._boundsPending = false;   // 是否已有 rAF 在排队
    this._lastBounds = '';         // 上次上报的 rect 指纹（不变就不打扰主进程）
    this._lastViewVisible = null;  // 上次下发给主进程的 view 可见性（去抖）

    // 外部协作钩子（由 main.js 注入；缺省空实现保证模块独立可用）
    //   closePopovers:      关闭其它模块弹层（模型/思考/工作区/会话右键……）
    //   onVisibilityChange: 右栏显隐变化回调
    this.hooks = { closePopovers: null, onVisibilityChange: null };

    this._favPollTimer = null;     // 地址栏轮询定时器
    this._resizeObserver = null;   // slot 尺寸观察器
    this._importing = false;       // Cookie 导入进行中（防重复点击）
  }

  /* =====================================================================
     bounds 上报：量 #browser-slot 的 rect → 去重 → 下发主进程
     原生 WebContentsView 不受 CSS 影响，必须把矩形同步过去
     ===================================================================== */

  // 真正量尺寸并下发（内部）：不在面板展开时不上报；尺寸没变不上报
  BrowserUI.prototype.sendBounds = function () {
    if (!this.ui.browserSlot) return;
    if (this.ui.browserPane && this.ui.browserPane.classList.contains('collapsed')) return;
    var r = this.ui.browserSlot.getBoundingClientRect();
    var b = {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height)
    };
    var key = b.x + ',' + b.y + ',' + b.width + ',' + b.height;
    if (key === this._lastBounds) return;
    this._lastBounds = key;
    this.ipc.call('browserBounds', b);
  };

  // 常规路径：rAF 节流，避免 resize 风暴时刷爆 IPC
  BrowserUI.prototype.reportBounds = function () {
    var self = this;
    if (this._boundsPending) return;
    this._boundsPending = true;
    requestAnimationFrame(function () {
      self._boundsPending = false;
      self.sendBounds();
    });
  };

  /* 【重要】拖拽栏宽 / 显隐切换必须走这个同步版，不能靠 rAF：
     窗口被遮挡 / 不在前台时 document.visibilityState 为 'hidden'，
     Chromium 会把 requestAnimationFrame 完全饿死（已实测：回调数秒不触发），
     那时 reportBounds() 会静默失效，原生 view 就停在旧位置错位。
     pointermove 本身已经是输入频率（≤120Hz），setBounds 很便宜，直接同步发。 */
  BrowserUI.prototype.reportBoundsNow = function () {
    this._boundsPending = false;   // 废掉可能残留的 rAF 标志，避免重复发
    this.sendBounds();
  };

  // 强制下一次上报不去重（栏宽/显隐变化后调用，确保最终位置落实）
  BrowserUI.prototype.invalidateBounds = function () {
    this._lastBounds = '';
  };

  /* =====================================================================
     右栏显隐 + 空状态

     原生 WebContentsView 永远盖在渲染层 DOM 之上，所以 #browser-empty（普通 DOM）
     只有在主进程把 view 缩到 0 时才看得见。三个【互相独立】的标志位：
       paneVisible     —— 用户手动开/关右栏（持久化 localStorage）
       pageBlank       —— 当前页面是 about:blank / 空（由 browser_url 事件推导）
       blankOverride   —— 手动「新建标签页」置的空页标记
       importModalOpen —— Cookie 导入模态框打开期间隐藏原生 view
     真正下发的可见性 = paneVisible && !isBlank() && !importModalOpen。
     ===================================================================== */
  BrowserUI.prototype.isBlank = function () {
    return !!(this.state.blankOverride || this.state.pageBlank);
  };

  // 统一同步点：空状态 DOM、原生 view 可见性、bounds 上报，全在这里收口
  BrowserUI.prototype.syncBrowserView = function () {
    var st = this.state;
    var modalHold = !!st.importModalOpen;
    // 原生 view / 空状态互斥占同一块矩形：空状态可见时必须把 view 缩到 0x0
    var showEmpty = !!st.paneVisible && this.isBlank();
    if (this.ui.browserEmpty) this.ui.browserEmpty.classList.toggle('hidden', !showEmpty);

    var viewVisible = !!st.paneVisible && !this.isBlank() && !modalHold;
    if (viewVisible !== this._lastViewVisible) {
      this._lastViewVisible = viewVisible;
      console.log(TAG, '原生 view 可见性 ->', viewVisible);
      this.ipc.call('browserToggle', viewVisible);
    }
    // 即使 view 当前不可见也要把 rect 报上去，主进程会缓存，
    // 等页面真正加载时直接按最新 rect 贴出来，避免闪一帧错位
    this._lastBounds = '';
    if (st.paneVisible) this.reportBoundsNow();
  };

  // 任何显式导航动作都要销掉「新建空标签页」标记，否则空状态会一直盖着真页面
  BrowserUI.prototype.clearBlank = function () {
    if (!this.state.blankOverride) return;
    this.state.blankOverride = false;
    this.syncBrowserView();
  };

  /* ----- 显隐主入口（#btn-show-browser / 菜单 toggle-browser 都走这里） ----- */

  // 设置右栏显隐：改 state → 改 DOM → 持久化 → 同步主进程 view → 通知外部
  BrowserUI.prototype.setBrowserVisible = function (visible) {
    var st = this.state;
    visible = !!visible;
    console.log(TAG, 'setBrowserVisible:', visible);
    st.paneVisible = visible;

    if (this.ui.browserPane) this.ui.browserPane.classList.toggle('collapsed', !visible);
    // 右栏折叠后在 #shell 打标，让中栏右缘的展开把手现身（同左栏 sidebar-hidden 模式）
    if (this.ui.shell) this.ui.shell.classList.toggle('browser-hidden', !visible);
    // 折叠时把 grid 轨道归零（不用 display:none —— Chromium 的 grid 会把 item
    // 剔除但轨道塌缩错位，右半屏变死区，实测踩过）。展开时移除归零变量。
    document.documentElement.style.setProperty('--browser-track', visible ? '' : '0px');
    // 可选按钮（当前已隐藏）存在时同步 active 态
    if (this.ui.btnBrowser) this.ui.btnBrowser.classList.toggle('active', visible);
    try { localStorage.setItem(BROWSER_KEY, visible ? '1' : '0'); } catch (e) {}

    this.syncBrowserView();
    this.updateToggleButton();
    if (typeof this.hooks.onVisibilityChange === 'function') {
      try { this.hooks.onVisibilityChange(visible); } catch (e) { console.error(TAG, e); }
    }
  };

  BrowserUI.prototype.toggleBrowser = function () {
    console.log(TAG, 'toggleBrowser，当前 =', !!this.state.paneVisible);
    this.setBrowserVisible(!this.state.paneVisible);
  };

  // 更新右上角开关按钮的提示文案（图标本身不变，位置恒定）
  BrowserUI.prototype.updateToggleButton = function () {
    var btn = this.ui.btnShowBrowser;
    if (!btn) return;
    btn.title = this.state.paneVisible ? '关闭浏览器面板' : '打开浏览器面板';
    btn.classList.toggle('active', !!this.state.paneVisible);
  };

  // 启动时恢复右栏可见性：首次运行（无键）默认展开
  BrowserUI.prototype.restoreVisibility = function () {
    var visible = true;
    try { visible = localStorage.getItem(BROWSER_KEY) !== '0'; } catch (e) {}
    console.log(TAG, 'restoreVisibility:', visible);
    this.setBrowserVisible(visible);
  };

  /* =====================================================================
     导航按钮 / omnibox 地址栏
     ===================================================================== */
  BrowserUI.prototype.setupNavButtons = function () {
    var self = this;
    var ipc = this.ipc;
    onClick(this.ui.btnBack, 'btn-back', function () { self.clearBlank(); ipc.call('browserBack'); });
    onClick(this.ui.btnForward, 'btn-forward', function () { self.clearBlank(); ipc.call('browserForward'); });
    onClick(this.ui.btnReload, 'btn-reload', function () { self.clearBlank(); ipc.call('browserReload'); });
    onClick(this.ui.btnHome, 'btn-home', function () { self.clearBlank(); ipc.call('browserHome'); });
    onClick(this.ui.btnDevtools, 'btn-devtools', function () { ipc.call('browserDevtools'); });

    // 在外部浏览器打开当前地址栏 URL：空/非 http(s) 时不动
    onClick(this.ui.btnOpenExternal, 'btn-open-external', function () {
      var u = (self.ui.urlInput && self.ui.urlInput.value || '').trim();
      if (!/^https?:\/\//i.test(u)) return;
      ipc.call('browserOpenExternal', u);
    });
  };

  BrowserUI.prototype.setupOmnibox = function () {
    var self = this;
    if (!this.ui.urlInput) { console.warn(TAG, '元素缺失: url-input'); return; }
    this.ui.urlInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var url = self.ui.urlInput.value.trim();
      if (!url) return;
      // omnibox 语义（对齐 Chrome 地址栏）：看着像域名/URL 才当网址，否则当搜索词。
      // 判定：带协议头 / about: / 形如 a.b 的域名（含 Unicode 域名）且不含空格。
      var looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
        || /^about:/i.test(url)
        || (/^[^\s]+\.[^\s]{2,}$/.test(url) && !url.includes(' '));
      if (!looksLikeUrl) {
        // 搜索：直接跳 Google 搜索结果页，登录态下就是个性化结果
        self.clearBlank();
        self.ipc.call('browserGo', 'https://www.google.com/search?hl=zh-CN&q=' + encodeURIComponent(url));
        return;
      }
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^about:/i.test(url)) url = 'https://' + url;
      self.clearBlank();                        // 输了真 URL → 销掉空页标记
      self.ipc.call('browserGo', url);
    });
  };

  /* =====================================================================
     收藏夹（localStorage 简易实现，上限 FAV_MAX 条）
     ===================================================================== */
  BrowserUI.prototype.getFavs = function () {
    try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (e) { return []; }
  };
  BrowserUI.prototype.saveFavs = function (list) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch (e) {}
  };
  BrowserUI.prototype.refreshFavState = function () {
    if (!this.ui.btnFavorite || !this.ui.urlInput) return;
    var url = this.ui.urlInput.value.trim();
    var fav = this.getFavs().some(function (f) { return f.url === url; });
    this.ui.btnFavorite.classList.toggle('active', fav);
    this.ui.btnFavorite.title = fav ? '取消收藏' : '收藏此页';
  };

  BrowserUI.prototype.setupFavorite = function () {
    var self = this;
    if (!this.ui.urlInput) return;
    onClick(this.ui.btnFavorite, 'btn-favorite', function () {
      var url = self.ui.urlInput.value.trim();
      if (!/^https?:\/\//.test(url)) return;        // 没有真页面不收藏
      var list = self.getFavs();
      var i = list.findIndex(function (f) { return f.url === url; });
      if (i >= 0) {
        list.splice(i, 1);
      } else {
        // 标题从当前活动标签拿，拿不到就退回 url
        var title = '';
        try {
          var ts = self.state.tabsState || { tabs: [] };
          var tabs = ts.tabs || [];
          var active = null;
          for (var k = 0; k < tabs.length; k++) { if (tabs[k].id === ts.activeId) { active = tabs[k]; break; } }
          title = (active && active.title) || url;
        } catch (e) {}
        list.unshift({ url: url, title: title });
        if (list.length > FAV_MAX) list.length = FAV_MAX;
      }
      self.saveFavs(list);
      self.refreshFavState();
    });

    // 地址栏 URL 变化时刷新收藏态（url-input 没有变更事件，轻轮询兜底）
    var lastVal = '';
    this._favPollTimer = setInterval(function () {
      if (!self.ui.urlInput) return;
      if (self.ui.urlInput.value !== lastVal) {
        lastVal = self.ui.urlInput.value;
        if (document.activeElement !== self.ui.urlInput) self.refreshFavState();
      }
    }, FAV_POLL_MS);
  };

  /* ---- 收藏弹层（#btn-more）：列出收藏，点击导航，✕ 移除 ---- */
  BrowserUI.prototype.renderMorePop = function () {
    var self = this;
    var pop = this.ui.morePop;
    if (!pop) return;
    pop.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'fav-head';
    head.textContent = '收藏';
    pop.appendChild(head);
    var favs = this.getFavs();
    if (!favs.length) {
      var em = document.createElement('div');
      em.className = 'fav-empty';
      em.textContent = '暂无收藏（点地址栏 ☆ 收藏当前页）';
      pop.appendChild(em);
      return;
    }
    favs.forEach(function (f, idx) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'fav-item';
      var texts = document.createElement('span');
      texts.className = 'fav-texts';
      var t = document.createElement('span');
      t.className = 'fav-title';
      t.textContent = f.title || f.url;
      var u = document.createElement('span');
      u.className = 'fav-url';
      u.textContent = f.url;
      texts.appendChild(t); texts.appendChild(u);
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'fav-remove';
      rm.title = '移除收藏';
      rm.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
        '<line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" /></svg>';
      rm.addEventListener('click', function (e) {
        e.stopPropagation();
        var list = self.getFavs();
        list.splice(idx, 1);
        self.saveFavs(list);
        self.refreshFavState();
        self.renderMorePop();                 // 移除后原地重绘，不关弹层
      });
      b.appendChild(texts); b.appendChild(rm);
      b.addEventListener('click', function () {
        self._closePopovers();
        self.clearBlank();
        self.ipc.call('browserGo', f.url);
        self.renderEmptyGrid();
      });
      pop.appendChild(b);
    });
  };

  BrowserUI.prototype.showFavorites = function () {
    if (!this.ui.morePop || !this.ui.btnMore) return;
    var opening = this.ui.morePop.classList.contains('hidden');
    this._closePopovers();
    if (!opening) return;
    this.renderMorePop();
    var r = this.ui.btnMore.getBoundingClientRect();
    this.positionPopoverXY(this.ui.morePop, r.right - 300, r.bottom + 6);
  };

  /* =====================================================================
     下载弹层：列出下载目录最近文件，点击在 Finder 中定位
     ===================================================================== */
  BrowserUI.prototype._fmtSize = function (n) {
    if (n == null || isNaN(n)) return '';
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'M';
    return (n / 1024 / 1024 / 1024).toFixed(1) + 'G';
  };

  BrowserUI.prototype.renderDownloadPop = function () {
    var self = this;
    var pop = this.ui.downloadPop;
    if (!pop) return;
    pop.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'dl-head';
    head.textContent = '下载目录最近文件';
    pop.appendChild(head);
    Promise.resolve(this.ipc.call('browserListDownloads')).then(function (r) {
      var items = (r && r.items) || [];
      if (!items.length) {
        var em = document.createElement('div');
        em.className = 'dl-empty';
        em.textContent = '下载目录为空';
        pop.appendChild(em);
        return;
      }
      items.forEach(function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'dl-item';
        b.title = it.path || it.name;
        var n = document.createElement('span');
        n.className = 'dl-name';
        n.textContent = it.name;
        var m = document.createElement('span');
        m.className = 'dl-meta';
        m.textContent = self._fmtSize(it.size);
        b.appendChild(n); b.appendChild(m);
        b.addEventListener('click', function () {
          self.ipc.call('browserShowInFolder', it.path);
        });
        pop.appendChild(b);
      });
    }).catch(function () {});
  };

  BrowserUI.prototype.showDownloads = function () {
    if (!this.ui.downloadPop || !this.ui.btnDownload) return;
    var opening = this.ui.downloadPop.classList.contains('hidden');
    this._closePopovers();
    if (!opening) return;
    this.renderDownloadPop();
    var r = this.ui.btnDownload.getBoundingClientRect();
    this.positionPopoverXY(this.ui.downloadPop, r.right - 300, r.bottom + 6);
  };

  /* =====================================================================
     标签栏（真多标签：主进程 browser_tabs 事件推全量列表，这里只负责画；
     增/删/切全走 IPC，本地不维护状态，避免两边不一致）
     ===================================================================== */
  BrowserUI.prototype.isBlankUrl = function (u) {
    var s = String(u || '').trim();
    return !s || /^about:/i.test(s);
  };

  BrowserUI.prototype.renderTabs = function (state) {
    var self = this;
    if (!this.ui.tabStrip) return;
    var st = this.state;
    if (state) st.tabsState = { activeId: state.activeId, tabs: state.tabs || [] };
    var ts = st.tabsState || { activeId: null, tabs: [] };
    var frag = document.createDocumentFragment();

    (ts.tabs || []).forEach(function (t) {
      var node = document.createElement('div');
      node.className = 'tab' + (t.id === ts.activeId ? ' active' : '');
      node.dataset.id = t.id;

      var ico = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ico.setAttribute('viewBox', '0 0 16 16');
      ico.innerHTML = '<circle cx="8" cy="8" r="6" /><line x1="2" y1="8" x2="14" y2="8" />' +
        '<path d="M8 2c1.9 2.2 1.9 9.8 0 12M8 2C6.1 4.2 6.1 11.8 8 14" />';
      node.appendChild(ico);

      var raw = String(t.title || '').trim() || (self.isBlankUrl(t.url) ? TAB_BLANK : t.url);
      var span = document.createElement('span');
      span.className = 'tab-title';
      span.textContent = raw.length > TAB_TITLE_MAX ? raw.slice(0, TAB_TITLE_MAX) + '…' : raw;
      span.title = t.url || raw;
      node.appendChild(span);

      // 只剩一个标签时也保留关闭按钮：主进程会自动新开一个空白页
      var close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.title = '关闭标签页';
      close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
        '<line x1="4.5" y1="4.5" x2="11.5" y2="11.5" /><line x1="11.5" y1="4.5" x2="4.5" y2="11.5" /></svg>';
      close.addEventListener('click', function (e) {
        e.stopPropagation();                  // 不要触发「切到该标签」
        self.ipc.call('browserTabClose', t.id);
      });
      node.appendChild(close);

      node.addEventListener('click', function () {
        if (t.id !== ts.activeId) self.ipc.call('browserTabActivate', t.id);
      });
      frag.appendChild(node);
    });

    this.ui.tabStrip.innerHTML = '';
    this.ui.tabStrip.appendChild(frag);
  };

  BrowserUI.prototype.setupTabs = function () {
    var self = this;
    onClick(this.ui.btnTabNew, 'btn-tab-new', function () {
      // 真开一个新 view。有了真多标签后，新标签直接加载主页更符合直觉。
      self.state.blankOverride = false;
      self.ipc.call('browserTabNew');
      self.syncBrowserView();
    });
  };

  /* =====================================================================
     新标签页空状态：大标题 + 快捷站点网格
     有收藏（≥1 条）时前 6 个快捷位换成收藏，否则用默认站点
     ===================================================================== */
  BrowserUI.prototype.buildNewTabPage = function () {
    return this.renderEmptyGrid();
  };

  BrowserUI.prototype.renderEmptyGrid = function () {
    var self = this;
    if (!this.ui.beGrid) return;
    var favs = this.getFavs().map(function (f) {
      var host = '';
      try { host = new URL(f.url).hostname.replace(/^www\./, ''); } catch (e) {}
      return { url: f.url, name: f.title || host || f.url };
    });
    var tiles = (favs.length ? favs : BE_DEFAULT_SITES).slice(0, 6);
    this.ui.beGrid.innerHTML = '';
    tiles.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'be-tile';
      b.title = s.url;
      var chip = document.createElement('span');
      chip.className = 'be-chip';
      chip.textContent = (s.name || '?').trim().charAt(0) || '?';
      var name = document.createElement('span');
      name.className = 'be-name';
      name.textContent = s.name;
      b.appendChild(chip); b.appendChild(name);
      b.addEventListener('click', function () {
        self.clearBlank();
        self.ipc.call('browserGo', s.url);
        self.renderEmptyGrid();
      });
      self.ui.beGrid.appendChild(b);
    });
  };

  /* =====================================================================
     Cookie 导入模态框（#btn-import → #import-overlay）

     原生 WebContentsView 永远盖在 DOM 之上，所以模态框打开前必须先把
     view 缩到 0（state.importModalOpen = true → syncBrowserView 处理），
     关闭时再恢复。导入结果展示在 #import-result。
     ===================================================================== */
  BrowserUI.prototype.setupImportModal = function () {
    var self = this;
    if (!this.ui.importOverlay) return;   // HTML 里没有就整段跳过

    onClick(this.ui.btnImport, 'btn-import', function () { self.openImportModal(); });
    onClick(this.ui.importCancel, 'import-cancel', function () { self.closeImportModal(); });
    onClick(this.ui.importConfirm, 'import-confirm', function () { self.runImport(); });

    // 点遮罩空白处关闭（点模态框本身不关）
    this.ui.importOverlay.addEventListener('click', function (e) {
      if (e.target === self.ui.importOverlay) self.closeImportModal();
    });
  };

  BrowserUI.prototype.openImportModal = function () {
    if (!this.ui.importOverlay) return;
    console.log(TAG, '打开 Cookie 导入模态框');
    this.state.importModalOpen = true;      // 触发 syncBrowserView 把原生 view 缩 0
    this.syncBrowserView();
    if (this.ui.importResult) this.ui.importResult.classList.add('hidden');
    this.ui.importOverlay.classList.remove('hidden');
  };

  BrowserUI.prototype.closeImportModal = function () {
    if (!this.ui.importOverlay) return;
    this.state.importModalOpen = false;
    this.syncBrowserView();                 // 恢复原生 view 可见性
    this.ui.importOverlay.classList.add('hidden');
  };

  // 执行导入：期间禁用按钮防重复点击，结果写进 #import-result
  BrowserUI.prototype.runImport = function () {
    var self = this;
    if (this._importing) return;
    this._importing = true;
    var btn = this.ui.importConfirm;
    if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }

    Promise.resolve(this.ipc.call('importCookies', {})).then(function (r) {
      r = r || {};
      var box = self.ui.importResult;
        if (box) {
        box.classList.remove('hidden');
        if (r.ok) {
          var line = '导入完成：成功 ' + (r.imported || 0) +
            '，跳过 ' + (r.skipped || 0) + '，失败 ' + (r.failed || 0) + '。';
          if (r.needCloseChrome) line += '（Chrome 未完全退出，部分 Cookie 可能未导入）';
          box.textContent = line;
        } else {
          box.textContent = '导入失败：' + (r.message || r.error || '未知错误');
        }
      }
      // 导入成功后刷新空状态网格（收藏/登录态可能变了）
      self.renderEmptyGrid();
    }).catch(function (e) {
      console.error(TAG, 'importCookies 失败:', e);
      var box = self.ui.importResult;
      if (box) { box.classList.remove('hidden'); box.textContent = '导入失败：' + (e && e.message || e); }
    }).then(function () {
      self._importing = false;
      if (btn) { btn.disabled = false; btn.textContent = '开始导入'; }
    });
  };

  /* =====================================================================
     浮层定位（保留防溢出逻辑：popoverRightEdge）

     原生浏览器 view 永远在渲染层 DOM 之上，弹层横向范围必须限制在
     「左栏+中栏」内 —— 浏览器面板可见时以它的左缘为界，否则贴窗口右缘。
     ===================================================================== */
  BrowserUI.prototype.popoverRightEdge = function () {
    if (this.ui.browserPane && !this.ui.browserPane.classList.contains('collapsed')) {
      var left = this.ui.browserPane.getBoundingClientRect().left;
      if (left > 0) return left - 8;
    }
    return window.innerWidth - 12;
  };

  BrowserUI.prototype.positionPopoverXY = function (pop, x, y) {
    if (!pop) return;
    pop.classList.remove('hidden');
    var w = pop.offsetWidth;
    var h = pop.offsetHeight;
    var right = this.popoverRightEdge();
    var left = Math.max(8, Math.min(x, right - w));
    var top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  };

  // 关闭本模块弹层 + 委托外部 closePopovers（模型/思考/工作区等其它弹层）
  BrowserUI.prototype._closePopovers = function () {
    if (this.ui.downloadPop) this.ui.downloadPop.classList.add('hidden');
    if (this.ui.morePop) this.ui.morePop.classList.add('hidden');
    if (typeof this.hooks.closePopovers === 'function') {
      try { this.hooks.closePopovers(); } catch (e) { console.error(TAG, e); }
    }
  };

  BrowserUI.prototype.closePopups = function () {
    this._closePopovers();
  };

  /* =====================================================================
     主进程事件入口：browser_url / browser_tabs
     由 main.js 的 onAny 分发到这里
     ===================================================================== */
  BrowserUI.prototype.handleEvent = function (evt) {
    if (!evt || !evt.type) return false;
    var st = this.state;
    switch (evt.type) {
      case 'browser_url':
        // 新建空标签页期间不让底层页面的 URL/标题回写到地址栏与标签上
        if (this.ui.urlInput && !st.blankOverride && document.activeElement !== this.ui.urlInput) {
          this.ui.urlInput.value = evt.url || '';
        }
        if (this.ui.btnBack) this.ui.btnBack.disabled = !evt.canBack;
        if (this.ui.btnForward) this.ui.btnForward.disabled = !evt.canForward;
        if (this.ui.urlLock) this.ui.urlLock.classList.toggle('hidden', st.blankOverride || !/^https:/i.test(evt.url || ''));
        if (this.ui.btnReload) {
          this.ui.btnReload.classList.toggle('loading', !!evt.loading);
          this.ui.btnReload.title = evt.loading ? '加载中…' : '刷新';
        }
        var blank = this.isBlankUrl(evt.url);
        // 标签标题不在这里改 —— 由 browser_tabs 事件驱动 renderTabs() 统一重画
        // 空页 → 让原生 view 缩到 0，把位置让给 #browser-empty（普通 DOM）
        if (st.pageBlank !== blank) {
          st.pageBlank = blank;
          this.syncBrowserView();
        }
        return true;

      case 'browser_tabs':
        this.renderTabs(evt);
        return true;
    }
    return false;
  };

  /* =====================================================================
     init：接线全部事件 + 恢复显隐 + 启动 ResizeObserver
     ===================================================================== */
  BrowserUI.prototype.init = function () {
    var self = this;
    console.log(TAG, 'init()，DOM 检查:', {
      pane: !!this.ui.browserPane,
      slot: !!this.ui.browserSlot,
      btnShowBrowser: !!this.ui.btnShowBrowser
    });

    this.setupNavButtons();
    this.setupOmnibox();
    this.setupFavorite();
    this.setupTabs();
    this.setupImportModal();

    // 下载 / 收藏弹层触发按钮
    onClick(this.ui.btnDownload, 'btn-download', function () { self.showDownloads(); });
    onClick(this.ui.btnMore, 'btn-more', function () { self.showFavorites(); });

    /* 右栏开关按钮 —— #shell 右上角永恒按钮 #btn-show-browser 是【唯一入口】。
       #btn-browser（左栏底部）已在 index.html 中隐藏，不绑事件，避免多入口状态不同步。
       注意：main.js 不得再对 #btn-show-browser 重复绑定，否则一次点击
       触发两次 toggle 互相抵消，表现为「按钮没反应」（历史踩过）。 */
    onClick(this.ui.btnShowBrowser, 'btn-show-browser', function () {
      self.toggleBrowser();
    });

    // bounds 上报：窗口 resize + slot 尺寸变化 + 页面 load
    var rafReport = function () { self.reportBounds(); };
    window.addEventListener('resize', rafReport);
    if (window.ResizeObserver && this.ui.browserSlot) {
      this._resizeObserver = new ResizeObserver(rafReport);
      this._resizeObserver.observe(this.ui.browserSlot);
    }
    window.addEventListener('load', rafReport);

    // 新标签页快捷站点网格（含收藏置换）
    this.renderEmptyGrid();

    // 恢复上次的显隐状态（内部会同步 DOM / 主进程 / bounds）
    this.restoreVisibility();
  };

  // 模块卸载（目前单页应用用不到，留作测试钩子）
  BrowserUI.prototype.destroy = function () {
    if (this._favPollTimer) { clearInterval(this._favPollTimer); this._favPollTimer = null; }
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
  };

  window.BrowserUI = BrowserUI;
})();
