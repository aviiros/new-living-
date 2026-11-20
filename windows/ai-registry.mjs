// The list of local AI models: the catalog (sizes and fingerprints are the real ones from the model pages), any the person added from this computer, and the settings.
import fs from 'node:fs';
import path from 'node:path';
import { llamaDir, fileOk } from './ai-engine.mjs';

const HY = 'https://huggingface.co/tencent/HY-MT1.5-1.8B-GGUF/resolve/main/', NQ = 'https://huggingface.co/SalahALHaismawi/Nuqta-Arabic-OCR-0.8B-GGUF/resolve/main/';
const NQMM = { name: 'nuqta-ocr-0.8b-mmproj-f16.gguf', url: NQ + 'nuqta-ocr-0.8b-mmproj-f16.gguf', bytes: 204986688, sha256: 'ca24aaf3a572147676411ba661f754eeadb66aa1daf8d133dc001e556370ed41' };
// tested: true only for models that were really run by the automatic test of the Windows build.
export const CATALOG = [
  { id: 'hymt', kind: 'translate', name: 'HY-MT 1.5 (1.8B)', quant: 'Q4_K_M', version: '1.5', builtin: true, tested: true, ramMB: 2200, langs: { n: 36, app: true }, license: 'Tencent HY Community License', licenseNote: 'eu', repo: 'tencent/HY-MT1.5-1.8B-GGUF',
    files: [{ name: 'HY-MT1.5-1.8B-Q4_K_M.gguf', url: HY + 'HY-MT1.5-1.8B-Q4_K_M.gguf', bytes: 1133080512, sha256: '4383ac0c3c8e476de98ff979c2a3f069f8c4fb385e7860cf2d28da896cc477c7' }] },
  { id: 'hymt-q6', kind: 'translate', name: 'HY-MT 1.5 (1.8B)', quant: 'Q6_K', version: '1.5', tested: false, ramMB: 2700, langs: { n: 36, app: true }, license: 'Tencent HY Community License', licenseNote: 'eu', repo: 'tencent/HY-MT1.5-1.8B-GGUF',
    files: [{ name: 'HY-MT1.5-1.8B-Q6_K.gguf', url: HY + 'HY-MT1.5-1.8B-Q6_K.gguf', bytes: 1474785216, sha256: 'c3819200ab9a79cb29b9a05ce8920e2eb01ae7ce520094fc5b57356494f3c641' }] },
  { id: 'hymt-q8', kind: 'translate', name: 'HY-MT 1.5 (1.8B)', quant: 'Q8_0', version: '1.5', tested: false, ramMB: 3200, langs: { n: 36, app: true }, license: 'Tencent HY Community License', licenseNote: 'eu', repo: 'tencent/HY-MT1.5-1.8B-GGUF',
    files: [{ name: 'HY-MT1.5-1.8B-Q8_0.gguf', url: HY + 'HY-MT1.5-1.8B-Q8_0.gguf', bytes: 1908528288, sha256: '6789b06d0902f2f5312c0e1703d56ccbddfcfb6c653d22519b7c720f7db9a98e' }] },
  { id: 'nuqta', kind: 'ocr', name: 'Nuqta OCR (0.8B)', quant: 'Q4_K_M', version: '0.8B', builtin: true, tested: true, ramMB: 2000, langs: { ar: true, en: true }, license: 'Apache-2.0', repo: 'SalahALHaismawi/Nuqta-Arabic-OCR-0.8B-GGUF',
    files: [{ name: 'nuqta-ocr-0.8b-Q4_K_M.gguf', url: NQ + 'nuqta-ocr-0.8b-Q4_K_M.gguf', bytes: 559595520, sha256: 'e68f6da1531330fa499e30f4b8d240936299ee6e1e2865dd01aa8ec482960f07' }, NQMM] },
  { id: 'nuqta-q8', kind: 'ocr', name: 'Nuqta OCR (0.8B)', quant: 'Q8_0', version: '0.8B', tested: false, ramMB: 2300, langs: { ar: true, en: true }, license: 'Apache-2.0', repo: 'SalahALHaismawi/Nuqta-Arabic-OCR-0.8B-GGUF',
    files: [{ name: 'nuqta-ocr-0.8b-Q8_0.gguf', url: NQ + 'nuqta-ocr-0.8b-Q8_0.gguf', bytes: 872607744, sha256: '9e668a31aaaa0262134737262298d53f8240f390004f5ff72270334acc90532c' }, NQMM] }
];
export const BUILTIN = CATALOG.filter((m) => m.builtin);
const DEFAULTS = { idleMin: 5, cpu: 'auto' };
const regFile = (cache) => path.join(llamaDir(cache), 'registry.json');
export function load(cache) {
  let r = {}; try { r = JSON.parse(fs.readFileSync(regFile(cache), 'utf8')) || {}; } catch (e) {}
  return { active: Object.assign({ translate: 'hymt', ocr: 'nuqta' }, r.active || {}), custom: Array.isArray(r.custom) ? r.custom : [], settings: Object.assign({}, DEFAULTS, r.settings || {}) };
}
export function save(cache, r) { fs.writeFileSync(regFile(cache), JSON.stringify(r, null, 1)); }
export function settings(cache) { return load(cache).settings; }
// CPU percentage limit for the engines: 70 normally, 50 in the light mode.
export function capOf(cache) { return settings(cache).cpu === 'light' ? 50 : 70; }
export function idleMsOf(cache) { const m = Number(settings(cache).idleMin); return m > 0 ? m * 60000 : 0; }
export function all(cache) { return CATALOG.concat(load(cache).custom.map((c) => Object.assign({ builtin: false, custom: true }, c))); }
// The model to use for a task: { id, name, model (full path), mm (full path or ''), files, builtin, cache }
export function resolve(cache, kind) {
  const r = load(cache), list = all(cache).filter((m) => m.kind === kind);
  const m = list.find((x) => x.id === r.active[kind]) || list[0], d = llamaDir(cache);
  if (m.files) return Object.assign({}, m, { cache, model: path.join(d, m.files[0].name), mm: m.files[1] ? path.join(d, m.files[1].name) : '' });
  return Object.assign({}, m, { cache, model: m.file, mm: m.mm || '' });
}
export function have(cache, m) {
  try {
    if (m.files) { const d = llamaDir(cache); return m.files.every((f) => fileOk(path.join(d, f.name), f.bytes)); }
    return fileOk(m.model) && (!m.mm || fileOk(m.mm));
  } catch (e) { return false; }
}
