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
    // the choices live in the program (main process), so they survive closing it and are the same in every book
    pref: function (k) { try { var p = D.prefs && D.prefs(); return !!(p && p[k]); } catch (e) { return false; } },
    setPref: function (k, v) { try { D.setPref(k, !!v); } catch (e) {} },
    translate: function (id, text, src, tgt) { D.translate(id, text, src, tgt, this.online(), this.hq(), false); },
    slow: function () { return !this.online(); },
    hq: function () { return this.pref('acc'); },
    setHQ: function (v) { this.setPref('acc', v); },
    online: function () { return this.pref('online'); },
    setOnline: function (v) { this.setPref('online', v); },
    printHtml: function (html, name) { D.printPdf(html, name); }
  };
  D.onTr(function (e) { if (window.__liTr) window.__liTr(e.id, e.kind, e.text); });
})();
