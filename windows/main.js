// Living Ideas — Windows (Electron) shell. The pages themselves are the same files the Android app uses.
const { app, BrowserWindow, protocol, net, ipcMain, shell, Notification, Tray, Menu, nativeImage, session } = require('electron');
const path = require('path'), url = require('url'), { Worker } = require('worker_threads');

const ROOT = path.join(__dirname, 'app');
const ICON = path.join(__dirname, 'build', 'icon.png');
app.setAppUserModelId('com.livingideas.library');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null, tray = null, quitting = false;
function showWin() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 360, minHeight: 520, backgroundColor: '#f0e8d3', title: 'Living Ideas', icon: ICON, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  win.setMenuBarVisibility(false);
  win.loadURL('app://local/index.html');
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^(https?:|mailto:)/i.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => { if (!u.startsWith('app://')) { e.preventDefault(); if (/^https?:/i.test(u)) shell.openExternal(u); } });
  win.on('close', (e) => { if (!quitting && timers.size) { e.preventDefault(); win.hide(); ensureTray(); } });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', showWin);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!timers.size || quitting) app.quit(); });

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('app', (req) => {
    let p = decodeURIComponent(new URL(req.url).pathname); if (!p || p === '/') p = '/index.html';
    const f = path.normalize(path.join(ROOT, p));
    if (!f.startsWith(ROOT)) return new Response('', { status: 404 });
    return net.fetch(url.pathToFileURL(f).toString());
  });
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['notifications', 'fullscreen', 'clipboard-sanitized-write'].includes(perm)));
  createWindow();
});

// ---------- window ----------
ipcMain.handle('win:fs', () => { if (win) win.setFullScreen(!win.isFullScreen()); });
ipcMain.on('open-url', (_e, u) => { if (/^(https?:|mailto:)/i.test(String(u))) shell.openExternal(String(u)); });

// ---------- notifications (daily quote, reading reminder, goal reached) ----------
const timers = new Map();
function ensureTray() {
  if (tray) return;
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('Living Ideas');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open · فتح', click: showWin }, { label: 'Quit · خروج', click: () => { quitting = true; app.quit(); } }]));
    tray.on('click', showWin);
  } catch (e) {}
}
function clearN(id) { const t = timers.get(id); if (t) { clearTimeout(t); timers.delete(id); } }
function arm(n) {
  clearN(n.id);
  const s = n.schedule || {}; let at;
  if (s.on) { at = new Date(); at.setHours(+s.on.hour || 0, +s.on.minute || 0, 0, 0); if (at.getTime() <= Date.now() + 1000) at.setDate(at.getDate() + 1); }
  else at = new Date(s.at || Date.now());
  const delay = Math.max(0, at.getTime() - Date.now()); if (delay > 2147483000) return;
  timers.set(n.id, setTimeout(() => {
    timers.delete(n.id);
    try { const nt = new Notification({ title: n.title || 'Living Ideas', body: n.largeBody || n.body || '', icon: ICON }); nt.on('click', showWin); nt.show(); } catch (e) {}
    if (s.on) arm(n);
  }, delay));
}
ipcMain.on('ntf:cancel', (_e, ids) => { (ids || []).forEach(clearN); });
ipcMain.on('ntf:schedule', (_e, list) => { (list || []).forEach((n) => { if (n && typeof n.id === 'number') arm(n); }); });

// ---------- offline translation (models download once, then run on this PC) ----------
let worker = null; const pending = new Set();
let smokeSink = null;
function toUI(m) { if (smokeSink) smokeSink(m); if (win && !win.isDestroyed()) win.webContents.send('tr:ev', m); }
function getWorker() {
  if (worker) return worker;
  const w = new Worker(path.join(__dirname, 'translator-worker.mjs'), { workerData: { cache: path.join(app.getPath('userData'), 'models') } });
  w.on('message', (m) => { if (m.kind === 'ok' || m.kind === 'err') pending.delete(m.id); toUI(m); });
  const dead = (why) => { if (worker === w) worker = null; toUI({ id: '', kind: 'nomodel', text: why }); pending.forEach((id) => toUI({ id, kind: 'err', text: why })); pending.clear(); };
  w.on('error', (e) => dead(String((e && e.message) || e).slice(0, 90)));
  w.on('exit', (c) => { if (worker === w) dead('translator stopped (' + c + ')'); });
  worker = w; return w;
}
ipcMain.on('tr:go', (_e, id, text, src, tgt) => {
  try { pending.add(id); getWorker().postMessage({ id, text: String(text), src, tgt }); }
  catch (e) { pending.delete(id); toUI({ id: '', kind: 'nomodel', text: String((e && e.message) || e).slice(0, 90) }); toUI({ id, kind: 'err', text: 'worker' }); }
});

// ---------- self-test used by the build server only (LI_SMOKE=1): opens the app, translates a few sentences, writes a report, exits ----------
if (process.env.LI_SMOKE) {
  const fs = require('fs'), out = process.env.LI_SMOKE_OUT || 'smoke.json', res = { app: [], translate: [] };
  const done = (ok) => { res.ok = ok; try { fs.writeFileSync(out, JSON.stringify(res, null, 1)); } catch (e) {} app.exit(ok ? 0 : 1); };
  setTimeout(() => { res.timeout = true; done(false); }, 13 * 60 * 1000);
  app.whenReady().then(() => {
    const waiters = {}; smokeSink = (m) => { if (m.id && waiters[m.id]) { waiters[m.id](m); delete waiters[m.id]; } else if (!m.id) res.app.push('event:' + m.kind + (m.text ? ' ' + m.text : '')); };
    const ask = (id, text, src, tgt) => new Promise((ok) => { waiters[id] = ok; getWorker().postMessage({ id, text, src, tgt }); });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      await wait(1500); while (!win) await wait(500);
      await new Promise((r) => { if (!win.webContents.isLoading()) r(); else win.webContents.once('did-finish-load', r); });
      await wait(5000);
      const info = await win.webContents.executeJavaScript("(async()=>{const s=await window.api.state();return {books:s.books.length,desk:!!window.liDesk,platform:window.api.platform,pdfjs:(await fetch('/pdfjs/pdf.min.js')).status}})()");
      res.info = info;
      const jobs = [['\u0645\u0631\u062d\u0628\u0627 \u0628\u0643\u0645 \u0641\u064a \u0647\u0630\u0627 \u0627\u0644\u0643\u062a\u0627\u0628 \u0627\u0644\u062c\u0645\u064a\u0644.', 'ar', 'en'], ['Reading is a conversation across time.', 'en', 'ar'], ['Reading is a conversation across time.', 'en', 'id'], ['Le livre est sur la table.', 'fr', 'ar']];
      let ok = info.books > 0 && info.desk && info.platform === 'win32' && info.pdfjs === 200, n = 0;
      for (const [text, src, tgt] of jobs) {
        const t0 = Date.now(), m = await ask('s' + (++n), text, src, tgt), good = m.kind === 'ok' && m.text && m.text !== text;
        res.translate.push({ pair: src + '>' + tgt, kind: m.kind, text: m.text, sec: Math.round((Date.now() - t0) / 1000) }); if (!good) ok = false;
      }
      done(ok);
    })().catch((e) => { res.error = String((e && e.stack) || e); done(false); });
  });
}
