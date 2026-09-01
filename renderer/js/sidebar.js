/* =========================================================================
   sidebar.js —— 左栏会话列表模块（从 app.js 抽离，零依赖 CommonJS/全局双挂载）

   职责：
     - 会话列表按项目分组渲染（buildSessionRow / renderGroups）
     - 会话搜索过滤（命中高亮 + 统计）
     - 右键菜单（重命名 / 删除 / 复制 ID）+ 行内重命名
     - 分支弹层（branch-badge → listBranches → switchToBranch）
     - 工作区切换弹层（最近工作区 + 选择其他目录）
     - 新对话 / 临时聊天按钮
     - Alt+←/→ 上一个/下一个会话

   依赖（全部通过构造参数注入，不直接读 app.js 的闭包变量）：
     new Sidebar({
       state:    AppState 实例（或普通对象），读写以下字段：
                   activeSessionId, currentSessionId, currentCwd, running,
                   sessionGroups, searchQuery, expandedProjects
       ipc:      IpcClient 实例（或 window.piAPI 兼容包装），须支持
                   call(name, ...args) -> Promise
       els:      DOM 元素表 { sidebar, sessionList, sessionTitle, searchRow,
                   sessionSearch, btnSearch, btnSearchClear, searchStat, btnNew,
                   btnEphemeral, sessionCtxMenu, cwdPop, navMore, btnAddProject,
                   branchPop, ctxCwd, browserPane }
       hooks:    回调表 {
                   clearThread(),              // 清空中栏对话流
                   showNotice(text),           // 轻提示
                   closePopovers(),            // 关所有弹层（本模块注册的之外）
                   positionPopoverXY(pop,x,y), // 通用弹层定位（可用内置默认）
                   relTime(ts)                 // 相对时间（可用内置默认）
                 }
     })

   使用：
     var sidebar = new Sidebar({ state: appState, ipc: ipcClient, els: {...}, hooks: {...} });
     sidebar.init();            // 绑定事件 + 首刷列表 + 拉工作区
     sidebar.refreshSessions(); // 外部任意时刻重拉
     sidebar.handleEvent(evt);  // 主进程事件流转发（session_info 等）
   ========================================================================= */
