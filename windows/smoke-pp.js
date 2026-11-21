// Build-server comparison of the new models with the current ones, through the same paths the app uses.
// Reads real drawn pages (Arabic, English, Indonesian, French, mixed; clean and degraded) and translates real sentences.
// Numbers are reported (accuracy, seconds, CPU and memory as Windows measures them); nothing here changes the defaults.
const fs = require('fs'), path = require('path');
const { PAGES, JOBS, DRAW, cer } = require('./pp-testdata.js');

const chrf = require('./pp-testdata.js').chrf;
const SENT = [
  ['A good book is a quiet friend that never asks for anything in return.', 'en', 'ar', 'الكتاب الجيد صديق هادئ لا يطلب شيئًا في المقابل.'],
  ['القراءة كل يوم تصنع فرقًا كبيرًا بعد سنة كاملة.', 'ar', 'en', 'Reading every day makes a big difference after a whole year.'],
  ['Knowledge grows when it is shared.', 'en', 'fr', 'Le savoir grandit quand il est partagé.'],
  ['Un bon livre est un ami silencieux.', 'fr', 'es', 'Un buen libro es un amigo silencioso.'],
  ['La lectura abre las puertas de la imaginación.', 'es', 'id', 'Membaca membuka pintu imajinasi.'],
  ['Buku adalah jendela dunia.', 'id', 'it', 'I libri sono la finestra sul mondo.'],
  ['La pazienza è la chiave di ogni successo.', 'it', 'ar', 'الصبر مفتاح كل نجاح.'],
  ['Ideas stay alive when people use them.', 'en', 'id', 'Gagasan tetap hidup ketika orang menggunakannya.']
];
module.exports = async function (c) {
  const { res, win, wait, hqAsk, api } = c, x = (res.v320 = { ocr: {}, tr: {} });
  const js = (code) => win.webContents.executeJavaScript(code);
  const R = await c.reg(), M = c.models();
  const orig = (await api.aiState()); const act = JSON.parse(JSON.stringify(R.load(M).active));
  // ---- A. reading pages: current reader (Nuqta) against PaddleOCR ----
  try {
    await js(DRAW);
    const dl = async (id, limitMin) => { await api.aiDl(id); const t0 = Date.now(); for (;;) { await wait(2000); const m = (await api.aiState()).models.find((z) => z.id === id); if (m.have && !m.dl) return { ok: true, sec: Math.round((Date.now() - t0) / 1000) }; if (m.dl && m.dl.state === 'error') return { ok: false, err: m.dl.err }; if (Date.now() - t0 > limitMin * 60000) return { ok: false, err: 'timeout' }; } };
    x.ocr.ppDownload = await dl('ppocr', 6);
    const imgs = {}; for (const [k, v] of JOBS) imgs[k + '_' + v] = await js('window.__mkPage(' + JSON.stringify(PAGES[k]) + ',' + (k === 'ar') + ',' + (v === 'deg') + ')');
    try { fs.mkdirSync(path.join(M, 'smoke-pages'), { recursive: true }); for (const k in imgs) fs.writeFileSync(path.join(M, 'smoke-pages', k + '.png'), Buffer.from(imgs[k].split(',')[1], 'base64')); } catch (e) {}
    const runEngine = async (id, tag, budgetMs) => {
      await api.aiSelect('ocr', id); await wait(1500);
      const out = x.ocr[tag] = { pages: {} }, t0 = Date.now();
      const prep = await js('(async()=>{const p=await window.liDesk.ocrPrep();return p.kind+(p.text||"")})()'); out.prep = prep;
      out.loadSec = Math.round((Date.now() - t0) / 1000);
      let sum = 0, n = 0;
      for (const [k, v] of JOBS) {
        if (Date.now() - t0 > budgetMs) { out.pages[k + '_' + v] = { skipped: 'time budget' }; continue; }
        const key = k + '_' + v, ref = PAGES[k].join(' '), s0 = Date.now();
        const r = await js('(async()=>{const r=await window.liDesk.ocrPage(' + JSON.stringify(imgs[key]) + ');return {kind:r.kind,text:r.text}})()');
        const sec = Math.round((Date.now() - s0) / 100) / 10, e = cer(ref, r.text);
        out.pages[key] = { kind: r.kind, sec, cer: r.kind === 'ok' ? e : null, text: String(r.text || '').slice(0, 400) };
        if (r.kind === 'ok') { sum += e; n++; }
      }
      out.meanCER = n ? Math.round(sum / n * 10) / 10 : null; out.pagesDone = n;
      const st = (await api.aiState()).stats.ocr; out.stats = st;
    };
    await runEngine('ppocr', 'pp', 6 * 60000);
    // the same pages again with the reader told which script it is (checks the script routing)
    try { const pp = x.ocr.pp.pages, r2 = {}; for (const key of ['ar_clean', 'en_clean', 'id_clean', 'mixed_clean']) { const k = key.split('_')[0], r = await js('(async()=>{const r=await window.liDesk.ocrPage(' + JSON.stringify(imgs[key]) + ',' + JSON.stringify(k === 'ar' || k === 'mixed' ? 'ar' : 'latin') + ');return {kind:r.kind,text:r.text}})()'); r2[key] = { forced: k === 'ar' || k === 'mixed' ? 'ar' : 'latin', cer: r.kind === 'ok' ? cer(PAGES[k].join(' '), r.text) : null, auto: pp[key] && pp[key].cer }; } x.ocr.ppForced = r2; } catch (e) { x.ocr.ppForcedError = String(e && e.message || e); }
    await runEngine('nuqta', 'nuqta', 14 * 60000);
    const a = x.ocr.pp, b = x.ocr.nuqta; x.ocr.compare = {};
    for (const [k, v] of JOBS) { const key = k + '_' + v; x.ocr.compare[key] = { pp: a.pages[key] && a.pages[key].cer, nuqta: b.pages[key] && b.pages[key].cer, ppSec: a.pages[key] && a.pages[key].sec, nuqtaSec: b.pages[key] && b.pages[key].sec }; }
    await api.aiSelect('ocr', act.ocr || 'nuqta');
  } catch (e) { x.ocr.error = String((e && e.stack) || e).slice(0, 600); try { await api.aiSelect('ocr', act.ocr || 'nuqta'); } catch (e2) {} }

  // ---- B. translation: HY-MT 1.5 (current) against HY-MT 2, same sentences, same path ----
  try {
    const hq = async (tag, text, src, tgt) => { const t0 = Date.now(), m = await hqAsk(tag, text, src, tgt); return { kind: m.kind, text: m.text, engine: m.engine, sec: Math.round((Date.now() - t0) / 100) / 10 }; };
    await api.aiDl('hymt2'); const t0 = Date.now(); let got = false;
    for (;;) { await wait(2000); const m = (await api.aiState()).models.find((z) => z.id === 'hymt2'); if (m.have && !m.dl) { got = true; break; } if (m.dl && m.dl.state === 'error') { x.tr.dlError = m.dl.err; break; } if (Date.now() - t0 > 8 * 60000) { x.tr.dlError = 'timeout'; break; } }
    x.tr.download = { ok: got, sec: Math.round((Date.now() - t0) / 1000) };
    if (got) {
      const V = (await api.aiVerify('hymt2')); x.tr.verify = V.ok;
      for (const [id, tag] of [['hymt', 'mt15'], ['hymt2', 'mt2']]) {
        await api.aiSelect('translate', id); await wait(1500);
        const o = x.tr[tag] = { items: [] }; let sum = 0, n = 0, secs = 0, ai = 0;
        for (let i = 0; i < SENT.length; i++) {
          const [text, s, t, ref] = SENT[i], r = await hq(tag + i, text, s, t), score = r.kind === 'ok' ? chrf(ref, r.text) : null;
          o.items.push({ pair: s + '>' + t, engine: r.engine, sec: r.sec, chrf: score, out: String(r.text || '').slice(0, 160) });
          if (score != null) { sum += score; n++; } secs += r.sec; if (r.engine === 'hymt') ai++;
        }
        o.meanChrF = n ? Math.round(sum / n * 10) / 10 : null; o.totalSec = Math.round(secs * 10) / 10; o.byAiEngine = ai; o.stats = (await api.aiState()).stats.translate;
      }
      await api.aiSelect('translate', act.translate || 'hymt');
    }
  } catch (e) { x.tr.error = String((e && e.stack) || e).slice(0, 600); try { await api.aiSelect('translate', act.translate || 'hymt'); } catch (e2) {} }

  // ---- C. adding PaddleOCR folders from this computer (an Arabic path, recognizer + detector together) ----
  try {
    const d = path.join(require('os').tmpdir(), 'مجلد اختبار'), R2 = await c.reg(), E2 = await c.eng(), L = E2.llamaDir(M), a = x.add = {};
    const mk = (n, o, y) => { const q = path.join(d, n); fs.mkdirSync(q, { recursive: true }); fs.copyFileSync(path.join(L, o), path.join(q, 'inference.onnx')); fs.copyFileSync(path.join(L, y), path.join(q, 'inference.yml')); return q; };
    const rec = mk('rec', 'ppocrv5-latin-rec.onnx', 'ppocrv5-latin-rec.yml'), det = mk('det', 'ppocrv6-small-det.onnx', 'ppocrv6-small-det.yml'), bad = path.join(d, 'bad'); fs.mkdirSync(bad, { recursive: true }); fs.writeFileSync(path.join(bad, 'inference.onnx'), 'not a model'); fs.writeFileSync(path.join(bad, 'inference.yml'), 'a: 1');
    a.bad = (await api.aiAddPP([bad])).text; a.two = (await api.aiAddPP([rec, rec])).text;
    const r = await api.aiAddPP([rec, det]); a.ok = r.ok; a.err = r.text;
    if (r.ok) {
      const img = await js('window.__mkPage(' + JSON.stringify(PAGES.fr) + ',false,false)'), o = await js('(async()=>{const r=await window.liDesk.ocrPage(' + JSON.stringify(img) + ',"latin");return {kind:r.kind,text:r.text}})()');
      a.cer = o.kind === 'ok' ? cer(PAGES.fr.join(' '), o.text) : null; await api.aiRemove(r.id); a.removed = !R2.load(M).custom.some((z) => z.id === r.id); a.activeAfter = R2.load(M).active.ocr;
    }
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
  } catch (e) { x.add = { error: String((e && e.stack) || e).slice(0, 400) }; }
  return true;
};
