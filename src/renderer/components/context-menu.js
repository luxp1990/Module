// Module — 组件：右键菜单（v1.5.0 填实）

(function() {

  const ContextMenu = {

    _menuEl: null,

    _state: null,



    init(stateRef, actionCallback) {

      this._state = stateRef;

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

        this._menuEl.querySelectorAll('.context-menu-item').forEach(item => {

          item.addEventListener('click', (e) => {

            e.stopPropagation();

            const action = item.dataset.action;

            if (action && actionCallback) {

              actionCallback(action, item.dataset.value, this._state.state.contextMenu.taskId);

            }

            this.hide();

          });

        });

      }

    },




    show(taskId, x, y) {

      if (!this._menuEl) return;



      // 更新状态机中的目标 ID

      this._state.patch({ contextMenu: { taskId, x, y } }, 'CONTEXT_MENU_OPEN');



      this._menuEl.hidden = false;

      const left = Math.min(x, window.innerWidth - 180);

      const top = Math.min(y, window.innerHeight - 290);

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
