// Module — 控制器：搜索中枢 (Controller)
(function() {

  function tr(key, fallback, params) {
    const I18n = window.ModuleApp && window.ModuleApp.I18n;
    if (I18n && typeof I18n.t === 'function') {
      if (typeof I18n.hasKey !== 'function' || I18n.hasKey(key)) {
        return I18n.t(key, params);
      }
    }
    let text = fallback || key;
    if (params && typeof text === 'string') {
      text = text.replace(/\{(\w+)\}/g, (m, k) =>
        Object.prototype.hasOwnProperty.call(params, k) && params[k] !== undefined && params[k] !== null
          ? String(params[k])
          : m
      );
    }
    return text;
  }

  const SearchController = {

    _state: null,
    _deps: null,    // { render, switchView }
    _debounceTimer: null,
    _matchIds: [],
    _matchIndex: -1,

    init(stateRef, deps) {
      this._state = stateRef;
      this._deps = deps;

      const searchInput    = document.getElementById('searchInput');
      const searchClear    = document.getElementById('searchClear');
      const searchResultEl = document.getElementById('searchResult');

      if (searchInput) {
        searchInput.addEventListener('input', () => {
          this._state.patch({ search: searchInput.value });
          this._matchIndex = -1;
          this._debouncedRender();
        });
        searchInput.addEventListener('keydown', e => {
          if (e.key === 'Escape') this.clearSearch();
          if (e.key === 'Enter' || e.key === 'F3') {
            e.preventDefault();
            this.jumpNextMatch(e.shiftKey);
          }
        });
      }

      if (searchClear) searchClear.addEventListener('click', () => this.clearSearch());

      if (searchResultEl) {
        searchResultEl.addEventListener('dblclick', e => {
          const item = e.target.closest('.search-item');
          if (item && item.dataset.searchJump) this.jumpToSearchHit(item.dataset.searchJump);
        });
        searchResultEl.addEventListener('click', e => {
          const item = e.target.closest('.search-item');
          if (item && item.dataset.searchJump) this.jumpToSearchHit(item.dataset.searchJump, { keepSearch: true });
        });
      }

      document.addEventListener('click', (e) => {
        const searchBox = document.querySelector('.search-box');
        if (searchResultEl && !searchResultEl.hidden) {
          if (!searchBox.contains(e.target) && !searchResultEl.contains(e.target)) {
            searchResultEl.hidden = true;
          }
        }
      });

      if (searchInput) {
        searchInput.addEventListener('focus', () => {
          if (searchInput.value.trim() && searchResultEl) {
            searchResultEl.hidden = false;
          }
        });
      }
    },

    _debouncedRender() {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => {
        if (this._state.state.view === 'hierarchy') this._deps.render();
        else this.updateSearchResult();
      }, 300);
    },

    clearSearch() {
      const si = document.getElementById('searchInput');
      if (si) { si.value = ''; si.focus(); }
      this._state.patch({ search: '' });
      this._matchIds = [];
      this._matchIndex = -1;
      if (this._state.state.view === 'hierarchy') this._deps.render();
      else this.updateSearchResult();
    },

    taskPathText(taskId) {
      const state = this._state.state;
      const parts = [];
      let cur = state.tasks.find(t => t.id === taskId);
      const guard = new Set();
      while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        parts.unshift(cur.content);
        if (!cur.parentId) break;
        cur = state.tasks.find(t => t.id === cur.parentId);
      }
      return parts.join(' / ');
    },

    _collectMatchIds() {
      const q = (this._state.state.search || '').trim().toLowerCase();
      if (!q) { this._matchIds = []; return; }
      const PS = window.ModuleApp.ProjectScope;
      const scoped = PS
        ? PS.filterTasksByProjectScope(this._state.state.tasks, this._state.state.projectScopeIds)
        : this._state.state.tasks;
      this._matchIds = scoped
        .filter(t => {
          if ((t.content || '').toLowerCase().includes(q)) return true;
          if ((t.notes || '').toLowerCase().includes(q)) return true;
          return false;
        })
        .map(t => t.id);
    },

    updateSearchResult() {
      const state = this._state.state;
      const result   = document.getElementById('searchResult');
      const clearBtn = document.getElementById('searchClear');
      if (!result) return;

      const q = state.search.trim();
      if (!q) {
        result.hidden = true; result.textContent = '';
        if (clearBtn) clearBtn.hidden = true;
        return;
      }
      if (clearBtn) clearBtn.hidden = false;

      const qLower = q.toLowerCase();
      const highlightMatch = window.ModuleApp.TaskItem?.helpers?.highlightMatch || (t => t);

      this._collectMatchIds();
      const matches = this._matchIds.map(id => state.tasks.find(t => t.id === id)).filter(Boolean);

      result.hidden = false;
      if (matches.length === 0) {
        result.innerHTML = `<span class="search-summary">${tr('hierarchy.emptyFiltered', '无匹配')}</span>`;
        return;
      }

      const top = matches.slice(0, 20);
      const Tc = window.ModuleApp.TaskController;
      const items = top.map(t => {
        const path = this.taskPathText(t.id);
        const lvl  = Tc.getTaskLevel(t);
        const tag  = `L${lvl}`;
        const completedBadge = t.completed
          ? `<span class="search-item-lvl" style="background:var(--fg-soft);margin-left:4px;">${tr('status.completed', '已完成')}</span>`
          : '';
        return `<div class="search-item" data-search-jump="${t.id}"
          title="Enter / F3"
          style="${t.completed ? 'opacity:0.6;' : ''}">
          <span class="search-item-lvl l${lvl}">${tag}</span>
          <span class="search-item-path">${highlightMatch(path, qLower)}</span>
          ${completedBadge}
        </div>`;
      }).join('');

      const more = matches.length > 20
        ? `<div class="search-item-more">+${matches.length - 20} ${tr('common.more', '更多')}</div>`
        : '';

      result.innerHTML = `<div class="search-summary">${matches.length} · Enter/F3</div>${items}${more}`;
    },

    jumpNextMatch(backward = false) {
      this._collectMatchIds();
      if (this._matchIds.length === 0) {
        window.ModuleApp.Toast?.show(tr('hierarchy.emptyFiltered', '无匹配任务'), 'info');
        return;
      }
      if (backward) {
        this._matchIndex = this._matchIndex <= 0 ? this._matchIds.length - 1 : this._matchIndex - 1;
      } else {
        this._matchIndex = (this._matchIndex + 1) % this._matchIds.length;
      }
      const id = this._matchIds[this._matchIndex];
      this.jumpToSearchHit(id, { keepSearch: true, toast: false });
      window.ModuleApp.Toast?.show(`${this._matchIndex + 1}/${this._matchIds.length}`, 'info');
    },

    jumpToSearchHit(taskId, opts = {}) {
      const keepSearch = !!opts.keepSearch;
      const state = this._state.state;
      if (state.view !== 'hierarchy') this._deps.switchView('hierarchy');

      if (!keepSearch) {
        const si = document.getElementById('searchInput');
        if (si) si.value = '';
        this._state.patch({ search: '' });
      }

      const target = state.tasks.find(t => t.id === taskId);
      if (!target) return;

      const chain = [];
      let cur = target;
      const guard = new Set();
      while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        if (cur.parentId) chain.push(cur.parentId);
        cur = state.tasks.find(t => t.id === cur.parentId);
      }

      const newCol = new Set(state.collapsed);
      for (const id of chain) newCol.delete(id);
      this._state.patch({ collapsed: newCol });

      this._deps.render();

      requestAnimationFrame(() => {
        const el = document.querySelector(`.task-row[data-id="${taskId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('search-highlight-row');
          setTimeout(() => el.classList.remove('search-highlight-row'), 3000);
        }
      });
      if (opts.toast !== false && !keepSearch) {
        window.ModuleApp.Toast.show(tr('reminder.focusTask', '已跳转到任务'), 'success');
      }
    }
  };

  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.SearchController = SearchController;
})();
