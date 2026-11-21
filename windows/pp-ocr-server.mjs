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

const reader = C.makeReader({
  get Tensor() { return getOrt().Tensor; },
  session: (f) => session(f),
  chars: (f) => chars(f),
  conf: (f) => conf(f).PostProcess || {}
});
const readPage = (png, lang) => reader(decodePng(png), lang, spec);

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
