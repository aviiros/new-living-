// Runs the translation models on this computer (no server). Each language pair is a small
// model (about 80 MB) that downloads on first use and is then read from disk, so it works offline.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as E from './ai-engine.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LANGS = ['ar', 'en', 'fr', 'es', 'it', 'id'];
let tf = null; const pipes = new Map(); let chain = Promise.resolve();
const post = (id, kind, text, engine) => parentPort.postMessage({ id, kind, text: text == null ? '' : String(text), engine: engine || '' });
const why = (e) => String((e && e.message) || e || 'error').slice(0, 400);

async function lib() {
  if (!tf) { tf = await import('@huggingface/transformers'); tf.env.cacheDir = workerData.cache; tf.env.allowLocalModels = false; }
  return tf;
}
function pipe(a, b) {
  const k = a + '-' + b;
  if (!pipes.has(k)) {
    pipes.set(k, (async () => {
      const t = await lib(); post('', 'prep');
      let last = null;
      for (let n = 0; n < 3; n++) {
        try { const p = await t.pipeline('translation', 'Xenova/opus-mt-' + k, { dtype: 'q8' }); post('', 'ready'); return p; }
        catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (n + 1))); }
      }
      pipes.delete(k); last.load = true; throw last;
    })());
  }
  return pipes.get(k);
}
function pieces(text) {
  const sents = text.split(/(?<=[.!?؟…।])\s+/), out = []; let cur = '';
  for (const s of sents) { if (cur && (cur + ' ' + s).length > 420) { out.push(cur); cur = s; } else cur = cur ? cur + ' ' + s : s; }
  if (cur) out.push(cur);
  return out;
}
async function hop(text, a, b) {
  const p = await pipe(a, b), pre = a === 'en' && b === 'ar' ? '>>ara<< ' : '', out = [];
  for (const s of pieces(text)) {
    let t = '';
    for (const nb of [2, 1, 4]) { const r = await p(pre + s, { max_new_tokens: 400, num_beams: nb }); t = ((r && r[0] && r[0].translation_text) || '').trim(); if (t) break; }
    out.push(t || s);
  }
  return out.join(' ');
}
// Best quality first: one multilingual model (NLLB-200, about 900 MB, downloaded once). If it cannot be loaded
// the small per-language Marian models above are used instead.
const NLLB = { ar: 'arb_Arab', en: 'eng_Latn', fr: 'fra_Latn', es: 'spa_Latn', it: 'ita_Latn', id: 'ind_Latn' };
let nllb = null, nllbBad = false, nllbWhy = '';
function nllbPipe() {
  if (!nllb) nllb = (async () => {
    const t = await lib(); post('', 'prep');
    try { const p = await t.pipeline('translation', 'Xenova/nllb-200-distilled-600M', { dtype: 'q8' }); post('', 'ready'); return p; }
    catch (e) { nllb = null; nllbBad = true; nllbWhy = why(e); throw e; }
  })();
  return nllb;
}
async function viaNllb(text, src, tgt) {
  const p = await nllbPipe(), out = [];
  for (const s of pieces(text)) { const r = await p(s, { src_lang: NLLB[src], tgt_lang: NLLB[tgt], max_new_tokens: 512, num_beams: 3 }); out.push(((r && r[0] && r[0].translation_text) || '').trim()); }
  return out.join(' ');
}

