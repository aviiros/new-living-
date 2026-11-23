// Shared helpers for the local AI engine (llama.cpp program + model files). Used by the translation worker and the OCR worker.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';

export const LLAMA_URL = 'https://github.com/ggml-org/llama.cpp/releases/download/b12532/llama-b12532-bin-win-cpu-x64.zip';

export function download(url, dest, onPct, hops = 0, ctl = null) {
  return new Promise((resolve, reject) => {
    if (hops > 6) return reject(new Error('too many redirects'));
    const part = dest + '.part'; let have = 0; try { have = fs.statSync(part).size; } catch (e) {}
    const req = https.get(url, { headers: have ? { Range: 'bytes=' + have + '-', 'User-Agent': 'LivingIdeas' } : { 'User-Agent': 'LivingIdeas' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) { r.resume(); return resolve(download(new URL(r.headers.location, url).href, dest, onPct, hops + 1, ctl)); }
      if (r.statusCode === 416) { try { fs.renameSync(part, dest); } catch (e) {} return resolve(dest); }
      if (r.statusCode !== 200 && r.statusCode !== 206) { r.resume(); return reject(new Error('download http ' + r.statusCode)); }
      const total = (r.statusCode === 206 ? have : 0) + Number(r.headers['content-length'] || 0); let got = r.statusCode === 206 ? have : 0, last = 0;
      const out = fs.createWriteStream(part, { flags: r.statusCode === 206 ? 'a' : 'w' });
      r.on('data', (c) => { got += c.length; const now = Date.now(); if (onPct && now - last > 1500 && total) { last = now; onPct(Math.round(got * 100 / total)); } });
      if (ctl) ctl.abort = () => { ctl.stopped = true; try { r.destroy(); } catch (e) {} try { out.end(); } catch (e) {} reject(new Error('paused')); };
      r.pipe(out); out.on('finish', () => { if (ctl && ctl.stopped) return; if (total && got < total) return reject(new Error('download cut off')); fs.renameSync(part, dest); resolve(dest); });
      r.on('error', (e) => { if (!(ctl && ctl.stopped)) reject(e); }); out.on('error', reject);
    });
    if (ctl && ctl.stopped) { req.destroy(); return reject(new Error('paused')); }
    req.on('error', (e) => { if (!(ctl && ctl.stopped)) reject(e); }); req.setTimeout(60000, () => req.destroy(new Error('download timed out')));
  });
}
export function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); }); }
function findExe(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = findExe(p); if (r) return r; } else if (f.name === 'llama-server.exe') return p; } return null; }
export function llamaDir(cache) { const d = path.join(cache, 'hymt'); fs.mkdirSync(d, { recursive: true }); return d; }
export function hasLlama(cache) { try { return !!findExe(path.join(llamaDir(cache), 'bin')); } catch (e) { return false; } }
export async function ensureLlama(cache, onPct) {
  if (process.platform !== 'win32') throw new Error('local AI is only available on Windows');
  const dir = llamaDir(cache); let exe = null; try { exe = findExe(path.join(dir, 'bin')); } catch (e) {}
  if (exe) return exe;
  const zip = await download(LLAMA_URL, path.join(dir, 'llama.zip'), onPct);
  fs.rmSync(path.join(dir, 'bin'), { recursive: true, force: true }); fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  let r = spawnSync('tar', ['-xf', zip, '-C', path.join(dir, 'bin')], { windowsHide: true });
  if (r.status !== 0) r = spawnSync('powershell', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath "' + zip + '" -DestinationPath "' + path.join(dir, 'bin') + '" -Force'], { windowsHide: true });
  if (r.status !== 0) throw new Error('could not unpack the AI engine');
  fs.rmSync(zip, { force: true }); exe = findExe(path.join(dir, 'bin'));
  if (!exe) throw new Error('AI engine files are missing');
  return exe;
}
export function ramOk(gb) { return os.totalmem() >= gb * 1073741824; }
// Free memory right now (Windows reports the memory that can be given to a program).
export function memOk(needMB) { return os.freemem() >= needMB * 1048576; }
// Few threads on purpose: about 60% of the cores, so the PC stays usable (the hard limit below is 70%).
export function threads() { return Math.max(1, Math.min(8, Math.floor(os.cpus().length * 0.6) || 1)); }
export function sha256(file) { return new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej); }); }
// A model file is complete when it has the exact expected size (catalog files) or is a plain file (added by the user).
export function fileOk(f, bytes) { try { const st = fs.statSync(f); return st.isFile() && (!bytes || st.size === bytes); } catch (e) { return false; } }
// Download every file of a catalog model (resumes after a stop), then check its fingerprint. cb: { pct(n), phase('verifying') }.
export async function fetchModel(m, cb, ctl) {
  cb = cb || {}; const dir = llamaDir(m.cache), files = m.files, sz = (f) => f.bytes || f.est || 1, total = files.reduce((a, f) => a + sz(f), 0); let done = 0;
  for (const f of files) {
    const dest = path.join(dir, f.name);
    if (!fileOk(dest, f.bytes)) {
      await download(f.url, dest, (p) => { if (cb.pct) cb.pct(Math.round((done + sz(f) * p / 100) * 100 / total)); }, 0, ctl);
      if (f.sha256) { if (cb.phase) cb.phase('verifying'); if (!shaOk(await sha256(dest), f.sha256)) { try { fs.rmSync(dest, { force: true }); } catch (e) {} throw new Error('file check failed (damaged download)'); } }
    }
    done += sz(f);
  }
  if (cb.pct) cb.pct(100);
}
// System-wide CPU use (percent of all cores) since the previous call.
let prevCpu = null;
export function sysLoad() {
  const c = os.cpus(); let idle = 0, tot = 0; for (const x of c) { for (const k in x.times) tot += x.times[k]; idle += x.times.idle; }
  const r = prevCpu && tot > prevCpu.tot ? Math.max(0, Math.min(100, (1 - (idle - prevCpu.idle) / (tot - prevCpu.tot)) * 100)) : 0;
  prevCpu = { idle, tot }; return r;
}
const num = (x) => (Number.isFinite(x) ? x : 0);
// A running AI engine process. With the helper program (runner) it lives in a Windows Job Object that hard-caps CPU use,
// below-normal priority, and real CPU / memory numbers come from Windows. Without it the engine still runs (lower priority, few threads), but the cap is not enforced.
export class Srv {
  constructor(name, kind) { this.name = name; this.kind = kind; this.busy = 0; this.lastUse = Date.now(); this.st = { state: 'loading', cpu: 0, ws: 0, peak: 0, cap: 0, capped: false, n: 0, sum: 0, max: 0, lastTaskMs: 0, tasks: 0, variant: '', paused: false, loadedAt: Date.now() }; this.timer = null; this.taskT0 = 0; }
  stats() { const s = this.st, a = s.n ? s.sum / s.n : 0; return { state: s.paused ? 'paused' : (this.busy ? 'working' : s.state), cpu: Math.round(s.cpu), avg: Math.round(a), max: Math.round(s.max), ws: Math.round(s.ws), peak: Math.round(s.peak), cap: s.cap, capped: s.capped, taskMs: this.busy ? Date.now() - this.taskT0 : s.lastTaskMs, tasks: s.tasks, variant: s.variant, engine: this.engine || ('llama.cpp ' + BUILD) }; }
  async work(fn) { if (!this.busy) this.taskT0 = Date.now(); this.busy++; try { return await fn(); } finally { this.busy--; this.lastUse = Date.now(); this.st.lastTaskMs = Date.now() - this.taskT0; this.st.tasks++; } }
  cmd(line) { try { if (this.proc.stdin && this.proc.stdin.writable) this.proc.stdin.write(line + '\n'); } catch (e) {} }
  pause() { if (this.st.capped) { this.cmd('pause'); this.st.paused = true; } } resume() { if (this.st.capped) { this.cmd('resume'); this.st.paused = false; } }
  kill() { clearInterval(this.timer); try { this.cmd('quit'); } catch (e) {} try { this.proc.kill(); } catch (e) {} }
}
// a fingerprint may be the whole value or its first 16 characters (as published on some model pages); files without one are checked by size only
export const shaOk = (actual, want) => !want || actual.startsWith(want);
export const BUILD = 'b12532';
// Starts the server and waits until it answers. onDead() is called if the process stops later.
// opt: { runner (path of the limiter program), cap: () => percent, idleMs: () => ms (0 = never), onIdle, name, kind, log }
export async function startServer(exe, args, onDead, opt = {}) {
  const port = await freePort(), full = args.concat(['--port', String(port), '--host', '127.0.0.1', '--parallel', '1']);
  const srv = new Srv(opt.name || 'model', opt.kind || ''); const useRunner = !!(opt.runner && fs.existsSync(opt.runner));
  const log = opt.log || path.join(os.tmpdir(), 'li-engine-' + process.pid + '-' + port + '.log'); try { fs.rmSync(log, { force: true }); } catch (e) {}
  const cap0 = Math.max(5, Math.min(100, Math.round(num(opt.cap ? opt.cap() : 70))));
  let proc;
  if (useRunner) {
    proc = spawn(opt.runner, [String(cap0), exe].concat(full), { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: Object.assign({}, process.env, opt.env || {}, { LI_LOG: log }) });
    srv.st.capped = true; srv.st.cap = cap0;
    let buf = ''; proc.stdout.on('data', (d) => {
      buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const ln = buf.slice(0, i); buf = buf.slice(i + 1); let j; try { j = JSON.parse(ln); } catch (e) { continue; }
        if (j.pid) srv.cpid = j.pid;
        if (j.cpu != null) { const s = srv.st; s.cpu = num(j.cpu); s.ws = num(j.ws); s.peak = Math.max(s.peak, num(j.peak)); s.cap = j.cap || s.cap; s.max = Math.max(s.max, s.cpu); if (srv.busy) { s.n++; s.sum += s.cpu; } } }
    });
    proc.stdin.on('error', () => {});
  } else {
    proc = spawn(exe, full, { windowsHide: true, stdio: 'ignore', env: Object.assign({}, process.env, opt.env || {}) }); try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) {}
  }
  srv.proc = proc; srv.port = port; if (opt.engine) srv.engine = opt.engine; srv.log = log;
  let dead = false; proc.on('exit', () => { dead = true; srv.st.state = 'stopped'; clearInterval(srv.timer); if (onDead) onDead(); });
  process.on('exit', () => { try { proc.kill(); } catch (e) {} });
  const t0 = Date.now();
  for (;;) {
    if (dead) throw new Error('AI engine stopped while starting (this PC may be too old for it)');
    if (Date.now() - t0 > 180000) { try { proc.kill(); } catch (e) {} throw new Error('AI engine took too long to start'); }
    try { const r = await fetch('http://127.0.0.1:' + port + '/health'); if (r.ok) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  srv.st.state = 'ready'; srv.lastUse = Date.now();
  // which CPU variant of the engine Windows really loaded: ask for the modules of the engine process
  if (process.platform === 'win32' && (srv.cpid || proc.pid) && !opt.noVariant) {
    try {
      const out = await new Promise((ok) => execFile('tasklist', ['/m', '/fi', 'PID eq ' + (srv.cpid || proc.pid), '/fo', 'csv'], { windowsHide: true, timeout: 8000 }, (e, o) => ok(String(o || ''))));
      const m = out.match(/ggml-cpu-([a-z0-9_]+)\.dll/gi); if (m) srv.st.variant = m[m.length - 1].replace(/^ggml-cpu-/i, '').replace(/\.dll$/i, '');
    } catch (e) {}
  }
  try { const t = fs.readFileSync(log, 'utf8'), m = t.match(/ggml-cpu-([a-z0-9_]+)\.dll/gi); if (m) srv.st.variant = m[m.length - 1].replace(/^ggml-cpu-/i, '').replace(/\.dll$/i, ''); else if (/loaded CPU backend/i.test(t)) srv.st.variant = 'cpu'; } catch (e) {}
  // every 3 s: give way to the person (lower the cap when other programs are busy) and free the memory after the idle time
  sysLoad();
  srv.timer = setInterval(() => {
    const sys = sysLoad(), own = srv.st.cpu, others = Math.max(0, sys - own), base = Math.max(5, Math.min(opt.unclamped ? 100 : 70, num(opt.cap ? opt.cap() : 70)));
    const want = others > 60 ? Math.min(base, 25) : others > 40 ? Math.min(base, 40) : others > 25 ? Math.min(base, 55) : base;
    if (srv.st.capped && want !== srv.st.cap) { srv.st.cap = want; srv.cmd('cap ' + want); }
    const idle = opt.idleMs ? opt.idleMs() : 0;
    if (idle > 0 && !srv.busy && !srv.st.paused && Date.now() - srv.lastUse > idle) { clearInterval(srv.timer); if (opt.onIdle) opt.onIdle(srv); srv.kill(); }
  }, 3000);
  if (srv.timer.unref) srv.timer.unref();
  return srv;
}
