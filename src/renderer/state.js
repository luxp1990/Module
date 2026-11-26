// Module — 发布订阅状态管理器（从 app.js 全局 state 提取）
// 原则：子模块只订阅状态变更，不直接读写全局对象
(function() {
  // 初始状态（与 app.js 的 state 对象完全一致）
  const initialState = {
    tasks: [],
    notes: [],
    view: 'hierarchy',
    collapsed: new Set(),       // 折叠的主任务 id
    modalTask: null,            // {mode: 'create'|'edit', parentId, id}
    selectedId: null,           // 当前选中任务 id
    multiSelect: new Set(),     // Ctrl/Shift 多选 id 集合
    anchorId: null,             // Shift 范围选择锚点
    search: '',                 // 实时搜索关键词
    quickDraft: {
      startDate: null,
      deadline: null,
      notes: '',
      notesExpanded: false,
    },
    datePicker: {
      value: null,
      target: null,             // 'quickStart'|'quickDeadline'|'modalStart'|'modalDeadline'
    },
    autoPlan: false,
    projectScopeIds: [],        // []=全部项目；[id]=单主任务作用域（预留多选并集）
    editingNoteId: null,        // 当前正在编辑的便签 id
    notesFilter: 'all',         // 便签筛选: 'all'|'pinned'
    // collapsed 序列化适配（Set 无法 postMessage，接收端用数组重建）
  };

  class ModuleStateManager {
    constructor() {
      this._state = Object.fromEntries(
        Object.entries(initialState).map(([k, v]) => {
          if (v instanceof Set) return [k, new Set()];
          return [k, v];
        })
      );
      this._listeners = new Set();
    }

    get state() { return this._state; }

    // 增量更新（推荐）：只传变化的字段
    patch(patchObj, actionType = 'GENERIC') {
      // Set 字段需要特殊处理（不能直接 Object.assign）
      const setFields = ['collapsed', 'multiSelect'];
      for (const [k, v] of Object.entries(patchObj)) {
        if (setFields.includes(k) && Array.isArray(v)) {
          this._state[k] = new Set(v);
        } else {
          this._state[k] = v;
        }
      }
      this.notify(actionType);
    }

    // 全量替换（降级用：从后端拉回全部数据后）
    replace(newState, actionType = 'REPLACE') {
      const setFields = ['collapsed', 'multiSelect'];
      this._state = Object.fromEntries(
        Object.entries(newState).map(([k, v]) => {
          if (setFields.includes(k) && Array.isArray(v)) return [k, new Set(v)];
          return [k, v];
        })
      );
      this.notify(actionType);
    }

    // 订阅：返回解绑函数
    subscribe(listener) {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    }

    notify(actionType) {
      for (const l of this._listeners) {
        l(this._state, actionType);
      }
    }

    // IPC 边界序列化：Set → 数组（广播前调用）
    toSerializable() {
      return Object.fromEntries(
        Object.entries(this._state).map(([k, v]) => {
          if (v instanceof Set) return [k, [...v]];
          return [k, v];
        })
      );
    }

    // IPC 边界反序列化：数组 → Set（接收后调用）
    fromSerializable(obj) {
      const setFields = ['collapsed', 'multiSelect'];
      this._state = Object.fromEntries(
        Object.entries(obj).map(([k, v]) => {
          if (setFields.includes(k) && Array.isArray(v)) return [k, new Set(v)];
          return [k, v];
        })
      );
    }
  }

  const appState = new ModuleStateManager();

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.State = appState;
})();
