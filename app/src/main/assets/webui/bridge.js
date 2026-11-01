/* bridge.js · 把 APK 的 AndroidShell 接口包装成 app.js 认识的 window.ksu
 * 只在拿到 root 时才暴露 ksu，否则界面自动进入预览模式。
 */
(function () {
  if (window.ksu && window.ksu.__dh) return;

  var pending = {};
  var seq = 0;
  var rootOK = false;

  try {
    rootOK = !!(window.AndroidShell && AndroidShell.isRoot());
  } catch (e) {
    rootOK = false;
  }

  window.__dhRoot = rootOK;

  window.__dhResolve = function (id, out) {
    var cb = pending[id];
    if (!cb) return;
    delete pending[id];
    try {
      cb(out);
    } catch (e) {
      console.log('callback error', e);
    }
  };

  if (!rootOK) {
    // 不定义 ksu，app.js 的 hasRoot() 会返回 false，走预览模式
    return;
  }

  window.ksu = {
    __dh: true,
    exec: function (cmd, opts, cb) {
      var id = String(++seq);
      pending[id] = cb || function () {};
      try {
        AndroidShell.exec(String(cmd), id);
      } catch (e) {
        delete pending[id];
      }
      return '';
    },
    toast: function (msg) {
      try {
        AndroidShell.toast(String(msg));
      } catch (e) {
        console.log(msg);
      }
    }
  };
})();
