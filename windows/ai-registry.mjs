// The list of local AI models: two built-in ones (downloaded once) and any the person adds from this computer.
import fs from 'node:fs';
import path from 'node:path';
import { llamaDir } from './ai-engine.mjs';

export const BUILTIN = [
  { id: 'hymt', kind: 'translate', name: 'HY-MT 1.8B (Tencent)', builtin: true, file: 'HY-MT1.5-1.8B-Q4_K_M.gguf', url: 'https://huggingface.co/tencent/HY-MT1.5-1.8B-GGUF/resolve/main/HY-MT1.5-1.8B-Q4_K_M.gguf', mb: 1081 },
  { id: 'nuqta', kind: 'ocr', name: 'Nuqta OCR 0.8B (Arabic + English)', builtin: true, file: 'nuqta-ocr-0.8b-Q4_K_M.gguf', url: 'https://huggingface.co/SalahALHaismawi/Nuqta-Arabic-OCR-0.8B-GGUF/resolve/main/nuqta-ocr-0.8b-Q4_K_M.gguf', mm: 'nuqta-ocr-0.8b-mmproj-f16.gguf', mmUrl: 'https://huggingface.co/SalahALHaismawi/Nuqta-Arabic-OCR-0.8B-GGUF/resolve/main/nuqta-ocr-0.8b-mmproj-f16.gguf', mb: 730 }
];
const regFile = (cache) => path.join(llamaDir(cache), 'registry.json');
export function load(cache) {
  let r = {}; try { r = JSON.parse(fs.readFileSync(regFile(cache), 'utf8')) || {}; } catch (e) {}
  return { active: Object.assign({ translate: 'hymt', ocr: 'nuqta' }, r.active || {}), custom: Array.isArray(r.custom) ? r.custom : [] };
}
export function save(cache, r) { fs.writeFileSync(regFile(cache), JSON.stringify(r, null, 1)); }
export function all(cache) { return BUILTIN.concat(load(cache).custom.map((c) => Object.assign({ builtin: false }, c))); }
// The model to use for a task: { id, name, model (full path), mm (full path or ''), url, mmUrl, builtin }
export function resolve(cache, kind) {
  const r = load(cache), list = all(cache).filter((m) => m.kind === kind);
  const m = list.find((x) => x.id === r.active[kind]) || list[0], d = llamaDir(cache);
  return Object.assign({}, m, { model: m.builtin ? path.join(d, m.file) : m.file, mm: m.mm ? (m.builtin ? path.join(d, m.mm) : m.mm) : '' });
}
export function have(cache, m) { try { return fs.existsSync(m.model) && (!m.mm || fs.existsSync(m.mm)); } catch (e) { return false; } }
