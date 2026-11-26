// Module — 键盘导航（大纲感）
(function () {
  const KeyboardController = {
    _state: null,
    _deps: null,

    init(stateRef, deps) {
      this._state = stateRef;
      this._deps = deps;
      // capture：在 quickInput 自己的 Enter 新建之前，先处理「空内容 → 编辑」
      window.addEventListener('keydown', (e) => this._onKey(e), true);
    },

    _isTypingTarget(el) {
      if (!el || el === window || el === document || el === document.body) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    },

    /** 顶栏搜索 / 底栏快速输入：允许部分导航键穿透 */
    _isChromeInput(el) {
      return !!(el && (el.id === 'quickInput' || el.id === 'searchInput'));
    },

    _visibleRows() {
      return [...document.querySelectorAll('#viewContainer .task-row[data-id]')];
    },

    _selectId(id) {
      const Tc = window.ModuleApp.TaskController;
      if (!Tc) return;
      // ↑↓ 是单选导航：若残留 multiSelect，先清掉，避免批量栏幽灵
      const multi = this._state.state.multiSelect;
      if (multi && multi.size > 0) {
        this._state.patch({ multiSelect: [] });
        document.querySelectorAll('.task-row.multi-selected').forEach(el => {
          el.classList.remove('multi-selected');
        });
        window.ModuleApp.BatchBar?.update?.();
      }
      if (typeof Tc.selectTask === 'function') Tc.selectTask(id);
      else {
        this._state.patch({ selectedId: id, multiSelect: new Set(), anchorId: id });
        document.querySelectorAll('.task-row.selected, .task-row.multi-selected').forEach(el => {
          el.classList.remove('selected', 'multi-selected');
        });
        const row = document.querySelector(`.task-row[data-id="${id}"]`);
        if (row) {
          row.classList.add('selected');
          row.scrollIntoView({ block: 'nearest' });
        }
      }
      window.ModuleApp.BatchBar?.update?.();
    },

    _moveSelection(delta) {
      const rows = this._visibleRows();
      if (rows.length === 0) return;
      const ids = rows.map(r => r.dataset.id);
      const cur = this._state.state.selectedId;
      let idx = ids.indexOf(cur);
      if (idx < 0) idx = delta > 0 ? -1 : 0;
      const next = Math.max(0, Math.min(ids.length - 1, idx + delta));
      this._selectId(ids[next]);
    },

    _onKey(e) {
      const state = this._state.state;
      if (document.querySelector('.modal:not([hidden])')) return;
      if (e.isComposing) return;

      const target = e.target;
      const typing = this._isTypingTarget(target);
      const chrome = this._isChromeInput(target);
      const inListView = state.view === 'hierarchy' || state.view === 'deadline';

      // Esc：有选中则取消选中（模态框打开时上面已 return；日期弹层由 Modal 自管）
      if (e.key === 'Escape') {
        if (!inListView) return;
        if (typing && !chrome) return;
        const hasSel = !!(state.selectedId || (state.multiSelect && state.multiSelect.size > 0));
        if (!hasSel) return;
        e.preventDefault();
        e.stopPropagation();
        window.ModuleApp.TaskController?.clearSelection?.();
        return;
      }

      // / → 聚焦搜索（搜索框内不劫持，便于输入斜杠）
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (target && target.id === 'searchInput') return;
        if (typing && !chrome) return;
        e.preventDefault();
        e.stopPropagation();
        document.getElementById('searchInput')?.focus();
        return;
      }

      // n：聚焦底栏快建（有高亮 → 建子；无高亮 → scope/顶层；弹窗仅编辑用）
      if ((e.key === 'n' || e.key === 'N') && !typing && !e.ctrlKey && !e.metaKey) {
        if (inListView) {
          e.preventDefault();
          e.stopPropagation();
          const Tc = window.ModuleApp.TaskController;
          const sel = state.selectedId;
          if (sel) Tc?.focusQuickCreate?.({ parentId: sel });
          else Tc?.focusQuickCreate?.({});
        }
        return;
      }

      // F3：全局下一项（输入框内也可）
      if (e.key === 'F3') {
        const Sc = window.ModuleApp.SearchController;
        if (Sc?.jumpNextMatch && (state.search || '').trim()) {
          e.preventDefault();
          Sc.jumpNextMatch(e.shiftKey);
        }
        return;
      }

      if (!inListView) return;

      // 非 chrome 的真正编辑框（备注等）不导航
      if (typing && !chrome) return;

      // ↑↓：列表或 chrome 输入框内均可
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        this._moveSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        this._moveSelection(-1);
        return;
      }

      // 底栏空内容：Enter=编辑；Space 保留正常输入语义，避免在输入框中误触完成任务
      // 例外：刚被 n/＋/加子唤起时（_quickCreateArmed），空键不误触发编辑
      if (chrome && target.id === 'quickInput') {
        const empty = !String(target.value || '').trim();
        const armed = !!window.ModuleApp.TaskController?.isQuickCreateArmed?.();
        if (e.key === 'Enter' && empty && state.selectedId) {
          e.preventDefault();
          e.stopPropagation();
          if (!armed) window.ModuleApp.TaskController?.openEditModal?.(state.selectedId);
          return;
        }
        return;
      }

      // 搜索框：Enter/F3 由 SearchController 处理；箭头已在上方处理
      if (chrome && target.id === 'searchInput') return;

      // 列表容器聚焦时
      if (e.key === 'Enter' && state.selectedId) {
        e.preventDefault();
        e.stopPropagation();
        window.ModuleApp.TaskController?.openEditModal?.(state.selectedId);
        return;
      }
      if (e.key === ' ' && state.selectedId) {
        e.preventDefault();
        e.stopPropagation();
        window.ModuleApp.TaskController?.handleComplete?.(state.selectedId);
        return;
      }
    }
  };

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.KeyboardController = KeyboardController;
})();
