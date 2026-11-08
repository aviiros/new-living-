/* Windows (Electron) glue, part 1 — runs before platform-android.js.
   Makes the desktop shell look like the pieces the shared code already knows:
   LocalNotifications (daily quote / reading reminders) and LiNative (offline translation). */
(function () {
  var D = window.liDesk; if (!D) return;
  var granted = function () { return Promise.resolve({ display: 'granted' }); };
  var LN = {
    requestPermissions: granted, checkPermissions: granted,
    cancel: function (o) { D.cancel(((o && o.notifications) || []).map(function (n) { return n.id; })); return Promise.resolve(); },
    schedule: function (o) { D.schedule(JSON.parse(JSON.stringify((o && o.notifications) || []))); return Promise.resolve(); }
  };
  window.Capacitor = { isNativePlatform: function () { return true; }, Plugins: { LocalNotifications: LN } };
  window.LiNative = {
    init: function () {}, blockMenu: function () {}, stop: function () {}, voices: function () { return '[]'; },
    translate: function (id, text, src, tgt) { D.translate(id, text, src, tgt); }
  };
  D.onTr(function (e) { if (window.__liTr) window.__liTr(e.id, e.kind, e.text); });
})();
