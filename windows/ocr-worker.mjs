// Reads page images with the local AI model "Nuqta" (Arabic and English, Apache-2.0). Models download once, then work offline.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import * as E from './ai-engine.mjs';

const BASE = 'https://huggingface.co/SalahALHaismawi/Nuqta-Arabic-OCR-0.8B-GGUF/resolve/main/';
const FILES = { model: 'nuqta-ocr-0.8b-Q4_K_M.gguf', mm: 'nuqta-ocr-0.8b-mmproj-f16.gguf' };
const PROMPT = 'Extract all the text from this page as Markdown. Keep headings and tables.';
const post = (m) => parentPort.postMessage(m);
const why = (e) => String((e && e.message) || e || 'error').slice(0, 300);
let srv = null, starting = null;
const dir = () => E.llamaDir(workerData.cache);
const have = () => E.hasLlama(workerData.cache) && fs.existsSync(path.join(dir(), FILES.model)) && fs.existsSync(path.join(dir(), FILES.mm));

async function start() {
  if (srv) return srv;
  if (!E.ramOk(3.5)) throw new Error('not enough memory for the local AI model');
  const exe = await E.ensureLlama(workerData.cache, (n) => post({ kind: 'prog', text: n + '%' }));
  for (const k of ['model', 'mm']) { const f = path.join(dir(), FILES[k]); if (!fs.existsSync(f)) await E.download(BASE + FILES[k], f, (n) => post({ kind: 'prog', text: n + '%' })); }
  srv = await E.startServer(exe, ['-m', path.join(dir(), FILES.model), '--mmproj', path.join(dir(), FILES.mm), '-t', String(E.threads()), '-c', '8192', '--image-max-tokens', '2048'], () => { srv = null; });
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