(function () {
  'use strict';

  var SESS_PER_PROJECT = 6;      // 每个项目默认最多展示几条会话
  var SESS_NAMES_KEY = 'pi-session-names';
  var COLLAPSED_KEY = 'pi-collapsed-projects';   // 折叠的项目 path 数组

  // 内联 svg 图标（CSP 不允许内联 style/script，svg 标签本身没问题）
  var ICON_FOLDER =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M1.8 4.2h4l1.4 1.6h7v6.4a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2z"/></svg>';
  // 折叠箭头（类文件树的 ▸/▾，靠 CSS transform 旋转，不换图标）
  var ICON_CHEVRON =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<polyline points="6,4 11,8 6,12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* ---------------- 内置小工具（hooks 未提供时的兜底实现） ---------------- */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // mtime → 「3 分钟前 / 昨天 / 3 天前 / 12月30日」
  function relTimeDefault(ts) {
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

  // 会话自定义名（右键「重命名」写入）：localStorage 映射 id(文件路径) -> 名字，
  // 不改 jsonl 本体。渲染列表时优先使用。
  function getSessionNames() {
    try { return JSON.parse(localStorage.getItem(SESS_NAMES_KEY) || '{}'); } catch (e) { return {}; }
  }
  function setSessionName(id, name) {
    var map = getSessionNames();
    if (name) map[id] = name; else delete map[id];
    try { localStorage.setItem(SESS_NAMES_KEY, JSON.stringify(map)); } catch (e) {}
  }

  function sessionMatches(s, q) {
    return String(s.name || s.id || '').toLowerCase().indexOf(q) !== -1;
  }

  // 取路径最后一段作为工作区名（兼容末尾斜杠）
  function baseName(p) {
    var parts = String(p || '').replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || p || '';
  }

  /* 项目折叠状态：localStorage['pi-collapsed-projects'] = [path, ...]。
     纯 UI 偏好，不走 AppState（AppState 那套是给会触发重渲染/事件派发的状态用的，
     折叠只影响 renderGroups，自己读自己写就够）。 */
  function getCollapsedProjects() {
    try {
      var v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function setCollapsedProjects(arr) {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  /* ================================ Sidebar ================================ */

  function Sidebar(opts) {
    opts = opts || {};
    this.state = opts.state || {};
    this.ipc = opts.ipc || null;
    this.els = opts.els || {};
    this.hooks = opts.hooks || {};

    // 弹层锤点元素（哪个按钮开的就贴哪个）
    this.cwdAnchor = null;

    // hooks 兜底
    var h = this.hooks;
    if (typeof h.relTime !== 'function') h.relTime = relTimeDefault;
    if (typeof h.clearThread !== 'function') h.clearThread = function () {};
    if (typeof h.showNotice !== 'function') h.showNotice = function (t) { console.log('[notice]', t); };
    if (typeof h.closePopovers !== 'function') h.closePopovers = function () {};
    if (typeof h.onSessionTitleChange !== 'function') h.onSessionTitleChange = function () {};
  }

  /* ---------------- IPC 包装 ---------------- */

  Sidebar.prototype.call = function (name) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (this.ipc && typeof this.ipc.call === 'function') {
      return Promise.resolve(this.ipc.call.apply(this.ipc, [name].concat(args)));
    }
    // 兼容直接传 window.piAPI
    var api = this.ipc || window.piAPI || {};
    if (typeof api[name] === 'function') return Promise.resolve(api[name].apply(api, args));
    return Promise.resolve(null);
  };

  /* ---------------- 状态访问（兼容 AppState getter/setter 与裸对象） ---------------- */

  Sidebar.prototype._get = function (key) {
    var s = this.state;
    if (typeof s.get === 'function') return s.get(key);
    return s[key];
  };

  Sidebar.prototype._set = function (key, val) {
    var s = this.state;
    if (typeof s.set === 'function') { s.set(key, val); return; }
    s[key] = val;
  };

  /* ---------------- 会话名 ---------------- */

  Sidebar.prototype.sessionDisplayName = function (s) {
    return getSessionNames()[s.id] || s.name || s.id;
  };

  // 列表 id 是会话文件路径；session_info 的 sessionId 兜底比对
  Sidebar.prototype.isActiveSession = function (s) {
    return s.id === this._get('activeSessionId') ||
      (!this._get('activeSessionId') && s.id === this._get('currentSessionId'));
  };

  /* ---------------- 弹层定位 ---------------- */

  // 弹层右边界：浏览器面板可见时以它的左缘为界，否则贴窗口右缘
  Sidebar.prototype.popoverRightEdge = function () {
    var pane = this.els.browserPane;
    if (pane && !pane.classList.contains('collapsed')) {
      var left = pane.getBoundingClientRect().left;
      if (left > 0) return left - 8;
    }
    return window.innerWidth - 12;
  };

  Sidebar.prototype.positionPopoverXY = function (pop, x, y) {
    if (typeof this.hooks.positionPopoverXY === 'function') {
      return this.hooks.positionPopoverXY(pop, x, y);
    }
    pop.classList.remove('hidden');
    var w = pop.offsetWidth;
    var h = pop.offsetHeight;
    var right = this.popoverRightEdge();
    var left = Math.max(8, Math.min(x, right - w));
    var top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  };

  Sidebar.prototype.closePopovers = function () {
    this.hooks.closePopovers();
    // 本模块自己的弹层也一并关（hooks.closePopovers 只管 app.js 侧的）
    if (this.els.cwdPop) this.els.cwdPop.classList.add('hidden');
    if (this.els.sessionCtxMenu) this.els.sessionCtxMenu.classList.add('hidden');
    if (this.els.branchPop) this.els.branchPop.classList.add('hidden');
    if (this.els.navMore) this.els.navMore.classList.remove('open');
    if (this.els.btnAddProject) this.els.btnAddProject.classList.remove('open');
  };

  /* ---------------- 会话切换 ---------------- */

  // 当前渲染顺序里的会话 id 列表（跨项目按渲染顺序，Alt+←/→ 按这个翻）
  Sidebar.prototype.currentSessionOrder = function () {
    var out = [];
    (this._get('sessionGroups') || []).forEach(function (g) {
      (g.sessions || []).forEach(function (s) { out.push(s.id); });
    });
    return out;
  };

  // 切到指定会话（与列表点击同逻辑）
  Sidebar.prototype.switchToSession = function (id) {
    var self = this;
    var s = null;
    (this._get('sessionGroups') || []).forEach(function (g) {
      (g.sessions || []).forEach(function (x) { if (x.id === id) s = x; });
    });
    if (!s || this._get('running') || this.isActiveSession(s)) return;
    this._set('activeSessionId', s.id);
    this.setTitle(this.sessionDisplayName(s));
    this.hooks.clearThread();
    this.call('switchSession', s.id);
    this.refreshSessions();
  };

  Sidebar.prototype.setTitle = function (text, ephemeral) {
    var t = this.els.sessionTitle;
    if (!t) return;
    t.textContent = text;
    if (ephemeral) t.dataset.ephemeral = '1';
    else delete t.dataset.ephemeral;
    this.hooks.onSessionTitleChange(text);
  };

  /* ---------------- 会话行渲染 ---------------- */

  Sidebar.prototype.buildSessionRow = function (s) {
    var self = this;
    var searchQuery = this._get('searchQuery') || '';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'session-item' + (this.isActiveSession(s) ? ' active' : '');
    var label = this.sessionDisplayName(s);
    // 无关键词时走 textContent（最安全），搜索态才用已转义的高亮 HTML
    if (searchQuery) b.innerHTML = highlight(label, searchQuery);
    else b.textContent = label;
    b.title = label + (s.mtime ? ' · ' + this.hooks.relTime(s.mtime) : '');
    b.dataset.sid = s.id;

    // 分支徽标：该会话 jsonl 里有 branch_summary 条目 → 标题后加 ⑂N，
    // 点击开弹层列各分叉摘要，点条目切到分叉点继续对话。
    if (s.branches > 0) {
      var badge = document.createElement('span');
      badge.className = 'branch-badge';
      badge.textContent = '⑂' + s.branches;
      badge.title = s.branches + ' 个分支（点击查看）';
      badge.addEventListener('click', function (e) {
        e.stopPropagation();                 // 别触发「切到该会话」
        self.openBranchPop(s, badge);
      });
      b.appendChild(badge);
    }

    b.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      self.openSessionCtxMenu(s, e.clientX, e.clientY);
    });
    b.addEventListener('click', function () {
      if (self._get('running') || self.isActiveSession(s)) return;
      self._set('activeSessionId', s.id);
      self.setTitle(self.sessionDisplayName(s));
      self.hooks.clearThread();
      self.call('switchSession', s.id);
      self.refreshSessions();
    });
    return b;
  };

  /* ---------------- 分组渲染 ---------------- */

  /* 按项目分组渲染：项目行（可切工作区）+ 缩进的会话行。
     数据全部来自 state.sessionGroups 缓存，搜索时只重渲染、不重新打 IPC。
     搜索态下：命中项全部展开（忽略 6 条上限），整组无命中则隐藏。 */
  Sidebar.prototype.renderGroups = function () {
    var self = this;
    var q = this._get('searchQuery') || '';
    var groups = this._get('sessionGroups') || [];
    var listEl = this.els.sessionList;
    if (!listEl) return;
    listEl.innerHTML = '';

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
    if (this.els.searchStat) {
      this.els.searchStat.classList.toggle('hidden', !q);
      if (q) this.els.searchStat.textContent = hits ? ('找到 ' + hits + ' 个会话') : '没有匹配的会话';
    }

    if (!visible.length) {
      var p = document.createElement('div');
      p.className = 'session-empty';
      p.textContent = q ? '没有匹配的会话' : '暂无项目';
      listEl.appendChild(p);
      return;
    }

    var expandedProjects = this._get('expandedProjects') || {};

    // 折叠状态一次读出（避免 forEach 里每行都 JSON.parse）
    var collapsedArr = getCollapsedProjects();

    visible.forEach(function (item) {
      var g = item.g;
      var block = document.createElement('div');
      block.className = 'proj-block';

      // 搜索态强制展开（不改动 localStorage 里的偏好），否则读用户折叠偏好
      var collapsed = !q && collapsedArr.indexOf(g.path) >= 0;
      if (collapsed) block.classList.add('collapsed');

      // 项目行：左侧折叠箭头（点击折叠/展开）+ 文件夹图标 + 项目名（点击切换工作区）
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'proj-row' + (g.current ? ' current' : '');
      row.innerHTML =
        '<span class="proj-toggle" role="button" aria-label="折叠/展开">' + ICON_CHEVRON + '</span>' +
        ICON_FOLDER + '<span class="proj-name"></span>';
      var pn = row.querySelector('.proj-name');
      if (item.projHit) pn.innerHTML = highlight(g.project || g.path, q);   // 已转义
      else pn.textContent = g.project || g.path;
      row.title = g.path || '';

      // 折叠箭头：stopPropagation 防止触发「切换工作区」
      var toggle = row.querySelector('.proj-toggle');
      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        self.toggleProjectCollapse(g.path);
      });

      row.addEventListener('click', function () {
        if (self._get('running') || g.current) return;
        Promise.resolve(self.call('setCwd', g.path)).then(function () {
          self.refreshSessions();
        }).catch(function () {});
      });
      block.appendChild(row);

      // 折叠态：只渲染项目行，跳过会话列表
      if (collapsed) {
        listEl.appendChild(block);
        return;
      }

      var list = item.list;
      if (!list.length) {
        var none = document.createElement('div');
        none.className = 'session-none';
        none.textContent = '暂无聊天';
        block.appendChild(none);
        listEl.appendChild(block);
        return;
      }

      // 搜索态强制全展，不受「只显 6 条」限制
      var expanded = !!q || !!expandedProjects[g.path];
      var shown = expanded ? list : list.slice(0, SESS_PER_PROJECT);
      shown.forEach(function (s) { block.appendChild(self.buildSessionRow(s)); });

      // 超过上限才出「展开显示 / 收起」（搜索态不出）
      if (!q && list.length > SESS_PER_PROJECT) {
        var more = document.createElement('button');
        more.type = 'button';
        more.className = 'session-more';
        more.textContent = expanded ? '收起' : '展开显示';
        more.addEventListener('click', function () {
          expandedProjects[g.path] = !expanded;
          self._set('expandedProjects', expandedProjects);
          self.renderGroups();               // 缓存重渲染，不必重拉 IPC
        });
        block.appendChild(more);
      }

      listEl.appendChild(block);
    });
  };

  /* ---------------- 项目折叠 / 展开 ---------------- */

  Sidebar.prototype.isProjectCollapsed = function (path) {
    return getCollapsedProjects().indexOf(path) >= 0;
  };

  // 切换折叠：改 localStorage 后重渲染（数据已在 sessionGroups 缓存，不走 IPC）
  Sidebar.prototype.toggleProjectCollapse = function (path) {
    var arr = getCollapsedProjects();
    var i = arr.indexOf(path);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(path);
    setCollapsedProjects(arr);
    this.renderGroups();
  };

  /* ---------------- 拉取列表 ---------------- */

  Sidebar.prototype.refreshSessions = function () {
    var self = this;
    return Promise.resolve(this.call('listSessionsGrouped')).then(function (groups) {
      self._set('sessionGroups', groups || []);
      self.renderGroups();
    }).catch(function () {
      self._set('sessionGroups', []);
      self.renderGroups();
    });
  };

  // 兼容任务书命名：loadSessions = refreshSessions
  Sidebar.prototype.loadSessions = Sidebar.prototype.refreshSessions;

  /* ---------------- 右键菜单（重命名 / 删除 / 复制 ID） ---------------- */

  Sidebar.prototype.openSessionCtxMenu = function (s, x, y) {
    var self = this;
    var menu = this.els.sessionCtxMenu;
    if (!menu) return;
    menu.innerHTML = '';
    menu.dataset.sid = s.id;

    function item(text, danger, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item-btn' + (danger ? ' danger' : '');
      b.textContent = text;
      b.addEventListener('click', function () {
        self.closePopovers();
        fn();
      });
      menu.appendChild(b);
    }

    item('重命名', false, function () { self.renameSession(s); });
    item('删除', true, function () { self.deleteSession(s); });
    item('复制 ID', false, function () {
      navigator.clipboard.writeText(s.id).then(function () {
        self.hooks.showNotice('已复制会话 ID');
      }).catch(function () { self.hooks.showNotice('复制失败'); });
    });

    this.positionPopoverXY(menu, x, y);
  };

  // 兼容任务书命名
  Sidebar.prototype.showContextMenu = Sidebar.prototype.openSessionCtxMenu;

  // 重命名：行内输入覆盖在会话行上，Enter 确认 / Esc 取消。
  // 名字只存 localStorage['pi-session-names']，不改 jsonl 本体。
  Sidebar.prototype.renameSession = function (s) {
    var self = this;
    var rows = this.els.sessionList.querySelectorAll('.session-item');
    var row = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset && rows[i].dataset.sid === s.id) { row = rows[i]; break; }
    }
    var cur2 = this.sessionDisplayName(s);
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
        if (self.isActiveSession(s)) self.setTitle(v);
        self.hooks.showNotice('已重命名为「' + v + '」');
      }
      self.refreshSessions();
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
  };

  // 删除：确认后调主进程删 .jsonl 文件；删的是当前活动会话则回到新对话态
  Sidebar.prototype.deleteSession = function (s) {
    var self = this;
    var name = this.sessionDisplayName(s);
    if (!window.confirm('删除会话「' + name + '」？\n该操作会删除会话文件，不可恢复。')) return;
    Promise.resolve(this.call('deleteSession', s.file || s.id)).then(function (r) {
      if (r && r.ok) {
        setSessionName(s.id, '');            // 顺带清掉自定义名
        if (self.isActiveSession(s)) {
          self._set('activeSessionId', null);
          self.hooks.clearThread();
          self.setTitle('新对话');
        }
        self.hooks.showNotice('会话已删除');
      } else {
        self.hooks.showNotice('删除失败：' + ((r && r.err) || '未知错误'));
      }
      self.refreshSessions();
    }).catch(function (e) {
      self.hooks.showNotice('删除失败：' + ((e && e.message) || e));
      self.refreshSessions();
    });
  };

  /* ---------------- 分支弹层 ---------------- */

  /* 点徽标 → 拉 pi:listBranches 流式解析出的 branch_summary 条目；
     点条目 → pi:switchToBranch（主进程 switchSession 装载后
     navigateTree(branchFromId, {summarize:false})，纯内存移动 leaf，不落盘），
     主进程回灌该分支消息后 session_restored 事件负责重建对话流。 */
  Sidebar.prototype.openBranchPop = function (s, anchor) {
    var self = this;
    this.closePopovers();
    var pop = this.els.branchPop;
    if (!pop) return;
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
    this.positionPopoverXY(pop, r.left, r.bottom + 4);

    Promise.resolve(this.call('listBranches', s.file || s.id)).then(function (branches) {
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
          t.textContent = self.hooks.relTime(new Date(br.timestamp).getTime());
          b.appendChild(t);
        }
        b.addEventListener('click', function () {
          self.closePopovers();
          self.switchToBranch(s, br, idx + 1);
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
  };

  // 切到分叉点：切换当前会话指向 + 调主进程 navigateTree
  Sidebar.prototype.switchToBranch = function (s, br, idx) {
    var self = this;
    if (this._get('running')) return;
    this._set('activeSessionId', s.id);
    this.setTitle(this.sessionDisplayName(s));
    this.hooks.clearThread();
    this.hooks.showNotice('正在切到分支 ' + idx + '…');
    Promise.resolve(this.call('switchToBranch', {
      file: s.file || s.id,
      branchFromId: br.fromId    // branch_summary.fromId = 被放弃路径的旧 leaf
    })).then(function (r) {
      if (r && r.ok) {
        self.hooks.showNotice('已切到分支 ' + idx + '，新消息将从分叉点继续');
      } else {
        self.hooks.showNotice('切换分支失败：' + ((r && r.err) || '未知错误'));
      }
      self.refreshSessions();
    }).catch(function (e) {
      self.hooks.showNotice('切换分支失败：' + ((e && e.message) || e));
      self.refreshSessions();
    });
  };

  /* ---------------- 会话搜索 ---------------- */

  /* 展开搜索行 → 实时过滤缓存重渲染；Esc / 再点放大镜 / 点✕ 收起并清空。
     搜索行在左栏内部，不跨栏、不浮层，所以不会被右栏原生 view 遮住。 */
  Sidebar.prototype.setSearchOpen = function (open) {
    var els = this.els;
    if (els.searchRow) els.searchRow.classList.toggle('hidden', !open);
    if (els.btnSearch) els.btnSearch.classList.toggle('active', open);
    if (open) {
      if (els.sessionSearch) { els.sessionSearch.focus(); els.sessionSearch.select(); }
    } else {
      if (els.sessionSearch) els.sessionSearch.value = '';
      this._set('searchQuery', '');
      if (els.searchStat) els.searchStat.classList.add('hidden');
      this.renderGroups();
    }
  };

  /* ---------------- 新对话 / 临时聊天 ---------------- */

  Sidebar.prototype.newSession = function () {
    var self = this;
    if (this._get('running')) return;
    this._set('activeSessionId', null);
    this.hooks.clearThread();
    this.setTitle('新对话');
    Promise.resolve(this.call('newSession')).then(function () { self.refreshSessions(); });
  };

  // 临时聊天：不落盘，关掉即焚。UI 上给标题加「临时」标记提醒用户当前会话不会保存。
  Sidebar.prototype.newEphemeral = function () {
    var self = this;
    if (this._get('running')) return;
    this._set('activeSessionId', null);
    this.hooks.clearThread();
    this.setTitle('临时聊天', true);
    this.call('newEphemeral').then(function () {
      self.refreshSessions();            // 会话列表不变（没落盘），只刷新一下无妨
    });
  };

  /* ---------------- 工作区弹层 ---------------- */

  Sidebar.prototype.setCwd = function (cwd) {
    if (!cwd) return;
    this._set('currentCwd', cwd);
    if (this.els.ctxCwd) {
      this.els.ctxCwd.textContent = baseName(cwd);   // 中栏上下文行只显示目录名
      this.els.ctxCwd.title = cwd;
    }
  };

  Sidebar.prototype.initCwd = function () {
    var self = this;
    Promise.resolve(this.call('getCwd')).then(function (d) { self.setCwd(d); }).catch(function () {});
  };

  // 点「更多」或项目区的「+」：弹出“最近工作区 + 选择其他目录”（仿 Codex）
  Sidebar.prototype.toggleWorkspacePicker = function (anchor) {
    var self = this;
    anchor = anchor || this.els.navMore || this.els.sidebar;
    if (this._get('running')) return;
    var opened = this.els.cwdPop && !this.els.cwdPop.classList.contains('hidden');
    var sameAnchor = this.cwdAnchor === anchor;
    this.closePopovers();
    if (opened && sameAnchor) { this.cwdAnchor = null; return; }
    this.cwdAnchor = anchor;
    anchor.classList.add('open');
    this.renderCwdMenu();
  };

  // 渲染工作区菜单，贴着锤点按钮定位，空间不够就向上弹
  Sidebar.prototype.renderCwdMenu = function () {
    var self = this;
    var pop = this.els.cwdPop;
    if (!pop) return;
    Promise.resolve(this.call('getRecentCwds')).then(function (list) {
      list = list || [];
      pop.innerHTML = '';

      if (!list.length) {
        var em = document.createElement('div');
        em.className = 'cwd-empty';
        em.textContent = '暂无最近工作区';
        pop.appendChild(em);
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
          self.closePopovers();
          if (it.current) return;
          Promise.resolve(self.call('setCwd', it.path)).then(function (d) {
            if (d) self.setCwd(d);
            self.refreshSessions();        // 工作区变了 → 项目分组重拉
          }).catch(function () {});
        });
        pop.appendChild(b);
      });

      var sep = document.createElement('div');
      sep.className = 'cwd-sep';
      pop.appendChild(sep);

      var pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'cwd-item';
      pick.innerHTML = '<span class="ci-name">选择其他目录…</span>';
      pick.addEventListener('click', function () {
        self.closePopovers();
        Promise.resolve(self.call('pickCwd')).then(function (d) {
          if (d) self.setCwd(d);
          self.refreshSessions();
        }).catch(function () {});
      });
      pop.appendChild(pick);

      // 定位：贴着锤点按钮，空间不够就向上弹
      var r = (self.cwdAnchor || self.els.sidebar).getBoundingClientRect();
      pop.classList.remove('hidden');
      var h = pop.offsetHeight;
      pop.style.left = Math.max(8, r.left) + 'px';
      pop.style.top = (r.bottom + h + 8 < window.innerHeight)
        ? (r.bottom + 4) + 'px'
        : Math.max(8, r.top - h - 6) + 'px';
    }).catch(function () {});
  };

  /* ---------------- 事件绑定（在 init() 里一次性挂好） ---------------- */

  Sidebar.prototype.init = function () {
    var self = this;
    var els = this.els;

    // 搜索行
    if (els.btnSearch) els.btnSearch.addEventListener('click', function () {
      self.setSearchOpen(els.searchRow.classList.contains('hidden'));
    });
    if (els.btnSearchClear) els.btnSearchClear.addEventListener('click', function () {
      self.setSearchOpen(false);
    });
    if (els.sessionSearch) {
      els.sessionSearch.addEventListener('input', function () {
        self._set('searchQuery', els.sessionSearch.value.trim().toLowerCase());
        self.renderGroups();
      });
      els.sessionSearch.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); self.setSearchOpen(false); }
      });
    }

    // 新对话 / 临时聊天
    if (els.btnNew) els.btnNew.addEventListener('click', function () {
      self.newSession();
    });
    if (els.btnEphemeral) els.btnEphemeral.addEventListener('click', function () {
      self.newEphemeral();
    });

    // 工作区弹层触发按钮（「更多」与项目区「+」）
    if (els.navMore) els.navMore.addEventListener('click', function (e) {
      e.stopPropagation();
      self.toggleWorkspacePicker(els.navMore);
    });
    if (els.btnAddProject) els.btnAddProject.addEventListener('click', function (e) {
      e.stopPropagation();
      self.toggleWorkspacePicker(els.btnAddProject);
    });

    // Alt+←/→ 上一个/下一个聊天（Codex 视图菜单同款）
    document.addEventListener('keydown', function (e) {
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        var items = self.currentSessionOrder();
        if (!items.length) return;
        e.preventDefault();
        var cur = items.indexOf(self._get('activeSessionId'));
        var next = e.key === 'ArrowRight'
          ? Math.min(cur + 1, items.length - 1)
          : Math.max(cur - 1, 0);
        if (cur < 0) next = 0;                       // 当前是新对话未落盘 → 跳第一个
        self.switchToSession(items[next]);
      }
    });

    // 首刷：异步加载，不阻塞界面渲染
    // 1. 先显示加载状态（立即渲染）
    this.showLoadingState();
    
    // 2. 异步获取工作区（不阻塞）
    this.initCwdAsync();
    
    // 3. 异步刷新会话列表（不阻塞）
    this.refreshSessionsAsync();
  };

  /* ---------------- 加载状态显示 ---------------- */
  // 显示会话列表加载中的占位提示
  Sidebar.prototype.showLoadingState = function () {
    var listEl = this.els.sessionList;
    if (!listEl) return;
    listEl.innerHTML = '<div class="loading-placeholder" style="padding:20px;text-align:center;color:var(--fg-muted,#888);">加载会话列表中...</div>';
  };

  // 显示错误提示
  Sidebar.prototype.showError = function (msg) {
    var listEl = this.els.sessionList;
    if (!listEl) return;
    listEl.innerHTML = '<div class="error-placeholder" style="padding:20px;text-align:center;color:var(--fg-error,#e74c3c);">' + (msg || '加载失败') + '</div>';
  };

  /* ---------------- 异步加载方法 ---------------- */
  // 异步刷新会话列表（不阻塞 init）
  Sidebar.prototype.refreshSessionsAsync = function () {
    var self = this;
    console.time('[Sidebar] 会话列表加载');
    
    Promise.resolve(this.call('listSessionsGrouped'))
      .then(function (groups) {
        console.timeEnd('[Sidebar] 会话列表加载');
        console.log('[Sidebar] 会话列表加载完成，共', groups ? groups.length : 0, '个项目');
        self._set('sessionGroups', groups || []);
        self.renderGroups();
      })
      .catch(function (err) {
        console.timeEnd('[Sidebar] 会话列表加载');
        console.error('[Sidebar] 会话列表加载失败:', err);
        self._set('sessionGroups', []);
        self.showError('会话列表加载失败');
      });
  };

  // 异步获取工作区（不阻塞 init）
  Sidebar.prototype.initCwdAsync = function () {
    var self = this;
    console.time('[Sidebar] 工作区获取');
    
    Promise.resolve(this.call('getCwd'))
      .then(function (result) {
        console.timeEnd('[Sidebar] 工作区获取');
        if (result && result.cwd) {
          self.setCwd(result.cwd);
        }
      })
      .catch(function (err) {
        console.timeEnd('[Sidebar] 工作区获取');
        console.error('[Sidebar] 获取工作区失败:', err);
      });
  };

  /* ---------------- 主进程事件流（session_info / session_cleared / agent_end 等） ----------------
     返回 true 表示本模块已消费该事件，false 表示与本模块无关，交给 app.js 其他逻辑。 */
  Sidebar.prototype.handleEvent = function (evt) {
    if (!evt || !evt.type) return false;
    switch (evt.type) {
      case 'agent_end':
        this.refreshSessions();
        return false;                       // 对话流收尾还得 app.js 做，不拦截

      case 'session_cleared':
        this._set('activeSessionId', null);
        this._set('currentSessionId', null);
        this.refreshSessions();
        return false;                       // clearThread / 标题复位由 app.js 统一做

      case 'session_restored':
        this.refreshSessions();
        return false;

      case 'session_info':
        if (evt.cwd && evt.cwd !== this._get('currentCwd')) {
          this.setCwd(evt.cwd);
          this.refreshSessions();           // 工作区变了 → 项目分组重拉
        }
        if (evt.sessionId) {
          this._set('currentSessionId', evt.sessionId);
          if (!this._get('activeSessionId')) this.refreshSessions();   // 高亮跟随当前会话
        }
        return false;                       // model / thinking 字段归 app.js

      default:
        return false;
    }
  };

  /* ---------------- 导出 ---------------- */

  if (typeof module !== 'undefined' && module.exports) module.exports = Sidebar;
  window.Sidebar = Sidebar;
})();
