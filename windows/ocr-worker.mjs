// Reads page images with the local AI model "Nuqta" (Arabic and English, Apache-2.0). Models download once, then work offline.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import * as E from './ai-engine.mjs';

import * as R from './ai-registry.mjs';
const PROMPT = 'Extract all the text from this page as Markdown. Keep headings and tables.';
const post = (m) => parentPort.postMessage(m);
const why = (e) => String((e && e.message) || e || 'error').slice(0, 300);
let srv = null, starting = null;
const cur = () => R.resolve(workerData.cache, 'ocr');
const have = () => E.hasLlama(workerData.cache) && R.have(workerData.cache, cur());

async function start() {
  if (srv) return srv;
  if (!E.ramOk(3.5)) throw new Error('not enough memory for the local AI model');
  const m = cur(), prog = (n) => post({ kind: 'prog', text: n + '%' });
  const exe = await E.ensureLlama(workerData.cache, prog);
  if (!R.have(workerData.cache, m)) {
    if (!m.builtin) throw new Error('model file not found');
    if (!fs.existsSync(m.model)) await E.download(m.url, m.model, prog);
    if (m.mm && !fs.existsSync(m.mm)) await E.download(m.mmUrl, m.mm, prog);
  }
  const args = ['-m', m.model, '-t', String(E.threads()), '-c', '8192', '--image-max-tokens', '2048']; if (m.mm) args.push('--mmproj', m.mm);
  srv = await E.startServer(exe, args, () => { srv = null; });
  return srv;
}
async function page(dataUrl) {
  if (!starting) starting = start().finally(() => { starting = null; });
  const s = await starting || srv;
  const body = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: PROMPT }] }], temperature: 0, max_tokens: 4096 };
  const r = await fetch('http://127.0.0.1:' + s.port + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('AI engine http ' + r.status);
  const j = await r.json();
  return ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
}
let chain = Promise.resolve();
parentPort.on('message', (m) => {
  if (m.kind === 'status') return post({ kind: 'status', id: m.id, have: have(), ram: E.ramOk(3.5), win: process.platform === 'win32' });
  if (m.kind === 'stop') { const s = srv; srv = null; if (s) try { s.proc.kill(); } catch (e) {} return post({ kind: 'stopped', id: m.id }); }
  if (m.kind === 'prep') { chain = chain.then(() => (starting = starting || start().finally(() => { starting = null; }))).then(() => post({ kind: 'ok', id: m.id }), (e) => post({ kind: 'err', id: m.id, text: why(e) })); return; }
  if (m.kind === 'page') { chain = chain.then(() => page(m.image)).then((t) => post({ kind: 'ok', id: m.id, text: t }), (e) => post({ kind: 'err', id: m.id, text: why(e) })); }
});
