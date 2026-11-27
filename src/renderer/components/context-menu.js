// Module — 组件：右键菜单（v1.5.0 填实）

(function() {
  function _t(key, params, zhFallback, enFallback) {
    const i18n = window.ModuleApp?.I18n;
    if (i18n && typeof i18n.t === 'function' && (!i18n.hasKey || i18n.hasKey(key))) {
      return i18n.t(key, params);
    }
    const loc = i18n?.getLocale?.() || 'zh-CN';
    let text = (loc === 'en-US' && enFallback) ? enFallback : (zhFallback || key);
    if (params && typeof text === 'string') {
      text = text.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
    }
    return text;
  }

  const ContextMenu = {

    _menuEl: null,

    _state: null,

    _actionCallback: null,

    _ensureAiBreakdownItem() {
      if (!this._menuEl) return null;
      let aiItem = this._menuEl.querySelector('[data-action="aiBreakdown"]');
      if (!aiItem) {
        aiItem = document.createElement('div');
        aiItem.className = 'context-menu-item context-menu-ai';
        aiItem.dataset.action = 'aiBreakdown';
        const addChild = this._menuEl.querySelector('[data-action="addChild"]');
        if (addChild && addChild.parentNode === this._menuEl) {
          addChild.insertAdjacentElement('afterend', aiItem);
        } else {
          this._menuEl.appendChild(aiItem);
        }
      }
      return aiItem;
    },

    _translateMenu() {
      if (!this._menuEl) return;
      const setLabel = (selector, text) => {
        const el = this._menuEl.querySelector(selector);
        if (el) el.textContent = text;
      };
      setLabel('[data-action="edit"]', `✎ ${_t('contextMenu.edit', null, '编辑', 'Edit Task')}`);
      setLabel('[data-action="complete"]', `✓ ${_t('contextMenu.complete', null, '完成', 'Mark Complete')}`);
      setLabel('[data-action="addChild"]', `＋ ${_t('contextMenu.addSubtask', null, '添加子任务', 'Add Subtask')}`);
      setLabel('[data-action="aiBreakdown"]', `✨ ${_t('contextMenu.aiBreakdown', null, 'AI 拆解子任务', 'AI Break Down')}`);
      setLabel('[data-action="delete"]', `🗑 ${_t('contextMenu.delete', null, '删除', 'Delete Task')}`);

      setLabel('[data-action="setPriority"][data-value="p0"]', `🔴 ${_t('priority.p0Short', null, 'P0', 'P0')}`);
      setLabel('[data-action="setPriority"][data-value="p1"]', `🟠 ${_t('priority.p1Short', null, 'P1', 'P1')}`);
      setLabel('[data-action="setPriority"][data-value="p2"]', `🟡 ${_t('priority.p2Short', null, 'P2', 'P2')}`);
      setLabel('[data-action="setPriority"][data-value=""]', `✕ ${_t('common.clear', null, '清除', 'Clear')}`);

      setLabel('[data-action="setStatus"][data-value="todo"]', `📋 ${_t('status.todo', null, '待办', 'To Do')}`);
      setLabel('[data-action="setStatus"][data-value="progress"]', `🔄 ${_t('status.progress', null, '进行中', 'In Progress')}`);
      setLabel('[data-action="setStatus"][data-value="blocked"]', `🚫 ${_t('status.blocked', null, '阻塞', 'Blocked')}`);
      setLabel('[data-action="setStatus"][data-value="review"]', `👁 ${_t('status.review', null, '审核中', 'In Review')}`);

      this._menuEl.querySelectorAll('.context-menu-item.has-submenu').forEach(subParent => {
        const firstText = [...subParent.childNodes].find(n => n.nodeType === 3);
        if (!firstText) return;
        if (subParent.querySelector('[data-action="setPriority"]')) {
          firstText.nodeValue = _t('contextMenu.setPriority', null, '设置优先级', 'Set Priority');
        } else if (subParent.querySelector('[data-action="setStatus"]')) {
          firstText.nodeValue = _t('contextMenu.setStatus', null, '设置状态', 'Set Status');
        }
      });
    },

    init(stateRef, actionCallback) {

      this._state = stateRef;

      this._actionCallback = actionCallback;

      this._menuEl = document.getElementById('contextMenu');



      // 1. 全局点击/失焦隐藏

      document.addEventListener('click', (e) => {

        if (!e.target.closest('#contextMenu')) this.hide();

      });

      document.addEventListener('contextmenu', (e) => {

        if (!e.target.closest('.task-row') && !e.target.closest('.gantt-bar')) this.hide();

      });




      // 2. 滚动时自动销毁（防止菜单漂移）
      // Bug-C 修复：甘特图用 .gantt-wrap 滚动，viewContainer.scroll 捕获不到；改用全局捕获阶段拦截
      window.addEventListener('scroll', () => {
        if (this._menuEl && !this._menuEl.hidden) this.hide();
      }, true);  // true = 捕获阶段，无论哪个局部 div 滚动都能拦截




      // 3. 菜单项点击代理

      if (this._menuEl) {

        this._ensureAiBreakdownItem();

        this._translateMenu();

        this._menuEl.querySelectorAll('.context-menu-item').forEach(item => {

          item.addEventListener('click', (e) => {

            e.stopPropagation();

            const action = item.dataset.action;

            const taskId = this._state.state.contextMenu.taskId;

            if (action === 'aiBreakdown') {

              if (taskId) window.ModuleApp.HierarchyView?.openAiBreakdown?.(taskId);

            } else if (action && actionCallback) {

              actionCallback(action, item.dataset.value, taskId);

            }

            this.hide();

          });

        });

      }

    },




    show(taskId, x, y) {

      if (!this._menuEl) return;

      this._translateMenu();

      // 更新状态机中的目标 ID

      this._state.patch({ contextMenu: { taskId, x, y } }, 'CONTEXT_MENU_OPEN');



      this._menuEl.hidden = false;

      const left = Math.min(x, window.innerWidth - 180);

      const top = Math.min(y, window.innerHeight - 320);

      this._menuEl.style.left = Math.max(4, left) + 'px';

      this._menuEl.style.top = Math.max(4, top) + 'px';



      // 子菜单边缘碰撞检测：右侧空间不足时改为向左弹出

      setTimeout(() => {

        const submenus = this._menuEl.querySelectorAll('.context-submenu');

        submenus.forEach(sub => {

          const parentRect = sub.parentElement.getBoundingClientRect();

          const subRect = sub.getBoundingClientRect();

          if (parentRect.right + subRect.width > window.innerWidth - 4) {

            sub.style.left = 'auto';

            sub.style.right = '100%';

          } else {

            sub.style.left = '100%';

            sub.style.right = 'auto';

          }

        });

      }, 0);

    },




    hide() {

      if (this._menuEl) this._menuEl.hidden = true;

      this._state.patch({ contextMenu: { taskId: null, x: 0, y: 0 } }, 'CONTEXT_MENU_CLOSE');

    }

  };




  window.ModuleApp = window.ModuleApp || {};

  window.ModuleApp.ContextMenu = ContextMenu;

})();
