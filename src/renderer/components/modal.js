// Module — 组件：模态框管理器
(function() {
  let _confirmDialogKeyHandler = null;
  let _isConfirmDialogOpen = false;
  let _taskModalKeyHandler = null;

  function _taskModalFocusables(modal) {
    const card = modal.querySelector('.modal-card') || modal;
    return [...card.querySelectorAll(
      'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter(el => !el.hidden && el.offsetParent !== null);
  }

  function _closeTaskModal() {
    const modal = document.getElementById('taskModal');
    if (!modal || modal.hidden) return;
    // 日期弹层开着时先关日期
    const dp = document.getElementById('datePickerModal');
    if (dp && !dp.hidden) {
      window.ModuleApp.DatePicker?.hide?.();
      return;
    }
    modal.hidden = true;
    if (window.ModuleApp.State) {
      window.ModuleApp.State.patch({ modalTask: null }, 'MODAL_CLOSE');
    }
    _unbindTaskModalKeys();
    document.getElementById('viewContainer')?.focus({ preventScroll: true });
  }

  function _unbindTaskModalKeys() {
    if (_taskModalKeyHandler) {
      window.removeEventListener('keydown', _taskModalKeyHandler, true);
      _taskModalKeyHandler = null;
    }
  }

  function _bindTaskModalKeys(modal) {
    _unbindTaskModalKeys();
    _taskModalKeyHandler = (e) => {
      if (modal.hidden) return;
      // 日期选择器打开时：Esc 交给 DatePicker，Tab 不跨到主界面
      const dp = document.getElementById('datePickerModal');
      const dpOpen = dp && !dp.hidden;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (dpOpen) {
          window.ModuleApp.DatePicker?.hide?.();
        } else {
          _closeTaskModal();
        }
        return;
      }

      if (e.key !== 'Tab') return;
      // Tab 全程困在任务弹窗（或日期弹窗）内，禁止落到背景
      const trapRoot = dpOpen ? dp : modal;
      const list = _taskModalFocusables(trapRoot);
      e.preventDefault();
      e.stopPropagation();
      if (list.length === 0) return;
      const active = document.activeElement;
      let idx = list.indexOf(active);
      if (idx < 0) idx = e.shiftKey ? 0 : -1;
      const next = e.shiftKey
        ? (idx <= 0 ? list.length - 1 : idx - 1)
        : (idx >= list.length - 1 ? 0 : idx + 1);
      list[next].focus();
    };
    window.addEventListener('keydown', _taskModalKeyHandler, true);
  }

  const Modal = {
    init() {
      document.querySelectorAll('[data-close]').forEach(el => {
        el.addEventListener('click', e => {
          const modal = e.currentTarget.closest('.modal');
          if (!modal) return;
          if (modal.id === 'taskModal') {
            _closeTaskModal();
            return;
          }
          modal.hidden = true;
        });
      });

      document.querySelectorAll('.modal-date-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          const target = e.currentTarget.dataset.target;
          const isStart = target === 'modalStart';
          const inputId = isStart ? 'taskStartDate' : 'taskDeadline';
          const currentValue = document.getElementById(inputId).value;
          const I18n = window.ModuleApp?.I18n;
          window.ModuleApp.DatePicker.show({
            target,
            title: isStart ? (I18n?.t('modal.startDate') || '选择开始日期') : (I18n?.t('modal.deadline') || '选择截止日期'),
            value: currentValue
          }, (_tgt, val) => {
            document.getElementById(inputId).value = val || '';
            window.ModuleApp.Modal.updateDateBtns();
          });
        });
      });

      // 日期文本框：宽松输入时自动插横线；失焦规范化
      ['taskStartDate', 'taskDeadline'].forEach(id => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener('blur', () => {
          input.value = Modal.normalizeDateInput(input.value);
        });
      });
    },

    /** 把用户输入收成 YYYY-MM-DD 或空串；非法则原样返回供 save 拦截 */
    normalizeDateInput(raw) {
      const s = String(raw || '').trim();
      if (!s) return '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const digits = s.replace(/\D/g, '');
      if (digits.length === 8) {
        return digits.slice(0, 4) + '-' + digits.slice(4, 6) + '-' + digits.slice(6, 8);
      }
      return s;
    },

    closeTaskModal: _closeTaskModal,

    confirm({ title, message } = {}) {
      if (_isConfirmDialogOpen) return Promise.resolve(false);
      const I18n = window.ModuleApp?.I18n;
      const isEn = I18n?.getLocale?.() === 'en-US';
      title = title ?? (I18n?.t('modal.confirmTitle') || '请确认');
      message = message ?? (isEn ? 'Are you sure you want to continue?' : '确定要继续吗?');
      if (typeof window !== 'undefined' && typeof window.__confirmDialogMock === 'function') {
        return window.__confirmDialogMock({ title, message });
      }
      _isConfirmDialogOpen = true;
      return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        const titleEl = document.getElementById('confirmTitle');
        const msgEl = document.getElementById('confirmMessage');
        const closeBtn = document.getElementById('confirmClose');
        const footer = document.getElementById('confirmFooter');

        if (footer) {
          footer.innerHTML = '';
          const btn = document.createElement('button');
          btn.className = 'btn btn-primary';
          btn.id = 'confirmOk';
          btn.textContent = I18n?.t('common.confirm') || '确定';
          footer.appendChild(btn);
        }
        const ok = document.getElementById('confirmOk');
        if (titleEl) titleEl.textContent = title;
        if (msgEl) msgEl.textContent = message;
        if (modal) modal.hidden = false;

        const cleanup = () => {
          if (modal) modal.hidden = true;
          if (_confirmDialogKeyHandler) {
            window.removeEventListener('keydown', _confirmDialogKeyHandler, true);
            _confirmDialogKeyHandler = null;
          }
          _isConfirmDialogOpen = false;
          ok.removeEventListener('click', onOk);
          closeBtn.removeEventListener('click', onClose);
        };
        const onOk = () => { cleanup(); resolve(true); };
        const onClose = () => { cleanup(); resolve(false); };
        _confirmDialogKeyHandler = (e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onOk(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        };
        window.addEventListener('keydown', _confirmDialogKeyHandler, true);
        ok.addEventListener('click', onOk);
        closeBtn.addEventListener('click', onClose);
        setTimeout(() => ok.focus(), 30);
      });
    },

    choose({ title, message = '', choices = [] } = {}) {
      if (_isConfirmDialogOpen) return Promise.resolve(null);
      if (!choices.length) return Promise.resolve(null);
      const I18n = window.ModuleApp?.I18n;
      const isEn = I18n?.getLocale?.() === 'en-US';
      title = title ?? (isEn ? 'Please choose' : '请选择');
      _isConfirmDialogOpen = true;
      return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        const titleEl = document.getElementById('confirmTitle');
        const msgEl = document.getElementById('confirmMessage');
        const closeBtn = document.getElementById('confirmClose');
        const footer = document.getElementById('confirmFooter');
        if (titleEl) titleEl.textContent = title;
        if (msgEl) msgEl.textContent = message;
        if (footer) {
          footer.innerHTML = '';
          for (const c of choices) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn' + (c.primary ? ' btn-primary' : '') + (c.danger ? ' danger' : '');
            btn.textContent = c.label;
            btn.dataset.choiceId = c.id;
            footer.appendChild(btn);
          }
        }
        if (modal) modal.hidden = false;
        const cleanup = (val) => {
          if (modal) modal.hidden = true;
          if (_confirmDialogKeyHandler) {
            window.removeEventListener('keydown', _confirmDialogKeyHandler, true);
            _confirmDialogKeyHandler = null;
          }
          _isConfirmDialogOpen = false;
          closeBtn.removeEventListener('click', onClose);
          footer?.removeEventListener('click', onFooterClick);
          resolve(val);
        };
        const onClose = () => cleanup(null);
        const onFooterClick = (e) => {
          const btn = e.target.closest('[data-choice-id]');
          if (!btn) return;
          cleanup(btn.dataset.choiceId);
        };
        _confirmDialogKeyHandler = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        };
        window.addEventListener('keydown', _confirmDialogKeyHandler, true);
        closeBtn.addEventListener('click', onClose);
        footer?.addEventListener('click', onFooterClick);
        setTimeout(() => {
          const primary = footer?.querySelector('.btn-primary') || footer?.querySelector('button');
          primary?.focus();
        }, 30);
      });
    },

    showTaskModal(mode, taskData, parentHintText) {
      const modal = document.getElementById('taskModal');
      if (!modal) return;
      const I18n = window.ModuleApp?.I18n;

      document.getElementById('modalTitle').textContent =
        mode === 'create'
          ? (taskData.parentId ? (I18n?.t('hierarchy.addSubtask') || '新建子任务') : (I18n?.t('modal.createTask') || '新建主任务'))
          : (I18n?.t('modal.editTask') || '编辑任务');
      document.getElementById('taskContent').value = taskData.content || '';
      document.getElementById('taskPriority').value = taskData.priority || '';
      document.getElementById('taskStatus').value = taskData.status || '';
      document.getElementById('taskDeadline').value = taskData.deadline || '';
      document.getElementById('taskStartDate').value = taskData.startDate || '';
      document.getElementById('taskNotes').value = taskData.notes || '';

      const hintEl = document.getElementById('parentHint');
      if (parentHintText) {
        hintEl.textContent = parentHintText;
        hintEl.hidden = false;
      } else {
        hintEl.hidden = true;
      }

      this.updateDateBtns();
      modal.hidden = false;
      _bindTaskModalKeys(modal);
      setTimeout(() => document.getElementById('taskContent').focus(), 50);
    },

    updateDateBtns() {
      // 文本框已直接显示值；按钮仅作日历入口，标记是否有值
      const startBtn = document.getElementById('taskStartDateBtn');
      const dlBtn = document.getElementById('taskDeadlineBtn');
      const startVal = document.getElementById('taskStartDate')?.value || '';
      const dlVal = document.getElementById('taskDeadline')?.value || '';
      if (startBtn) {
        startBtn.textContent = '📅';
        startBtn.classList.toggle('has-value', !!startVal);
      }
      if (dlBtn) {
        dlBtn.textContent = '📅';
        dlBtn.classList.toggle('has-value', !!dlVal);
      }
    },

    showNotesModal(task) {
      const I18n = window.ModuleApp?.I18n;
      const isEn = I18n?.getLocale?.() === 'en-US';
      document.getElementById('notesTitle').textContent = task.content;
      document.getElementById('notesContent').textContent = task.notes || (I18n?.t('common.none') || '（无备注）');
      let deadlineStr = I18n?.t('common.none') || '无';
      if (task.deadline) {
        const days = window.ModuleApp.TaskItem.helpers.daysFromNow(task.deadline);
        const dayUnit = isEn ? 'd' : '天';
        deadlineStr = `${task.deadline} ${days !== null ? '(' + days + dayUnit + ')' : ''}`;
      }
      const dlLabel = I18n?.t('modal.deadline') || '截止';
      document.getElementById('notesDeadline').textContent = `${dlLabel}：${deadlineStr}`;
      document.getElementById('notesModal').hidden = false;
    },

    showDataModal(dbPath) {
      document.getElementById('dataModal').hidden = false;
      if (dbPath) {
        const isEn = window.ModuleApp?.I18n?.getLocale?.() === 'en-US';
        document.getElementById('exportHint').textContent = (isEn ? 'Current data: ' : '当前数据: ') + dbPath;
      }
      window.ModuleApp.refreshBackupsList?.();
    }
  };

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.Modal = Modal;
})();
