/* =========================================================================
   breadcrumb.js —— 面包屑导航模块（Codex风格）

   职责：
     - 紧凑显示当前工作区名称、会话数、路径
     - 点击工作区名切换工作区（复用 workspace-menu 弹层）
     - 编辑工作区（弹窗：重命名/删除）
     - 更多选项（导出/设置等）
     - 分享对话（复用会话导出）

   依赖注入：
     new Breadcrumb({
       state: AppState 实例,
       ipc:   IpcClient 实例,
       hooks: {
         showNotice(text),
         refreshSessions(),       // 刷新会话列表（sidebar）
         getSessionGroups(),      // 获取当前会话分组（用于统计数量）
         exportConversation(),    // 导出当前对话
         closePopovers(),         // 关闭其他弹层
         positionPopoverXY()      // 弹层定位
       }
     })
   ========================================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function Breadcrumb(opts) {
    opts = opts || {};
    this.state = opts.state || {};
    this.ipc = opts.ipc || null;
    this.hooks = opts.hooks || {};

    // DOM 引用
    this.el = {
      root: $('conversation-breadcrumb'),
      workspaceBtn: $('bc-workspace-btn'),
      workspaceName: $('bc-workspace-name'),
      sessionCount: $('bc-session-count'),
      workspacePath: $('bc-workspace-path'),
      editBtn: $('bc-edit-btn'),
      moreBtn: $('bc-more-btn'),
      shareBtn: $('bc-share-btn'),
      workspaceMenu: $('workspace-menu'),
    };

    this.currentWorkspace = '';
    this._wsManageMode = false;

    this.init();
  }

  /* ---------------- IPC 调用兜底 ---------------- */
  Breadcrumb.prototype._call = function (name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var ipc = this.ipc;
    if (ipc) {
      if (typeof ipc.call === 'function') return Promise.resolve(ipc.call.apply(ipc, [name].concat(args)));
      if (typeof ipc.invoke === 'function') return Promise.resolve(ipc.invoke.apply(ipc, [name].concat(args)));
    }
    var api = window.piAPI || {};
    if (typeof api[name] === 'function') return Promise.resolve(api[name].apply(api, args));
    return Promise.resolve(null);
  };

  Breadcrumb.prototype._get = function (key) {
    var s = this.state;
    if (typeof s.get === 'function') return s.get(key);
    return s[key];
  };

  /* ---------------- 初始化 ---------------- */
  Breadcrumb.prototype.init = function () {
    var self = this;

    // 点击工作区名称 → 切换工作区弹层
    if (this.el.workspaceBtn) {
      this.el.workspaceBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        self.toggleWorkspaceMenu();
      });
    }

    // 点击编辑 → 工作区编辑器弹窗
    if (this.el.editBtn) {
      this.el.editBtn.addEventListener('click', function () {
        self.showWorkspaceEditor();
      });
    }

    // 点击更多 → 更多选项菜单
    if (this.el.moreBtn) {
      this.el.moreBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        self.showMoreMenu(e);
      });
    }

    // 点击分享 → 分享/导出对话
    if (this.el.shareBtn) {
      this.el.shareBtn.addEventListener('click', function () {
        self.shareConversation();
      });
    }

    // 点击弹层外部关闭
    document.addEventListener('mousedown', function (e) {
      var menu = self.el.workspaceMenu;
      if (!menu || menu.classList.contains('hidden')) return;
      if (e.target.closest && e.target.closest('#workspace-menu, #bc-workspace-btn')) return;
      self.closeWorkspaceMenu();
    });

    // 监听 session_info 更新面包屑
    if (this.ipc && typeof this.ipc.on === 'function') {
      this.ipc.on('session_info', function (info) {
        self.updateBreadcrumb(info);
      });
      this.ipc.on('recent_cwds', function () {
        self.updateWorkspaceDisplay();
        var menu = self.el.workspaceMenu;
        if (menu && !menu.classList.contains('hidden')) self.renderWorkspaceMenu();
      });
    }

    // 首刷
    this.updateWorkspaceDisplay();
    this.updateSessionCount();

    console.log('[Breadcrumb] 初始化完成');
  };

  /* ---------------- 更新显示 ---------------- */

  /**
   * 从 session_info 事件更新面包屑
   */
  Breadcrumb.prototype.updateBreadcrumb = function (info) {
    if (!info) return;

    // 工作区路径
    if (info.cwd) {
      this.currentWorkspace = info.cwd;
      var name = this._baseName(info.cwd);
      if (this.el.workspaceName) this.el.workspaceName.textContent = name;
      if (this.el.workspacePath) {
        var shortPath = info.cwd.replace(/^\/Users\/[^\/]+/, '~');
        this.el.workspacePath.textContent = shortPath;
        this.el.workspacePath.title = info.cwd;
      }
      if (this.el.workspaceBtn) this.el.workspaceBtn.title = info.cwd;
    }

    console.log('[Breadcrumb] 更新信息:', info);
  };

  /**
   * 主动拉取当前工作区（启动时/ recent_cwds 变化时）
   */
  Breadcrumb.prototype.updateWorkspaceDisplay = function () {
    var self = this;
    Promise.resolve(this._call('getCwd')).then(function (cwd) {
      if (!cwd) return;
      self.currentWorkspace = cwd;
      var name = self._baseName(cwd);
      if (self.el.workspaceName) self.el.workspaceName.textContent = name;
      if (self.el.workspacePath) {
        var shortPath = String(cwd).replace(/^\/Users\/[^\/]+/, '~');
        self.el.workspacePath.textContent = shortPath;
        self.el.workspacePath.title = cwd;
      }
      if (self.el.workspaceBtn) self.el.workspaceBtn.title = cwd;
    }).catch(function (err) {
      console.warn('[Breadcrumb] 获取当前工作区失败:', err);
    });
  };

  /**
   * 更新会话数量统计
   */
  Breadcrumb.prototype.updateSessionCount = function () {
    var self = this;
    Promise.resolve(this._call('listSessionsGrouped')).then(function (groups) {
      groups = groups || [];
      var cur = groups.find(function (g) { return g.current; });
      var count = cur ? (cur.sessions || []).length : 0;
      if (self.el.sessionCount) {
        self.el.sessionCount.textContent = count + ' 个会话';
      }
    }).catch(function () {
      if (self.el.sessionCount) self.el.sessionCount.textContent = '0 个会话';
    });
  };

  Breadcrumb.prototype._baseName = function (p) {
    var parts = String(p || '').replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || p || '';
  };

  /* ---------------- 工作区切换弹层（复用 conversation.js 的 workspace-menu） ---------------- */

  Breadcrumb.prototype.toggleWorkspaceMenu = function () {
    var menu = this.el.workspaceMenu;
    if (!menu) return;
    var opened = !menu.classList.contains('hidden');
    if (opened) { this.closeWorkspaceMenu(); return; }
    if (typeof this.hooks.closePopovers === 'function') this.hooks.closePopovers();
    if (this.el.workspaceBtn) this.el.workspaceBtn.classList.add('open');
    this.renderWorkspaceMenu();
  };

  Breadcrumb.prototype.closeWorkspaceMenu = function () {
    var menu = this.el.workspaceMenu;
    if (menu) menu.classList.add('hidden');
    if (this.el.workspaceBtn) this.el.workspaceBtn.classList.remove('open');
    this._wsManageMode = false;
  };

  Breadcrumb.prototype.renderWorkspaceMenu = function () {
    var self = this;
    var menu = this.el.workspaceMenu;
    var anchor = this.el.workspaceBtn;
    if (!menu || !anchor) return;

    Promise.resolve(this._call('getRecentCwds')).then(function (list) {
      list = list || [];
      menu.innerHTML = '';
      var manageMode = !!self._wsManageMode;
      var curPath = self.currentWorkspace;

      if (!list.length) {
        var em = document.createElement('div');
        em.className = 'ws-empty';
        em.textContent = '暂无最近工作区';
        menu.appendChild(em);
      }

      list.forEach(function (it) {
        var row = document.createElement('div');
        row.className = 'ws-row';

        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ws-item' + (it.current ? ' active' : '');
        b.title = it.path;

        var name = document.createElement('span');
        name.className = 'ws-item-name';
        name.textContent = it.name || it.path;
        var path = document.createElement('span');
        path.className = 'ws-item-path';
        path.textContent = it.path;
        b.appendChild(name);
        b.appendChild(path);

        b.addEventListener('click', function () {
          if (manageMode) return;
          self.closeWorkspaceMenu();
          if (it.current) return;
          self.switchWorkspace(it.path);
        });
        row.appendChild(b);

        if (manageMode && it.path !== curPath) {
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'ws-del';
          del.title = '从最近列表移除';
          del.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
          del.addEventListener('click', function (e) {
            e.stopPropagation();
            self.removeWorkspace(it.path);
          });
          row.appendChild(del);
        }
        menu.appendChild(row);
      });

      var sep = document.createElement('div');
      sep.className = 'ws-sep';
      menu.appendChild(sep);

      var pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'ws-item ws-action';
      pick.innerHTML = '<span class="ws-item-name">选择其他目录…</span>';
      pick.addEventListener('click', function () {
        self.closeWorkspaceMenu();
        self.pickNewWorkspace();
      });
      menu.appendChild(pick);

      var manage = document.createElement('button');
      manage.type = 'button';
      manage.className = 'ws-item ws-action' + (manageMode ? ' active' : '');
      manage.innerHTML = '<span class="ws-item-name">' + (manageMode ? '完成管理' : '管理工作区…') + '</span>';
      manage.addEventListener('click', function () {
        self._wsManageMode = !manageMode;
        self.renderWorkspaceMenu();
      });
      menu.appendChild(manage);

      // 定位
      menu.classList.remove('hidden');
      var r = anchor.getBoundingClientRect();
      var width = Math.max(280, r.width + 40);
      menu.style.minWidth = width + 'px';
      var right = window.innerWidth - 12;
      var browserPane = document.getElementById('browser-pane');
      if (browserPane && !browserPane.classList.contains('collapsed')) {
        var paneLeft = browserPane.getBoundingClientRect().left;
        if (paneLeft > 0) right = paneLeft - 8;
      }
      var left = r.left;
      if (left + width > right) left = Math.max(8, right - width);
      menu.style.left = left + 'px';
      menu.style.top = (r.bottom + 6) + 'px';
    }).catch(function (err) {
      console.warn('[Breadcrumb] 渲染工作区菜单失败:', err);
    });
  };

  Breadcrumb.prototype.switchWorkspace = function (path) {
    var self = this;
    console.log('[Breadcrumb] 切换工作区:', path);
    Promise.resolve(this._call('setCwd', path)).then(function (d) {
      if (d) {
        self.currentWorkspace = d;
        self.updateWorkspaceDisplay();
      }
      if (typeof self.hooks.refreshSessions === 'function') self.hooks.refreshSessions();
    }).catch(function (err) {
      console.error('[Breadcrumb] 切换工作区失败:', err);
    });
  };

  Breadcrumb.prototype.pickNewWorkspace = function () {
    var self = this;
    Promise.resolve(this._call('pickCwd')).then(function (d) {
      if (d) {
        self.currentWorkspace = d;
        self.updateWorkspaceDisplay();
      }
      if (typeof self.hooks.refreshSessions === 'function') self.hooks.refreshSessions();
    }).catch(function (err) {
      console.error('[Breadcrumb] 选择工作区失败:', err);
    });
  };

  Breadcrumb.prototype.removeWorkspace = function (path) {
    var self = this;
    console.log('[Breadcrumb] 移除工作区:', path);
    Promise.resolve(this._call('removeRecentCwd', path)).then(function (res) {
      if (res && res.ok === false) {
        console.warn('[Breadcrumb] 移除失败:', res.err);
        if (typeof self.hooks.showNotice === 'function') self.hooks.showNotice(res.err || '移除失败');
        return;
      }
      self.renderWorkspaceMenu();
      if (typeof self.hooks.refreshSessions === 'function') self.hooks.refreshSessions();
    }).catch(function (err) {
      console.error('[Breadcrumb] 移除工作区异常:', err);
    });
  };

  /* ---------------- 工作区编辑器弹窗 ---------------- */

  Breadcrumb.prototype.showWorkspaceEditor = function () {
    var self = this;
    console.log('[Breadcrumb] 显示工作区编辑器');

    // 移除已有弹窗
    var old = document.querySelector('.workspace-editor-modal');
    if (old) old.remove();

    var cwd = this.currentWorkspace || '';
    var name = this._baseName(cwd);

    // 获取当前会话数
    var sessionCount = 0;
    var groups = this._get('sessionGroups') || [];
    var curGroup = groups.find(function (g) { return g.path === cwd; });
    if (curGroup) sessionCount = (curGroup.sessions || []).length;

    var modal = document.createElement('div');
    modal.className = 'workspace-editor-modal';
    modal.innerHTML =
      '<div class="workspace-editor-overlay"></div>' +
      '<div class="workspace-editor-content">' +
      '  <h3>编辑工作区</h3>' +
      '  <div class="we-form">' +
      '    <label><span>名称</span><input type="text" id="we-name" class="we-input" value="' + escapeHtml(name) + '" /></label>' +
      '    <label><span>路径</span><input type="text" id="we-path" class="we-input" value="' + escapeHtml(cwd) + '" readonly /></label>' +
      '    <label><span>会话数</span><input type="text" id="we-count" class="we-input" value="' + sessionCount + '" readonly /></label>' +
      '  </div>' +
      '  <div class="we-actions">' +
      '    <button class="we-btn we-btn-danger" id="we-delete">从列表移除</button>' +
      '    <div class="we-actions-right">' +
      '      <button class="we-btn we-btn-secondary" id="we-cancel">取消</button>' +
      '      <button class="we-btn we-btn-primary" id="we-save">保存</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    document.body.appendChild(modal);

    // 取消
    modal.querySelector('#we-cancel').addEventListener('click', function () {
      modal.remove();
    });

    // 遮罩点击关闭
    modal.querySelector('.workspace-editor-overlay').addEventListener('click', function () {
      modal.remove();
    });

    // 保存（目前仅支持显示名称，实际路径不可改）
    modal.querySelector('#we-save').addEventListener('click', function () {
      var newName = modal.querySelector('#we-name').value.trim();
      if (newName && newName !== name) {
        // 工作区名称是 path.basename，不可直接改
        // 这里预留：未来可支持自定义工作区别名
        console.log('[Breadcrumb] 工作区名称修改（预留）:', newName);
        if (typeof self.hooks.showNotice === 'function') {
          self.hooks.showNotice('工作区别名功能即将上线');
        }
      }
      modal.remove();
    });

    // 删除（从最近列表移除）
    modal.querySelector('#we-delete').addEventListener('click', function () {
      if (!window.confirm('确定要从最近工作区列表移除「' + name + '」？\n不会删除会话历史文件。')) return;
      Promise.resolve(self._call('removeRecentCwd', cwd)).then(function (res) {
        if (res && res.ok === false) {
          if (typeof self.hooks.showNotice === 'function') self.hooks.showNotice(res.err || '移除失败');
        } else {
          if (typeof self.hooks.showNotice === 'function') self.hooks.showNotice('已从列表移除');
          modal.remove();
          // 如果删的是当前工作区，刷新显示
          self.updateWorkspaceDisplay();
          if (typeof self.hooks.refreshSessions === 'function') self.hooks.refreshSessions();
        }
      });
    });
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- 更多选项菜单 ---------------- */

  Breadcrumb.prototype.showMoreMenu = function (e) {
    var self = this;
    console.log('[Breadcrumb] 显示更多菜单');

    // 移除已有菜单
    var old = document.getElementById('bc-more-menu');
    if (old) old.remove();

    var menu = document.createElement('div');
    menu.id = 'bc-more-menu';
    menu.className = 'session-ctx-menu';
    menu.style.position = 'fixed';
    menu.style.zIndex = '1000';
    menu.style.minWidth = '160px';

    function item(text, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item-btn';
      b.textContent = text;
      b.addEventListener('click', function () {
        menu.remove();
        try { fn(); } catch (err) { console.error(err); }
      });
      menu.appendChild(b);
    }

    item('导出对话…', function () { self.shareConversation(); });
    item('工作区设置', function () { self.showWorkspaceEditor(); });

    document.body.appendChild(menu);

    var rect = this.el.moreBtn.getBoundingClientRect();
    menu.style.left = Math.max(8, rect.right - menu.offsetWidth) + 'px';
    menu.style.top = (rect.bottom + 6) + 'px';

    // 点击外部关闭
    setTimeout(function () {
      var closer = function (ev) {
        if (!menu.contains(ev.target)) {
          menu.remove();
          document.removeEventListener('mousedown', closer, true);
        }
      };
      document.addEventListener('mousedown', closer, true);
    }, 0);
  };

  /* ---------------- 分享对话 ---------------- */

  Breadcrumb.prototype.shareConversation = function () {
    console.log('[Breadcrumb] 分享对话');
    // 复用宿主的导出能力
    if (typeof this.hooks.exportConversation === 'function') {
      this.hooks.exportConversation();
      return;
    }
    // 兜底：直接调 IPC 导出为 markdown
    var sessionId = this._get('currentSessionId') || this._get('activeSessionId');
    if (!sessionId) {
      if (typeof this.hooks.showNotice === 'function') this.hooks.showNotice('当前没有可导出的会话');
      return;
    }
    Promise.resolve(this._call('exportSession', sessionId, 'markdown')).then(function (res) {
      if (res && res.ok) {
        if (typeof self.hooks.showNotice === 'function') self.hooks.showNotice('已导出: ' + res.filePath);
      } else {
        if (typeof self.hooks.showNotice === 'function') self.hooks.showNotice('导出失败: ' + ((res && res.error) || '未知错误'));
      }
    });
  };

  /* ---------------- 导出 ---------------- */
  window.Breadcrumb = Breadcrumb;
})();