// ---- Bergamot (the engine behind Firefox's offline translation): small models (about 37 MB per direction), fast on a normal CPU.
// Models come from Mozilla's public model list, are saved once on this computer, and then work offline. Pairs without a direct
// model go through English. If anything fails we fall back to the Marian models below, so translation never stops.
let berg = null, bergBad = false, bergWhy = ''; const pairBad = new Map();
const MOZ = 'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records', CDN = 'https://firefox-settings-attachments.cdn.mozilla.net/';
const verKey = (v) => { const m = /^(\d+)\.(\d+)(.*)$/.exec(String(v)); return m ? [+m[1], +m[2], m[3] ? 0 : 1] : [0, 0, 0]; };
const verCmp = (a, b) => { const x = verKey(a), y = verKey(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };
async function bergRegistry() {
  const file = path.join(workerData.cache, 'bergamot-registry.json');
  try {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 25000);
    const r = await fetch(MOZ, { signal: ctl.signal }); clearTimeout(to);
    if (!r.ok) throw new Error('registry http ' + r.status);
    const recs = (await r.json()).data || [], by = {};
    for (const x of recs) {
      if (!LANGS.includes(x.fromLang) || !LANGS.includes(x.toLang) || !x.attachment || !['model', 'lex', 'vocab'].includes(x.fileType)) continue;
      const k = x.fromLang + x.toLang; ((by[k] = by[k] || {})[x.fileType] = by[k][x.fileType] || []).push(x);
    }
    const reg = {};
    for (const k of Object.keys(by)) {
      const g = by[k]; if (!g.model || !g.lex || !g.vocab) continue;
      const vers = [...new Set(g.model.map((x) => x.version))].filter((v) => g.lex.some((x) => x.version === v) && g.vocab.some((x) => x.version === v)).sort(verCmp);
      if (!vers.length) continue; reg[k] = {};
      for (const t of ['model', 'lex', 'vocab']) { const a = g[t].find((x) => x.version === vers[0]); reg[k][t] = { name: CDN + a.attachment.location, size: a.attachment.size, expectedSha256Hash: a.attachment.hash }; }
    }
    if (!Object.keys(reg).length) throw new Error('empty registry');
    try { fs.mkdirSync(workerData.cache, { recursive: true }); fs.writeFileSync(file, JSON.stringify(reg)); } catch (e) {}
    return reg;
  } catch (e) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (x) { throw e; }
  }
}
const ce = console.error.bind(console);
console.error = (...a) => { try { if (String(a[0]).indexOf('WASM Translation Worker error') >= 0) { bergBad = true; bergWhy = 'bergamot worker failed to start'; } } catch (e) {} ce(...a); };
function limit(p, ms, what) { let t; return Promise.race([p, new Promise((_, rj) => { t = setTimeout(() => { bergBad = true; bergWhy = what + ' timed out'; rj(new Error(what + ' timed out')); }, ms); })]).finally(() => clearTimeout(t)); }
async function bergamot() {
  if (bergBad) throw new Error(bergWhy || 'bergamot unavailable');
  if (!berg) berg = (async () => {
    try {
      post('', 'prep');
      // The package's worker file is written for CommonJS but the package is marked as a module, so Node refuses it.
      // Use a private copy where the worker folder is marked CommonJS.
      const srcDir = path.dirname(fileURLToPath(import.meta.resolve('@browsermt/bergamot-translator/translator.js')));
      const pkgDir = path.join(workerData.cache, 'bergamot-pkg2-' + (process.env.LI_BERG_V || '1'));
      if (!fs.existsSync(path.join(pkgDir, 'ok'))) {
        fs.rmSync(pkgDir, { recursive: true, force: true }); fs.mkdirSync(path.join(pkgDir, 'worker'), { recursive: true });
        fs.copyFileSync(path.join(srcDir, 'translator.js'), path.join(pkgDir, 'translator.js'));
        for (const f of fs.readdirSync(path.join(srcDir, 'worker'))) fs.copyFileSync(path.join(srcDir, 'worker', f), path.join(pkgDir, 'worker', f));
        // On Windows the package turns file:///D:/x into "/D:/x" and fails to read it; use the proper conversion.
        const wf = path.join(pkgDir, 'worker', 'translator-worker.js'); let ws = fs.readFileSync(wf, 'utf8');
        ws = ws.replace('await readFile(url.pathname)', "await readFile(require('node:url').fileURLToPath(url))"); fs.writeFileSync(wf, ws);
        fs.writeFileSync(path.join(pkgDir, 'package.json'), '{"type":"module"}');
        fs.writeFileSync(path.join(pkgDir, 'worker', 'package.json'), '{"type":"commonjs"}');
        fs.writeFileSync(path.join(pkgDir, 'ok'), '1');
      }
      const { BatchTranslator } = await import(pathToFileURL(path.join(pkgDir, 'translator.js')).href);
      const reg = await bergRegistry(), dir = path.join(workerData.cache, 'bergamot'); fs.mkdirSync(dir, { recursive: true });
      class Cached extends BatchTranslator {
        async fetch(url, checksum, extra) {
          const f = path.join(dir, crypto.createHash('sha1').update(url).digest('hex') + '.bin');
          try { const b = await fs.promises.readFile(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } catch (e) { /* not saved yet */ }
          const buf = await super.fetch(url, checksum, extra);
          if (!buf || buf.byteLength < 1000) throw new Error('download failed');
          try { await fs.promises.writeFile(f + '.tmp', Buffer.from(buf)); await fs.promises.rename(f + '.tmp', f); } catch (e) {}
          return buf;
        }
      }
      const t = new Cached({ registryUrl: 'data:application/json,' + encodeURIComponent(JSON.stringify(reg)), pivotLanguage: 'en', workers: 2, batchSize: 8, downloadTimeout: 0, cacheSize: 0 });
      post('', 'ready'); return t;
    } catch (e) { bergBad = true; bergWhy = why(e); berg = null; throw e; }
  })();
  return berg;
}
async function viaBergamot(text, src, tgt) {
  const key = src + '>' + tgt, bad = pairBad.get(key); if (bad && Date.now() - bad < 120000) throw new Error('bergamot pair skipped');
  const t = await limit(bergamot(), 180000, 'bergamot load');
  try {
    const out = [];
    for (const part of text.split(/\n+/)) { if (!part.trim()) continue; const r = await limit(t.translate({ from: src, to: tgt, text: part, html: false, qualityScores: false }), 60000, 'bergamot translate'); out.push(((r && r.target && r.target.text) || '').trim()); }
    const res = out.join('\n'); if (!res.trim()) throw new Error('empty'); return res;
  } catch (e) { pairBad.set(key, Date.now()); throw e; }
}
async function marian(text, src, tgt) { return (src === 'en' || tgt === 'en') ? await hop(text, src, tgt) : await hop(await hop(text, src, 'en'), 'en', tgt); }
async function viaOnline(text, src, tgt) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + src + '&tl=' + tgt + '&dt=t&ie=UTF-8&oe=UTF-8', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: 'q=' + encodeURIComponent(text), signal: ctl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json(), out = (j[0] || []).map((x) => (x && x[0]) || '').join('').trim();
    if (!out) throw new Error('empty'); return out;
  } finally { clearTimeout(to); }
}

