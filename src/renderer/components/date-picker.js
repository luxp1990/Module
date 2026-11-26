// Module — 组件：自定义日期选择器（v1.5.0 填实）

(function() {

  const DatePicker = {

    _state: null,

    _onConfirm: null,




    init(stateRef) {

      this._state = stateRef;

      this._bindEvents();

    },




    show({ target, title, hint, value }, onConfirmCallback) {

      this._onConfirm = onConfirmCallback;

      const dpState = { target, title: title || '选择日期', hint: hint || '' };



      if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {

        const [y, m, d] = value.split('-').map(Number);

        dpState.viewYear = y;

        dpState.viewMonth = m;

        dpState.value = value;

      } else {

        const now = new Date();

        dpState.viewYear = now.getFullYear();

        dpState.viewMonth = now.getMonth() + 1;

        dpState.value = '';

      }



      this._state.patch({ datePicker: dpState }, 'DATE_PICKER_OPEN');



      const titleEl = document.getElementById('datePickerTitle');

      const hintEl = document.getElementById('datePickerHint');

      if (titleEl) titleEl.textContent = dpState.title;

      if (hintEl) hintEl.textContent = dpState.hint;



      this._renderCalendar();



      const modal = document.getElementById('datePickerModal');

      if (modal) {

        modal.hidden = false;

        modal.focus();

      }

    },




    hide() {

      const modal = document.getElementById('datePickerModal');

      if (modal) modal.hidden = true;

      const target = this._state.state.datePicker.target;

      this._state.patch({ datePicker: { value: null, target: null } }, 'DATE_PICKER_CLOSE');



      // 焦点归还防御

      if (target === 'modalStart' || target === 'modalDeadline') {

        const tc = document.getElementById('taskContent');

        if (tc) tc.focus();

      } else {

        const qi = document.getElementById('quickInput');

        if (qi) qi.focus();

      }

    },




    _renderCalendar() {

      const { viewYear, viewMonth, value } = this._state.state.datePicker;

      const titleEl = document.getElementById('dpTitle');

      if (titleEl) titleEl.textContent = `${viewYear} 年 ${viewMonth} 月`;




      const firstDay = new Date(viewYear, viewMonth - 1, 1);

      let firstDayDow = (firstDay.getDay() + 6) % 7; // 转为周一起点

      const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();

      const prevMonthLastDay = new Date(viewYear, viewMonth - 1, 0).getDate();

      const now = new Date();

      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;



      const cells = [];

      // 上月补齐

      for (let i = firstDayDow - 1; i >= 0; i--) {

        const d = prevMonthLastDay - i;

        const pm = viewMonth === 1 ? 12 : viewMonth - 1;

        const py = viewMonth === 1 ? viewYear - 1 : viewYear;

        cells.push({ date: `${py}-${String(pm).padStart(2, '0')}-${String(d).padStart(2, '0')}`, day: d, otherMonth: true });

      }

      // 本月

      for (let d = 1; d <= daysInMonth; d++) {

        cells.push({ date: `${viewYear}-${String(viewMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`, day: d, otherMonth: false });

      }

      // 下月补齐

      const remain = 42 - cells.length;

      for (let d = 1; d <= remain; d++) {

        const nm = viewMonth === 12 ? 1 : viewMonth + 1;

        const ny = viewMonth === 12 ? viewYear + 1 : viewYear;

        cells.push({ date: `${ny}-${String(nm).padStart(2, '0')}-${String(d).padStart(2, '0')}`, day: d, otherMonth: true });

      }




      const grid = document.getElementById('dpGrid');

      if (!grid) return;

      grid.innerHTML = cells.map(c => {

        const classes = ['dp-cell'];

        if (c.otherMonth) classes.push('other-month');

        if (c.date === todayStr) classes.push('today');

        if (c.date === value) classes.push('selected');

        return `<button type="button" class="${classes.join(' ')}" data-date="${c.date}">${c.day}</button>`;

      }).join('');




      // 绑定每个格子的点击

      grid.querySelectorAll('.dp-cell').forEach(btn => {

        btn.addEventListener('click', e => {

          e.preventDefault();

          const date = e.currentTarget.dataset.date;

          const [y, m] = date.split('-').map(Number);

          const currentDp = this._state.state.datePicker;

          this._state.patch({

            datePicker: {

              ...currentDp,

              viewYear: y,

              viewMonth: m,

              value: date

            }

          }, 'DATE_PICKER_SELECT');

          this._renderCalendar();

        });

      });

    },




    _bindEvents() {

      // 确认

      document.getElementById('datePickerConfirm')?.addEventListener('click', () => {

        if (this._onConfirm) this._onConfirm(this._state.state.datePicker.target, this._state.state.datePicker.value);

        this.hide();

      });



      // 清除

      document.getElementById('datePickerClear')?.addEventListener('click', () => {

        if (this._onConfirm) this._onConfirm(this._state.state.datePicker.target, null);

        this.hide();

      });




      // 导航

      const nav = (dy, dm) => {

        let y = this._state.state.datePicker.viewYear + dy;

        let m = this._state.state.datePicker.viewMonth + dm;

        if (m < 1) { m = 12; y -= 1; }

        if (m > 12) { m = 1; y += 1; }

        this._state.patch({ datePicker: { ...this._state.state.datePicker, viewYear: y, viewMonth: m } }, 'DATE_PICKER_NAV');

        this._renderCalendar();

      };

      document.getElementById('dpPrevYear')?.addEventListener('click', () => nav(-1, 0));

      document.getElementById('dpPrevMonth')?.addEventListener('click', () => nav(0, -1));

      document.getElementById('dpNextMonth')?.addEventListener('click', () => nav(0, 1));

      document.getElementById('dpNextYear')?.addEventListener('click', () => nav(1, 0));




      // 快捷键

      document.getElementById('datePickerModal')?.addEventListener('keydown', e => {

        if (e.key === 'Escape') { e.preventDefault(); this.hide(); }

        else if (e.key === 'Enter') {

          e.preventDefault();

          if (this._onConfirm) this._onConfirm(this._state.state.datePicker.target, this._state.state.datePicker.value);

          this.hide();

        }

      });

    }

  };




  window.ModuleApp = window.ModuleApp || {};

  window.ModuleApp.DatePicker = DatePicker;

})();
