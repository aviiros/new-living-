// Runs the translation models on this computer (no server). Each language pair is a small
// model (about 80 MB) that downloads on first use and is then read from disk, so it works offline.
import { parentPort, workerData } from 'node:worker_threads';

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
      try { const p = await t.pipeline('translation', 'Xenova/opus-mt-' + k, { dtype: 'q8' }); post('', 'ready'); return p; }
      catch (e) { pipes.delete(k); e.load = true; throw e; }
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
async function go(m) {
  const { id, text, src, tgt } = m;
  if (!LANGS.includes(src) || !LANGS.includes(tgt)) return post(id, 'err', 'language ' + src + '>' + tgt);
  if (src === tgt) return post(id, 'ok', text);
  if (m.online && process.env.LI_SMOKE !== '1') { try { return post(id, 'ok', await viaOnline(text, src, tgt), 'online'); } catch (e) { /* no internet: use the models on this computer */ } }
  try {
    let r = null, eng = 'marian', why1 = '';
    // Fast by default (small model per language pair). The big NLLB model is only used when the person asks for higher quality.
    if (!m.hq) { try { r = await marian(text, src, tgt); } catch (e) { r = null; why1 = why(e); } }
    if (r == null && !nllbBad) { try { r = await viaNllb(text, src, tgt); eng = 'nllb'; } catch (e) { r = null; why1 = why1 || why(e); } } else if (r == null) why1 = why1 || nllbWhy;
    if (r == null && m.hq) { eng = 'marian' + (why1 ? ' (nllb failed: ' + why1 + ')' : ''); r = await marian(text, src, tgt); }
    post(id, 'ok', r, eng);
  } catch (e) { if (e && e.load) post('', 'nomodel', why(e)); post(id, 'err', why(e)); }
}
parentPort.on('message', (m) => { if (m.online && process.env.LI_SMOKE !== '1') { go(m).catch(() => {}); return; } chain = chain.then(() => go(m)).catch(() => {}); });
