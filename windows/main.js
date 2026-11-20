// Living Ideas — Windows (Electron) shell. The pages themselves are the same files the Android app uses.
const { app, BrowserWindow, protocol, net, ipcMain, shell, Notification, Tray, Menu, nativeImage, session } = require('electron');
const path = require('path'), url = require('url'), fs = require('fs'), os = require('os'), { Worker } = require('worker_threads');
const { dialog } = require('electron');

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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false }
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

// ---------- save the translated book as a PDF ----------
async function makePdf(html) {
  const tmp = path.join(os.tmpdir(), 'li-print-' + Date.now() + '.html'); fs.writeFileSync(tmp, html, 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try { await w.loadFile(tmp); return await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } }); }
  finally { try { w.destroy(); } catch (e) {} try { fs.unlinkSync(tmp); } catch (e) {} }
}
ipcMain.on('pdf:print', async (_e, html, name) => {
  try {
    const pdf = await makePdf(String(html || ''));
    const r = await dialog.showSaveDialog(win, { defaultPath: String(name || 'book').replace(/[\\/:*?"<>|]+/g, ' ') + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!r.canceled && r.filePath) fs.writeFileSync(r.filePath, pdf);
  } catch (e) { dialog.showErrorBox('Living Ideas', 'PDF: ' + String((e && e.message) || e)); }
});

// ---------- offline translation (models download once, then run on this PC) ----------
// The small helper program that keeps every AI engine under the CPU limit (Windows Job Object) and measures it. Without it the engines still run, only the limit is not enforced.
function RUNNER() { try { const p = app.isPackaged ? path.join(process.resourcesPath, 'li-runner.exe') : path.join(__dirname, 'native', 'li-runner.exe'); return fs.existsSync(p) ? p : ''; } catch (e) { return ''; } }
const ctlWait = new Map(); let ctlSeq = 0;
let worker = null; const pending = new Set();
let smokeSink = null;
function toUI(m) { if (smokeSink) smokeSink(m); if (win && !win.isDestroyed()) win.webContents.send('tr:ev', m); }
function getWorker() {
  if (worker) return worker;
  const w = new Worker(path.join(__dirname, 'translator-worker.mjs'), { workerData: { cache: path.join(app.getPath('userData'), 'models'), runner: RUNNER() } });
  w.on('message', (m) => { if (m.kind === 'ctl') { const f = ctlWait.get(m.rid); if (f) { ctlWait.delete(m.rid); f(m); } return; } if (m.kind === 'ok' || m.kind === 'err') pending.delete(m.id); toUI(m); });
  const dead = (why) => { if (worker === w) worker = null; toUI({ id: '', kind: 'nomodel', text: why }); pending.forEach((id) => toUI({ id, kind: 'err', text: why })); pending.clear(); };
  w.on('error', (e) => dead(String((e && e.message) || e).slice(0, 90)));
  w.on('exit', (c) => { if (worker === w) dead('translator stopped (' + c + ')'); });
  worker = w; return w;
}
ipcMain.on('tr:go', (_e, id, text, src, tgt, online, hq) => {
  try { pending.add(id); getWorker().postMessage({ id, text: String(text), src, tgt, online: !!online, hq: !!hq }); }
  catch (e) { pending.delete(id); toUI({ id: '', kind: 'nomodel', text: String((e && e.message) || e).slice(0, 90) }); toUI({ id, kind: 'err', text: 'worker' }); }
});


// ---------- scanned pages / photos -> text with the local AI model (Arabic + English) ----------
let ocrW = null; const ocrWait = new Map(); let ocrSeq = 0;
function getOcr() {
  if (ocrW) return ocrW;
  const w = new Worker(path.join(__dirname, 'ocr-worker.mjs'), { workerData: { cache: path.join(app.getPath('userData'), 'models'), runner: RUNNER() } });
  w.on('message', (m) => { if (m.kind === 'prog') { if (win && !win.isDestroyed()) win.webContents.send('ai:prog', m.text); return; } const f = ocrWait.get(m.id); if (f) { ocrWait.delete(m.id); f(m); } });
  const dead = (why) => { if (ocrW === w) ocrW = null; ocrWait.forEach((f, id) => f({ kind: 'err', id, text: why })); ocrWait.clear(); };
  w.on('error', (e) => dead(String((e && e.message) || e).slice(0, 120))); w.on('exit', () => dead('stopped'));
  ocrW = w; return w;
}
function ocrCall(msg, freeTranslator) {
  return new Promise((ok) => {
    if (freeTranslator && worker) { try { worker.postMessage({ aistop: true }); } catch (e) {} }
    const id = ++ocrSeq; ocrWait.set(id, ok);
    try { getOcr().postMessage(Object.assign({ id }, msg)); } catch (e) { ocrWait.delete(id); ok({ kind: 'err', id, text: String((e && e.message) || e) }); }
  });
}
ipcMain.handle('ai:ocr:status', () => ocrCall({ kind: 'status' }));
ipcMain.handle('ai:ocr:prep', () => ocrCall({ kind: 'prep' }, true));
ipcMain.handle('ai:ocr:page', (_e, image) => ocrCall({ kind: 'page', image: String(image) }, true));
ipcMain.handle('ai:ocr:stop', () => ocrCall({ kind: 'stop' }));


// ---------- the list of local AI models (catalog + added from this computer), settings, downloads, resources ----------
const MODELS = () => path.join(app.getPath('userData'), 'models');
let regMod = null, engMod = null;
async function reg() { return regMod || (regMod = await import('./ai-registry.mjs')); }
async function eng() { return engMod || (engMod = await import('./ai-engine.mjs')); }
function freeServers() { try { if (worker) worker.postMessage({ aistop: true }); } catch (e) {} ocrCall({ kind: 'stop' }); }
const nothing = { stats: { state: 'stopped' } };
function trCtl(ctl) { return new Promise((ok) => { if (!worker) return ok(nothing); const rid = ++ctlSeq; ctlWait.set(rid, ok); try { worker.postMessage({ ctl, rid }); } catch (e) { ctlWait.delete(rid); return ok(nothing); } setTimeout(() => { if (ctlWait.delete(rid)) ok(nothing); }, 4000); }); }
function ocrCtl(ctl) { if (!ocrW) return Promise.resolve(nothing); return Promise.race([ocrCall({ kind: 'ctl', ctl }), new Promise((r) => setTimeout(() => r(nothing), 4000))]); }
const dls = new Map(); // model id -> { state: 'downloading' | 'verifying' | 'paused' | 'error', pct, ctl, err }
const MB = (b) => Math.round(b / 1048576);
async function aiState() {
  const R = await reg(), E = await eng(), r = R.load(MODELS());
  const [t, o] = await Promise.all([trCtl('stats'), ocrCtl('stats')]);
  const models = R.all(MODELS()).map((m) => {
    const have = R.have(MODELS(), m.files ? m : { model: m.file, mm: m.mm || '' });
    let mb = m.files ? MB(m.files.reduce((a, f) => a + f.bytes, 0)) : 0;
    if (!m.files) { try { mb = MB(fs.statSync(m.file).size) + (m.mm ? MB(fs.statSync(m.mm).size) : 0); } catch (e) {} }
    const d = dls.get(m.id);
    return { id: m.id, kind: m.kind, name: m.name, quant: m.quant || '', version: m.version || '', builtin: !!m.builtin, custom: !!m.custom, tested: !!m.tested, mb, ramMB: m.ramMB || 0, langs: m.langs || null, license: m.license || '', licenseNote: m.licenseNote || '', repo: m.repo || '', have, active: r.active[m.kind] === m.id, dl: d ? { state: d.state, pct: d.pct, err: d.err || '' } : null };
  });
  return { models, stats: { translate: t.stats, ocr: o.stats }, settings: r.settings, sys: { cores: os.cpus().length, ramMB: MB(os.totalmem()), freeMB: MB(os.freemem()), limiter: !!RUNNER(), engine: E.hasLlama(MODELS()), build: E.BUILD } };
}
async function aiSelect(kind, id) {
  const R = await reg(), r = R.load(MODELS());
  if (!R.all(MODELS()).some((m) => m.kind === kind && m.id === id)) return { ok: false };
  r.active[kind] = id; R.save(MODELS(), r); freeServers(); return { ok: true };
}
async function aiSet(p) {
  const R = await reg(), r = R.load(MODELS()), s = r.settings;
  if (p && p.idleMin != null) { const v = Number(p.idleMin); if (v >= 0 && v <= 600) s.idleMin = v; }
  if (p && (p.cpu === 'auto' || p.cpu === 'light')) s.cpu = p.cpu;
  R.save(MODELS(), r); return { ok: true, settings: s };
}
async function aiUnload() { const [t, o] = await Promise.all([trCtl('unload'), ocrCtl('unload')]); return { ok: true, busy: !!(t.busy || o.busy) }; }
async function aiDl(id) {
  const R = await reg(), E = await eng(), m = R.all(MODELS()).find((x) => x.id === id);
  if (!m || !m.files) return { ok: false };
  const cur = dls.get(id); if (cur && (cur.state === 'downloading' || cur.state === 'verifying')) return { ok: true };
  const d = { state: 'downloading', pct: 0, ctl: {}, err: '' }; dls.set(id, d);
  E.fetchModel(Object.assign({}, m, { cache: MODELS() }), { pct: (n) => { d.pct = n; }, phase: () => { d.state = 'verifying'; } }, d.ctl).then(() => { dls.delete(id); }, (e) => { if (d.ctl.stopped) { d.state = 'paused'; } else { d.state = 'error'; d.err = String((e && e.message) || e).slice(0, 160); } });
  return { ok: true };
}
async function aiDlPause(id) { const d = dls.get(id); if (d && d.ctl && d.ctl.abort) { d.ctl.abort(); d.state = 'paused'; } return { ok: true }; }
async function aiDlCancel(id) {
  const R = await reg(), E = await eng(), m = R.all(MODELS()).find((x) => x.id === id), d = dls.get(id);
  if (d && d.ctl && d.ctl.abort) { try { d.ctl.abort(); } catch (e) {} }
  dls.delete(id);
  if (m && m.files) for (const f of m.files) { try { fs.rmSync(path.join(E.llamaDir(MODELS()), f.name + '.part'), { force: true }); } catch (e) {} }
  return { ok: true };
}
async function aiVerify(id) {
  const R = await reg(), E = await eng(), m = R.all(MODELS()).find((x) => x.id === id);
  if (!m || !m.files) return { ok: false };
  const d = { state: 'verifying', pct: 0, ctl: {}, err: '' }; dls.set(id, d); let bad = false;
  try {
    for (const f of m.files) { const p = path.join(E.llamaDir(MODELS()), f.name); if (!E.fileOk(p, f.bytes) || (await E.sha256(p)) !== f.sha256) { bad = true; try { fs.rmSync(p, { force: true }); } catch (e) {} } }
  } finally { dls.delete(id); }
  if (bad) freeServers();
  return { ok: !bad, bad };
}
const isGguf = (f) => { try { const fd = fs.openSync(f, 'r'), b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); return b.toString('latin1') === 'GGUF' && fs.statSync(f).size > 20 * 1048576; } catch (e) { return false; } };
// Register a model file that already exists on this computer: checked, test-loaded, never copied.
async function addModel(kind, f, mm) {
  const R = await reg(), E = await eng();
  if (!isGguf(f) || (kind === 'ocr' && !isGguf(mm))) return { ok: false, text: 'badfile' };
  freeServers();
  const exe = await E.ensureLlama(MODELS());
  const args = ['-m', f, '-t', '2', '-c', '1024']; if (kind === 'ocr') args.push('--mmproj', mm);
  let srv; try { srv = await E.startServer(exe, args, null, { runner: RUNNER(), cap: () => R.capOf(MODELS()), name: 'test' }); } catch (e) { return { ok: false, text: 'cannotload' }; }
  srv.kill();
  const r = R.load(MODELS()), id = 'c' + Date.now().toString(36);
  r.custom.push({ id, kind, name: path.basename(f).replace(/\.gguf$/i, ''), file: f, mm: kind === 'ocr' ? mm : '', mb: 0 }); r.active[kind] = id; R.save(MODELS(), r);
  return { ok: true, id };
}
async function aiAdd(kind) {
  try {
    const pick = async (title) => { const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: [{ name: 'GGUF model', extensions: ['gguf'] }] }); return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]; };
    const isOcr = kind === 'ocr';
    const f = await pick(isOcr ? 'Choose the reading model file (.gguf)' : 'Choose the translation model file (.gguf)'); if (!f) return { ok: false, cancel: true };
    let mm = ''; if (isOcr) { mm = await pick('Choose its vision file (mmproj .gguf)'); if (!mm) return { ok: false, cancel: true }; }
    return await addModel(kind, f, mm);
  } catch (e) { return { ok: false, text: String((e && e.message) || e).slice(0, 120) }; }
}
// Remove from the list; downloaded files of catalog models are deleted (the UI asks first), files the person added are never deleted.
async function aiRemove(id) {
  const R = await reg(), E = await eng(), r = R.load(MODELS()), m = R.all(MODELS()).find((x) => x.id === id); if (!m) return { ok: false };
  freeServers(); await aiDlCancel(id);
  if (m.files) {
    const d = E.llamaDir(MODELS());
    for (const f of m.files) {
      const shared = R.CATALOG.some((o) => o.id !== id && o.files.some((x) => x.name === f.name) && E.fileOk(path.join(d, o.files[0].name), o.files[0].bytes));
      if (!shared) { try { fs.rmSync(path.join(d, f.name), { force: true }); } catch (e) {} }
    }
  } else r.custom = r.custom.filter((x) => x.id !== id);
  Object.keys(r.active).forEach((k) => { if (r.active[k] === id) r.active[k] = k === 'translate' ? 'hymt' : 'nuqta'; });
  R.save(MODELS(), r); return { ok: true };
}
ipcMain.handle('ai:list', async () => (await aiState()).models);
ipcMain.handle('ai:state', () => aiState());
ipcMain.handle('ai:select', (_e, k, id) => aiSelect(k, id));
ipcMain.handle('ai:set', (_e, p) => aiSet(p));
ipcMain.handle('ai:unload', () => aiUnload());
ipcMain.handle('ai:pause', (_e, k) => (k === 'ocr' ? ocrCtl('pause') : trCtl('pause')).then(() => ({ ok: true })));
ipcMain.handle('ai:resume', (_e, k) => (k === 'ocr' ? ocrCtl('resume') : trCtl('resume')).then(() => ({ ok: true })));
ipcMain.handle('ai:dl', (_e, id) => aiDl(String(id)));
ipcMain.handle('ai:dlpause', (_e, id) => aiDlPause(String(id)));
ipcMain.handle('ai:dlcancel', (_e, id) => aiDlCancel(String(id)));
ipcMain.handle('ai:verify', (_e, id) => aiVerify(String(id)));
ipcMain.handle('ai:add', (_e, k) => aiAdd(k));
ipcMain.handle('ai:remove', (_e, id) => aiRemove(String(id)));