// ---------- Local AI translation (HY-MT, Tencent) for "higher quality on this PC" ----------
// One small program (llama.cpp, about 25 MB) runs the model (about 1.1 GB). Both download once and then work offline.
// Every answer is checked; if the model is unavailable or an answer looks wrong the faster engines are used instead.
import * as R from './ai-registry.mjs';
const LNAME = { ar: 'Arabic', en: 'English', fr: 'French', es: 'Spanish', it: 'Italian', id: 'Indonesian' };
let ai = null, aiSrv = null, aiLoading = false, aiBad = false, aiWhy = '', aiLast = null;
const pct = (n) => post('', 'prep', n + '%');
const runnerPath = () => workerData.runner || '';
async function aiStart() {
  if (!E.ramOk(5.5)) throw new Error('not enough memory for the local AI model (needs about 6 GB)');
  post('', 'prep');
  const m = R.resolve(workerData.cache, 'translate');
  if (!R.have(workerData.cache, m)) {
    if (!m.files) throw new Error('model file not found: ' + m.model);
    await E.fetchModel(m, { pct, phase: () => post('', 'prep', '...') });
  }
  const exe = await E.ensureLlama(workerData.cache, pct);
  // do not load while the memory is short: a transient problem, the faster engines answer instead
  const need = Math.round((m.files ? m.files[0].bytes : 1100000000) / 1048576 * 1.4 + 400);
  if (!E.memOk(need)) { const e = new Error('not enough free memory right now (' + need + ' MB needed)'); e.transient = true; throw e; }
  aiLoading = true;
  try {
    const srv = await E.startServer(exe, ['-m', m.model, '-t', String(E.threads()), '-c', '2048'], () => { ai = null; aiSrv = null; }, { runner: runnerPath(), name: m.name, kind: 'translate', cap: () => R.capOf(workerData.cache), idleMs: () => R.idleMsOf(workerData.cache), onIdle: (s) => { aiLast = Object.assign(s.stats(), { state: 'stopped', name: m.name }); ai = null; aiSrv = null; } });
    aiSrv = srv; srv.mname = m.name; post('', 'ready'); return srv;
  } finally { aiLoading = false; }
}
function aiStop() { const cur = ai, s = aiSrv; if (s) aiLast = Object.assign(s.stats(), { state: 'stopped', name: s.mname }); ai = null; aiSrv = null; if (s) s.kill(); else if (cur) cur.then((x) => { try { x.kill(); } catch (e) {} }).catch(() => {}); }
async function aiGet() {
  if (aiBad) throw new Error(aiWhy);
  if (!ai) ai = aiStart().catch((e) => { ai = null; if (!e.transient) { aiBad = true; aiWhy = why(e); } throw e; });
  return ai;
}
function aiStats() { if (aiSrv) return Object.assign(aiSrv.stats(), { name: aiSrv.mname }); if (aiLoading || ai) return { state: 'loading' }; return aiLast || { state: 'stopped' }; }
// An answer is accepted only if it looks like a real translation of this text.
function aiOk(src, out, tgt) {
  const o = String(out || '').trim(); if (!o) return false;
  const ratio = o.length / Math.max(1, src.length); if (ratio < 0.25 || ratio > 4) return false;
  if (/[぀-ヿ㐀-鿿]/.test(o)) return false;
  if (/Translate the following|without additional explanation/i.test(o)) return false;
  const digits = (t) => (t.match(/[0-9٠-٩]+/g) || []).map((d) => d.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632))).sort().join(',');
  if (digits(src) !== digits(o)) return false;
  if (tgt === 'ar' && !/[؀-ۿ]/.test(o) && /[A-Za-z]{4}/.test(src)) return false;
  return true;
}
async function viaAi(text, src, tgt) {
  const srv = await aiGet(), port = srv.port;
  const out = [];
  for (const s of pieces(text)) {
    let t = '';
    for (const temp of [0, 0.3]) {
      const body = { messages: [{ role: 'user', content: 'Translate the following segment into ' + LNAME[tgt] + ', without additional explanation.\n\n' + s }], temperature: temp, top_k: 20, top_p: 0.6, repeat_penalty: 1.05, max_tokens: Math.min(1500, s.length * 3 + 60) };
      const j = await srv.work(async () => { const r = await fetch('http://127.0.0.1:' + port + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error('AI engine http ' + r.status); return r.json(); }); t = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
      if (aiOk(s, t, tgt)) break; t = '';
    }
    if (!t) throw new Error('AI answer rejected by the safety check');
    out.push(t);
  }
  return out.join(' ');
}
async function go(m) {
  const { id, text, src, tgt } = m;
  if (!LANGS.includes(src) || !LANGS.includes(tgt)) return post(id, 'err', 'language ' + src + '>' + tgt);
  if (src === tgt) return post(id, 'ok', text);
  if (m.online && process.env.LI_SMOKE !== '1') { try { return post(id, 'ok', await viaOnline(text, src, tgt), 'online'); } catch (e) { /* no internet: use the models on this computer */ } }
  try {
    let r = null, eng = 'marian', why1 = '';
    // Fast by default (small model per language pair). The big NLLB model is only used when the person asks for higher quality.
    if (m.hq) {
      try { r = await viaAi(text, src, tgt); eng = 'hymt'; } catch (e) { r = null; why1 = 'local AI: ' + why(e); }
      if (r == null) { try { r = await viaBergamot(text, src, tgt); eng = 'bergamot (' + why1 + ')'; } catch (e) { r = null; } }
      if (r == null) { try { r = await marian(text, src, tgt); eng = 'marian (' + why1 + ')'; } catch (e) { r = null; } }
    }
    if (!m.hq) { try { r = await viaBergamot(text, src, tgt); eng = 'bergamot'; } catch (e) { r = null; why1 = 'bergamot: ' + why(e); } }
    if (!m.hq && (r == null || !String(r).trim())) { try { r = await marian(text, src, tgt); eng = 'marian' + (why1 ? ' (' + why1 + ')' : ''); } catch (e) { r = null; why1 = why1 || why(e); } }
    if (r == null && !nllbBad) { try { r = await viaNllb(text, src, tgt); eng = 'nllb'; } catch (e) { r = null; why1 = why1 || why(e); } } else if (r == null) why1 = why1 || nllbWhy;
    if (r == null && m.hq) { eng = 'marian' + (why1 ? ' (nllb failed: ' + why1 + ')' : ''); r = await marian(text, src, tgt); }
    if (!r || !String(r).trim()) { try { r = await marian(text, src, tgt); eng = 'marian'; } catch (e) { r = null; } }
    if (!r || !String(r).trim()) return post(id, 'err', 'empty result ' + src + '>' + tgt);
    post(id, 'ok', r, eng);
  } catch (e) { if (e && e.load) post('', 'nomodel', why(e)); post(id, 'err', why(e)); }
}
parentPort.on('message', (m) => { if (m.ctl) { if (m.ctl === 'pause' && aiSrv) aiSrv.pause(); else if (m.ctl === 'resume' && aiSrv) aiSrv.resume(); else if (m.ctl === 'unload') { if (aiSrv && aiSrv.busy) return parentPort.postMessage({ kind: 'ctl', rid: m.rid, busy: true }); aiStop(); } parentPort.postMessage({ kind: 'ctl', rid: m.rid, stats: aiStats() }); return; } if (m.aistop) { aiStop(); return; } if (m.online && process.env.LI_SMOKE !== '1') { go(m).catch(() => {}); return; } chain = chain.then(() => go(m)).catch(() => {}); });
