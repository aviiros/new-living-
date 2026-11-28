// Audiobook import / persistence in desktop Chromium (stubbed native bridge). NOT a phone test.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const W = path.join(__dirname, '..'), root = os.tmpdir() + '/aud-' + process.pid, prof = os.tmpdir() + '/audprof-' + process.pid;
fs.cpSync(W + '/web-src', root, { recursive: true }); fs.mkdirSync(root + '/lib', { recursive: true }); fs.copyFileSync(W + '/node_modules/jszip/dist/jszip.min.js', root + '/lib/jszip.min.js'); fs.copyFileSync(W + '/platform/platform-android.js', root + '/platform-android.js');
fs.writeFileSync(root + '/index.html', fs.readFileSync(W + '/web-src/library.html', 'utf8').replace('<script src="i18n.js"></script>', '<script src="lib/jszip.min.js"></script><script src="formats.js"></script><script src="pdfgeo.js"></script><script src="ar-fix.js"></script><script src="convert.js"></script><script src="platform-android.js"></script><script src="i18n.js"></script>'));
const types = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm', png: 'image/png', svg: 'image/svg+xml' };
const srv = http.createServer((q, r) => { let u = decodeURIComponent(q.url.split('?')[0]); if (u === '/') u = '/index.html'; fs.readFile(path.join(root, u), (e, b) => { if (e) { r.writeHead(404); r.end(); return } r.writeHead(200, { 'content-type': types[path.extname(u).slice(1)] || 'application/octet-stream' }); r.end(b) }) }).listen(0);
const fail = [], ck = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fail.push(n) };
const url = () => `http://127.0.0.1:${srv.address().port}/index.html`;
const init = () => { window.__calls = []; window.__ab = []; const o = Blob.prototype.arrayBuffer; Blob.prototype.arrayBuffer = function () { window.__ab.push(this.size); return o.call(this) };
  window.LiNative = { speakBatch() {}, ttsCmd() {}, translate() {}, keepAlive() {}, audioSession(t, p) { window.__calls.push('aus:' + p) }, online() { return false }, packs() {}, packGet() {}, packDel() {}, sleepTimer() {}, sleepLeft() { return 0 } } };
(async () => {
  let ctx = await chromium.launchPersistentContext(prof, { viewport: { width: 420, height: 900 } }), pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(String(e)));
  await pg.addInitScript(init); await pg.goto(url()); await pg.waitForTimeout(2500);
  const can = await pg.evaluate(() => { const a = document.createElement('audio'); return { mp3: a.canPlayType('audio/mpeg'), m4b: a.canPlayType('audio/mp4'), ogg: a.canPlayType('audio/ogg'), wav: a.canPlayType('audio/wav'), flac: a.canPlayType('audio/flac'), opus: a.canPlayType('audio/ogg; codecs=opus') } });
  console.log('canPlayType in this Chromium', JSON.stringify(can));
  // 1. big files are imported without being read into memory
  const r1 = await pg.evaluate(async () => { const chunk = new Uint8Array(1 << 20).fill(7); const big = new File(Array(150).fill(chunk), 'Big Book.mp3', { type: '' }); const wav = new File([new Uint8Array(3e6)], 'Second.wav'); const s1 = await window.api.addFile(big); const s2 = await window.api.addFile(wav); return { n: s2.books.filter(b => b.format === 'audio').length, maxRead: Math.max(0, ...window.__ab), titles: s2.books.filter(b => b.format === 'audio').map(b => b.title + ':' + b.bytes) } });
  ck('150 MB mp3 and a wav were added', r1.n === 2, JSON.stringify(r1.titles));
  ck('the audio file was never read whole into memory', r1.maxRead <= 1.5 * 1048576, 'largest read = ' + r1.maxRead + ' bytes');
  const dup = await pg.evaluate(async () => { const chunk = new Uint8Array(1 << 20).fill(7); const again = new File(Array(150).fill(chunk), 'Copy.mp3'); const s = await window.api.addFile(again); return s.books.filter(b => b.format === 'audio').length });
  ck('the same file is not added twice', dup === 2, 'audio books ' + dup);
  const bad = await pg.evaluate(async () => { const s = await window.api.addFile(new File([new Uint8Array(100)], 'x.xyz')); return s.books.length });
  // 2. the dialog has an Add button which uses the file picker, and the new book goes to the queue
  await pg.evaluate(() => window.liAudioDlg()); await pg.waitForTimeout(300);
  ck('"Add audiobook" button is visible in the audiobook window', await pg.evaluate(() => { const b = document.getElementById('aqAdd'); return !!b && b.offsetParent !== null && b.textContent.length > 3 }), await pg.evaluate(() => (document.getElementById('aqAdd') || {}).textContent));
  const [fc] = await Promise.all([pg.waitForEvent('filechooser', { timeout: 5000 }), pg.click('#aqAdd')]);
  ck('the picker accepts audio files', /mp3/.test(await pg.evaluate(() => [...document.querySelectorAll('input[type=file]')].map(i => i.accept).join(' ')) || 'mp3'));
  await fc.setFiles([{ name: 'Third Book.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(2e6) }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]); await pg.waitForTimeout(1500);
  const q = await pg.evaluate(async () => ({ q: JSON.parse(localStorage.getItem('li-aq') || '[]').length, rows: document.querySelectorAll('#sheet .svq').length, st: (await window.api.state()).books.filter(b => b.format === 'audio').map(b => b.title) }));
  ck('picked audio file was added and queued; the .txt was ignored', q.st.length === 3 && q.q >= 1 && q.st.indexOf('notes') < 0, JSON.stringify(q));
  const before = await pg.evaluate(async () => { const s = await window.api.state(); const out = {}; for (const b of s.books.filter(b => b.format === 'audio')) { out[b.id] = await new Promise(res => { const r = indexedDB.open('livingideas-library', 1); r.onsuccess = () => { const g = r.result.transaction('files').objectStore('files').get(b.id + '/' + b.file); g.onsuccess = () => res(g.result ? g.result.size : -1) } }) } return out });
  console.log('stored sizes', JSON.stringify(before));
  ck('stored blobs have the real sizes', Object.values(before).sort((a, b) => a - b).join() === [2e6, 3e6, 150 * 1048576].join());
  ck('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
  // 3. force-close: new browser process on the same profile
  ctx = await chromium.launchPersistentContext(prof, { viewport: { width: 420, height: 900 } }); pg = await ctx.newPage(); await pg.addInitScript(init); await pg.goto(url()); await pg.waitForTimeout(3000);
  const after = await pg.evaluate(async () => { const s = await window.api.state(); const out = {}; for (const b of s.books.filter(b => b.format === 'audio')) { out[b.id] = await new Promise(res => { const r = indexedDB.open('livingideas-library', 1); r.onsuccess = () => { const g = r.result.transaction('files').objectStore('files').get(b.id + '/' + b.file); g.onsuccess = () => res(g.result ? g.result.size : -1) } }) } return { out, q: JSON.parse(localStorage.getItem('li-aq') || '[]').length } });
  ck('after closing and reopening: audiobooks are still in the library with their files', Object.keys(after.out).length === 3 && JSON.stringify(after.out) === JSON.stringify(before), JSON.stringify(after.out));
  ck('the queue survived too', after.q >= 1, 'queue ' + after.q);
  await ctx.close(); srv.close(); try { fs.rmSync(prof, { recursive: true, force: true }) } catch (e) { }
  if (fail.length) { console.log('FAILED: ' + fail.join(' | ')); process.exit(1) } console.log('all audio import checks passed');
})();
