/* =========================================================================
   browser-ui.js — 右栏内置浏览器 UI 模块

   从 renderer/app.js 提取的右栏全部逻辑：
     - 标签栏渲染与切换（真多标签，主进程每标签一个 WebContentsView）
     - 地址栏 omnibox（URL/搜索分流，对齐 Chrome 语义）
     - 收藏按钮 + 收藏弹层（localStorage 简易收藏夹）
     - 新标签页空状态网格（收藏 ≥1 时置换默认站点）
     - 下载按钮 + 下载列表弹层
     - #browser-slot bounds 上报（ResizeObserver + rAF 节流 + 同步版）

   依赖：
     - window.piAPI  —— preload 注入的 IPC 桥（本模块用 IpcClient 薄封装）
     - AppState      —— 可选的共享状态对象（承载跨模块标志位）；不传则内部自管
     - window.AppUtils.escapeHtml —— 可选；缺失时用本地实现兜底

   用法：
     var ipc = new IpcClient(window.piAPI);
     var browserUI = new BrowserUI(document.getElementById('browser-pane'), appState, ipc);
     browserUI.init();

   注意：本模块【不】改动 app.js；app.js 侧的同名逻辑后续可替换为对本模块的委托。
   ========================================================================= */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     IpcClient：对 window.piAPI 的薄封装。
     主进程未注入时（如浏览器里直接打开）返回 resolved(null)，保证 UI 不崩。
     --------------------------------------------------------------------- */
  function IpcClient(api) {
    this.api = api || {};
  }
  IpcClient.prototype.call = function (name) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (typeof this.api[name] === 'function') return this.api[name].apply(this.api, args);
    return Promise.resolve(null);
  };
  window.IpcClient = window.IpcClient || IpcClient;

  /* ---------------------------------------------------------------------
     AppState：跨模块共享状态（轻量容器）。
     右栏相关字段：
       paneVisible     用户手动开/关右栏（持久化 localStorage）
       pageBlank       当前 URL 是否空页（由 browser_url 事件推导）
       blankOverride   手动「新建标签页」置的空页标记
       importModalOpen Cookie 导入模态框打开期间隐藏原生 view
       tabsState       {activeId, tabs} 主进程 browser_tabs 事件推送的全量标签
     --------------------------------------------------------------------- */
  function AppState() {
    this.paneVisible = false;
    // 主进程创建 view 时就直接 loadURL(HOME_URL)，首个 browser_url 事件可能比
    // 渲染层注册监听更早（丢包）。初值取【乐观】：先当作已有页面，
    // 宁可多显一帧真页面，也不要出现「空状态盖住已加载页面」的死锁。
    this.pageBlank = false;
    this.blankOverride = false;
    this.importModalOpen = false;
    this.tabsState = { activeId: null, tabs: [] };
  }
  window.AppState = window.AppState || AppState;

  /* ---------------------------------------------------------------------
     本地兜底 escapeHtml（app.js 有同名实现；模块化后从 AppUtils 取，没有就自建）
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

  /* =====================================================================
     BrowserUI
     @param container 右栏根元素（#browser-pane）
     @param state     AppState 实例（可选；缺省内部 new 一个）
     @param ipc       IpcClient 实例（可选；缺省用 window.piAPI 包一个）
     ===================================================================== */
  var BROWSER_KEY = 'pi-browser-visible';
  var FAV_KEY = 'pi-browser-favorites';
  var TAB_TITLE_MAX = 14;
  var TAB_BLANK = '新标签页';

  var BE_DEFAULT_SITES = [
    { url: 'https://www.google.com', name: 'Google' },
    { url: 'https://github.com', name: 'GitHub' },
    { url: 'https://x.com', name: 'X' },
    { url: 'https://www.youtube.com', name: 'YouTube' },
    { url: 'https://mail.google.com', name: 'Gmail' },
    { url: 'https://gemini.google.com', name: 'Gemini' }
  ];

  function BrowserUI(container, state, ipc) {
    this.el = container;
    this.state = state || new AppState();
    this.ipc = ipc || new IpcClient(window.piAPI);

    var $ = function (id) { return document.getElementById(id); };
    // 右栏内部元素（容器内查找优先，拿不到退回全局 id —— 兼容现有 index.html）
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
      // 跨栏协作元素
      shell: $('shell'),
      btnBrowser: $('btn-browser'),
      btnBrowserInline: $('btn-toggle-browser-inline')
    };

    // bounds 上报去重状态
    this._boundsPending = false;
    this._lastBounds = '';
    this._lastViewVisible = null;

    // 外部协作钩子（由 app.js 侧注入；缺省空实现保证模块独立可用）
    // closePopovers: 关闭其它弹层（模型/思考/工作区/会话右键……）
    // onVisibilityChange: 右栏显隐变化回调（用于栏宽拖拽后补报等）
    this.hooks = { closePopovers: null, onVisibilityChange: null };

    this._favPollTimer = null;
  }

  /* =====================================================================
     bounds 上报：量 #browser-slot 的 rect → 去重 → 下发主进程
     原生 WebContentsView 不受 CSS 影响，必须把矩形同步过去
     ===================================================================== */
  BrowserUI.prototype.sendBounds = function () {
    if (this.ui.browserPane.classList.contains('collapsed')) return;
    var r = this.ui.browserSlot.getBoundingClientRect();
    var b = {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height)
    };
    var key = b.x + ',' + b.y + ',' + b.width + ',' + b.height;
    if (key === this._lastBounds) return;      // 位置没变就不打扰主进程
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

  /* 【重要】拖拽栏宽时必须走这个同步版，不能靠 rAF：
     窗口被遮挡 / 不在前台时 document.visibilityState 为 'hidden'，
     Chromium 会把 requestAnimationFrame 完全饿死（已实测：回调数秒不触发），
     那时 reportBounds() 会静默失效，原生 view 就停在旧位置错位。
     pointermove 本身已经是输入频率（≤120Hz），setBounds 很便宜，直接同步发。 */
  BrowserUI.prototype.reportBoundsNow = function () {
    this._boundsPending = false;               // 废掉可能残留的 rAF 标志
    this.sendBounds();
  };

  // 强制下一次上报不去重（栏宽/显隐变化后调用，确保最终位置落实）
  BrowserUI.prototype.invalidateBounds = function () {
    this._lastBounds = '';
  };

  /* =====================================================================
     右栏显隐 + 空状态

     原生 WebContentsView 永远盖在渲染层 DOM 之上，所以 #browser-empty（普通 DOM）
     只有在主进程把 view 缩到 0 时才看得见。两个【互相独立】的标志位：
       paneVisible   —— 用户手动开/关右栏（持久化 localStorage）
       pageBlank     —— 当前页面是 about:blank / 空（由 browser_url 事件推导）
       blankOverride —— 手动空页标记
     真正下发的可见性 = paneVisible && !isBlank() && !importModalOpen。
     ===================================================================== */
  BrowserUI.prototype.isBlank = function () {
    return this.state.blankOverride || this.state.pageBlank;
  };

  BrowserUI.prototype.syncBrowserView = function () {
    var st = this.state;
    // 导入模态框打开期间不让原生 view 遮住模态框（原生 view 永远在 DOM 之上）
    var modalHold = st.importModalOpen;
    // 原生 view / 空状态互斥占同一块矩形：空状态可见时必须把 view 缩到 0x0
    var showEmpty = st.paneVisible && this.isBlank();
    this.ui.browserEmpty.classList.toggle('hidden', !showEmpty);

    var viewVisible = st.paneVisible && !this.isBlank() && !modalHold;
    if (viewVisible !== this._lastViewVisible) {
      this._lastViewVisible = viewVisible;
      this.ipc.call('browserToggle', viewVisible);
    }
    // 即使 view 当前不可见也要把 rect 报上去，主进程会缓存，
    // 等页面真正加载时直接按最新 rect 贴出来，避免闪一帧错位
    this._lastBounds = '';                        // 强制下次上报
    if (st.paneVisible) this.reportBoundsNow();
  };

  // 任何显式导航动作都要销掉「新建空标签页」标记，否则空状态会一直盖着真页面
  BrowserUI.prototype.clearBlank = function () {
    if (!this.state.blankOverride) return;
    this.state.blankOverride = false;
    this.syncBrowserView();
  };

  BrowserUI.prototype.setBrowserVisible = function (visible) {
    var st = this.state;
    st.paneVisible = !!visible;
    this.ui.browserPane.classList.toggle('collapsed', !st.paneVisible);
    // 右栏折叠后在 #shell 打标，让中栏右缘的展开把手现身
    if (this.ui.shell) this.ui.shell.classList.toggle('browser-hidden', !st.paneVisible);
    // 折叠时把 grid 轨道归零（不用 display:none —— Chromium 的 grid 会把 item
    // 剔除但轨道塌缩错位，右半屏变死区，实测踩过）。展开时移除归零变量。
    document.documentElement.style.setProperty('--browser-track', st.paneVisible ? '' : '0px');
    if (this.ui.btnBrowser) this.ui.btnBrowser.classList.toggle('active', st.paneVisible);
    if (this.ui.btnBrowserInline) this.ui.btnBrowserInline.classList.toggle('active', st.paneVisible);
    try { localStorage.setItem(BROWSER_KEY, st.paneVisible ? '1' : '0'); } catch (e) {}
    this.syncBrowserView();
    if (typeof this.hooks.onVisibilityChange === 'function') {
      this.hooks.onVisibilityChange(st.paneVisible);
    }
  };

  BrowserUI.prototype.toggleBrowser = function () {
    this.setBrowserVisible(!this.state.paneVisible);
  };

  // 启动时恢复右栏可见性：首次运行（无键）默认展开
  BrowserUI.prototype.restoreVisibility = function () {
    this.setBrowserVisible(localStorage.getItem(BROWSER_KEY) !== '0');
  };

  /* =====================================================================
     导航按钮 / omnibox 地址栏
     ===================================================================== */
  BrowserUI.prototype.setupNavButtons = function () {
    var self = this;
    var ipc = this.ipc;
    this.ui.btnBack.addEventListener('click', function () { self.clearBlank(); ipc.call('browserBack'); });
    this.ui.btnForward.addEventListener('click', function () { self.clearBlank(); ipc.call('browserForward'); });
    this.ui.btnReload.addEventListener('click', function () { self.clearBlank(); ipc.call('browserReload'); });
    this.ui.btnHome.addEventListener('click', function () { self.clearBlank(); ipc.call('browserHome'); });
    this.ui.btnDevtools.addEventListener('click', function () { ipc.call('browserDevtools'); });

    // 在外部浏览器打开当前地址栏 URL：空/非 http(s) 时不动
    this.ui.btnOpenExternal.addEventListener('click', function () {
      var u = self.ui.urlInput.value.trim();
      if (!/^https?:\/\//i.test(u)) return;
      ipc.call('browserOpenExternal', u);
    });
  };

  BrowserUI.prototype.setupOmnibox = function () {
    var self = this;
    this.ui.urlInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var url = self.ui.urlInput.value.trim();
      if (!url) return;
      // omnibox 语义（对齐 Chrome 地址栏）：看着像域名/URL 才当网址，否则当搜索词。
      // 判定：带协议头 / localhost:port / 形如 a.b 的域名（含 Unicode 域名）。
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
     收藏夹（localStorage 简易实现，上限 50 条）
     ===================================================================== */
  BrowserUI.prototype.getFavs = function () {
    try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (e) { return []; }
  };
  BrowserUI.prototype.saveFavs = function (list) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch (e) {}
  };
  BrowserUI.prototype.refreshFavState = function () {
    var url = this.ui.urlInput.value.trim();
    var fav = this.getFavs().some(function (f) { return f.url === url; });
    this.ui.btnFavorite.classList.toggle('active', fav);
    this.ui.btnFavorite.title = fav ? '取消收藏' : '收藏此页';
  };

  BrowserUI.prototype.setupFavorite = function () {
    var self = this;
    this.ui.btnFavorite.addEventListener('click', function () {
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
          var ts = self.state.tabsState;
          var active = (ts.tabs || []).find(function (t) { return t.id === ts.activeId; });
          title = (active && active.title) || url;
        } catch (e) {}
        list.unshift({ url: url, title: title });
        if (list.length > 50) list.length = 50;      // 上限 50，防无限膨胀
      }
      self.saveFavs(list);
      self.refreshFavState();
    });

    // 地址栏 URL 变化时刷新收藏态（url-input 没有变更事件，轻轮询兜底）
    var lastVal = '';
    this._favPollTimer = setInterval(function () {
      if (self.ui.urlInput.value !== lastVal) {
        lastVal = self.ui.urlInput.value;
        if (document.activeElement !== self.ui.urlInput) self.refreshFavState();
      }
    }, 800);
  };

  /* ---- 收藏弹层（#btn-more）：列出收藏，点击导航，✕ 移除 ---- */
  BrowserUI.prototype.renderMorePop = function () {
    var self = this;
    var pop = this.ui.morePop;
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
    var st = this.state;
    if (state) st.tabsState = { activeId: state.activeId, tabs: state.tabs || [] };
    var ts = st.tabsState;
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
    this.ui.btnTabNew.addEventListener('click', function () {
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
     浮层定位（保留防溢出逻辑：popoverRightEdge）

     原生浏览器 view 永远在渲染层 DOM 之上，弹层横向范围必须限制在
     「左栏+中栏」内 —— 浏览器面板可见时以它的左缘为界，否则贴窗口右缘。
     ===================================================================== */
  BrowserUI.prototype.popoverRightEdge = function () {
    if (!this.ui.browserPane.classList.contains('collapsed')) {
      var left = this.ui.browserPane.getBoundingClientRect().left;
      if (left > 0) return left - 8;
    }
    return window.innerWidth - 12;
  };

  BrowserUI.prototype.positionPopoverXY = function (pop, x, y) {
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
    this.ui.downloadPop.classList.add('hidden');
    this.ui.morePop.classList.add('hidden');
    if (typeof this.hooks.closePopovers === 'function') this.hooks.closePopovers();
  };

  BrowserUI.prototype.closePopups = function () {
    this._closePopovers();
  };

  /* =====================================================================
     主进程事件入口：browser_url / browser_tabs
     由 app.js 的 handleEvent 分发到这里（或直接挂 api.onEvent）
     ===================================================================== */
  BrowserUI.prototype.handleEvent = function (evt) {
    if (!evt || !evt.type) return false;
    var st = this.state;
    switch (evt.type) {
      case 'browser_url':
        // 新建空标签页期间不让底层页面的 URL/标题回写到地址栏与标签上
        if (!st.blankOverride && document.activeElement !== this.ui.urlInput) {
          this.ui.urlInput.value = evt.url || '';
        }
        this.ui.btnBack.disabled = !evt.canBack;
        this.ui.btnForward.disabled = !evt.canForward;
        this.ui.urlLock.classList.toggle('hidden', st.blankOverride || !/^https:/i.test(evt.url || ''));
        this.ui.btnReload.classList.toggle('loading', !!evt.loading);
        this.ui.btnReload.title = evt.loading ? '加载中…' : '刷新';
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
     init：接线全部事件 + 启动 ResizeObserver
     ===================================================================== */
  BrowserUI.prototype.init = function () {
    var self = this;

    this.setupNavButtons();
    this.setupOmnibox();
    this.setupFavorite();
    this.setupTabs();

    // 下载 / 收藏弹层触发按钮
    this.ui.btnDownload.addEventListener('click', function () { self.showDownloads(); });
    this.ui.btnMore.addEventListener('click', function () { self.showFavorites(); });

    // 右栏开关按钮（标题栏 / 中栏上下文行 / #shell 右上角永恒按钮）
    if (this.ui.btnBrowser) {
      this.ui.btnBrowser.addEventListener('click', function () { self.toggleBrowser(); });
    }
    if (this.ui.btnBrowserInline) {
      this.ui.btnBrowserInline.addEventListener('click', function () { self.toggleBrowser(); });
    }
    if (this.ui.btnShowBrowser) {
      this.ui.btnShowBrowser.addEventListener('click', function () { self.toggleBrowser(); });
    }

    // bounds 上报：窗口 resize + slot 尺寸变化 + 页面 load
    var rafReport = function () { self.reportBounds(); };
    window.addEventListener('resize', rafReport);
    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(rafReport);
      this._resizeObserver.observe(this.ui.browserSlot);
    }
    window.addEventListener('load', rafReport);

    // 新标签页快捷站点网格（含收藏置换）
    this.renderEmptyGrid();
  };

  // 模块卸载（目前单页应用用不到，留作测试钩子）
  BrowserUI.prototype.destroy = function () {
    if (this._favPollTimer) { clearInterval(this._favPollTimer); this._favPollTimer = null; }
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
  };

  window.BrowserUI = BrowserUI;
})();
