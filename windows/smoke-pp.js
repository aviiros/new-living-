// Build-server comparison of the new models with the current ones, through the same paths the app uses.
// Reads real drawn pages (Arabic, English, Indonesian, French, mixed; clean and degraded) and translates real sentences.
// Numbers are reported (accuracy, seconds, CPU and memory as Windows measures them); nothing here changes the defaults.
const fs = require('fs'), path = require('path');
const lev = (a, b) => { const m = a.length, n = b.length; if (!m) return n; if (!n) return m; let p = Array.from({ length: n + 1 }, (_, j) => j), c = new Array(n + 1); for (let i = 1; i <= m; i++) { c[0] = i; for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); [p, c] = [c, p]; } return p[n]; };
const norm = (s) => String(s || '').replace(/[#*_`>|\-]/g, '').replace(/[ً-ْـ]/g, '').replace(/[’‘]/g, "'").replace(/\s+/g, '').toLowerCase();
const cer = (ref, got) => { const a = norm(ref), b = norm(got); return a.length ? Math.round(lev(a, b) / a.length * 1000) / 10 : 0; };
// chrF (character n-grams 1..6, recall weighted twice as much as precision), 0..100
const chrf = (ref, hyp) => { const r = norm(ref), h = norm(hyp); let f = 0, k = 0; for (let n = 1; n <= 6; n++) { const gr = {}, gh = {}; for (let i = 0; i + n <= r.length; i++) gr[r.substr(i, n)] = (gr[r.substr(i, n)] || 0) + 1; for (let i = 0; i + n <= h.length; i++) gh[h.substr(i, n)] = (gh[h.substr(i, n)] || 0) + 1; let ov = 0, tr = 0, th = 0; for (const g in gr) { tr += gr[g]; ov += Math.min(gr[g], gh[g] || 0); } for (const g in gh) th += gh[g]; if (!tr || !th) continue; const P = ov / th, Rr = ov / tr; f += (P + Rr) ? 5 * P * Rr / (4 * P + Rr) : 0; k++; } return k ? Math.round(f / k * 1000) / 10 : 0; };
const PAGES = {
  ar: ['الفصل الثالث: قوة العادات', 'تتشكل حياتنا من عادات صغيرة نكررها كل يوم دون أن نشعر بها.', 'وحين نغير عادة واحدة فقط، تبدأ بقية الأمور في التغير تدريجيًا.', 'يقول الحكماء إن الطريق الطويل يبدأ بخطوة واحدة صغيرة وثابتة.', 'القراءة كل يوم لمدة عشر دقائق تصنع فرقًا كبيرًا بعد سنة كاملة.', 'ومن لا يقرأ اليوم فلن يجد غدًا ما يقوله لأبنائه عن حكمة الأيام.'],
  en: ['Chapter 3: The Power of Habits', 'Our lives are built from small habits that we repeat every day without noticing.', 'When a single habit changes, the rest of life slowly begins to change with it.', 'Reading for ten minutes each day makes a remarkable difference after one year.', 'A good book is a quiet friend that never asks for anything in return.', 'Knowledge grows when it is shared, and ideas stay alive when they are used.'],
  id: ['Bab 3: Kekuatan Kebiasaan', 'Hidup kita dibentuk oleh kebiasaan kecil yang kita ulangi setiap hari tanpa sadar.', 'Ketika satu kebiasaan berubah, bagian kehidupan lainnya perlahan ikut berubah.', 'Membaca selama sepuluh menit setiap hari membuat perbedaan besar setelah satu tahun.', 'Buku yang baik adalah teman yang tenang dan tidak pernah meminta imbalan.', 'Pengetahuan tumbuh ketika dibagikan, dan gagasan tetap hidup ketika digunakan.'],
  fr: ['Chapitre 3 : La puissance des habitudes', 'Notre vie est faite de petites habitudes que nous répétons chaque jour sans le remarquer.', 'Quand une seule habitude change, le reste de l’existence commence peu à peu à changer.', 'Lire dix minutes par jour fait une différence remarquable après une année entière.', 'Un bon livre est un ami silencieux qui ne demande jamais rien en échange.', 'Le savoir grandit quand il est partagé, et les idées vivent quand on les utilise.'],
  mixed: ['القراءة بوابة المعرفة وطريق الحرية.', 'Reading is a conversation across time.', 'ومن يقرأ كثيرًا يفهم الحياة بعمق أكبر.', 'Knowledge grows when it is shared.']
};
const JOBS = [['ar', 'clean'], ['ar', 'deg'], ['en', 'clean'], ['en', 'deg'], ['id', 'clean'], ['id', 'deg'], ['fr', 'clean'], ['mixed', 'clean']];
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
// draws one page in the app window and returns it as a PNG data URL
const DRAW = `window.__mkPage=function(lines,rtl,deg){var W=1100,pad=60,sz=deg?24:32;var m0=document.createElement('canvas').getContext('2d');m0.font=sz+'px Tahoma, Arial';var mw=0;lines.forEach(function(t){mw=Math.max(mw,m0.measureText(t).width)});if(mw>W-2*pad)sz=Math.floor(sz*(W-2*pad)/mw)-1;var lh=sz*2.1,H=Math.max(420,pad*2+lines.length*lh+40),cv=document.createElement('canvas');cv.width=W;cv.height=H;var c=cv.getContext('2d');c.fillStyle=deg?'#e4dfd2':'#fff';c.fillRect(0,0,W,H);c.fillStyle=deg?'#3a3a3a':'#000';c.textBaseline='top';
lines.forEach(function(t,i){var big=i===0&&lines.length>4;c.font=(big?'bold ':'')+(big?sz+6:sz)+'px Tahoma, Arial';var arab=/[\\u0600-\\u06ff]/.test(t);c.direction=arab?'rtl':'ltr';c.textAlign=arab?'right':'left';c.fillText(t,arab?W-pad:pad,pad+i*lh)});
if(deg){var o=document.createElement('canvas');o.width=W*0.7;o.height=H*0.7;var q=o.getContext('2d');q.filter='blur(0.6px)';q.drawImage(cv,0,0,o.width,o.height);var d=document.createElement('canvas');d.width=W;d.height=H;var e=d.getContext('2d');e.drawImage(o,0,0,W,H);var im=e.getImageData(0,0,W,H),p=im.data,s=7;for(var k=0;k<p.length;k+=4){var n=(Math.random()-0.5)*40;p[k]+=n;p[k+1]+=n;p[k+2]+=n}e.putImageData(im,0,0);return d.toDataURL('image/png')}
return cv.toDataURL('image/png')};true`;
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
