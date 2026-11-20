// Page reader with the PaddleOCR models (PP-OCRv6 small for Latin languages, PP-OCRv5 mobile for Arabic).
// Runs as its own small process (started by the app under the CPU limit) and answers on localhost:
//   GET /health      POST /ocr?lang=auto|ar|latin   (body: PNG image)   ->  { md, lines, script, ms }
// Start:  <node> pp-ocr-server.mjs --port N --spec spec.json
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as C from './pp-core.mjs';
const require = createRequire(import.meta.url);

const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : ''; };
const spec = JSON.parse(fs.readFileSync(arg('spec'), 'utf8'));
let ort = null; const getOrt = () => ort || (ort = require('onnxruntime-node'));
const { PNG } = require('pngjs'), YAML = require('yaml');

const sess = new Map();
async function session(file) {
  if (!sess.has(file)) sess.set(file, getOrt().InferenceSession.create(file, { executionProviders: ['cpu'], intraOpNumThreads: spec.threads || 2, interOpNumThreads: 1, graphOptimizationLevel: 'all', logSeverityLevel: 3 }));
  return sess.get(file);
}
const ymls = new Map();
function conf(file) { if (!ymls.has(file)) ymls.set(file, YAML.parse(fs.readFileSync(file, 'utf8'))); return ymls.get(file); }
function chars(file) { const k = 'c:' + file; if (!ymls.has(k)) { const d = (conf(file).PostProcess || {}).character_dict || []; ymls.set(k, [''].concat(d.map(String), [' '])); } return ymls.get(k); }

function decodePng(buf) {
  const p = PNG.sync.read(buf), d = p.data; // flatten transparency onto white
  for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; if (a < 255) { const k = a / 255; d[i] = d[i] * k + 255 * (1 - k); d[i + 1] = d[i + 1] * k + 255 * (1 - k); d[i + 2] = d[i + 2] * k + 255 * (1 - k); d[i + 3] = 255; } }
  return { w: p.width, h: p.height, data: d };
}

async function detect(img, P) {
  const post = conf(P.detYml).PostProcess || {}, { dw, dh } = C.detSize(img.w, img.h), s = await session(P.det);
  const x = new (getOrt().Tensor)('float32', C.toTensor(img, null, dw, dh, 'det'), [1, 3, dh, dw]);
  const out = await s.run({ [s.inputNames[0]]: x }), prob = out[s.outputNames[0]].data;
  const bx = C.dbBoxes(prob, dw, dh, { thresh: post.thresh, boxThresh: post.box_thresh, unclip: post.unclip_ratio, max: post.max_candidates });
  const fx = img.w / dw, fy = img.h / dh;
  return bx.map((b) => [Math.max(0, Math.floor(b[0] * fx)), Math.max(0, Math.floor(b[1] * fy)), Math.min(img.w, Math.ceil(b[2] * fx)), Math.min(img.h, Math.ceil(b[3] * fy))]).filter((b) => b[2] - b[0] > 4 && b[3] - b[1] > 4);
}

// Recognizes every box with one recognizer (batches of similar width). Returns [{text, conf}] in box order.
async function recognize(img, boxes, recFile, ymlFile, reverse) {
  const s = await session(recFile), ch = chars(ymlFile), H = 48, res = new Array(boxes.length);
  const order = boxes.map((b, i) => i).sort((a, b) => (boxes[a][2] - boxes[a][0]) / (boxes[a][3] - boxes[a][1]) - (boxes[b][2] - boxes[b][0]) / (boxes[b][3] - boxes[b][1]));
  for (let i = 0; i < order.length; i += 6) {
    const grp = order.slice(i, i + 6), ratios = grp.map((k) => (boxes[k][2] - boxes[k][0]) / (boxes[k][3] - boxes[k][1]));
    const W = Math.min(3200, Math.max(320, Math.ceil(H * Math.max(...ratios)))), data = new Float32Array(grp.length * 3 * H * W);
    grp.forEach((k, j) => { const w = Math.min(W, Math.max(8, Math.ceil(H * ratios[j]))); C.toTensor(img, boxes[k], w, H, 'rec', data, j * 3 * H * W, W); });
    const out = await s.run({ [s.inputNames[0]]: new (getOrt().Tensor)('float32', data, [grp.length, 3, H, W]) }), o = out[s.outputNames[0]], [B, T, Cn] = o.dims;
    grp.forEach((k, j) => { const r = C.ctcDecode(o.data, j * T * Cn, T, Cn, ch); res[k] = { text: reverse ? C.reverseVisual(r.text) : r.text, conf: r.conf }; });
  }
  return res;
}

async function readPage(png, lang) {
  const t0 = Date.now(), img = decodePng(png), A = spec.pipelines.arabic, L = spec.pipelines.latin;
  let script = lang === 'ar' ? 'arabic' : (lang === 'latin' ? 'latin' : 'auto'), items = [];
  const runArabic = async () => {
    const boxes = await detect(img, A), rs = await recognize(img, boxes, A.rec, A.recYml, A.reverse !== false);
    return boxes.map((b, i) => ({ box: b, text: rs[i].text, conf: rs[i].conf }));
  };
  const runLatin = async () => {
    const boxes = await detect(img, L), rs = await recognize(img, boxes, L.rec, L.recYml, false);
    return boxes.map((b, i) => ({ box: b, text: rs[i].text, conf: rs[i].conf }));
  };
  if (script === 'latin') items = await runLatin();
  else {
    items = await runArabic();
    const all = items.map((x) => x.text).join(' '), share = C.arabicShare(all);
    if (script === 'auto') {
      if (C.letters(all) >= 8 && share < 0.1) { items = await runLatin(); script = 'latin'; } // a Latin-script page: the Latin reader is the better one
      else {
        script = 'arabic';
        // mixed pages: lines that are clearly Latin go to the Latin reader, the better answer wins
        const idx = items.map((x, i) => i).filter((i) => C.letters(items[i].text) >= 3 && C.arabicShare(items[i].text) < 0.3);
        if (idx.length) { const rs = await recognize(img, idx.map((i) => items[i].box), L.rec, L.recYml, false); idx.forEach((i, j) => { if (rs[j].conf >= items[i].conf - 0.02) items[i] = Object.assign(items[i], rs[j]); }); }
      }
    } else script = 'arabic';
  }
  items = items.filter((x) => x.conf >= 0.3 && x.text.trim());
  const md = C.toMarkdown(items, script === 'arabic');
  return { md, lines: items.length, script, ms: Date.now() - t0 };
}

let chain = Promise.resolve(), loaded = false;
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/health')) { res.writeHead(loaded ? 200 : 503); return res.end(loaded ? 'ok' : 'loading'); }
  if (req.method === 'POST' && req.url.startsWith('/ocr')) {
    const u = new URL(req.url, 'http://x'), lang = u.searchParams.get('lang') || 'auto', parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      chain = chain.then(() => readPage(Buffer.concat(parts), lang)).then((r) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); }, (e) => { res.writeHead(500); res.end(String((e && e.message) || e)); });
    });
    return;
  }
  res.writeHead(404); res.end();
});
srv.listen(Number(arg('port')) || 0, '127.0.0.1');
// load the models now so that the first page is not slow, and so that "ready" means ready
(async () => { const P = [spec.pipelines.arabic, spec.pipelines.latin]; for (const p of P) { await session(p.det); await session(p.rec); conf(p.detYml); chars(p.recYml); } loaded = true; })().catch((e) => { console.error('load failed', e); process.exit(3); });
