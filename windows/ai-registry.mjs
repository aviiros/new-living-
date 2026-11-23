// The list of local AI models: the catalog (sizes and fingerprints are the real ones from the model pages), any the person added from this computer, and the settings.
import fs from 'node:fs';
import path from 'node:path';
import { llamaDir, fileOk } from './ai-engine.mjs';

const HY = 'https://huggingface.co/tencent/HY-MT1.5-1.8B-GGUF/resolve/main/', NQ = 'https://huggingface.co/SalahALHaismawi/Nuqta-Arabic-OCR-0.8B-GGUF/resolve/main/';
const H2 = 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/main/', PP = 'https://huggingface.co/PaddlePaddle/';
const mt2 = (id, q, ramMB, bytes, sha) => ({ id, kind: 'translate', name: 'HY-MT 2 (1.8B)', quant: q, version: '2', tested: q === 'Q4_K_M', ramMB, langs: { n: 36, app: true }, license: 'Apache-2.0', repo: 'tencent/Hy-MT2-1.8B-GGUF', files: [{ name: 'Hy-MT2-1.8B-' + q + '.gguf', url: H2 + 'Hy-MT2-1.8B-' + q + '.gguf', bytes, sha256: sha }] });
// PaddleOCR page-reading bundle: detector + recognizer pairs (ONNX) with their setting files. Fingerprints: first 16 characters as published; the small setting files are checked by size.
const pp = (name, repo, file, bytes, sha) => ({ name, url: PP + repo + '/resolve/main/' + file, bytes, sha256: sha });
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
// PLaMo 3 Translate (Preferred Networks), 53 languages including the six of this app. Small: about 0.57 GB. The exact size is not published on the page, so progress uses an estimate and the finished download is accepted as it is.
CATALOG.push({ id: 'plamo3', kind: 'translate', name: 'PLaMo 3 Translate (0.8B)', quant: 'Q4_K_M', version: '3', tested: false, ramMB: 1100, langs: { n: 53, app: true }, license: 'PLaMo Community License (free for personal use; commercial use needs a free registration)', repo: 'pfnet/plamo-3-translate-0.8b-GGUF',
  files: [{ name: 'plamo-3-translate-0.8b-Q4_K_M.gguf', url: 'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/main/plamo-3-translate-0.8b-Q4_K_M.gguf', bytes: 0, est: 573000000 }] });
