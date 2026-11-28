// Regression tests for the Android repair release (run in Chromium; the phone itself is NOT involved).
//   REPO=<path>  runs the same tests against another checkout (used to show before / after).
const { chromium } = require('playwright'); const fs = require('fs'), http = require('http'), path = require('path'), os = require('os');
const REPO = process.env.REPO ? path.resolve(process.env.REPO) : path.join(__dirname, '..');
const root = os.tmpdir() + '/adfix-' + process.pid; fs.mkdirSync(root, { recursive: true });
fs.cpSync(REPO + '/web-src/pdfjs', root + '/pdfjs', { recursive: true });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.pdf': 'application/pdf' };
const srv = http.createServer((q, r) => { const f = path.join(root, decodeURIComponent(q.url.split('?')[0])); fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); r.end(); return } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b) }) }).listen(0);
const port = srv.address().port;
const pa = fs.readFileSync(REPO + '/platform/platform-android.js', 'utf8');
const fnOf = (n) => { const a = pa.indexOf('function ' + n + '()'); let d = 0, i = pa.indexOf('{', a); for (let j = i; j < pa.length; j++) { if (pa[j] == '{') d++; else if (pa[j] == '}') { d--; if (d == 0) return pa.slice(a, j + 1) } } };

// ---- a PDF writer without dependencies: pages = [{w,h,text,ink}]
function makePdf(pages) {
  const objs = []; const add = (s) => { objs.push(s); return objs.length };
  add('<< /Type /Catalog /Pages 2 0 R >>'); add(''); // 2 = pages, filled below
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); const kids = [];
  pages.forEach((p, i) => {
    let c = ''; if (p.text) c += `BT /F1 22 Tf 50 ${p.h - 70} Td (${p.text}) Tj ET\n`; if (p.ink) c += '0 g 80 120 260 14 re f\n';
    const cs = add(`<< /Length ${c.length} >>\nstream\n${c}endstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${cs} 0 R >>`));
  });
  objs[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.map(k => k + ' 0 R').join(' ')}] >>`;
  let out = '%PDF-1.4\n', off = [0]; objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` });
  const xr = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF`; return Buffer.from(out, 'latin1');
}
const sizeOf = (i) => (i % 7 === 0 ? { w: 500, h: 700 } : i % 11 === 0 ? { w: 700, h: 500 } : { w: 600, h: 800 });
const big = []; for (let i = 1; i <= 400; i++) big.push({ ...sizeOf(i), text: 'Page ' + i });
fs.writeFileSync(root + '/big.pdf', makePdf(big));
const scan = []; for (let i = 1; i <= 60; i++) scan.push({ w: 600, h: 800, ink: true });   // no text layer: every page needs OCR
fs.writeFileSync(root + '/scan.pdf', makePdf(scan));

const viewer = (file, pre) => {
  let h = fs.readFileSync(REPO + '/web-src/pdfviewer.html', 'utf8').replace(/book:\/\/__ID__\/__pdfjs\//g, '/pdfjs/').replace(/book:\/\/__ID__\/__file/g, '/' + file).replace(/__ID__/g, 'x').replace(/__TITLE__/g, 't').replace(/__LANG__/g, 'en');
  const p = `<script>window.__LI=${JSON.stringify({ ui: 'en', id: 'x' + file, url: '/' + file, base: '/pdfjs/' })};window.__gp=[];window.__msgs=[];addEventListener('message',e=>{if(e.data&&e.data.liBook)__msgs.push(e.data)});
