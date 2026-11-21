// Reads drawn test pages with the in-page PaddleOCR reader (the Android code path) in Chromium, and checks accuracy.
// Run after "npm install" and "node scripts/prepare-www.js"; needs internet (models come from Hugging Face).
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const T = require('../windows/pp-testdata.js'), YAML = require('yaml');
const root = path.join(__dirname, '..', 'www');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const srv = http.createServer((q, r) => { let f = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith(path.sep) || !fs.existsSync(f)) f = path.join(root, 'index.html'); r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }).listen(0);
(async () => {
  const out = { pages: {}, yml: {} }, port = srv.address().port;
  const b = await chromium.launch(), pg = await b.newPage();
  pg.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)));
  await pg.goto('http://127.0.0.1:' + port + '/pp-test.html');
  await pg.evaluate(T.DRAW);
  // 1. the small yml reader gives the same answer as the real YAML parser
  for (const k of ['det6', 'rec6', 'det5', 'recar']) {
    const repo = await pg.evaluate((k) => window.liPP._Y[k], k);
    const txt = await (await fetch('https://huggingface.co/PaddlePaddle/' + repo + '/resolve/main/inference.yml')).text();
    const mine = await pg.evaluate((t) => window.liPP.parseYml(t), txt), real = (YAML.parse(txt).PostProcess) || {};
    const a = JSON.stringify((mine.PostProcess.character_dict || []).map(String)), c = JSON.stringify((real.character_dict || []).map(String));
    const ma = (mine.PostProcess.character_dict || []).map(String), re = (real.character_dict || []).map(String), diffs = []; for (let i = 0; i < Math.max(ma.length, re.length) && diffs.length < 8; i++) if (ma[i] !== re[i]) diffs.push([i, ma[i], re[i]]);
    out.yml[k] = { diffs, lens: [ma.length, re.length], dictSame: a === c, n: (real.character_dict || []).length, thresh: [mine.PostProcess.thresh, real.thresh], unclip: [mine.PostProcess.unclip_ratio, real.unclip_ratio] };
  }
  // 2. download (one time) and read the pages
  const t0 = Date.now(); out.prepSec = await pg.evaluate(async () => { const t = Date.now(); await window.liPP.prep(); return Math.round((Date.now() - t) / 1000); });
  out.haveAfter = await pg.evaluate(() => window.liPP.have());
  let sum = 0, n = 0;
  for (const [k, v] of T.JOBS) {
    const key = k + '_' + v, r = await pg.evaluate(async ([lines, deg]) => { const url = window.__mkPage(lines, false, deg), img = new Image(); await new Promise((ok) => { img.onload = ok; img.src = url; }); const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; cv.getContext('2d').drawImage(img, 0, 0); const t = Date.now(); const md = await window.liPP.page(cv, 'auto'); return { md, ms: Date.now() - t }; }, [T.PAGES[k], v === 'deg']);
    const e = T.cer(T.PAGES[k].join(' '), r.md); out.pages[key] = { cer: e, sec: Math.round(r.ms / 100) / 10, text: r.md.slice(0, 200) }; sum += e; n++;
  }
  out.meanCER = Math.round(sum / n * 10) / 10;
  console.log(JSON.stringify(out, null, 1));
  fs.writeFileSync('pp-web-report.json', JSON.stringify(out, null, 1));
  const ok = out.haveAfter && Object.values(out.yml).every((y) => y.dictSame) && out.meanCER < 8;
  await b.close(); srv.close(); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