CATALOG.push(
  mt2('hymt2', 'Q4_K_M', 2200, 1133080448, 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699'),
  mt2('hymt2-q6', 'Q6_K', 2700, 1474785120, 'd98fe604dec1f28f58f80d7d560f7177e584d3b8e5835862687660e5ff97cb40'),
  mt2('hymt2-q8', 'Q8_0', 3200, 1908528192, '5c3fe0b1408a5ceb0143184ef247b11b579c525f4b02b060e6c851bb76fef1a4'),
  { id: 'ppocr', kind: 'ocr', engine: 'ppocr', name: 'PaddleOCR (v6 Latin + v5 Arabic)', quant: '', version: 'PP-OCRv6 small / PP-OCRv5 mobile', tested: true, ramMB: 1100, langs: { ar: true, en: true, latin: true }, license: 'Apache-2.0', repo: 'PaddlePaddle/PP-OCRv6_small_det_onnx',
    files: [
      pp('ppocrv6-small-det.onnx', 'PP-OCRv6_small_det_onnx', 'inference.onnx', 9880512, 'd73e0058b7a8086b'), pp('ppocrv6-small-det.yml', 'PP-OCRv6_small_det_onnx', 'inference.yml', 885),
      pp('ppocrv6-small-rec.onnx', 'PP-OCRv6_small_rec_onnx', 'inference.onnx', 21159378, '5435fd747c9e0efe'), pp('ppocrv6-small-rec.yml', 'PP-OCRv6_small_rec_onnx', 'inference.yml', 150579),
      pp('ppocrv5-mobile-det.onnx', 'PP-OCRv5_mobile_det_onnx', 'inference.onnx', 4826518, 'a431985659dc9219'), pp('ppocrv5-mobile-det.yml', 'PP-OCRv5_mobile_det_onnx', 'inference.yml', 903),
      pp('ppocrv5-arabic-rec.onnx', 'arabic_PP-OCRv5_mobile_rec_onnx', 'inference.onnx', 7998947, '799113ebf267fbe7'), pp('ppocrv5-arabic-rec.yml', 'arabic_PP-OCRv5_mobile_rec_onnx', 'inference.yml', 6165),
      pp('ppocrv5-latin-rec.onnx', 'latin_PP-OCRv5_mobile_rec_onnx', 'inference.onnx', 8042023, '7888113072263cb4'), pp('ppocrv5-latin-rec.yml', 'latin_PP-OCRv5_mobile_rec_onnx', 'inference.yml', 6817)
    ] }
);
export const BUILTIN = CATALOG.filter((m) => m.builtin);
const DEFAULTS = { idleMin: 5, cpu: 'auto' };
const regFile = (cache) => path.join(llamaDir(cache), 'registry.json');
// Default translation model: HY-MT 2 (about 1.1 GB, downloaded once). HY-MT 1.5 stays in the list for going back.
const defTr = () => 'hymt2';
export function load(cache) {
  let r = {}; try { r = JSON.parse(fs.readFileSync(regFile(cache), 'utf8')) || {}; } catch (e) {}
  return { active: Object.assign({ translate: defTr(cache), ocr: 'ppocr' }, r.active || {}), custom: Array.isArray(r.custom) ? r.custom : [], settings: Object.assign({}, DEFAULTS, r.settings || {}) };
}
export function save(cache, r) { fs.writeFileSync(regFile(cache), JSON.stringify(r, null, 1)); }
export function settings(cache) { return load(cache).settings; }
// CPU percentage limit for the engines: 70 normally, 50 in the light mode.
export function capOf(cache) { return settings(cache).cpu === 'light' ? 50 : 70; }
export function idleMsOf(cache) { const m = Number(settings(cache).idleMin); return m > 0 ? m * 60000 : 0; }
export function all(cache) { return CATALOG.concat(load(cache).custom.map((c) => Object.assign({ builtin: false, custom: true }, c))); }
// The model to use for a task: { id, name, model (full path), mm (full path or ''), files, builtin, cache }
// the larger translation model offered as "more accurate"
export const ACC_ID = 'hymt2-q8';
export function resolveId(cache, id) {
  const m = all(cache).find((x) => x.id === id); if (!m) return null; const d = llamaDir(cache);
  return Object.assign({}, m, { cache, model: m.files ? path.join(d, m.files[0].name) : m.file, mm: m.files && m.files[1] ? path.join(d, m.files[1].name) : (m.mm || '') });
}
export function resolve(cache, kind) {
  const r = load(cache), list = all(cache).filter((m) => m.kind === kind);
  let m = list.find((x) => x.id === r.active[kind]) || list[0]; const d = llamaDir(cache);
  // the chosen translation model is not downloaded, but the base HY-MT 2 is: use the one that is on this computer instead of starting a big download of an old choice
  if (kind === 'translate' && m.files && !have(cache, Object.assign({}, m, { model: path.join(d, m.files[0].name), mm: m.files[1] ? path.join(d, m.files[1].name) : '' }))) { const alt = list.find((x) => x.id === 'hymt2' && x.files && have(cache, Object.assign({}, x, { model: path.join(d, x.files[0].name), mm: '' }))); if (alt) m = alt; }
  if (m.engine === 'ppocr' && !m.files) return Object.assign({}, m, { cache, model: m.file, mm: '', dir: d });
  if (m.engine === 'ppocr' && m.files) return Object.assign({}, m, { cache, model: path.join(d, m.files[0].name), mm: '', dir: d });
  if (m.files) return Object.assign({}, m, { cache, model: path.join(d, m.files[0].name), mm: m.files[1] ? path.join(d, m.files[1].name) : '' });
  return Object.assign({}, m, { cache, model: m.file, mm: m.mm || '' });
}
// PaddleOCR: the files of the built-in bundle, and the spec the reader process starts from (a model added from this computer replaces the recognizer, and the detector if it came with one, of its script)
export const ppBase = () => CATALOG.find((m) => m.id === 'ppocr');
export function ppSpec(cache, m, threads) {
  const d = llamaDir(cache), f = (n) => path.join(d, n);
  const sp = { threads: Math.max(1, threads || 2), pipelines: {
    latin: { det: f('ppocrv6-small-det.onnx'), detYml: f('ppocrv6-small-det.yml'), rec: f('ppocrv6-small-rec.onnx'), recYml: f('ppocrv6-small-rec.yml') },
    latin5: { det: f('ppocrv5-mobile-det.onnx'), detYml: f('ppocrv5-mobile-det.yml'), rec: f('ppocrv5-latin-rec.onnx'), recYml: f('ppocrv5-latin-rec.yml') },
    arabic: { det: f('ppocrv5-mobile-det.onnx'), detYml: f('ppocrv5-mobile-det.yml'), rec: f('ppocrv5-arabic-rec.onnx'), recYml: f('ppocrv5-arabic-rec.yml'), reverse: true } } };
  if (m && m.custom && m.engine === 'ppocr') { const k = m.script === 'arabic' ? 'arabic' : 'latin', p = sp.pipelines[k]; p.rec = m.rec; p.recYml = m.recYml; if (m.det) { p.det = m.det; p.detYml = m.detYml; } if (k === 'latin') sp.pipelines.latin5 = p; }
  return sp;
}
export function have(cache, m) {
  try {
    if (m.engine === 'ppocr' && !m.files) return [m.rec, m.recYml, m.det, m.detYml].filter(Boolean).every((x) => fileOk(x)) && have(cache, ppBase());
    if (m.files) { const d = llamaDir(cache); return m.files.every((f) => fileOk(path.join(d, f.name), f.bytes)); }
    return fileOk(m.model) && (!m.mm || fileOk(m.mm));
  } catch (e) { return false; }
}
