/* =========================================================================
   pi-desktop 渲染层逻辑
   - 与主进程通过 window.piAPI 通信（preload 注入）
   - 极简 markdown 渲染（自研，无外部依赖）
   - #browser-slot 位置上报（主进程据此定位原生 WebContentsView）
   ========================================================================= */
(function () {
  'use strict';

  // 主进程未注入时（如浏览器里直接打开）用空实现兜底，保证 UI 不崩
  var api = window.piAPI || {};
  function call(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (typeof api[name] === 'function') return api[name].apply(api, args);
    return Promise.resolve(null);
  }

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    titlebar: $('titlebar'),
    sessionTitle: $('session-title'),
    modelBtn: $('model-btn'),
    modelLabel: $('model-label'),
    thinkingBtn: $('thinking-btn'),
    thinkingLabel: $('thinking-label'),
    modelPop: $('model-pop'),
    modelSearch: $('model-search'),
    modelList: $('model-list'),
    thinkingPop: $('thinking-pop'),
    btnTheme: $('btn-theme'),
    btnBrowser: $('btn-browser'),
    btnShowSidebar: $('btn-show-sidebar'),
    shell: $('shell'),
    btnNavBack: $('btn-nav-back'),
    btnNavForward: $('btn-nav-forward'),
    btnBrand: $('btn-brand'),
    btnSearch: $('btn-search'),
    btnNotify: $('btn-notify'),
    navScheduled: $('nav-scheduled'),
    navPlugins: $('nav-plugins'),
    navMore: $('nav-more'),
    btnAddProject: $('btn-add-project'),
    btnHelp: $('btn-help'),
    sidebar: $('sidebar'),
    shell: $('shell'),
    resizeLeft: $('resize-left'),
    resizeRight: $('resize-right'),
    searchRow: $('search-row'),
    sessionSearch: $('session-search'),
    btnSearchClear: $('btn-search-clear'),
    searchStat: $('search-stat'),
    btnNew: $('btn-new'),
    sessionList: $('session-list'),
    cwdPop: $('cwd-pop'),
    thread: $('thread'),
    findBar: $('find-bar'),
    findInput: $('find-input'),
    findCount: $('find-count'),
    center: $('center'),
    emptyState: $('empty-state'),
    suggestions: $('suggestions'),
    messages: $('messages'),
    input: $('input'),
    composer: $('composer'),
    btnAttach: $('btn-attach'),
    btnPlugins: $('btn-plugins'),
    ctxCwd: $('ctx-cwd'),
    btnBrowserInline: $('btn-toggle-browser-inline'),
    btnCompact: $('btn-compact'),
    btnSend: $('btn-send'),
    btnStop: $('btn-stop'),
    browserPane: $('browser-pane'),
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
    btnImport: $('btn-import'),
    importOverlay: $('import-overlay'),
    importResult: $('import-result'),
    importConfirm: $('import-confirm'),
    importCancel: $('import-cancel'),
    btnDevtools: $('btn-devtools'),
    sessionCtxMenu: $('session-ctx-menu'),
    downloadPop: $('download-pop'),
    morePop: $('more-pop'),
    branchPop: $('branch-pop'),
    compactBar: $('compact-bar'),
    compactBarHead: $('compact-bar-head'),
    compactBarLabel: $('compact-bar-label'),
    compactBarTime: $('compact-bar-time'),
    compactBarBody: $('compact-bar-body'),
    beGrid: $('be-grid')
  };

  /* =======================================================================
     一、极简 markdown 渲染
     顺序：HTML 转义 → 抽出代码块 → 行级块解析 → 行内标记 → 还原
     ======================================================================= */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 行内标记：先把 `code` 换成占位符，避免其内部的 * _ 被当作标记
  function renderInline(text) {
    var codes = [];
    var out = text.replace(/`([^`\n]+)`/g, function (_, code) {
      codes.push(code);
      return '\u0000C' + (codes.length - 1) + '\u0000';
    });

    // 链接 [文字](url)，只放行 http(s) 与 mailto，防 javascript: 注入
    out = out.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, function (m, label, href) {
      if (!/^(https?:|mailto:)/i.test(href)) return escapeHtml(m);
      return '<a href="' + href + '" target="_blank" rel="noopener">' + (label || href) + '</a>';
    });

    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    return out.replace(/\u0000C(\d+)\u0000/g, function (_, i) {
      return '<code>' + codes[+i] + '</code>';
    });
  }

  function codeBlockHtml(lang, code) {
    return '<div class="codeblock">' +
      '<div class="codeblock-head"><span>' + (lang || 'text') + '</span>' +
      '<button class="copy-btn" data-copy>复制</button></div>' +
      '<pre><code>' + code + '</code></pre></div>';
  }

  // 行级块解析（输入已转义）
  function renderBlocks(src) {
    var lines = src.split('\n');
    var html = '';
    var para = [];          // 段落缓冲
    var list = null;        // {tag:'ul'|'ol', items:[]}
    var quote = [];         // 引用缓冲

    function flushPara() {
      if (!para.length) return;
      html += '<p>' + renderInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>';
      para = [];
    }
    function flushList() {
      if (!list) return;
      html += '<' + list.tag + '>' +
        list.items.map(function (t) { return '<li>' + renderInline(t) + '</li>'; }).join('') +
        '</' + list.tag + '>';
      list = null;
    }
    function flushQuote() {
      if (!quote.length) return;
      html += '<blockquote>' + renderInline(quote.join('\n')).replace(/\n/g, '<br>') + '</blockquote>';
      quote = [];
    }
    function flushAll() { flushPara(); flushList(); flushQuote(); }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      if (!line.trim()) { flushAll(); continue; }

      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flushAll();
        var lv = Math.min(h[1].length, 3);
        html += '<h' + lv + '>' + renderInline(h[2]) + '</h' + lv + '>';
        continue;
      }

      // 分割线：三个以上同种符号（--- / *** / ___）
      if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
        flushAll(); html += '<hr>'; continue;
      }

      var q = /^&gt;\s?(.*)$/.exec(line);
      if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }

      var ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      var ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara(); flushQuote();
        var tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag: tag, items: [] }; }
        list.items.push((ul || ol)[1]);
        continue;
      }

      flushList(); flushQuote();
      para.push(line);
    }
    flushAll();
    return html;
  }

  // 主入口：markdown → HTML 字符串
  function renderMarkdown(src) {
    var escaped = escapeHtml(src);
    var blocks = [];

    // 抽出围栏代码块（含未闭合的流式代码块）
    var text = escaped.replace(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g, function (_, lang, code) {
      blocks.push(codeBlockHtml(lang.trim(), code.replace(/\n$/, '')));
      return '\n\u0000B' + (blocks.length - 1) + '\u0000\n';
    });

    return renderBlocks(text).replace(
      /<p>\s*\u0000B(\d+)\u0000\s*<\/p>|\u0000B(\d+)\u0000/g,
      function (_, a, b) { return blocks[+(a != null ? a : b)]; }
    );
  }

  /* =======================================================================
     二、通用小工具：相对时间 / 思考等级中文名
     ======================================================================= */

  // mtime → 「3 分钟前 / 昨天 / 3 天前 / 12月30日」
  function relTime(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 0) return '';
    var m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    var d = Math.floor(h / 24);
    if (d === 1) return '昨天';
    if (d < 7) return d + ' 天前';
    var dt = new Date(ts);
    var md = (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
    return dt.getFullYear() === new Date().getFullYear() ? md : (dt.getFullYear() + '年' + md);
  }

  var THINKING_ZH = {
    off: '关闭', minimal: '极简', low: '低',
    medium: '中', high: '高', xhigh: '极高'
  };
  function thinkingZh(level) {
    return THINKING_ZH[level] || String(level || '');
  }

  /* =======================================================================
     三、主题
     ======================================================================= */
  var THEME_KEY = 'pi-theme';

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }
  function systemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  // 默认暗色；暂不跟随系统，systemTheme() 保留给后续「跟随系统」选项用
  void systemTheme;
  function initTheme() {
    // 默认暗色（跟 Codex 一致），手动切过就记住用户选择
    applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
  }
  el.btnTheme.addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });

  /* =======================================================================
     四、#browser-slot 位置上报
     真实浏览器是主进程贴的原生 view，不受 CSS 影响，必须把矩形同步过去
     ======================================================================= */
  var boundsPending = false;
  var lastBounds = '';

  // 量 rect → 去重 → 下发。同步执行，不经 rAF。
  function sendBounds() {
    if (el.browserPane.classList.contains('collapsed')) return;
    var r = el.browserSlot.getBoundingClientRect();
    var b = {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height)
    };
    var key = b.x + ',' + b.y + ',' + b.width + ',' + b.height;
    if (key === lastBounds) return;        // 位置没变就不打扰主进程
    lastBounds = key;
    call('browserBounds', b);
  }

  // 常规路径：rAF 节流，避免 resize 风暖时刷爆 IPC
  function reportBounds() {
    if (boundsPending) return;
    boundsPending = true;
    requestAnimationFrame(function () {
      boundsPending = false;
      sendBounds();
    });
  }

  /* 【重要】拖拽栏宽时必须走这个同步版，不能靠 rAF：
     窗口被遮挡 / 不在前台时 document.visibilityState 为 'hidden'，
     Chromium 会把 requestAnimationFrame 完全饱死（已实测：回调数秒不触发），
     那时 reportBounds() 会静默失效，原生 view 就停在旧位置错位。
     pointermove 本身已经是输入频率（≤120Hz），setBounds 很便宜，直接同步发。 */
  function reportBoundsNow() {
    boundsPending = false;                 // 废掉可能残留的 rAF 标志
    sendBounds();
  }

  window.addEventListener('resize', reportBounds);
  if (window.ResizeObserver) new ResizeObserver(reportBounds).observe(el.browserSlot);
  window.addEventListener('load', reportBounds);

  /* =======================================================================
     四之二、栏宽拖拽（#resize-left / #resize-right）

     宽度真正的取值处是 CSS 变量 --sidebar-width / --browser-width，JS 只改变量，
     这样：① 不动 grid-template-columns；② 与 .collapsed（display:none）不打架——
     折叠时宽度变量仍保留用户值，展开后自然恢复。

     【关键正确性】拖拽时原生 WebContentsView 必须跟手：
     虽然 ResizeObserver 盯着 #browser-slot，但不能只指望它（左栏变宽时 slot 尺寸
     不变、只是位置平移，ResizeObserver 根本不触发），所以 pointermove 里每帧
     都主动调 reportBounds()，拖完 pointerup 再补一次。
     ======================================================================= */
  var WIDTH_KEY = 'pi-col-widths';
  var SIDEBAR_DEFAULT = 260;
  var BROWSER_DEFAULT = 480;
  var SIDEBAR_MIN = 200, SIDEBAR_MAX = 420;
  var BROWSER_MIN = 320, BROWSER_MAX = 900;
  var CENTER_MIN = 420;                 // 中栏剩余宽度下限，不够就不让继续拖

  var colW = { sidebar: SIDEBAR_DEFAULT, browser: BROWSER_DEFAULT };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // 写入 CSS 变量（手柄位置也是用这两个变量 calc 出来的，一并跟随）
  function applyWidths() {
    var root = document.documentElement.style;
    root.setProperty('--sidebar-width', colW.sidebar + 'px');
    root.setProperty('--browser-width', colW.browser + 'px');
  }

  // 当前布局下中栏能拿到的宽度（折叠的栏不占位）
  function centerWidth(sidebarW, browserW) {
    var total = el.shell.clientWidth;
    var s = el.sidebar.classList.contains('collapsed') ? 0 : sidebarW;
    var b = el.browserPane.classList.contains('collapsed') ? 0 : browserW;
    return total - s - b;
  }

  function loadWidths() {
    try {
      var saved = JSON.parse(localStorage.getItem(WIDTH_KEY) || 'null');
      if (saved) {
        if (saved.sidebar) colW.sidebar = clamp(saved.sidebar, SIDEBAR_MIN, SIDEBAR_MAX);
        if (saved.browser) colW.browser = clamp(saved.browser, BROWSER_MIN, BROWSER_MAX);
      }
    } catch (e) { /* 存的值坏了就用默认 */ }
    applyWidths();
    reportBoundsNow();                  // 应用完必须补报一次，否则原生 view 停在默认位置
  }

  function saveWidths() {
    localStorage.setItem(WIDTH_KEY, JSON.stringify(colW));
  }

  // side: 'sidebar' 向右拖变宽；'browser' 向左拖变宽（故 dx 取反）
  function bindResizer(node, side) {
    if (!node) return;
    var startX = 0, startW = 0, dragging = false;

    node.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startW = colW[side];
      node.classList.add('dragging');
      document.body.classList.add('resizing');
      // 捕获指针：鼠标离开 5px 手柄后仍能收到 pointermove。
      // 合成事件（自动化测试）的 pointerId 不存在会抛 NotFoundError，包住不影响拖拽。
      try { node.setPointerCapture(e.pointerId); } catch (err) { /* 合成指针 */ }
      e.preventDefault();
    });

    node.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var raw = side === 'sidebar' ? (startW + dx) : (startW - dx);
      var next = side === 'sidebar'
        ? clamp(raw, SIDEBAR_MIN, SIDEBAR_MAX)
        : clamp(raw, BROWSER_MIN, BROWSER_MAX);

      // 中栏不能被挤得比 CENTER_MIN 还窄：已经越线且还在变宽就直接丢弃本帧
      var cur = colW[side];
      var w = { sidebar: colW.sidebar, browser: colW.browser };
      w[side] = next;
      if (centerWidth(w.sidebar, w.browser) < CENTER_MIN && next > cur) return;
      if (next === cur) return;

      colW[side] = next;
      applyWidths();
      reportBoundsNow();                // 每个 move 同步给主进程，原生 view 才能跟手
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      node.classList.remove('dragging');
      document.body.classList.remove('resizing');
      try { node.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
      saveWidths();
      lastBounds = '';                  // 强制重报，确保最终位置一定落实
      reportBoundsNow();
    }
    node.addEventListener('pointerup', endDrag);
    node.addEventListener('pointercancel', endDrag);

    // 双击重置为默认宽度
    node.addEventListener('dblclick', function () {
      colW[side] = side === 'sidebar' ? SIDEBAR_DEFAULT : BROWSER_DEFAULT;
      applyWidths();
      saveWidths();
      lastBounds = '';
      reportBoundsNow();
    });
  }

  bindResizer(el.resizeLeft, 'sidebar');
  bindResizer(el.resizeRight, 'browser');

  /* =======================================================================
     五、右栏 / 左栏折叠 + 浏览器空状态

     原生 WebContentsView 永远盖在渲染层 DOM 之上，所以 #browser-empty（普通 DOM）
     只有在主进程把 view 缩到 0 时才看得见。这里用两个【互相独立】的标志位：
       paneVisible —— 用户手动开/关右栏（持久化到 localStorage）
       pageBlank   —— 当前页面是 about:blank / 空（由 browser_url 事件推导）
       blankOverride — 用户点「+ 新建标签页」置的手动空页标记
     真正下发给主进程的可见性 = paneVisible && !isBlank()，统一走 syncBrowserView()。
     这样「用户折叠右栏」与「页面为空所以让 view 让位给空状态」不会互相打架。
     ======================================================================= */
  var BROWSER_KEY = 'pi-browser-visible';
  var paneVisible = false;      // 右栏 DOM 是否展开（用户意图）
  // 主进程创建 view 时就直接 loadURL(HOME_URL)，而首个 browser_url 事件可能比
  // 渲染层注册监听更早（丢包）。因此初值取【乐观】：先当作已有页面，
  // 宁可多显一帧真页面，也不要出现「空状态盖住已加载页面」的死锁。
  var pageBlank = false;        // 当前 URL 是否为空页（由 browser_url 事件推导）
  var blankOverride = false;    // 手动「新建标签页」置的空页标记（见 btnTabNew）
  var lastViewVisible = null;   // 上一次下发给主进程的 view 可见性，去抖

  function isBlank() { return blankOverride || pageBlank; }

  // （已拆）外置 Chrome 模式下线：Cookie 导入已解决 Google 登录（详见「从 Chrome 导入」），
  // 独立 Chrome 窗口方案失去存在意义，右栏只保留内置浏览器。
  // 主进程 chrome-bridge.js 及其 IPC 暂留（无害），UI 入口全部移除。

  function syncBrowserView() {
    // 导入模态框打开期间不让原生 view 遮住模态框（原生 view 永远在 DOM 之上）
    var modalHold = importModalOpen;
    // 原生 view / 空状态互斥占同一块矩形：原生 view 永远盖在 DOM 之上，
    // 所以空状态可见时必须把 view 缩到 0x0。
    var showEmpty = paneVisible && isBlank();
    el.browserEmpty.classList.toggle('hidden', !showEmpty);

    var viewVisible = paneVisible && !isBlank() && !modalHold;
    if (viewVisible !== lastViewVisible) {
      lastViewVisible = viewVisible;
      call('browserToggle', viewVisible);
    }
    // 即使 view 当前不可见也要把 rect 报上去，主进程会缓存，
    // 等页面真正加载时直接按最新 rect 贴出来，避免闪一帧错位
    lastBounds = '';                          // 强制下次上报
    if (paneVisible) reportBoundsNow();
  }

  // 任何显式导航动作都要销掉「新建空标签页」标记，否则空状态会一直盖着真页面
  function clearBlank() {
    if (!blankOverride) return;
    blankOverride = false;
    syncBrowserView();
  }

  function setBrowserVisible(visible) {
    paneVisible = !!visible;
    el.browserPane.classList.toggle('collapsed', !paneVisible);
    // 右栏折叠后在 #shell 打标，让中栏右缘的展开把手现身（同左栏 sidebar-hidden 模式）
    if (el.shell) el.shell.classList.toggle('browser-hidden', !paneVisible);
    // 折叠时把 grid 轨道归零（新方案：不用 display:none —— 那样 Chromium 的
    // grid 会把 item 剔除但轨道塌缩错位，右半屏变死区，实测踩过）。
    // 展开时移除归零变量，轨道回落到 --browser-width。
    document.documentElement.style.setProperty('--browser-track', paneVisible ? '' : '0px');
    el.btnBrowser.classList.toggle('active', paneVisible);
    el.btnBrowserInline.classList.toggle('active', paneVisible);
    localStorage.setItem(BROWSER_KEY, paneVisible ? '1' : '0');
    syncBrowserView();
  }

  function toggleBrowser() { setBrowserVisible(!paneVisible); }

  el.btnBrowser.addEventListener('click', toggleBrowser);
  el.btnBrowserInline.addEventListener('click', toggleBrowser);   // 中栏上下文行
  // 右栏永恒按钮(#shell 右上角):点击切换右栏开/关,位置恒定不随栏状态变化
  if (el.btnShowBrowser) el.btnShowBrowser.addEventListener('click', toggleBrowser);

  /* （已拆）「五之二 Chrome 来源切换」整段移除：Cookie 导入已解决 Google 登录，
     外置 Chrome 窗口方案下线。主进程 chrome-bridge 保留但不再被 UI 触发。 */

  var SIDEBAR_KEY = 'pi-sidebar-hidden';

  function setSidebarHidden(hidden) {
    el.sidebar.classList.toggle('collapsed', hidden);
    // 同上：轨道归零而非 display:none（详见 #shell 注释）
    document.documentElement.style.setProperty('--sidebar-track', hidden ? '0px' : '');
    // #shell 上的标记让中栏那个展开按钮现身（见 styles.css）。
    // 不这么做的话，折叠后连折叠按钮自己也一起隐了，就打不开了。
    if (el.shell) el.shell.classList.toggle('sidebar-hidden', hidden);
    try { localStorage.setItem(SIDEBAR_KEY, hidden ? '1' : '0'); } catch (e) {}
    reportBoundsNow();                        // 中栏变宽 → slot 位置变了
  }

  function toggleSidebar() {
    setSidebarHidden(!el.sidebar.classList.contains('collapsed'));
  }

  // 左栏永恒按钮(#shell 左上角,红绿灯右侧):点击切换左栏开/关,位置恒定
  if (el.btnShowSidebar) el.btnShowSidebar.addEventListener('click', toggleSidebar);

  // 启动时恢复上次的折叠状态（默认展开）
  try {
    if (localStorage.getItem(SIDEBAR_KEY) === '1') setSidebarHidden(true);
  } catch (e) {}

  // 左栏 + 中栏卡片 + 右栏占位按钮：会话历史前进/后退、通知、已安排、
  // 插件、帮助、附件、展开
  // 暂未实现，先给 hover 体验与日志占位
  // （#btn-search 已实装为会话搜索；#btn-open-external / #btn-download / #btn-more
  //  已实装，均不在此列）
  [
    ['btnNavBack', 'nav:back'],
    ['btnNavForward', 'nav:forward'],
    ['btnBrand', 'brand'],
    ['btnNotify', 'notify'],
    ['navScheduled', 'scheduled'],
    ['navPlugins', 'plugins'],
    ['btnHelp', 'help'],
    ['btnAttach', 'composer:attach'],
    ['btnPlugins', 'composer:plugins']
  ].forEach(function (pair) {
    var node = el[pair[0]];
    if (!node) return;
    node.addEventListener('click', function () {
      console.debug('[pi-desktop] 占位按钮待实现：' + pair[1]);
    });
  });

  el.btnBack.addEventListener('click', function () { clearBlank(); call('browserBack'); });
  el.btnForward.addEventListener('click', function () { clearBlank(); call('browserForward'); });
  el.btnReload.addEventListener('click', function () { clearBlank(); call('browserReload'); });
  el.btnHome.addEventListener('click', function () { clearBlank(); call('browserHome'); });
  el.btnDevtools.addEventListener('click', function () { call('browserDevtools'); });

  // ☆ 收藏当前页（对齐 Codex 地址栏的收藏位）。存 localStorage 的简易收藏夹；
  // 已收藏时再点 = 取消。标题取当前标签标题，url 取地址栏值。
  var FAV_KEY = 'pi-browser-favorites';
  function getFavs() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveFavs(list) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function refreshFavState() {
    var url = el.urlInput.value.trim();
    var fav = getFavs().some(function (f) { return f.url === url; });
    el.btnFavorite.classList.toggle('active', fav);
    el.btnFavorite.title = fav ? '取消收藏' : '收藏此页';
  }
  el.btnFavorite.addEventListener('click', function () {
    var url = el.urlInput.value.trim();
    if (!/^https?:\/\//.test(url)) return;          // 没有真页面不收藏
    var list = getFavs();
    var i = list.findIndex(function (f) { return f.url === url; });
    if (i >= 0) list.splice(i, 1);
    else {
      // 标题从当前活动标签拿（tabStrip 渲染里有），拿不到就退回 url
      var title = '';
      try {
        var active = (tabsState && tabsState.tabs || []).find(function (t) { return t.id === tabsState.activeId; });
        title = active && active.title || url;
      } catch (e) {}
      list.unshift({ url: url, title: title });
      if (list.length > 50) list.length = 50;        // 上限 50，防无限膨胀
    }
    saveFavs(list);
    refreshFavState();
  });
  // 地址栏 URL 变化时刷新收藏态（browser_url 事件里已更新 urlInput.value）
  var _origUrlInputVal = '';
  setInterval(function () {                           // 轻轮询：url-input 没有变更事件
    if (el.urlInput.value !== _origUrlInputVal) {
      _origUrlInputVal = el.urlInput.value;
      if (document.activeElement !== el.urlInput) refreshFavState();
    }
  }, 800);

  /* ---- 标签页栏 ----
     【UI 占位】主进程目前只维护一个 WebContentsView，所以这里只有一个固定标签：
       「+」 = 把当前 view 导到 about:blank（当作新开一页）
       「✕」 = 回主页（当作关掉当前页）
     真正的多标签需要主进程新增：多个 WebContentsView + 切换可见性 + tab 列表 IPC，
     渲染层不能单方面假造。标题文字由 browser_url 事件的 title 字段驱动。 */
  var TAB_TITLE_MAX = 14;
  var TAB_BLANK = '新标签页';

  // 空页判定：about:blank / 空串 / about:* 都算「没开页面」
  function isBlankUrl(u) {
    var s = String(u || '').trim();
    return !s || /^about:/i.test(s);
  }

  /* ---------------------------------------------------------------------
     真多标签页：每个标签对应主进程一个真实的 WebContentsView。
     主进程通过 browser_tabs 事件推送全量列表，这边只负责画。
     标签的增/删/切全走 IPC，本地不维护状态（避免两边不一致）。
     --------------------------------------------------------------------- */
  var tabsState = { activeId: null, tabs: [] };

  function renderTabs(state) {
    if (state) tabsState = state;
    var frag = document.createDocumentFragment();

    tabsState.tabs.forEach(function (t) {
      var el2 = document.createElement('div');
      el2.className = 'tab' + (t.id === tabsState.activeId ? ' active' : '');
      el2.dataset.id = t.id;

      var ico = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ico.setAttribute('viewBox', '0 0 16 16');
      ico.innerHTML = '<circle cx="8" cy="8" r="6" /><line x1="2" y1="8" x2="14" y2="8" />' +
        '<path d="M8 2c1.9 2.2 1.9 9.8 0 12M8 2C6.1 4.2 6.1 11.8 8 14" />';
      el2.appendChild(ico);

      var raw = String(t.title || '').trim() || (isBlankUrl(t.url) ? TAB_BLANK : t.url);
      var span = document.createElement('span');
      span.className = 'tab-title';
      span.textContent = raw.length > TAB_TITLE_MAX ? raw.slice(0, TAB_TITLE_MAX) + '\u2026' : raw;
      span.title = t.url || raw;
      el2.appendChild(span);

      // 只剩一个标签时也保留关闭按钮：主进程会自动新开一个空白页
      var close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.title = '关闭标签页';
      close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
        '<line x1="4.5" y1="4.5" x2="11.5" y2="11.5" /><line x1="11.5" y1="4.5" x2="4.5" y2="11.5" /></svg>';
      close.addEventListener('click', function (e) {
        e.stopPropagation();                  // 不要触发“切到该标签”
        call('browserTabClose', t.id);
      });
      el2.appendChild(close);

      el2.addEventListener('click', function () {
        if (t.id !== tabsState.activeId) call('browserTabActivate', t.id);
      });
      frag.appendChild(el2);
    });

    el.tabStrip.innerHTML = '';
    el.tabStrip.appendChild(frag);
  }

  el.btnTabNew.addEventListener('click', function () {
    // 真开一个新 view。不再用 blankOverride 假装空页 ——
    // 有了真多标签后，新标签直接加载主页更符合直觉。
    blankOverride = false;
    call('browserTabNew');
    syncBrowserView();
  });

  el.urlInput.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var url = el.urlInput.value.trim();
    if (!url) return;
    // omnibox 语义（对齐 Chrome 地址栏）：看着像域名/URL 才当网址，否则当搜索词。
    // 判定：带协议头 / localhost:port / 形如 a.b 的域名（含中文域名等 Unicode）。
    var looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
      || /^about:/i.test(url)
      || (/^[^\s]+\.[^\s]{2,}$/.test(url) && !url.includes(' '));   // 例：example.com、baidu.com
    if (!looksLikeUrl) {
      // 搜索：输入「x」直接跳 Google 搜索结果页，登录态下就是个性化结果
      clearBlank();
      call('browserGo', 'https://www.google.com/search?hl=zh-CN&q=' + encodeURIComponent(url));
      return;
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^about:/i.test(url)) url = 'https://' + url;
    clearBlank();                             // 输了真 URL → 销掉空页标记，让 view 重新贴出来
    call('browserGo', url);
  });

  /* =======================================================================
     六、对话流渲染
     ======================================================================= */
  var stickToBottom = true;     // 用户手动上滚后不再强行拉回

  el.thread.addEventListener('scroll', function () {
    var gap = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight;
    stickToBottom = gap < 48;
  });
  function scrollToBottom() {
    if (stickToBottom) el.thread.scrollTop = el.thread.scrollHeight;
  }

  // 当前流式状态
  var cur = {
    msg: null,        // 助手消息容器
    text: null,       // {node, buf} 当前文本块
    think: null,      // {node, body, buf, t0} 当前思考块
    tools: {}         // id -> {node, body, t0}
  };
  var rafPending = false;

  // 首次产生消息：隐掉空状态标题，并把输入卡片从居中落回底部
  function markUsed() {
    el.emptyState.classList.add('hidden');
    el.center.classList.remove('thread-empty');
  }

  // 需要重绘时统一走 rAF，避免每个 delta 都同步渲染
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      if (cur.text) {
        cur.text.node.innerHTML = renderMarkdown(cur.text.buf) + '<span class="cursor"></span>';
      }
      if (cur.think) cur.think.body.textContent = cur.think.buf;
      scrollToBottom();
    });
  }

  function ensureAssistantMsg() {
    if (cur.msg) return cur.msg;
    markUsed();
    var d = document.createElement('div');
    d.className = 'msg assistant';
    el.messages.appendChild(d);
    cur.msg = d;
    return d;
  }

  function addUserMessage(text) {
    markUsed();
    var d = document.createElement('div');
    d.className = 'msg user';
    d.textContent = text;
    el.messages.appendChild(d);
    stickToBottom = true;
    scrollToBottom();
  }

  function appendText(delta) {
    var host = ensureAssistantMsg();
    if (!cur.text) {
      var d = document.createElement('div');
      d.className = 'md';
      host.appendChild(d);
      cur.text = { node: d, buf: '' };
    }
    cur.text.buf += delta;
    scheduleRender();
  }

  function appendThinking(delta) {
    var host = ensureAssistantMsg();
    if (!cur.think) {
      var box = document.createElement('div');
      box.className = 'thinking';
      box.innerHTML =
        '<button class="thinking-head" type="button">' +
        '<svg class="caret" viewBox="0 0 16 16"><polyline points="6,3 11,8 6,13"/></svg>' +
        '<span class="thinking-label">思考中…</span></button>' +
        '<div class="thinking-body"></div>';
      box.querySelector('.thinking-head').addEventListener('click', function () {
        box.classList.toggle('open');
      });
      host.appendChild(box);
      cur.think = {
        node: box,
        body: box.querySelector('.thinking-body'),
        label: box.querySelector('.thinking-label'),
        buf: '',
        t0: Date.now()
      };
    }
    cur.think.buf += delta;
    scheduleRender();
  }

  // 思考块收尾：标题改成"已思考 Ns"
  function finishThinking() {
    if (!cur.think) return;
    var s = Math.max(1, Math.round((Date.now() - cur.think.t0) / 1000));
    cur.think.label.textContent = '已思考 ' + s + ' 秒';
    cur.think.body.textContent = cur.think.buf;
    cur.think = null;
  }

  // 文本块收尾：去掉流式光标
  function finishText() {
    if (!cur.text) return;
    cur.text.node.innerHTML = renderMarkdown(cur.text.buf);
    cur.text = null;
  }

  var MAX_OUTPUT = 2000;    // 工具输出展示上限
  var BASH_FOLD_LINES = 15; // bash 输出超过此行数 → 收纳为「终端 ▸ N 行」折叠块

  function clip(s) {
    s = (s == null) ? '' : (typeof s === 'string' ? s : JSON.stringify(s, null, 2));
    if (s.length <= MAX_OUTPUT) return s;
    return s.slice(0, MAX_OUTPUT) + '\n\n… 已截断，共 ' + s.length + ' 字符';
  }

  /* bash 长输出收纳（P1-8）：tool_end 且 name=bash 且输出 > BASH_FOLD_LINES 行时，
     把 <pre> 装进「终端 ▸ N 行」折叠块（默认折叠），点击头部展开/收起。 */
  function maybeWrapBashOutput(toolName, pre, rawOutput) {
    if (toolName !== 'bash') return;
    var lines = String(rawOutput == null ? '' : rawOutput).split('\n').length;
    if (lines <= BASH_FOLD_LINES) return;
    var wrap = document.createElement('div');
    wrap.className = 'term-collapse';
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'term-collapse-head';
    head.innerHTML = '<svg class="caret" viewBox="0 0 16 16"><polyline points="6,3 11,8 6,13"/></svg>' +
      '<span>终端 ▸ ' + lines + ' 行</span>';
    head.addEventListener('click', function () {
      wrap.classList.toggle('open');
      head.querySelector('span').textContent =
        (wrap.classList.contains('open') ? '终端 ▾ ' : '终端 ▸ ') + lines + ' 行';
    });
    var body = document.createElement('div');
    body.className = 'term-collapse-body';
    pre.parentNode.insertBefore(wrap, pre);
    body.appendChild(pre);
    wrap.appendChild(head);
    wrap.appendChild(body);
  }

  // 工具卡片骨架（实时 tool_start 与历史回灌共用）
  function buildToolBox(name, args) {
    var box = document.createElement('div');
    box.className = 'tool';
    box.innerHTML =
      '<button class="tool-head" type="button">' +
      '<svg class="caret" viewBox="0 0 16 16"><polyline points="6,3 11,8 6,13"/></svg>' +
      '<span class="dot running"></span>' +
      '<span class="tool-name"></span><span class="tool-ms"></span></button>' +
      '<div class="tool-body"><div class="label">参数</div><pre class="tool-args"></pre></div>';
    box.querySelector('.tool-name').textContent = name || 'tool';
    box.querySelector('.tool-args').textContent = clip(args);
    box.querySelector('.tool-head').addEventListener('click', function () {
      box.classList.toggle('open');
    });
    return box;
  }

  function toolStart(evt) {
    finishThinking();
    finishText();
    var host = ensureAssistantMsg();
    var box = buildToolBox(evt.name, evt.args);
    host.appendChild(box);
    cur.tools[evt.id] = { node: box, t0: Date.now(), name: evt.name };
    scrollToBottom();
  }

  function toolEnd(evt) {
    var t = cur.tools[evt.id];
    if (!t) return;
    delete cur.tools[evt.id];
    var box = t.node;
    var dot = box.querySelector('.dot');
    dot.className = 'dot ' + (evt.ok ? 'ok' : 'fail');
    var ms = (typeof evt.ms === 'number') ? evt.ms : (Date.now() - t.t0);
    box.querySelector('.tool-ms').textContent = ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';

    var body = box.querySelector('.tool-body');
    var label = document.createElement('div');
    label.className = 'label';
    label.textContent = evt.ok ? '输出' : '错误';
    var pre = document.createElement('pre');
    pre.textContent = clip(evt.output);
    body.appendChild(label);
    body.appendChild(pre);
    maybeWrapBashOutput(t.name, pre, evt.output);   // bash 长输出 → 折叠收纳
    if (!evt.ok) box.classList.add('open');    // 失败时默认展开，方便看错误
    scrollToBottom();
  }

  function showError(message) {
    markUsed();
    var d = document.createElement('div');
    d.className = 'error-box';
    d.textContent = message || '未知错误';   // textContent 天然支持多行（white-space: pre-wrap）
    el.messages.appendChild(d);
    scrollToBottom();
  }

  // 居中灰色小字系统提示（如「上下文已压缩」）
  function showNotice(text) {
    if (!text) return;
    var d = document.createElement('div');
    d.className = 'notice';
    d.textContent = text;
    el.messages.appendChild(d);
    scrollToBottom();
  }

  /* ---- 置顶摘要横条（P1-8）----
     compaction_end 后主进程发 {type:'compaction', text, reason, aborted}。
     横条吸在消息流顶部（position:sticky），默认折叠显示
     「⚡ 上下文已压缩 · 点击展开」，展开出摘要全文；展开态存 localStorage。 */
  var COMPACT_BAR_KEY = 'pi-compact-bar-open';
  function setCompactBarOpen(open) {
    el.compactBar.classList.toggle('open', open);
    try { localStorage.setItem(COMPACT_BAR_KEY, open ? '1' : '0'); } catch (e) {}
  }
  el.compactBarHead.addEventListener('click', function () {
    setCompactBarOpen(!el.compactBar.classList.contains('open'));
  });
  function showCompaction(evt) {
    var text = (evt && evt.text) || '';
    var time = new Date();
    el.compactBarLabel.textContent = '⚡ 上下文已压缩 · 点击' +
      (el.compactBar.classList.contains('open') ? '收起' : '展开');
    el.compactBarTime.textContent =
      String(time.getHours()).padStart(2, '0') + ':' + String(time.getMinutes()).padStart(2, '0');
    el.compactBarBody.textContent = text.trim() || '（本次压缩未返回摘要文本）';
    el.compactBar.classList.remove('hidden');
    // 记住用户的展开偏好；默认折叠
    var open = false;
    try { open = localStorage.getItem(COMPACT_BAR_KEY) === '1'; } catch (e) {}
    el.compactBar.classList.toggle('open', open);
    el.compactBarLabel.textContent = '⚡ 上下文已压缩 · 点击' + (open ? '收起' : '展开');
  }

  /* =======================================================================
     七、输入框
     ======================================================================= */
  var running = false;

  // textarea 多行自适应（1~10 行，上限由 CSS max-height 卡住）
  // 卡片高度变化 → 右栏 slot 位置不变（不同栏），无需重报 bounds
  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = el.input.scrollHeight + 'px';
  }

  function setRunning(on) {
    running = on;
    el.input.disabled = on;
    el.btnSend.classList.toggle('hidden', on);
    el.btnStop.classList.toggle('hidden', !on);
    if (!on) el.input.focus();
  }

  function submit() {
    if (running) return;
    var text = el.input.value.trim();
    if (!text) return;
    addUserMessage(text);
    el.input.value = '';
    autoGrow();
    setRunning(true);
    call('send', text);
  }

  el.input.addEventListener('input', function () {
    autoGrow();
    el.btnSend.disabled = !el.input.value.trim();
  });
  el.input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  el.btnSend.addEventListener('click', submit);
  el.btnStop.addEventListener('click', function () { call('abort'); });
  el.btnSend.disabled = true;

  // 压缩上下文
  el.btnCompact.addEventListener('click', function () { call('compact'); });

  /* =======================================================================
     八、会话列表（真实数据 + 历史回灌）
     ======================================================================= */
  var activeSessionId = null;    // 用户在列表里点中的会话
  var currentSessionId = null;   // session_info 同步来的当前会话 id
  var SESS_PER_PROJECT = 6;      // 每个项目默认最多展示几条会话
  var expandedProjects = {};     // path -> true，已点「展开显示」的项目
  var sessionGroups = [];        // 分组数据缓存（listSessionsGrouped 的原样）
  var searchQuery = '';          // 会话搜索关键词（已 toLowerCase）

  function clearThread() {
    el.messages.innerHTML = '';
    el.emptyState.classList.remove('hidden');
    el.center.classList.add('thread-empty');   // 输入卡片重新居中
    cur = { msg: null, text: null, think: null, tools: {} };
    stickToBottom = true;
  }

  // 列表 id 是会话文件路径；session_info 的 sessionId 兜底比对
  function isActiveSession(s) {
    return s.id === activeSessionId || (!activeSessionId && s.id === currentSessionId);
  }

  // 内联 svg 图标（CSP 不允许内联 style/script，svg 标签本身没问题）
  var ICON_FOLDER =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M1.8 4.2h4l1.4 1.6h7v6.4a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2z"/></svg>';

  /* 命中片段高亮：【先转义再拼 <mark>】。
     会话标题 / 项目名都来自用户输入（会话名可能是首条提问文本），
     直接拼 innerHTML 会构成 XSS；这里把原串按命中位置切片，每片先过 escapeHtml()，
     只有我们自己生成的 <mark> 标签是真标签。 */
  function highlight(text, q) {
    var s = (text == null) ? '' : String(text);
    if (!q) return escapeHtml(s);
    var lower = s.toLowerCase();
    var out = '';
    var from = 0;
    var at;
    while ((at = lower.indexOf(q, from)) !== -1) {
      out += escapeHtml(s.slice(from, at)) +
        '<mark>' + escapeHtml(s.slice(at, at + q.length)) + '</mark>';
      from = at + q.length;
    }
    return out + escapeHtml(s.slice(from));
  }

  function sessionMatches(s, q) {
    return String(s.name || s.id || '').toLowerCase().indexOf(q) !== -1;
  }

  // 会话自定义名（右键「重命名」写入）：localStorage 映射 id(文件路径) -> 名字，
  // 不改 jsonl 本体。渲染列表时优先使用。
  var SESS_NAMES_KEY = 'pi-session-names';
  function getSessionNames() {
    try { return JSON.parse(localStorage.getItem(SESS_NAMES_KEY) || '{}'); } catch (e) { return {}; }
  }
  function setSessionName(id, name) {
    var map = getSessionNames();
    if (name) map[id] = name; else delete map[id];
    try { localStorage.setItem(SESS_NAMES_KEY, JSON.stringify(map)); } catch (e) {}
  }
  function sessionDisplayName(s) {
    return getSessionNames()[s.id] || s.name || s.id;
  }

  // 单条会话行
  // 当前渲染顺序里的会话 id 列表（跨项目按渲染顺序，Alt+←/→ 按这个翻）
  function currentSessionOrder() {
    var out = [];
    (sessionGroups || []).forEach(function (g) {
      (g.sessions || []).forEach(function (s) { out.push(s.id); });
    });
    return out;
  }
  // 切到指定会话（与列表点击同逻辑）
  function switchToSession(id) {
    var s = null;
    (sessionGroups || []).forEach(function (g) {
      (g.sessions || []).forEach(function (x) { if (x.id === id) s = x; });
    });
    if (!s || running || isActiveSession(s)) return;
    activeSessionId = s.id;
    el.sessionTitle.textContent = sessionDisplayName(s);
    delete el.sessionTitle.dataset.ephemeral;
    clearThread();
    call('switchSession', s.id);
    refreshSessions();
  }

  function buildSessionRow(s) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'session-item' + (isActiveSession(s) ? ' active' : '');
    var label = sessionDisplayName(s);
    // 无关键词时走 textContent（最安全），搜索态才用已转义的高亮 HTML
    if (searchQuery) b.innerHTML = highlight(label, searchQuery);
    else b.textContent = label;
    b.title = label + (s.mtime ? ' · ' + relTime(s.mtime) : '');
    b.dataset.sid = s.id;
    // 分支徽标（P1-7）：该会话 jsonl 里有 branch_summary 条目 → 标题后加 ⑂N，
    // 点击开弹层列各分叉摘要，点条目切到分叉点继续对话。
    if (s.branches > 0) {
      var badge = document.createElement('span');
      badge.className = 'branch-badge';
      badge.textContent = '⑂' + s.branches;
      badge.title = s.branches + ' 个分支（点击查看）';
      badge.addEventListener('click', function (e) {
        e.stopPropagation();                 // 别触发「切到该会话」
        openBranchPop(s, badge);
      });
      b.appendChild(badge);
    }
    b.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openSessionCtxMenu(s, e.clientX, e.clientY);
    });
    b.addEventListener('click', function () {
      if (running || isActiveSession(s)) return;
      activeSessionId = s.id;
      el.sessionTitle.textContent = sessionDisplayName(s);
      clearThread();
      call('switchSession', s.id);
      refreshSessions();
    });
    return b;
  }

  /* ---- 分支弹层（P1-7）----
     点徽标 → 拉 pi:listBranches 流式解析出的 branch_summary 条目；
     点条目 → pi:switchToBranch（主进程 switchSession 装载后
     navigateTree(branchFromId, {summarize:false})，纯内存移动 leaf，不落盘），
     主进程回灌该分支消息后 session_restored 事件负责重建对话流。 */
  function openBranchPop(s, anchor) {
    closePopovers();
    var pop = el.branchPop;
    pop.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'branch-head';
    head.textContent = '分支（点击切到分叉点）';
    pop.appendChild(head);
    var loading = document.createElement('div');
    loading.className = 'branch-empty';
    loading.textContent = '读取中…';
    pop.appendChild(loading);

    var r = anchor.getBoundingClientRect();
    positionPopoverXY(pop, r.left, r.bottom + 4);

    Promise.resolve(call('listBranches', s.file || s.id)).then(function (branches) {
      pop.innerHTML = '';
      pop.appendChild(head);
      if (!branches || !branches.length) {
        var em = document.createElement('div');
        em.className = 'branch-empty';
        em.textContent = '未读到分支摘要';
        pop.appendChild(em);
        return;
      }
      branches.forEach(function (br, idx) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'branch-item';
        var sum = document.createElement('span');
        sum.className = 'branch-sum';
        sum.textContent = (idx + 1) + '. ' + (br.summary || '（无摘要）').slice(0, 40);
        sum.title = br.summary || '';
        b.appendChild(sum);
        if (br.timestamp) {
          var t = document.createElement('span');
          t.className = 'branch-time';
          t.textContent = relTime(new Date(br.timestamp).getTime());
          b.appendChild(t);
        }
        b.addEventListener('click', function () {
          closePopovers();
          switchToBranch(s, br, idx + 1);
        });
        pop.appendChild(b);
      });
      var hint = document.createElement('div');
      hint.className = 'branch-hint';
      hint.textContent = '切换后新消息将从分叉点继续（不改写历史）';
      pop.appendChild(hint);
    }).catch(function () {
      loading.textContent = '读取失败';
    });
  }

  // 切到分叉点：切换当前会话指向 + 调主进程 navigateTree
  function switchToBranch(s, br, idx) {
    if (running) return;
    activeSessionId = s.id;
    el.sessionTitle.textContent = sessionDisplayName(s);
    clearThread();
    showNotice('正在切到分支 ' + idx + '…');
    Promise.resolve(call('switchToBranch', {
      file: s.file || s.id,
      branchFromId: br.fromId    // branch_summary.fromId = 被放弃路径的旧 leaf
    })).then(function (r) {
      if (r && r.ok) {
        showNotice('已切到分支 ' + idx + '，新消息将从分叉点继续');
      } else {
        showNotice('切换分支失败：' + ((r && r.err) || '未知错误'));
      }
      refreshSessions();
    }).catch(function (e) {
      showNotice('切换分支失败：' + ((e && e.message) || e));
      refreshSessions();
    });
  }

  /* 按项目分组渲染：项目行（可切工作区）+ 缩进的会话行。
     数据全部来自模块缓存 sessionGroups，搜索时只重渲染、不重新打 IPC。
     搜索态下：命中项全部展开（忽略 6 条上限），整组无命中则隐藏。 */
  function renderGroups() {
    var q = searchQuery;
    var groups = sessionGroups || [];
    el.sessionList.innerHTML = '';

    // 先算出可见分组与命中数（项目名命中 = 该项目下所有会话都算命中）
    var visible = [];
    var hits = 0;
    groups.forEach(function (g) {
      var list = g.sessions || [];
      var projHit = !!q && String(g.project || g.path || '').toLowerCase().indexOf(q) !== -1;
      var shown = (!q || projHit) ? list : list.filter(function (s) { return sessionMatches(s, q); });
      if (q && !projHit && !shown.length) return;      // 整组隐藏
      if (q) hits += shown.length;
      visible.push({ g: g, projHit: projHit, list: shown });
    });

    // 命中统计：仅搜索态可见
    el.searchStat.classList.toggle('hidden', !q);
    if (q) el.searchStat.textContent = hits ? ('找到 ' + hits + ' 个会话') : '没有匹配的会话';

    if (!visible.length) {
      var p = document.createElement('div');
      p.className = 'session-empty';
      p.textContent = q ? '没有匹配的会话' : '暂无项目';
      el.sessionList.appendChild(p);
      return;
    }

    visible.forEach(function (item) {
      var g = item.g;
      var block = document.createElement('div');
      block.className = 'proj-block';

      // 项目行：点击切换工作区
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'proj-row' + (g.current ? ' current' : '');
      row.innerHTML = ICON_FOLDER + '<span class="proj-name"></span>';
      var pn = row.querySelector('.proj-name');
      if (item.projHit) pn.innerHTML = highlight(g.project || g.path, q);   // 已转义
      else pn.textContent = g.project || g.path;
      row.title = g.path || '';
      row.addEventListener('click', function () {
        if (running || g.current) return;
        Promise.resolve(call('setCwd', g.path)).then(function () {
          refreshSessions();
        }).catch(function () {});
      });
      block.appendChild(row);

      var list = item.list;
      if (!list.length) {
        var none = document.createElement('div');
        none.className = 'session-none';
        none.textContent = '暂无聊天';
        block.appendChild(none);
        el.sessionList.appendChild(block);
        return;
      }

      // 搜索态强制全展，不受「只显 6 条」限制
      var expanded = !!q || !!expandedProjects[g.path];
      var shown = expanded ? list : list.slice(0, SESS_PER_PROJECT);
      shown.forEach(function (s) { block.appendChild(buildSessionRow(s)); });

      // 超过上限才出「展开显示 / 收起」（搜索态不出）
      if (!q && list.length > SESS_PER_PROJECT) {
        var more = document.createElement('button');
        more.type = 'button';
        more.className = 'session-more';
        more.textContent = expanded ? '收起' : '展开显示';
        more.addEventListener('click', function () {
          expandedProjects[g.path] = !expanded;
          renderGroups();                 // 缓存重渲染，不必重拉 IPC
        });
        block.appendChild(more);
      }

      el.sessionList.appendChild(block);
    });
  }

  function refreshSessions() {
    Promise.resolve(call('listSessionsGrouped')).then(function (groups) {
      sessionGroups = groups || [];
      renderGroups();
    }).catch(function () { sessionGroups = []; renderGroups(); });
  }

  /* ---- 会话右键菜单（重命名 / 删除 / 复制 ID）----
     自绘绝对定位小弹层，复用 .popover 样式；横向范围限制在
     「左栏+中栏」内（popoverRightEdge），不越过右栏原生 view 左缘。 */
  function positionPopoverXY(pop, x, y) {
    pop.classList.remove('hidden');
    var w = pop.offsetWidth;
    var h = pop.offsetHeight;
    var right = popoverRightEdge();
    var left = Math.max(8, Math.min(x, right - w));
    var top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }


  function openSessionCtxMenu(s, x, y) {
    var menu = el.sessionCtxMenu;
    menu.innerHTML = '';
    menu.dataset.sid = s.id;

    function item(text, danger, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item-btn' + (danger ? ' danger' : '');
      b.textContent = text;
      b.addEventListener('click', function () {
        closePopovers();
        fn();
      });
      menu.appendChild(b);
    }

    item('重命名', false, function () { renameSession(s); });
    item('删除', true, function () { deleteSession(s); });
    item('复制 ID', false, function () {
      navigator.clipboard.writeText(s.id).then(function () {
        showNotice('已复制会话 ID');
      }).catch(function () { showNotice('复制失败'); });
    });

    positionPopoverXY(menu, x, y);
  }

  // 重命名：行内输入覆盖在会话行上，Enter 确认 / Esc 取消。
  // 名字只存 localStorage['pi-session-names']，不改 jsonl 本体。
  function renameSession(s) {
    var rows = el.sessionList.querySelectorAll('.session-item');
    var row = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset && rows[i].dataset.sid === s.id) { row = rows[i]; break; }
    }
    var cur2 = sessionDisplayName(s);
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-rename-input';
    input.value = cur2;
    input.spellcheck = false;

    var done = false;
    function commit(ok) {
      if (done) return;
      done = true;
      var v = input.value.trim();
      if (ok && v && v !== cur2) {
        setSessionName(s.id, v);
        if (isActiveSession(s)) el.sessionTitle.textContent = v;
        showNotice('已重命名为「' + v + '」');
      }
      refreshSessions();
    }
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', function () { commit(true); });

    if (row && row.parentElement) {
      row.parentElement.replaceChild(input, row);
      input.focus();
      input.select();
    }
  }

  // 删除：确认后调主进程删 .jsonl 文件；删的是当前活动会话则回到新对话态
  function deleteSession(s) {
    var name = sessionDisplayName(s);
    if (!window.confirm('删除会话「' + name + '」？\n该操作会删除会话文件，不可恢复。')) return;
    Promise.resolve(call('deleteSession', s.file || s.id)).then(function (r) {
      if (r && r.ok) {
        setSessionName(s.id, '');            // 顺带清掉自定义名
        if (isActiveSession(s)) {
          activeSessionId = null;
          clearThread();
          el.sessionTitle.textContent = '新对话';
        }
        showNotice('会话已删除');
      } else {
        showNotice('删除失败：' + ((r && r.err) || '未知错误'));
      }
      refreshSessions();
    }).catch(function (e) {
      showNotice('删除失败：' + ((e && e.message) || e));
      refreshSessions();
    });
  }

  /* ---- 会话搜索（左栏品牌行 🔍）----
     展开搜索行 → 实时过滤缓存重渲染；Esc / 再点放大镜 / 点✕ 收起并清空。
     搜索行在左栏内部，不跨栏、不浮层，所以不会被右栏原生 view 遮住。 */
  function setSearchOpen(open) {
    el.searchRow.classList.toggle('hidden', !open);
    el.btnSearch.classList.toggle('active', open);
    if (open) {
      el.sessionSearch.focus();
      el.sessionSearch.select();
    } else {
      el.sessionSearch.value = '';
      searchQuery = '';
      el.searchStat.classList.add('hidden');
      renderGroups();
    }
  }

  el.btnSearch.addEventListener('click', function () {
    setSearchOpen(el.searchRow.classList.contains('hidden'));
  });
  el.btnSearchClear.addEventListener('click', function () { setSearchOpen(false); });
  el.sessionSearch.addEventListener('input', function () {
    searchQuery = el.sessionSearch.value.trim().toLowerCase();
    renderGroups();
  });
  el.sessionSearch.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.stopPropagation(); setSearchOpen(false); }
  });

  el.btnNew.addEventListener('click', function () {
    if (running) return;
    activeSessionId = null;
    clearThread();
    el.sessionTitle.textContent = '新对话';
    Promise.resolve(call('newSession')).then(refreshSessions);
  });

  // 临时聊天：不落盘，关掉即焚。UI 上给标题加「临时」标记提醒用户当前会话不会保存。
  el.btnEphemeral = $('btn-ephemeral');
  if (el.btnEphemeral) el.btnEphemeral.addEventListener('click', function () {
    if (running) return;
    activeSessionId = null;
    clearThread();
    el.sessionTitle.textContent = '临时聊天';
    el.sessionTitle.dataset.ephemeral = '1';
    call('newEphemeral').then(function (r) {
      refreshSessions();                 // 会话列表不变（没落盘），只刷新一下无妨
    });
  });
  // 正常新建对话时清掉临时标记
  var _origBtnNew = el.btnNew;
  _origBtnNew.addEventListener('click', function () {
    delete el.sessionTitle.dataset.ephemeral;
  });

  // 用历史消息重建对话流（switchSession 后主进程回灌）
  function restoreSession(payload) {
    clearThread();
    var msgs = (payload && payload.messages) || [];
    msgs.forEach(function (m) {
      if (m.role === 'user') {
        addUserMessage(m.text || '');
      } else if (m.role === 'assistant') {
        markUsed();
        var d = document.createElement('div');
        d.className = 'msg assistant';
        if ((m.text || '').trim()) {
          var md = document.createElement('div');
          md.className = 'md';
          md.innerHTML = renderMarkdown(m.text);
          d.appendChild(md);
        }
        (m.tools || []).forEach(function (t) {
          var box = buildToolBox(t.name || 'tool', t.args);
          box.querySelector('.dot').className = 'dot';   // 历史卡片：结果未知，灰色圆点
          d.appendChild(box);
        });
        el.messages.appendChild(d);
      }
    });
    stickToBottom = true;
    el.thread.scrollTop = el.thread.scrollHeight;
  }

  // 在外部浏览器打开当前地址栏 URL：空/非 http(s) 时不动
  el.btnOpenExternal.addEventListener('click', function () {
    var u = el.urlInput.value.trim();
    if (!/^https?:\/\//i.test(u)) return;
    call('browserOpenExternal', u);
  });

  /* ---- 下载弹层：列出下载目录最近 20 个文件，点击在 Finder 中定位 ---- */
  function fmtSize(n) {
    if (n == null || isNaN(n)) return '';
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'M';
    return (n / 1024 / 1024 / 1024).toFixed(1) + 'G';
  }

  function renderDownloadPop() {
    var pop = el.downloadPop;
    pop.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'dl-head';
    head.textContent = '下载目录最近文件';
    pop.appendChild(head);
    Promise.resolve(call('browserListDownloads')).then(function (r) {
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
        m.textContent = fmtSize(it.size);
        b.appendChild(n); b.appendChild(m);
        b.addEventListener('click', function () {
          call('browserShowInFolder', it.path);
        });
        pop.appendChild(b);
      });
    }).catch(function () {});
  }

  el.btnDownload.addEventListener('click', function () {
    var opening = el.downloadPop.classList.contains('hidden');
    closePopovers();
    if (!opening) return;
    renderDownloadPop();
    var r = el.btnDownload.getBoundingClientRect();
    positionPopoverXY(el.downloadPop, r.right - 300, r.bottom + 6);
  });

  /* ---- 收藏夹面板（#btn-more）：列出 localStorage 收藏，点击导航，✕ 移除 ---- */
  function renderMorePop() {
    var pop = el.morePop;
    pop.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'fav-head';
    head.textContent = '收藏';
    pop.appendChild(head);
    var favs = getFavs();
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
        var list = getFavs();
        list.splice(idx, 1);
        saveFavs(list);
        refreshFavState();
        renderMorePop();              // 移除后原地重绘，不关弹层
      });
      b.appendChild(texts); b.appendChild(rm);
      b.addEventListener('click', function () {
        closePopovers();
        clearBlank();
        call('browserGo', f.url);
        renderEmptyGrid();
      });
      pop.appendChild(b);
    });
  }

  el.btnMore.addEventListener('click', function () {
    var opening = el.morePop.classList.contains('hidden');
    closePopovers();
    if (!opening) return;
    renderMorePop();
    var r = el.btnMore.getBoundingClientRect();
    positionPopoverXY(el.morePop, r.right - 300, r.bottom + 6);
  });

  /* ---- 新标签页（空状态升级）：大标题 + 快捷站点网格。
     有收藏（≥1 条）时前 6 个快捷位换成收藏，否则用默认站点。 ---- */
  var BE_DEFAULT_SITES = [
    { url: 'https://www.google.com', name: 'Google' },
    { url: 'https://github.com', name: 'GitHub' },
    { url: 'https://x.com', name: 'X' },
    { url: 'https://www.youtube.com', name: 'YouTube' },
    { url: 'https://mail.google.com', name: 'Gmail' },
    { url: 'https://gemini.google.com', name: 'Gemini' }
  ];

  function renderEmptyGrid() {
    if (!el.beGrid) return;
    var favs = getFavs().map(function (f) {
      var host = '';
      try { host = new URL(f.url).hostname.replace(/^www\./, ''); } catch (e) {}
      return { url: f.url, name: f.title || host || f.url };
    });
    var tiles = (favs.length ? favs : BE_DEFAULT_SITES).slice(0, 6);
    el.beGrid.innerHTML = '';
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
        clearBlank();
        call('browserGo', s.url);
        renderEmptyGrid();
      });
      el.beGrid.appendChild(b);
    });
  }

  /* =======================================================================
     九、模型选择器弹层（下拉面板 + 搜索，替代原生 select）
     原生浏览器 view 永远在渲染层之上，面板必须限制在「左栏+中栏」横向范围内
     ======================================================================= */
  var models = [];               // [{id, name, provider, reasoning}]
  var currentModelId = '';
  var MODEL_CAP = 100;           // 渲染上限：1341 条全渲染会卡
  var FAVORITE_KEYS = ['glm-5.3-ioa', 'kimi-k3-ioa'];

  // 弹层右边界：浏览器面板可见时以它的左缘为界，否则贴窗口右缘
  function popoverRightEdge() {
    if (!el.browserPane.classList.contains('collapsed')) {
      var left = el.browserPane.getBoundingClientRect().left;
      if (left > 0) return left - 8;
    }
    return window.innerWidth - 12;
  }

  // 模型 / 思考等级按钮现在在输入卡片底部，弹层需【向上】展开：
  //   水平：右对齐按钮，但右边界不得越过 popoverRightEdge()
  //           （原生 WebContentsView 永远盖在 DOM 之上，越过就会被遮住）
  //   垂直：默认底部贴在按钮上方 6px（向上展开），高度不够就用 max-height 卡住让列表自己滚；
  //           只有上方空间小得没法用（< MIN_UP）且下方更宽裕时才回退到向下展开。
  //   注意：弹层必须先 remove('hidden') 才能量到 offsetHeight，所以本函数要在显示后调。
  function positionAbove(pop, anchor, width) {
    var right = popoverRightEdge();
    var r = anchor.getBoundingClientRect();
    var GAP = 6;
    var MARGIN = 8;
    var MIN_UP = 220;               // 向上展开至少需要这么多高度才可用

    pop.style.left = Math.max(MARGIN, Math.min(r.right, right) - width) + 'px';

    // 先清掉上一次的 max-height，否则量到的是被旧限制卡住的高度
    pop.style.maxHeight = '';
    var spaceAbove = r.top - GAP - MARGIN;
    var spaceBelow = window.innerHeight - r.bottom - GAP - MARGIN;
    var h = pop.offsetHeight;

    if (spaceAbove >= MIN_UP || spaceAbove >= spaceBelow) {
      pop.style.maxHeight = spaceAbove + 'px';
      pop.style.top = Math.max(MARGIN, r.top - GAP - Math.min(h, spaceAbove)) + 'px';
    } else {
      pop.style.maxHeight = spaceBelow + 'px';
      pop.style.top = (r.bottom + GAP) + 'px';
    }
  }

  function isPopoverOpen() {
    return !el.modelPop.classList.contains('hidden')
      || !el.thinkingPop.classList.contains('hidden')
      || !el.cwdPop.classList.contains('hidden')
      || !el.sessionCtxMenu.classList.contains('hidden')
      || !el.downloadPop.classList.contains('hidden')
      || !el.morePop.classList.contains('hidden')
      || !el.branchPop.classList.contains('hidden');
  }

  function closePopovers() {
    el.modelPop.classList.add('hidden');
    el.thinkingPop.classList.add('hidden');
    el.cwdPop.classList.add('hidden');
    el.sessionCtxMenu.classList.add('hidden');
    el.downloadPop.classList.add('hidden');
    el.morePop.classList.add('hidden');
    el.branchPop.classList.add('hidden');
    el.modelBtn.classList.remove('open');
    el.thinkingBtn.classList.remove('open');
    el.navMore.classList.remove('open');
    el.btnAddProject.classList.remove('open');
  }

  function modelMatches(m, q) {
    return ((m.id || '') + ' ' + (m.provider || '') + ' ' + (m.name || ''))
      .toLowerCase().indexOf(q) !== -1;
  }

  function renderModelList() {
    var q = el.modelSearch.value.trim().toLowerCase();
    el.modelList.innerHTML = '';

    // 分组：命中关键词的先进桶，常用置顶，其余按 provider 字典序
    var favs = [];
    var byProvider = {};
    var total = 0;
    models.forEach(function (m) {
      if (!modelMatches(m, q)) return;
      total++;
      var isFav = FAVORITE_KEYS.some(function (k) { return (m.id || '').indexOf(k) !== -1; });
      if (isFav) { favs.push(m); return; }
      var p = m.provider || '其他';
      (byProvider[p] = byProvider[p] || []).push(m);
    });

    var groups = [];
    if (favs.length) groups.push({ name: '常用', items: favs });
    Object.keys(byProvider).sort().forEach(function (p) {
      groups.push({ name: p, items: byProvider[p] });
    });

    function addItem(m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'model-item' + (m.id === currentModelId ? ' selected' : '');
      b.innerHTML = '<span class="model-id"></span>' +
        '<svg class="check" viewBox="0 0 16 16"><polyline points="3,8.5 6.5,12 13,4.5"/></svg>';
      b.querySelector('.model-id').textContent = m.id;
      b.title = m.name && m.name !== m.id ? m.name + ' · ' + (m.provider || '') : m.id;
      b.addEventListener('click', function () {
        currentModelId = m.id;
        el.modelLabel.textContent = m.id;
        closePopovers();
        call('setModel', m.id);
      });
      el.modelList.appendChild(b);
    }

    var shown = 0;
    for (var gi = 0; gi < groups.length && shown < MODEL_CAP; gi++) {
      var g = groups[gi];
      var h = document.createElement('div');
      h.className = 'model-group';
      h.textContent = g.name;
      el.modelList.appendChild(h);
      for (var i = 0; i < g.items.length && shown < MODEL_CAP; i++) {
        addItem(g.items[i]);
        shown++;
      }
    }
    if (!total) {
      var empty = document.createElement('div');
      empty.className = 'model-more';
      empty.textContent = '没有匹配的模型';
      el.modelList.appendChild(empty);
    } else if (total > MODEL_CAP) {
      var more = document.createElement('div');
      more.className = 'model-more';
      more.textContent = '还有 ' + (total - MODEL_CAP) + ' 个，继续输入以缩小范围';
      el.modelList.appendChild(more);
    }
  }

  el.modelBtn.addEventListener('click', function () {
    var opening = el.modelPop.classList.contains('hidden');
    closePopovers();
    if (!opening) return;
    el.modelSearch.value = '';
    renderModelList();
    el.modelPop.classList.remove('hidden');   // 先显示才能量高度
    positionAbove(el.modelPop, el.modelBtn, 380);
    el.modelBtn.classList.add('open');
    el.modelSearch.focus();
  });
  el.modelSearch.addEventListener('input', renderModelList);

  /* =======================================================================
     十、思考等级选择器
     ======================================================================= */
  var thinkingLevel = 'off';
  var thinkingLevels = [];

  function renderThinkingMenu() {
    el.thinkingPop.innerHTML = '';
    thinkingLevels.forEach(function (lv) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'thinking-opt' + (lv === thinkingLevel ? ' selected' : '');
      b.innerHTML = '<span class="opt-name"></span>' +
        '<svg class="check" viewBox="0 0 16 16"><polyline points="3,8.5 6.5,12 13,4.5"/></svg>';
      b.querySelector('.opt-name').textContent = thinkingZh(lv);
      b.addEventListener('click', function () {
        thinkingLevel = lv;
        el.thinkingLabel.textContent = '思考·' + thinkingZh(lv);
        renderThinkingMenu();
        closePopovers();
        call('setThinking', lv);
      });
      el.thinkingPop.appendChild(b);
    });
  }

  el.thinkingBtn.addEventListener('click', function () {
    var opening = el.thinkingPop.classList.contains('hidden');
    closePopovers();
    if (!opening) return;
    el.thinkingPop.classList.remove('hidden');   // 先显示才能量高度
    positionAbove(el.thinkingPop, el.thinkingBtn, 150);
    el.thinkingBtn.classList.add('open');
  });

  // 点击弹层外部 / Esc 关闭
  document.addEventListener('mousedown', function (e) {
    if (!isPopoverOpen()) return;
    if (e.target.closest && e.target.closest(
      '#model-pop, #thinking-pop, #model-btn, #thinking-btn, #cwd-pop, #nav-more, #btn-add-project, ' +
      '#session-ctx-menu, #download-pop, #more-pop, #btn-download, #btn-more, #branch-pop, .branch-badge'
    )) return;
    closePopovers();
  });
  document.addEventListener('keydown', function (e) {
    // 上一个/下一个聊天（Codex 视图菜单同款）：Alt+←/Alt+→ 在会话列表里翻
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      var items = currentSessionOrder();
      if (items.length) {
        e.preventDefault();
        var cur = items.indexOf(activeSessionId);
        var next = e.key === 'ArrowRight'
          ? Math.min(cur + 1, items.length - 1)
          : Math.max(cur - 1, 0);
        if (cur < 0) next = 0;                       // 当前是新对话未落盘 → 跳第一个
        switchToSession(items[next]);
      }
    }
    if (e.key === 'Escape' && isPopoverOpen()) closePopovers();
    // 对话内查找（Codex 视图菜单「查找」）：⌘F / Ctrl+F 开搜索条，Esc 关
    // （与菜单「查找」走同一动作：menu-action:'find' → handleEvent，见下）
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
      if (el.findBar) {
        e.preventDefault();
        el.findBar.classList.remove('hidden');
        if (el.findInput) { el.findInput.value = ''; el.findInput.focus(); doThreadFind(''); }
      }
    }
  });

  // —— 对话内查找实现：逐条消息正文做大小写不敏感子串匹配，命中则高亮并滚动定位 ——
  // 简单可靠优先：不引依赖，用 CSS 类 .find-hit 标记命中行，支持 Enter=下一个。
  var findPos = -1;
  function doThreadFind(q) {
    var msgs = document.getElementById('messages');
    if (!msgs) return;
    // 清旧高亮
    msgs.querySelectorAll('.find-hit').forEach(function (n) {
      n.classList.remove('find-hit');
      var p = n.parentElement;
      if (p && p.dataset.origHtml !== undefined) {
        p.innerHTML = p.dataset.origHtml; delete p.dataset.origHtml;
      }
    });
    var hits = [];
    if (q) {
      var lower = q.toLowerCase();
      msgs.querySelectorAll('.msg .md').forEach(function (node) {
        var text = node.textContent.toLowerCase();
        if (text.indexOf(lower) >= 0) {
          hits.push(node);
          // 用文本节点替换实现高亮（避免 innerHTML 重建丢掉消息节点）
          highlightFindTerms(node, q);
        }
      });
    }
    var cnt = document.getElementById('find-count');
    if (cnt) cnt.textContent = hits.length ? (hits.length + ' 处') : (q ? '无结果' : '');
    findPos = hits.length ? 0 : -1;
    if (hits.length) scrollFindHit(hits[0]);
    window.__findHits = hits;
  }
  function highlightFindTerms(node, q) {
    // 遍历文本节点，把命中片段包上 <mark class="find-hit">
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    var toWrap = [];
    while (walker.nextNode()) {
      var t = walker.currentNode, idx = t.textContent.toLowerCase().indexOf(q.toLowerCase());
      if (idx >= 0) toWrap.push({ node: t, idx: idx, len: q.length });
    }
    toWrap.forEach(function (w) {
      var range = document.createRange();
      range.setStart(w.node, w.idx); range.setEnd(w.node, w.idx + w.len);
      var mark = document.createElement('mark');
      mark.className = 'find-hit';
      range.surroundContents(mark);
    });
  }
  function scrollFindHit(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    var marks = el.querySelectorAll('mark.find-hit');
    marks.forEach(function (m) { m.classList.remove('find-cur'); });
    // 当前命中项在 findPos 对应的 mark 上加 find-cur 样式（简化：首/当前）
    if (marks.length) marks[Math.min(findPos < 0 ? 0 : findPos, marks.length - 1)].classList.add('find-cur');
  }

  // —— find-bar 事件接线：输入即时搜、Enter 下一个、Shift+Enter 上一个、Esc 关闭 ——
  function initFindBar() {
    var bar = document.getElementById('find-bar');
    var inp = document.getElementById('find-input');
    if (!bar || !inp) return;
    inp.addEventListener('input', function () { doThreadFind(inp.value); });
    inp.addEventListener('keydown', function (e) {
      e.stopPropagation();                       // 别让 Esc 走到全局弹层逻辑
      if (e.key === 'Enter') {
        var hits = window.__findHits || [];
        if (!hits.length) return;
        findPos = e.shiftKey
          ? (findPos - 1 + hits.length) % hits.length
          : (findPos + 1) % hits.length;
        scrollFindHit(hits[findPos]);
        var cnt = document.getElementById('find-count');
        if (cnt) cnt.textContent = hits.length + ' 处 · 第 ' + (findPos + 1) + ' 个';
      } else if (e.key === 'Escape') {
        doThreadFind('');                          // 清高亮
        bar.classList.add('hidden');
        el.input.focus();
      }
    });
    document.getElementById('find-close').addEventListener('click', function () {
      doThreadFind('');
      bar.classList.add('hidden');
      el.input.focus();
    });
  }
  initFindBar();

  function initModels() {
    Promise.resolve(call('getModels')).then(function (list) {
      models = list || [];
      if (!models.length) el.modelLabel.textContent = '默认模型';
    }).catch(function () {});
    Promise.resolve(call('getThinkingLevels')).then(function (levels) {
      thinkingLevels = levels || [];
      renderThinkingMenu();
    }).catch(function () {});
  }

  /* =======================================================================
     十一、工作区
     #cwd-path 行已从左栏移除（项目列表本身就能切工作区），
     但 #cwd-pop 弹层与 renderCwdMenu() 保留，作为「选择其他目录」入口，
     现由「更多」按钮与项目区标题旁的「+」触发。
     ======================================================================= */
  var currentCwd = '';
  var cwdAnchor = null;          // 弹层锤点元素（哪个按钮开的就贴哪个）

  // 取路径最后一段作为工作区名（兼容末尾斜杠）
  function baseName(p) {
    var parts = String(p || '').replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || p || '';
  }

  function setCwd(cwd) {
    if (!cwd) return;
    currentCwd = cwd;
    el.ctxCwd.textContent = baseName(cwd);     // 中栏上下文行只显示目录名
    el.ctxCwd.title = cwd;
  }

  function initCwd() {
    Promise.resolve(call('getCwd')).then(setCwd).catch(function () {});
  }

  // 点「更多」或项目区的「+」：弹出“最近工作区 + 选择其他目录”（仿 Codex）
  function toggleCwdMenu(anchor) {
    return function (e) {
      e.stopPropagation();
      if (running) return;
      var opened = !el.cwdPop.classList.contains('hidden');
      closePopovers();
      if (opened && cwdAnchor === anchor) { cwdAnchor = null; return; }
      cwdAnchor = anchor;
      anchor.classList.add('open');
      renderCwdMenu();
    };
  }
  el.navMore.addEventListener('click', toggleCwdMenu(el.navMore));
  el.btnAddProject.addEventListener('click', toggleCwdMenu(el.btnAddProject));

  // 渲染工作区菜单，锚定在左栏底部的工作区行上方
  function renderCwdMenu() {
    Promise.resolve(call('getRecentCwds')).then(function (list) {
      list = list || [];
      el.cwdPop.innerHTML = '';

      if (!list.length) {
        var em = document.createElement('div');
        em.className = 'cwd-empty';
        em.textContent = '暂无最近工作区';
        el.cwdPop.appendChild(em);
      }

      list.forEach(function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'cwd-item' + (it.current ? ' current' : '');
        var n = document.createElement('span');
        n.className = 'ci-name';
        n.textContent = it.name;
        var pth = document.createElement('span');
        pth.className = 'ci-path';
        pth.textContent = it.path;
        b.appendChild(n); b.appendChild(pth);
        b.title = it.path;
        b.addEventListener('click', function () {
          closePopovers();
          if (it.current) return;
          Promise.resolve(call('setCwd', it.path)).then(function (d) {
            if (d) setCwd(d);
            refreshSessions();               // 工作区变了 → 项目分组重拉
          }).catch(function () {});
        });
        el.cwdPop.appendChild(b);
      });

      var sep = document.createElement('div');
      sep.className = 'cwd-sep';
      el.cwdPop.appendChild(sep);

      var pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'cwd-item';
      pick.innerHTML = '<span class="ci-name">选择其他目录…</span>';
      pick.addEventListener('click', function () {
        closePopovers();
        Promise.resolve(call('pickCwd')).then(function (d) {
          if (d) setCwd(d);
          refreshSessions();
        }).catch(function () {});
      });
      el.cwdPop.appendChild(pick);

      // 定位：贴着锤点按钮，空间不够就向下弹
      var r = (cwdAnchor || el.sidebar).getBoundingClientRect();
      el.cwdPop.classList.remove('hidden');
      var h = el.cwdPop.offsetHeight;
      el.cwdPop.style.left = Math.max(8, r.left) + 'px';
      el.cwdPop.style.top = (r.bottom + h + 8 < window.innerHeight)
        ? (r.bottom + 4) + 'px'
        : Math.max(8, r.top - h - 6) + 'px';
    }).catch(function () {});
  }

  /* =======================================================================
     十二、事件流（主进程 → 渲染层）
     ======================================================================= */
  function handleEvent(evt) {
    if (!evt || !evt.type) return;
    switch (evt.type) {
      case 'agent_start':
        setRunning(true);
        break;

      case 'message_start':
        cur.msg = null; cur.text = null; cur.think = null;
        break;

      case 'thinking_start':
        finishText();
        appendThinking('');      // 立即建出「思考中…」块，不再等第一个 delta
        break;

      case 'thinking_delta':
        finishText();
        appendThinking(evt.delta || '');
        break;

      case 'thinking_end':
        finishThinking();
        break;

      case 'text_delta':
        finishThinking();
        appendText(evt.delta || '');
        break;

      case 'tool_start':
        toolStart(evt);
        break;

      case 'tool_end':
        toolEnd(evt);
        break;

      case 'message_end':
        finishThinking();
        finishText();
        cur.msg = null;
        break;

      case 'agent_end':
        finishThinking();
        finishText();
        cur.msg = null;
        setRunning(false);
        refreshSessions();
        break;

      case 'error':
        finishThinking();
        finishText();
        showError(evt.message);
        setRunning(false);
        break;

      case 'notice':
        showNotice(evt.text);
        break;

      case 'compaction':
        showCompaction(evt);          // 置顶摘要横条（P1-8）
        break;

      case 'menu-action':
        // macOS 原生菜单转发（P1-6）：与对应按钮的点击逻辑完全同路径
        switch (evt.action) {
          case 'new':           if (!running) el.btnNew.click(); break;
          case 'new-ephemeral': if (!running && el.btnEphemeral) el.btnEphemeral.click(); break;
          case 'toggle-sidebar': toggleSidebar(); break;
          case 'toggle-browser': toggleBrowser(); break;
          case 'find':
            if (el.findBar) {
              el.findBar.classList.remove('hidden');
              if (el.findInput) { el.findInput.value = ''; el.findInput.focus(); doThreadFind(''); }
            }
            break;
        }
        break;

      case 'session_cleared':
        activeSessionId = null;
        currentSessionId = null;
        clearThread();
        el.sessionTitle.textContent = '新对话';
        refreshSessions();
        break;

      case 'session_restored':
        restoreSession(evt);
        refreshSessions();
        break;

      case 'session_info':
        if (evt.name) el.sessionTitle.textContent = evt.name;
        if (evt.cwd && evt.cwd !== currentCwd) {
          setCwd(evt.cwd);
          refreshSessions();          // 工作区变了 → 项目分组重拉
        }
        if (evt.model) {
          currentModelId = evt.model;
          el.modelLabel.textContent = evt.model;
        }
        if (evt.thinkingLevel) {
          thinkingLevel = evt.thinkingLevel;
          el.thinkingLabel.textContent = '思考·' + thinkingZh(evt.thinkingLevel);
          renderThinkingMenu();
        }
        if (evt.sessionId) {
          currentSessionId = evt.sessionId;
          if (!activeSessionId) refreshSessions();   // 高亮跟随当前会话
        }
        break;

      case 'browser_url':
        // 新建空标签页期间不让底层页面的 URL/标题回写到地址栏与标签上
        if (!blankOverride && document.activeElement !== el.urlInput) {
          el.urlInput.value = evt.url || '';
        }
        el.btnBack.disabled = !evt.canBack;
        el.btnForward.disabled = !evt.canForward;
        el.urlLock.classList.toggle('hidden', blankOverride || !/^https:/i.test(evt.url || ''));
        el.btnReload.classList.toggle('loading', !!evt.loading);
        el.btnReload.title = evt.loading ? '加载中…' : '刷新';
        var blank = isBlankUrl(evt.url);
        // 标签标题不在这里改了 —— 由 browser_tabs 事件驱动 renderTabs() 统一重画
        // 空页 → 让原生 view 缩到 0，把位置让给 #browser-empty（普通 DOM）
        if (pageBlank !== blank) {
          pageBlank = blank;
          syncBrowserView();
        }
        break;

      case 'browser_tabs':
        renderTabs(evt);
        break;
    }
  }

  if (typeof api.onEvent === 'function') api.onEvent(handleEvent);

  /* =======================================================================
     十二之二、从 Chrome 导入登录态（Cookie）

     原理见主进程 import-cookies.js 头部注释：解密用户真 Chrome 的 Google 域
     Cookie 写进 persist:pi-browser 分区，右栏内置浏览器直接继承登录态，
     绕开 Google 对 Electron 的登录拦截（即 ChatGPT/Codex 桌面端「从浏览器导入」）。

     【关键】右栏是原生 WebContentsView，永远盖在渲染层 DOM 之上。
     模态框打开前必须调 browserToggle(false) 把 view 缩到 0，关闭时恢复。
     不直接改 paneVisible：那会连带折叠整个右栏 DOM。这里用一个独立标志
     importModalOpen，在 syncBrowserView() 里一并考虑，两者互不干扰。
     ======================================================================= */
  var importModalOpen = false;   // 导入模态框是否打开（打开期间隐藏原生 view）
  var importing = false;         // 导入进行中（禁止重复点击）

  function paintImportResult(html, isErr) {
    el.importResult.classList.remove('hidden');
    el.importResult.classList.toggle('err', !!isErr);
    el.importResult.innerHTML = html;
  }

  function setImportBusy(on) {
    importing = on;
    el.importConfirm.disabled = on;
    // needCloseChrome 时按钮文案是「我已退出，重试」，收尾时保持住不覆盖
    if (on) el.importConfirm.textContent = '导入中…';
    else if (el.importConfirm.textContent === '导入中…') el.importConfirm.textContent = '开始导入';
  }

  function openImportModal() {
    closePopovers();
    importModalOpen = true;
    el.importResult.classList.add('hidden');
    setImportBusy(false);
    el.importConfirm.textContent = '开始导入';
    el.importOverlay.classList.remove('hidden');
    syncBrowserView();          // 把原生 view 缩到 0，否则模态框右半边会被盖住
  }

  function closeImportModal() {
    importModalOpen = false;
    el.importOverlay.classList.add('hidden');
    setImportBusy(false);
    el.importConfirm.textContent = '开始导入';
    syncBrowserView();          // 恢复原生 view
  }

  // 渲染导入结果（成功统计 / 需关 Chrome / 钥匙串失败 / 其他错误）
  function showImportOutcome(r) {
    if (!r) {
      paintImportResult('导入失败：主进程无响应', true);
      return;
    }
    if (r.ok) {
      var html = '导入完成：成功 <b>' + (r.imported || 0) + '</b> 条，跳过 ' + (r.skipped || 0) +
        ' 条，失败 ' + (r.failed || 0) + ' 条。<br />当前分区 Google 域 Cookie 共 <b>' +
        (r.sessionGoogleCookies != null ? r.sessionGoogleCookies : '?') + '</b> 条。';
      if (!(r.imported > 0)) {
        html += '<br />没有导入任何 Cookie —— 请确认 Chrome 里已登录 Google。';
      }
      paintImportResult(html, !(r.imported > 0));
      return;
    }
    if (r.needCloseChrome) {
      paintImportResult(
        '检测到 Chrome 正在运行，Cookie 库被占用。<br />请<b>完全退出 Chrome（⌘Q）</b>后点「我已退出，重试」。',
        true);
      el.importConfirm.textContent = '我已退出，重试';
      return;
    }
    if (r.error === 'keychain') {
      paintImportResult(
        '读取钥匙串失败：请在弹出的钥匙串窗口点<b>「始终允许」</b>（或输入密码授权）后重试。<br />' +
        '<span class="im-detail">' + escapeHtml(r.message || '') + '</span>', true);
      return;
    }
    paintImportResult('导入失败：' + escapeHtml(r.message || r.error || '未知错误'), true);
  }

  function runImport() {
    if (importing) return;
    setImportBusy(true);
    el.importResult.classList.add('hidden');
    Promise.resolve(call('importCookies', {}))
      .then(showImportOutcome)
      .catch(function (e) {
        paintImportResult('导入失败：' + escapeHtml((e && e.message) ? e.message : String(e)), true);
      })
      .then(function () { setImportBusy(false); });
  }

  el.btnImport.addEventListener('click', openImportModal);
  el.importCancel.addEventListener('click', closeImportModal);
  el.importConfirm.addEventListener('click', runImport);
  // 点遮罩 / Esc 关闭（模态框内部点击不冒泡到遮罩）
  el.importOverlay.addEventListener('mousedown', function (e) {
    if (e.target === el.importOverlay) closeImportModal();
  });
  el.importModal = $('import-modal');
  el.importModal.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && importModalOpen) closeImportModal();
  });

  /* =======================================================================
     十三、代码块复制按钮（事件委托）
     ======================================================================= */
  el.messages.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    var code = btn.closest('.codeblock').querySelector('code');
    navigator.clipboard.writeText(code.textContent).then(function () {
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = '复制'; }, 1500);
    }).catch(function () { btn.textContent = '复制失败'; });
  });

  /* =======================================================================
     十四、示例提示词
     ======================================================================= */
  var SUGGESTIONS = [
    '这个仓库的整体结构是什么？',
    '帮我找出最近改动的文件',
    '跑一遍测试并解释失败原因',
    '给这个函数补上单元测试'
  ];

  SUGGESTIONS.forEach(function (text) {
    var b = document.createElement('button');
    b.className = 'suggestion';
    b.textContent = text;
    b.addEventListener('click', function () {
      el.input.value = text;
      autoGrow();
      el.btnSend.disabled = false;
      el.input.focus();
    });
    el.suggestions.appendChild(b);
  });

  /* =======================================================================
     启动
     ======================================================================= */
  initTheme();
  loadWidths();       // 先恢复栏宽，再定右栏可见性（syncBrowserView 会再报一次 bounds）
  // 首次运行时 localStorage 里没有这个键，此时应【默认展开】右栏 —— 否则
  // DOM 上右栏是展开的、而 paneVisible=false 导致主进程把 view 缩到 0，
  // 表现为「右栏有框但内容全黑」。只有用户显式关过（存 '0'）才折叠。
  setBrowserVisible(localStorage.getItem(BROWSER_KEY) !== '0');
  try { localStorage.removeItem('pi-browser-src'); } catch (e) {}   // 清掉旧来源标记
  initModels();       // 同时拉模型列表与思考档位
  initCwd();
  refreshSessions();
  renderEmptyGrid();  // 新标签页快捷站点网格（含收藏置换）
  autoGrow();
  el.input.focus();

  // 自动化验收钩子：E2E 测试用 CDP 注入假事件走真实渲染路径
  // （等价于主进程 win.webContents.send('pi:event', ...)）。
  // 仅读/渲染，不触达主进程，无副作用。
  window.__piDispatch = handleEvent;
})();
