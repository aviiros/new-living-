// Android library page in desktop Chromium with a stubbed native bridge: statistics, timers, translation packs, online warning.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path');
const root = require('os').tmpdir() + '/libt-' + process.pid, W = path.join(__dirname, '..');
fs.cpSync(W + '/web-src', root, { recursive: true }); fs.mkdirSync(root + '/lib', { recursive: true }); fs.copyFileSync(W + '/node_modules/jszip/dist/jszip.min.js', root + '/lib/jszip.min.js'); fs.copyFileSync(W + '/platform/platform-android.js', root + '/platform-android.js');
fs.writeFileSync(root + '/index.html', fs.readFileSync(W + '/web-src/library.html', 'utf8').replace('<script src="i18n.js"></script>', '<script src="lib/jszip.min.js"></script><script src="formats.js"></script><script src="pdfgeo.js"></script><script src="ar-fix.js"></script><script src="convert.js"></script><script src="platform-android.js"></script><script src="i18n.js"></script>')); const types = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm', png: 'image/png', svg: 'image/svg+xml' };
const srv = http.createServer((q, r) => { let u = decodeURIComponent(q.url.split('?')[0]); if (u === '/') u = '/index.html'; fs.readFile(path.join(root, u), (e, b) => { if (e) { r.writeHead(404); r.end(); return } r.writeHead(200, { 'content-type': types[path.extname(u).slice(1)] || 'application/octet-stream' }); r.end(b) }) }).listen(0);
const fail = [], ck = (n, c) => { console.log(c ? 'ok  ' : 'FAIL', n); if (!c) fail.push(n) };
(async () => {
  const br = await chromium.launch(), pg = await br.newPage({ viewport: { width: 420, height: 900 } }), errs = [];
  pg.on('pageerror', e => errs.push(String(e))); pg.on('dialog', d => { global.__dlg = d.message(); d.dismiss() });
  await pg.addInitScript(() => { window.__calls = []; window.LiNative = { speakBatch() {}, ttsCmd() {}, translate() {}, keepAlive() {}, audioSession(t, p, a, b) { window.__calls.push('aus:' + p) }, online() { return false }, setOnline() { window.__calls.push('setOnline') },
    packs() { window.__calls.push('packs'); setTimeout(() => window.__liPacks(['ar', 'en']), 30) }, packGet(l) { window.__calls.push('get:' + l); setTimeout(() => window.__liPackEv(l, 'ok', ''), 30) }, packDel(l) { window.__calls.push('del:' + l); setTimeout(() => window.__liPackEv(l, 'del', ''), 30) },
    sleepTimer(m) { window.__calls.push('sleep:' + m); window.__sl = m ? Date.now() + m * 60000 : 0 }, sleepLeft() { return window.__sl ? Math.round((window.__sl - Date.now()) / 1000) : 0 } } });
  await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`); await pg.waitForTimeout(2500);
  // record some reading + listening, then open statistics
  const st = await pg.evaluate(async () => { await window.api.tick(60, 'nobook', 'read'); await window.api.tick(90, 'nobook', 'listen'); const s = await window.api.tick(30, 'nobook', 'listen'); return { r: s.goals.days[Object.keys(s.goals.days)[0]], l: Object.values(s.listenDays)[0], sess: s.sessions.length, last: s.sessions[s.sessions.length - 1] } });
  ck('reading and listening are separate', st.r >= 60 && st.l === 120 && st.sess === 2 && st.last.k === 'listen' && st.last.s === 120);
  await pg.evaluate(() => liStatsDlg()); await pg.waitForTimeout(300); const t1 = await pg.evaluate(() => document.getElementById('box').innerText); ck('statistics dialog shows today and sessions', /Reading statistics|إحصائيات/.test(t1) && /Reading|قراءة/.test(t1) && /Listening|استماع/.test(t1) && /Total|الإجمالي/.test(t1));
  await pg.screenshot({ path: '/tmp/lt/stats.png' }); await pg.click('#no');
  // timers
  await pg.evaluate(() => liTimersDlg()); await pg.click('#slc [data-m="15"]'); await pg.waitForTimeout(1300);
  const t2 = await pg.evaluate(() => ({ txt: document.getElementById('sll').innerText, calls: window.__calls.slice() })); ck('sleep timer set natively and countdown shown', t2.calls.includes('sleep:15') && /1[45]:\d\d/.test(t2.txt));
  await pg.click('#slx'); await pg.waitForTimeout(200); ck('sleep timer can be cancelled', (await pg.evaluate(() => window.__calls)).includes('sleep:0'));
  await pg.click('#rtc [data-m="15"]'); await pg.waitForTimeout(1300); const rl = await pg.evaluate(() => document.getElementById('rtl').innerText); ck('reading timer counts down', /1[45]:\d\d/.test(rl));
  await pg.screenshot({ path: '/tmp/lt/timers.png' }); await pg.click('#rtx'); await pg.waitForTimeout(200); ck('reading timer cancel', (await pg.evaluate(() => liTimers.readEnd())) === 0); await pg.click('#no');
  // packs
  await pg.evaluate(() => liPacksDlg()); await pg.waitForTimeout(300); let t3 = await pg.evaluate(() => document.getElementById('box').innerText); ck('packs listed with state', /العربية/.test(t3) && /Downloaded|محمّلة/.test(t3) && /Not downloaded|غير محمّلة/.test(t3));
  await pg.click('[data-pg="id"]'); await pg.waitForTimeout(400); const t4 = await pg.evaluate(() => ({ calls: window.__calls, has: !!document.querySelector('[data-pd="id"]') })); ck('pack download then delete button', t4.calls.includes('get:id') && t4.has);
  await pg.click('[data-pd="id"]'); await pg.waitForTimeout(400); ck('pack delete', (await pg.evaluate(() => window.__calls)).includes('del:id') && !!(await pg.$('[data-pg="id"]'))); ck('English pack cannot be deleted', !(await pg.$('[data-pd="en"]')));
  await pg.screenshot({ path: '/tmp/lt/packs.png' });
  // audiobook player: queue management
  await pg.evaluate(async () => { const l = await window.api.state(); ['a1', 'a2', 'a3'].forEach((id, i) => l.books.push({ id, format: 'audio', title: 'Audio ' + (i + 1), audio: { pos: 60, dur: 3600 }, added: Date.now() })); });
  await pg.evaluate(() => liAudioDlg()); await pg.waitForTimeout(200);
  await pg.click('[data-qa="a1"]'); await pg.click('[data-qa="a2"]'); await pg.click('[data-qa="a3"]');
  let q = await pg.evaluate(() => JSON.parse(localStorage.getItem('li-aq'))); ck('queue holds three audiobooks in order', q.join() === 'a1,a2,a3');
  await pg.click('[data-qu="2"]'); q = await pg.evaluate(() => JSON.parse(localStorage.getItem('li-aq'))); ck('queue reorder up', q.join() === 'a1,a3,a2');
  await pg.click('[data-qr="0"]'); q = await pg.evaluate(() => JSON.parse(localStorage.getItem('li-aq'))); ck('queue remove', q.join() === 'a3,a2');
  ck('play-queue button present', !!(await pg.$('#aqGo'))); ck('sidebar audiobook player entry', !!(await pg.$('#aqBtn')));
  await pg.screenshot({ path: '/tmp/lt/audio.png' }); await pg.click('#no');
  // audiobook session bridge exists and a remote command reaches without throwing (no frame open -> ignored)
  ck('audiobook remote-command hook defined', await pg.evaluate(() => { try { window.__liAudioCmd('toggle', 0); return typeof window.__liAudioCmd === 'function' } catch (e) { return false } }));
  ck('pdf-to-html listener accepts frame or pframe', (await require('fs').promises.readFile(__dirname + '/../web-src/library.html', 'utf8')).includes("['frame','pframe']"));
  ck('no page errors', errs.length === 0); if (errs.length) console.log(errs.join('\n'));
  await br.close(); srv.close(); if (fail.length) { console.log('FAILED:', fail.join(' | ')); process.exit(1) } console.log('all library checks passed');
})();
