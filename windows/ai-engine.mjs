// Shared helpers for the local AI engine (llama.cpp program + model files). Used by the translation worker and the OCR worker.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

export const LLAMA_URL = 'https://github.com/ggml-org/llama.cpp/releases/download/b12532/llama-b12532-bin-win-cpu-x64.zip';

export function download(url, dest, onPct, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 6) return reject(new Error('too many redirects'));
    const part = dest + '.part'; let have = 0; try { have = fs.statSync(part).size; } catch (e) {}
    const req = https.get(url, { headers: have ? { Range: 'bytes=' + have + '-', 'User-Agent': 'LivingIdeas' } : { 'User-Agent': 'LivingIdeas' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) { r.resume(); return resolve(download(new URL(r.headers.location, url).href, dest, onPct, hops + 1)); }
      if (r.statusCode === 416) { try { fs.renameSync(part, dest); } catch (e) {} return resolve(dest); }
      if (r.statusCode !== 200 && r.statusCode !== 206) { r.resume(); return reject(new Error('download http ' + r.statusCode)); }
      const total = (r.statusCode === 206 ? have : 0) + Number(r.headers['content-length'] || 0); let got = r.statusCode === 206 ? have : 0, last = 0;
      const out = fs.createWriteStream(part, { flags: r.statusCode === 206 ? 'a' : 'w' });
      r.on('data', (c) => { got += c.length; const now = Date.now(); if (onPct && now - last > 1500 && total) { last = now; onPct(Math.round(got * 100 / total)); } });
      r.pipe(out); out.on('finish', () => { if (total && got < total) return reject(new Error('download cut off')); fs.renameSync(part, dest); resolve(dest); });
      r.on('error', reject); out.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('download timed out')));
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
export function threads() { return Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2) || 2)); }
// Starts the server and waits until it answers. onDead() is called if the process stops later.
export async function startServer(exe, args, onDead) {
  const port = await freePort();
  const proc = spawn(exe, args.concat(['--port', String(port), '--host', '127.0.0.1', '--parallel', '1']), { windowsHide: true, stdio: 'ignore' });
  let dead = false; proc.on('exit', () => { dead = true; if (onDead) onDead(); });
  process.on('exit', () => { try { proc.kill(); } catch (e) {} });
  const t0 = Date.now();
  for (;;) {
    if (dead) throw new Error('AI engine stopped while starting (this PC may be too old for it)');
    if (Date.now() - t0 > 180000) { try { proc.kill(); } catch (e) {} throw new Error('AI engine took too long to start'); }
    try { const r = await fetch('http://127.0.0.1:' + port + '/health'); if (r.ok) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { proc, port };
}