(function(){var v;Object.defineProperty(window,'__pdoc',{configurable:true,get(){return v},set(d){var o=d.getPage.bind(d);d.getPage=function(n){window.__gp.push(n);return o(n)};v=d}})})();${pre || ''}<\/script>`;
  return h.replace(/(<script src="[^"]*pdf\.min\.js"><\/script>)/, m => p + m + `<script>(${fnOf('PDFN')})();<\/script>`);
};
const fail = [], ck = (n, c, extra) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); if (!c) fail.push(n) };

(async () => {
  const br = await chromium.launch();
  // ===== 1. large PDF: opens without waiting for every page, immediate jump to page 12 stays put while sizes load
  fs.writeFileSync(root + '/a.html', viewer('big.pdf'));
  let pg = await br.newPage({ viewport: { width: 700, height: 900 } }); const errs = []; pg.on('pageerror', e => errs.push(String(e)));
  const t0 = Date.now(); await pg.goto(`http://127.0.0.1:${port}/a.html`);
  await pg.waitForFunction(() => document.querySelectorAll('.pg canvas').length >= 1, null, { timeout: 20000 }); const tFirst = Date.now() - t0;
  const early = await pg.evaluate(() => ({ pages: document.querySelectorAll('.pg').length, fetched: new Set(window.__gp).size }));
  ck('400 page boxes exist at once', early.pages === 400, 'pages=' + early.pages);
  ck('first page drawn before all pages were fetched', early.fetched < 60, 'getPage distinct at first draw=' + early.fetched + ' first draw ' + tFirst + ' ms');
  await pg.evaluate(() => window.__pgo(12)); await pg.waitForTimeout(700);
  const at12 = async () => pg.evaluate(() => { const sc = document.getElementById('sc'), el = document.querySelectorAll('.pg')[11], r = el.getBoundingClientRect(), s = sc.getBoundingClientRect(); return { cur: window.__pcur(), top: Math.round(r.top - s.top), h: Math.round(r.height), vis: r.bottom > s.top && r.top < s.bottom } });
  let a = await at12(); ck('jump 1 -> 12 lands on page 12', a.cur === 12 && a.vis, JSON.stringify(a));
  await pg.waitForTimeout(6000);   // background sizes arrive
  a = await at12(); ck('page 12 stays in place while the other sizes load', a.cur === 12 && a.vis && a.top > -40 && a.top < 400, JSON.stringify(a));
  const sized = await pg.evaluate(() => [...document.querySelectorAll('.pg')].filter(e => e.style.height).length); ck('every page box has a size', sized === 400);
  const bg = await pg.evaluate(() => new Set(window.__gp).size); ck('page sizes continue loading in the background', bg > early.fetched, 'distinct getPage ' + bg);
  // different page sizes are honoured in the end (page 7 is 500x700, i.e. a different ratio)
  const ratio = await pg.evaluate(() => { const e = document.querySelectorAll('.pg')[6]; return +(e.offsetHeight / e.offsetWidth).toFixed(3) });
  await pg.waitForTimeout(4000); const ratio2 = await pg.evaluate(() => { const e = document.querySelectorAll('.pg')[6]; return +(e.offsetHeight / e.offsetWidth).toFixed(3) });
  ck('real page ratio (page 7) applied', Math.abs(ratio2 - 1.4) < 0.02, 'ratio ' + ratio + ' -> ' + ratio2);
  ck('direct jump forward and back', await pg.evaluate(async () => { window.__pgo(300); await new Promise(r => setTimeout(r, 500)); const a = window.__pcur(); window.__pgo(2); await new Promise(r => setTimeout(r, 500)); return a === 300 && window.__pcur() === 2 }));
  ck('no page errors (viewer)', errs.length === 0, errs.join(' | '));
  await pg.close();

  // ===== 2. OCR queue: quick navigation must not leave stale pages in the queue
  fs.writeFileSync(root + '/b.html', viewer('scan.pdf', 'window.__ocr=0;window.liBlank=function(){return Promise.resolve(false)};window.liOcrLines=function(cv){window.__ocr++;return new Promise(function(r){setTimeout(function(){r({script:"latin",rows:[{t:"hello",x:.1,y:.1,w:.3,h:.03}]})},350)})};'));
  pg = await br.newPage({ viewport: { width: 700, height: 900 } }); const errs2 = []; pg.on('pageerror', e => errs2.push(String(e)));
  await pg.goto(`http://127.0.0.1:${port}/b.html`); await pg.waitForFunction(() => document.querySelectorAll('.pg canvas').length >= 1, null, { timeout: 20000 });
  await pg.evaluate(() => postMessage({ liCmd: 'init', annots: [] }, '*'));
  for (const n of [8, 16, 24, 32, 40, 48]) { await pg.evaluate(n => window.__pgo(n), n); await pg.waitForTimeout(160); }
  await pg.waitForTimeout(7000);
  const o = await pg.evaluate(() => ({ calls: window.__ocr, cur: window.__pcur(), spans: document.querySelectorAll('.pg .tl span').length, near: [...document.querySelectorAll('.pg')].map((e, i) => e.querySelector('.tl span') ? i + 1 : 0).filter(Boolean) }));
  ck('sweeping 6 distant pages does not read them all', o.calls <= 12, 'OCR calls=' + o.calls + ' pages with text: ' + o.near.join(','));
  ck('the page finally shown gets its text', o.near.some(n => Math.abs(n - o.cur) <= 1), 'cur=' + o.cur);
  ck('no page errors (queue)', errs2.length === 0, errs2.join(' | '));
  // empty results are cached: a page that returned no lines is not read again
  await pg.evaluate(() => { window.liOcrLines = function () { window.__ocr++; return Promise.resolve({ script: 'latin', rows: [] }) } });
  const before = await pg.evaluate(() => window.__ocr); await pg.evaluate(() => window.__pgo(50)); await pg.waitForTimeout(2500);
  const mid = await pg.evaluate(() => window.__ocr); await pg.evaluate(() => { window.__pgo(1); }); await pg.waitForTimeout(1200); await pg.evaluate(() => window.__pgo(50)); await pg.waitForTimeout(2000);
  const after = await pg.evaluate(() => window.__ocr);
  ck('empty OCR result is cached (page 50 read once)', mid > before && after - mid <= 3, `before ${before} mid ${mid} after ${after}`);
  await pg.close();

  // ===== 3. convert.js pieces: blank detection, ETA, dialog labels (code extracted from the real file)
  const cs = fs.readFileSync(REPO + '/web-src/convert.js', 'utf8');
  const cut = (a, b) => { const i = cs.indexOf(a), j = cs.indexOf(b, i); return i >= 0 && j > i ? cs.slice(i, j) : '' };
  const blankSrc = cut('  function nextTick()', 'window.liBlank = isBlankCanvas;') || cut('  function isBlankCanvas', 'window.liBlank = isBlankCanvas;');
  pg = await br.newPage(); await pg.setContent('<body></body>');
  if (blankSrc) {
    await pg.addScriptTag({ content: '(function(){' + blankSrc + ';window.__isBlank=isBlankCanvas;})();' });
    const res = await pg.evaluate(async () => {
      const mk = (draw) => { const c = document.createElement('canvas'); c.width = 1400; c.height = 2000; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1400, 2000); draw && draw(g, c); return c };
      const noise = (g, amp) => { const im = g.getImageData(0, 0, 1400, 2000), d = im.data; let s = 12345; for (let i = 0; i < d.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; const v = ((s >> 8) % (2 * amp + 1)) - amp; d[i] += v; d[i + 1] += v; d[i + 2] += v } g.putImageData(im, 0, 0) };
      const out = {};
      out.white = await window.__isBlank(mk());
      out.whiteNoise2 = await window.__isBlank(mk((g) => noise(g, 2)));
      out.creamPaper = await window.__isBlank(mk((g) => { g.fillStyle = '#f3ecd8'; g.fillRect(0, 0, 1400, 2000); noise(g, 2) }));
      out.faintText = await window.__isBlank(mk((g) => { g.fillStyle = 'rgb(236,236,236)'; g.font = '30px sans-serif'; for (let i = 0; i < 12; i++) g.fillText('faint scanned line of text number ' + i, 120, 300 + i * 60) }));
      out.lowContrast = await window.__isBlank(mk((g) => { g.fillStyle = 'rgb(226,226,226)'; g.font = '28px sans-serif'; g.fillText('Low contrast scan, one single line', 200, 900) }));
      out.smallText = await window.__isBlank(mk((g) => { g.fillStyle = '#333'; g.font = '13px sans-serif'; g.fillText('small text only', 300, 1000) }));
      out.pageNumberOnly = await window.__isBlank(mk((g) => { g.fillStyle = '#222'; g.font = '26px serif'; g.fillText('17', 690, 1900) }));
      out.sparseWords = await window.__isBlank(mk((g) => { g.fillStyle = '#444'; g.font = '40px serif'; g.fillText('The end', 600, 700) }));
      out.arabicFaint = await window.__isBlank(mk((g) => { g.fillStyle = 'rgb(230,230,230)'; g.font = '34px sans-serif'; g.direction = 'rtl'; g.fillText('نص عربي باهت في صفحة ممسوحة', 1100, 800) }));
      out.noiseOnlyHeavy = await window.__isBlank(mk((g) => noise(g, 10)));
      return out;
    });
    console.log('BLANK', JSON.stringify(res));
    ck('blank: plain white page', res.white === true); ck('blank: white with scanner noise', res.whiteNoise2 === true); ck('blank: cream paper with noise', res.creamPaper === true);
    ck('NOT blank: faint text', res.faintText === false); ck('NOT blank: low-contrast single line', res.lowContrast === false); ck('NOT blank: small text', res.smallText === false);
    ck('NOT blank: page number only', res.pageNumberOnly === false); ck('NOT blank: sparse words', res.sparseWords === false); ck('NOT blank: faint Arabic', res.arabicFaint === false);
    console.log('INFO heavy noise (amp 10) classified blank =', res.noiseOnlyHeavy, '(false = OCR runs and finds nothing: safe)');
  } else ck('blank detector present', false, 'isBlankCanvas not found in convert.js');
  const etaSrc = cut('  function etaText(', '  function ocrRun(');
  if (etaSrc) {
    const e = await pg.evaluate((src) => { window.TT = (a, b) => b; eval(src + ';window.__eta=etaText;'); return { cold: window.__eta([90000, 3000, 3100], 100), few: window.__eta([90000, 3000, 3100, 2900], 100), warm: window.__eta([90000, 3000, 3100, 2900, 3000, 3050], 100), slowFirst: window.__eta([600000, 3000, 3000, 3000, 3000, 3000, 3000], 100) } }, etaSrc.replace(/^[\s\S]*?function etaText/, 'function etaText'));
    console.log('ETA', JSON.stringify(e));
    ck('ETA: nothing before 4 warmed-up pages', e.cold === '' && e.few === '');
    ck('ETA: about 5 min for 100 pages at 3 s (not hours)', /~5 min/.test(e.warm), e.warm);
    ck('ETA: a slow cold first page does not inflate it', /~5 min/.test(e.slowFirst), e.slowFirst);
  } else ck('etaText present', false);
  await pg.close();

  // ===== 4. dialog labels: webGate / askFallback pass explicit Yes / No labels; __liAsk has defaults
  pg = await br.newPage(); await pg.setContent('<body></body>'); await pg.addScriptTag({ content: 'window.__FMT=new Proxy({esc:function(s){return s},isArabic:function(){return false},shell:function(){return ""}},{get:function(t,k){return k in t?t[k]:function(){return 0}}});window.__PDFGEO={median:function(){},pageLines:function(){},readingOrder:function(){}};window.__asks=[];window.WebAssembly=window.WebAssembly||{};window.liPP={have:function(){return Promise.resolve(false)},prep:function(){return Promise.resolve()},stop:function(){}};window.__liAsk=function(t,b,y,n){window.__asks.push([t,b,y,n]);return Promise.resolve(false)};window.T=function(a,e){return e};' });
  await pg.addScriptTag({ content: cs });
  const asks = await pg.evaluate(async () => { try { await window.__FMT.imagesToHtml([new Blob(['x'], { type: 'image/png' })], 'n', function () { }, {}); } catch (e) { } return window.__asks });
  ck('both OCR dialogs were shown with explicit labels', asks.length >= 2 && asks.every(a => a[2] && a[3]), JSON.stringify(asks.map(a => [a[2], a[3]])));
  const lib = fs.readFileSync(REPO + '/web-src/library.html', 'utf8');
  ck('__liAsk has safe default labels', /window\.__liAsk=function\(title,body,yes,no\)\{yes=yes\|\|/.test(lib));
  ck('#mini uses an existing theme variable', !/#mini[^}]*var\(--ink\)/.test(lib) && /#mini button\{[^}]*var\(--text\)/.test(lib));
  await pg.close();

  // ===== 5. dock icons are not moved by the converted-book SVG rule
  const dockJs = fs.readFileSync(REPO + '/web-src/dock.js', 'utf8');
  pg = await br.newPage({ viewport: { width: 420, height: 800 } });
  await pg.setContent('<!doctype html><html><head><style>img,svg,video{max-width:100%;height:auto;display:block;margin:1.2em auto;border-radius:4px}</style></head><body><p>one paragraph of text for the dock</p><p>two paragraphs of text for the dock</p><p>three paragraphs of text for the dock</p><p>four paragraphs</p></body></html>');
  await pg.addScriptTag({ content: 'window.__LI={ui:"en",id:"d"};' }); await pg.addScriptTag({ content: dockJs }); await pg.waitForTimeout(800);
  const ic = await pg.evaluate(() => [...document.querySelectorAll('.li-dock>button')].map(b => { const s = b.querySelector('svg'), r = b.getBoundingClientRect(), q = s && s.getBoundingClientRect(); return s ? { w: Math.round(q.width), h: Math.round(q.height), dx: Math.round((q.left + q.width / 2) - (r.left + r.width / 2)), dy: Math.round((q.top + q.height / 2) - (r.top + r.height / 2)) } : null }));
  console.log('DOCK', JSON.stringify(ic));
  ck('dock has buttons with icons', ic.length >= 3 && ic.every(Boolean));
  ck('dock icons are 21x21 and centred', ic.every(x => x && x.w === 21 && x.h === 21 && Math.abs(x.dx) <= 1 && Math.abs(x.dy) <= 1));
  await pg.close();
  await br.close(); srv.close();
  if (fail.length) { console.log('FAILED: ' + fail.join(' | ')); process.exit(1) } console.log('all android fix checks passed');
})();
