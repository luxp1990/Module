// Module — Toast 通知组件（桩文件，逐步替代现有 toast 函数）
(function() {
  const Toast = {
    show(msg, type = 'info', duration = 2500) {
      const container = document.getElementById('toastContainer');
      if (!container) return;
      const el = document.createElement('div');
      el.className = `toast toast-${type}`;
      el.textContent = msg;
      container.appendChild(el);
      setTimeout(() => el.remove(), duration);
    }
  };
  window.ModuleApp = window.ModuleApp || {};
  window.ModuleApp.Toast = Toast;
})();
