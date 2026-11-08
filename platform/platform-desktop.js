/* Windows (Electron) glue, part 2 — runs after platform-android.js. */
(function () {
  var D = window.liDesk, api = window.api; if (!D || !api) return;
  api.platform = 'win32'; api.noFullscreen = false;
  api.fullscreen = function () { return D.fullscreen(); };
  api.openUrl = function (u) { if (/^(https?:|mailto:)/i.test(u)) D.openUrl(u); };
  api.reveal = function () { return Promise.resolve(); };
})();