// ---------- self-test used by the build server only (LI_SMOKE=1): opens the app, translates a few sentences, writes a report, exits ----------
if (process.env.LI_SMOKE) {
  const fs = require('fs'), out = process.env.LI_SMOKE_OUT || 'smoke.json', res = { app: [], translate: [] };
  const done = (ok) => { res.ok = ok; try { fs.writeFileSync(out, JSON.stringify(res, null, 1)); } catch (e) {} app.exit(ok ? 0 : 1); };
  setTimeout(() => { res.timeout = true; done(false); }, 38 * 60 * 1000);
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
        res.translate.push({ pair: src + '>' + tgt, kind: m.kind, text: m.text, engine: m.engine, sec: Math.round((Date.now() - t0) / 1000) }); if (!good) ok = false;
      }
      // Local AI engine check (downloads the model once on the build server). Reported, but a network hiccup there does not fail the build.
      try {
        const hqAsk = (id, text, src, tgt) => new Promise((ok) => { waiters[id] = ok; getWorker().postMessage({ id, text, src, tgt, hq: true }); });
        res.hq = [];
        for (const [text, src, tgt] of [['Reading is the road to knowledge, and knowledge is the road to freedom.', 'en', 'ar'], ['\u0627\u0644\u0643\u062a\u0627\u0628 \u0627\u0644\u062c\u064a\u062f \u0635\u062f\u064a\u0642 \u0644\u0627 \u064a\u062e\u0648\u0646.', 'ar', 'en']]) {
          const t0 = Date.now(), m = await hqAsk('h' + res.hq.length, text, src, tgt);
          res.hq.push({ pair: src + '>' + tgt, kind: m.kind, text: m.text, engine: m.engine, sec: Math.round((Date.now() - t0) / 1000) });
        }
      } catch (e) { res.hqError = String(e && e.message || e); }
      // Local AI reader check: draw an Arabic page in the app, send it through the same path the import uses. Reported, not required.
      try {
        const t0 = Date.now();
        res.ocr = await win.webContents.executeJavaScript(`(async()=>{const D=window.liDesk;const cv=document.createElement('canvas');cv.width=1000;cv.height=700;const c=cv.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,1000,700);c.fillStyle='#000';c.direction='rtl';c.textAlign='right';c.font='bold 44px Tahoma, Arial';c.fillText('\u0627\u0644\u0641\u0635\u0644 \u0627\u0644\u0623\u0648\u0644: \u0627\u0644\u0639\u0642\u0644 \u0648\u0627\u0644\u0625\u0631\u0627\u062f\u0629',940,100);c.font='30px Tahoma, Arial';c.fillText('\u064a\u0631\u0649 \u0634\u0648\u0628\u0646\u0647\u0627\u0648\u0631 \u0623\u0646 \u0627\u0644\u0639\u0627\u0644\u0645 \u0647\u0648 \u062a\u0645\u062b\u0644\u064a\u060c \u0648\u0623\u0646 \u0627\u0644\u0625\u0631\u0627\u062f\u0629 \u0647\u064a \u0627\u0644\u062c\u0648\u0647\u0631 \u0627\u0644\u062e\u0641\u064a.',940,200);const st=await D.ocrStatus();const pr=await D.ocrPrep();const r=await D.ocrPage(cv.toDataURL('image/png'));return {status:st,prep:pr.kind+(pr.text||''),kind:r.kind,text:r.text};})()`);
        res.ocr.sec = Math.round((Date.now() - t0) / 1000);
      } catch (e) { res.ocrError = String(e && e.message || e); }
      try {
        const hqAsk2 = (id, text, src, tgt) => new Promise((ok2) => { waiters[id] = ok2; getWorker().postMessage({ id, text, src, tgt, hq: true }); });
        const extra = await require('./smoke-extra.js')({ res, win, wait, hqAsk: hqAsk2, runner: RUNNER, reg, eng, models: MODELS, addModel, api: { aiState, aiSet, aiUnload, aiDl, aiDlPause, aiVerify, aiSelect, aiRemove } });
        if (!extra) ok = false;
      } catch (e) { res.extraError = String((e && e.stack) || e); ok = false; }
      try { const pdf = await makePdf('<!doctype html><meta charset="utf-8"><body dir="rtl" style="font:16px Tahoma"><h1>ترجمة تجريبية</h1><p>' + 'هذه فقرة عربية للتأكد من إنشاء ملف PDF صحيح. '.repeat(40) + '</p>'); res.pdf = { bytes: pdf.length, header: pdf.slice(0, 5).toString() }; if (!(pdf.length > 3000 && res.pdf.header === '%PDF-')) ok = false; } catch (e) { res.pdf = { error: String(e) }; ok = false; }
      done(ok);
    })().catch((e) => { res.error = String((e && e.stack) || e); done(false); });
  });
}
