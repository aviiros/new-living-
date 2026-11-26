// Runs the shipped PaddleOCR reader (pp-core.mjs, same code as the app) over a manifest of images.
import fs from 'node:fs'; import { createRequire } from 'node:module';
import * as C from './pp-core.mjs';
const require = createRequire(import.meta.url), ort = require('onnxruntime-node'), { PNG } = require('pngjs'), YAML = require('yaml');
const [,, mani, outf, mdir, lang, vlist] = process.argv, M = JSON.parse(fs.readFileSync(mani, 'utf8')), threads = +(process.env.THREADS || 2);
const sess = new Map(), ym = new Map();
const session = (f) => { if (!sess.has(f)) sess.set(f, ort.InferenceSession.create(f, { executionProviders: ['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', logSeverityLevel: 3 })); return sess.get(f); };
const conf = (f) => { if (!ym.has(f)) ym.set(f, YAML.parse(fs.readFileSync(f, 'utf8'))); return ym.get(f); };
const chars = (f) => C.charsOf(conf(f));
const reader = C.makeReader({ Tensor: ort.Tensor, session, chars, conf: (f) => conf(f).PostProcess || {} });
const P = (n) => mdir + '/' + n;
const spec = { threads, pipelines: {
  latin: { det: P('ppocrv6-small-det.onnx'), detYml: P('ppocrv6-small-det.yml'), rec: P('ppocrv6-small-rec.onnx'), recYml: P('ppocrv6-small-rec.yml') },
  arabic: { det: P('ppocrv5-mobile-det.onnx'), detYml: P('ppocrv5-mobile-det.yml'), rec: P('ppocrv5-arabic-rec.onnx'), recYml: P('ppocrv5-arabic-rec.yml'), reverse: true } } };
const dec = (f) => { const p = PNG.sync.read(fs.readFileSync(f)); return { w: p.width, h: p.height, data: p.data }; };
const res = {}; let first = true;
for (const v of vlist.split(',')) for (const [pid, files] of Object.entries(M[v] || {})) {
  if (first) { await reader(dec(files[0]), lang, spec); first = false; }   // warm-up (loads the models) is not counted
  const t0 = Date.now(), texts = []; let lines = 0;
  for (const f of files) { const r = await reader(dec(f), lang, spec); texts.push(r.md); lines += r.lines; }
  (res[v] = res[v] || {})[pid] = { text: texts.join('\n'), sec: (Date.now() - t0) / 1000, lines };
  console.log(v, pid, ((Date.now() - t0) / 1000).toFixed(1) + 's');
}
res._meta = { engine: 'pp', lang, threads, maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024), cpuSec: (process.cpuUsage().user + process.cpuUsage().system) / 1e6 };
fs.writeFileSync(outf, JSON.stringify(res));
