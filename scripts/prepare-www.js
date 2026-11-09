// Builds ./www (the folder Capacitor packages into the APK) from ./web-src + ./platform.
// Run:  npm run prepare:www
const fs = require('fs'), path = require('path');
const desktop = process.argv.includes('--desktop');
const root = path.join(__dirname, '..'), src = path.join(root, 'web-src'), out = desktop ? path.join(root, 'windows', 'app') : path.join(root, 'www');
const cp = (a, b) => fs.cpSync(a, b, { recursive: true });
fs.rmSync(out, { recursive: true, force: true });
cp(src, out);
fs.mkdirSync(path.join(out, 'lib'), { recursive: true });
const jz = path.join(root, 'node_modules', 'jszip', 'dist', 'jszip.min.js');
if (!fs.existsSync(jz)) { console.error('jszip not found — run "npm install" first.'); process.exit(1); }
fs.copyFileSync(jz, path.join(out, 'lib', 'jszip.min.js'));
// OCR (reads scanned PDFs and photos on the device, no internet): tesseract + Arabic and English data
try {
  const nm = path.join(root, 'node_modules'), od = path.join(out, 'ocr'); fs.mkdirSync(path.join(od, 'lang'), { recursive: true });
  const first = (...c) => c.find(f => fs.existsSync(f));
  const tj = first(path.join(nm, 'tesseract.js', 'dist', 'tesseract.min.js')), wj = first(path.join(nm, 'tesseract.js', 'dist', 'worker.min.js'));
  if (!tj || !wj) throw new Error('tesseract.js not installed');
  fs.copyFileSync(tj, path.join(od, 'tesseract.min.js')); fs.copyFileSync(wj, path.join(od, 'worker.min.js'));
  const cd = path.join(nm, 'tesseract.js-core'); fs.readdirSync(cd).filter(f => /^tesseract-core.*\.(js|wasm)$/.test(f)).forEach(f => fs.copyFileSync(path.join(cd, f), path.join(od, f)));
  for (const l of ['ara', 'eng']) {
    const base = path.join(nm, '@tesseract.js-data', l), dirs = ['4.0.0_best_int', '4.0.0_fast', '4.0.0'].map(d => path.join(base, d, l + '.traineddata.gz'));
    const f = first(...dirs); if (!f) throw new Error('language data missing: ' + l); fs.copyFileSync(f, path.join(od, 'lang', l + '.traineddata.gz'));
  }
  console.log('ocr ready:', fs.readdirSync(od).join(', '));
} catch (e) { console.warn('OCR files not added:', e.message); }
fs.copyFileSync(path.join(root, 'platform', 'platform-android.js'), path.join(out, 'platform-android.js'));
let html = fs.readFileSync(path.join(src, 'library.html'), 'utf8');
if (desktop) ['platform-desktop.js', 'platform-desktop-pre.js'].forEach(f => fs.copyFileSync(path.join(root, 'platform', f), path.join(out, f)));
const tag = '<script src="lib/jszip.min.js"></script>\n<script src="formats.js"></script>\n<script src="pdfgeo.js"></script>\n<script src="convert.js"></script>\n' + (desktop ? '<script src="platform-desktop-pre.js"></script>\n' : '') + '<script src="platform-android.js"></script>\n' + (desktop ? '<script src="platform-desktop.js"></script>\n' : '');
if (!html.includes('<script src="i18n.js"></script>')) { console.error('library.html layout changed: cannot inject platform scripts'); process.exit(1); }
html = html.replace('<script src="i18n.js"></script>', tag + '<script src="i18n.js"></script>');
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.rmSync(path.join(out, 'library.html'));
console.log('www ready:', fs.readdirSync(out).join(', '));
