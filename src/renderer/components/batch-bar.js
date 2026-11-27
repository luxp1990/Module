// Module — 组件：批量操作栏（v1.5.0 填实）

(function() {

  const BatchBar = {

    _barEl: null,

    _state: null,




    init(stateRef, actionCallback) {

      this._state = stateRef;

      this._barEl = document.getElementById('batchBar');



      if (this._barEl && actionCallback) {

        this._barEl.addEventListener('click', (e) => {

          const btn = e.target.closest('[data-batch-action]');

          if (!btn) return;

          const action = btn.dataset.batchAction;

          actionCallback(action, Array.from(this._state.state.multiSelect));

        });

      }

    },




    // 渲染方法：根据当前状态更新 DOM

    update() {

      const s = this._state.state;

      const n = s.multiSelect.size;



      // 同步 DOM 高亮

      document.querySelectorAll('.task-row').forEach(r => {

        r.classList.toggle('multi-selected', s.multiSelect.has(r.dataset.id));

      });




      if (!this._barEl) return;




      // 仅层级和截止日期视图允许批量操作

      if (s.view !== 'hierarchy' && s.view !== 'deadline') {

        this._barEl.hidden = true;

        return;

      }




      if (n === 0) {

        this._barEl.hidden = true;

      } else {

        this._barEl.hidden = false;

        const countEl = this._barEl.querySelector('.batch-count');

        if (countEl) countEl.textContent = window.ModuleApp.I18n?.t('batch.selectedCount', { count: n }) || `已选 ${n} 项`;

      }

    }

  };




  window.ModuleApp = window.ModuleApp || {};

  window.ModuleApp.BatchBar = BatchBar;

})();
