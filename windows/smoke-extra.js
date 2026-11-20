// Build-server checks for the local AI manager (run only by the automatic self-test, LI_SMOKE=1).
// Everything here uses the real functions of the app: real downloads, real Windows processes, the real window.
const fs = require('fs'), path = require('path');
module.exports = async function (c) {
  const { res, win, wait, hqAsk, api } = c, x = (res.v319 = {});
  let ok = true; const okAdd = [];
  const need = (name, cond, extra) => { x[name] = extra === undefined ? !!cond : extra; if (!cond) { ok = false; (x.failed = x.failed || []).push(name); } };
  const R = await c.reg(), E = await c.eng(), M = c.models();
  const hq = async (tag, text, src, tgt) => { const t0 = Date.now(), m = await hqAsk(tag, text, src, tgt); return { kind: m.kind, text: m.text, engine: m.engine, sec: Math.round((Date.now() - t0) / 1000) }; };
  const SENT = ['Reading is the road to knowledge, and knowledge is the road to freedom.', 'en', 'ar'];

  // 1. the limiter exists and the numbers are real (from Windows), after the translation and reading done earlier
  const s1 = await api.aiState(); x.state1 = { sys: s1.sys, stats: s1.stats, settings: s1.settings };
  need('limiter_present', s1.sys.limiter);
  // a longer job so that several one-second samples exist
  const long = []; for (let i = 0; i < 6; i++) long.push('Knowledge grows when it is shared, and reading is the quiet way of sharing it.');
  const tl = await hq('long', long.join(' '), 'en', 'ar'); x.longTranslation = tl;
  const s2 = await api.aiState(); const t = s2.stats.translate; x.translateStats = t;
  need('stats_real', t && t.ws > 100 && t.peak >= t.ws && t.tasks > 0 && t.engine && t.cap > 0);
  need('cpu_cap_enforced_avg', t && t.capped && t.avg > 0 && t.avg <= 78, t ? { avg: t.avg, max: t.max, cap: t.cap, cores: s2.sys.cores } : null);
  need('cpu_variant_reported', !!(t && t.variant), t && t.variant);

  // 1b. the limit really holds: an engine forced to use 4 threads (more than this server has cores) is measured at 100 percent, then at 70 percent, by Windows itself
  try {
    const exe = await E.ensureLlama(M), mp = R.resolve(M, 'translate').model, cores = require('os').cpus().length; x.capTest = { cores };
    await api.aiUnload(); await wait(1500);
    for (const cap of [100, 70, 50]) {
      const srv = await E.startServer(exe, ['-m', mp, '-t', String(Math.max(4, cores * 2)), '-c', '1024'], null, { runner: c.runner(), cap: () => cap, unclamped: true, name: 'cap' + cap });
      E.sysLoad(); const sys = []; const tm = setInterval(() => sys.push(E.sysLoad()), 1000); const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        await srv.work(async () => { const r = await fetch('http://127.0.0.1:' + srv.port + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Translate the following segment into Arabic, without additional explanation.\n\nKnowledge grows when it is shared, and reading is the quiet way of sharing it. Knowledge grows when it is shared.' }], temperature: 0, max_tokens: 200 }) }); await r.json(); });
      }
      clearInterval(tm); const st = srv.stats(); srv.kill(); await wait(1500);
      const avgSys = sys.length ? Math.round(sys.reduce((a, b) => a + b, 0) / sys.length) : 0;
      x.capTest['cap' + cap] = { engineAvgBusy: st.avg, engineMax: st.max, systemWideAvg: avgSys, samples: sys.length, ws: st.ws, peak: st.peak, appliedCap: st.cap };
    }
    const c70 = x.capTest.cap70, c100 = x.capTest.cap100, c50 = x.capTest.cap50;
    need('cap70_holds', c70.engineAvgBusy <= 75 && c70.systemWideAvg <= 80, c70);
    need('cap50_holds', c50.engineAvgBusy <= 55, c50);
    need('cap_actually_limits', c100.engineAvgBusy > c70.engineAvgBusy + 8 || cores > 8, { uncapped: c100.engineAvgBusy, capped70: c70.engineAvgBusy });
  } catch (e) { need('cap_test', false, String(e && e.message || e)); }

  // 2. memory is given back after the idle time, the files stay, and the model loads again when needed
  await api.aiSet({ idleMin: 0.1 });
  await wait(30000);
  const s3 = await api.aiState(); x.afterIdle = s3.stats.translate;
  need('idle_unload', s3.stats.translate.state === 'stopped');
  need('files_kept_after_unload', s3.models.find((m) => m.id === 'hymt').have);
  await api.aiSet({ idleMin: 5 });
  const again = await hq('again', SENT[0], SENT[1], SENT[2]); x.reloaded = again;
  need('reload_after_unload', again.engine === 'hymt' && !!again.text);
  const u = await api.aiUnload(); const s4 = await api.aiState(); need('manual_unload', !u.busy && s4.stats.translate.state === 'stopped');

  // 3. download a catalog model (with stop and resume), check its fingerprint, run it, then delete it
  await api.aiDl('hymt-q6'); let paused = false, resumed = false, t0 = Date.now(), last = null;
  for (;;) {
    await wait(1500); const s = await api.aiState(), m = s.models.find((z) => z.id === 'hymt-q6'); last = m;
    if (m.have && !m.dl) break;
    if (!paused && m.dl && m.dl.state === 'downloading' && m.dl.pct >= 10) { await api.aiDlPause('hymt-q6'); paused = true; await wait(1500); const q = (await api.aiState()).models.find((z) => z.id === 'hymt-q6'); x.pausedState = q.dl && q.dl.state; need('download_pause', q.dl && q.dl.state === 'paused'); await api.aiDl('hymt-q6'); resumed = true; }
    if (m.dl && m.dl.state === 'error') { x.dlError = m.dl.err; break; }
    if (Date.now() - t0 > 8 * 60000) { x.dlTimeout = true; break; }
  }
  need('download_done', last && last.have && !last.dl, { paused, resumed, sec: Math.round((Date.now() - t0) / 1000) });
  if (last && last.have) {
    const v = await api.aiVerify('hymt-q6'); need('verify_ok', v.ok);
    await api.aiSelect('translate', 'hymt-q6');
    const q6 = await hq('q6', SENT[0], SENT[1], SENT[2]); x.q6 = q6;
    const sq = (await api.aiState()).stats.translate; x.q6Stats = sq;
    need('q6_runs', q6.engine === 'hymt' && !!q6.text, q6);
    await api.aiSelect('translate', 'hymt');
    await api.aiRemove('hymt-q6'); const left = fs.existsSync(path.join(E.llamaDir(M), 'HY-MT1.5-1.8B-Q6_K.gguf'));
    need('delete_download', !left && fs.existsSync(path.join(E.llamaDir(M), 'HY-MT1.5-1.8B-Q4_K_M.gguf')));
  }

  // 4. add a model from this computer: a real one (through a folder with an Arabic name), an unsupported one and a broken one
  const dir = E.llamaDir(M), ar = path.join(path.dirname(dir), 'نماذج عربية');
  try { fs.rmSync(ar, { force: true, recursive: true }); fs.symlinkSync(dir, ar, 'junction'); } catch (e) { x.junctionError = String(e); }
  const real = path.join(ar, 'HY-MT1.5-1.8B-Q4_K_M.gguf');
  const add = await c.addModel('translate', real, ''); x.addReal = add;
  need('add_real_model', add.ok);
  if (add.ok) {
    const r1 = await hq('custom', SENT[0], SENT[1], SENT[2]); x.customRun = r1;
    need('custom_model_runs_arabic_path', r1.engine === 'hymt' && !!r1.text);
    await api.aiRemove(add.id); need('custom_removed_files_kept', fs.existsSync(real) && !R.load(M).custom.some((m) => m.id === add.id));
  }
  const txt = path.join(dir, 'not-a-model.gguf'); fs.writeFileSync(txt, 'hello');
  const bad1 = await c.addModel('translate', txt, ''); need('reject_text_file', !bad1.ok && bad1.text === 'badfile', bad1);
  const fake = path.join(dir, 'fake.gguf'); const buf = Buffer.alloc(25 * 1048576); buf.write('GGUF'); fs.writeFileSync(fake, buf);
  const bad2 = await c.addModel('translate', fake, ''); need('reject_unrunnable_model', !bad2.ok && bad2.text === 'cannotload', bad2);
  for (const f of [txt, fake]) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  x.activeAfterAdd = R.load(M).active; need('active_restored', R.load(M).active.translate === 'hymt');

  // 5. old processors: only the engine variants for AVX-only (Sandy Bridge, like the Core i5 2nd generation) or SSE4.2 (1st generation) stay
  x.variants = {};
  for (const keep of ['sandybridge', 'sse42']) {
    try {
      await api.aiUnload(); await wait(1500);
      const bin = path.join(dir, 'bin'); const found = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/^ggml-cpu-.*\.dll$/i.test(f.name)) found.push(p); } })(bin);
      for (const p of found) if (!new RegExp('ggml-cpu-' + keep + '\\.dll$', 'i').test(p)) fs.renameSync(p, p + '.off');
      const r = await hq('v-' + keep, SENT[0], SENT[1], SENT[2]); const st = (await api.aiState()).stats.translate;
      x.variants[keep] = { engine: r.engine, text: r.text, sec: r.sec, variant: st.variant, cpu: st.cpu, max: st.max, peak: st.peak };
      await api.aiUnload(); await wait(1500);
      for (const p of found) { try { fs.renameSync(p + '.off', p); } catch (e) {} }
    } catch (e) { x.variants[keep] = { error: String(e && e.message || e) }; }
  }
  need('runs_on_avx_only_engine', x.variants.sandybridge && x.variants.sandybridge.engine === 'hymt');

  // 5b. new models against the current ones (reported; the defaults stay as they are)
  try { await require('./smoke-pp.js')(c); } catch (e) { x.ppError = String((e && e.stack) || e).slice(0, 500); }

  // 6. the models screen in the real window, in all six languages, and a language change while it is open
  const LANGS = ['ar', 'en', 'fr', 'es', 'it', 'id'], shots = x.screens = {};
  const js = (code) => win.webContents.executeJavaScript(code);
  const open = async () => { await js("(function(){var m=document.querySelector('#modal');if(m&&m.classList.contains('on')){var b=document.querySelector('#mxClose');if(b)b.click()}document.querySelector('#dSet').click()})()"); await wait(400); await js("document.querySelector('[data-sa=\"ai\"]').click()"); await wait(1800); };
  const snap = () => js("({dir:document.documentElement.dir,lang:document.documentElement.lang,text:document.querySelector('#box').innerText,open:!!window.__aiOpen,align:getComputedStyle(document.querySelector('#box')).direction})");
  const ARAB = /[؀-ۿ]/, LAT = /[A-Za-z]{3,}/g;
  const ENG = /\b(Download|Installed|Available|Delete|Details|Working|Stopped|Never|Automatic|Verify files|Remove from|Free memory|Unload|Tested|Not tested|Downloading|Verifying|Loading)\b/;
  const okWords = new Set(['llama', 'cpp', 'HY', 'MT', 'Tencent', 'Nuqta', 'OCR', 'CPU', 'RAM', 'AVX', 'SSE', 'Apache', 'MIT', 'Community', 'License', 'GB', 'MB', 'sandybridge', 'haswell', 'huggingface', 'com', 'Hugging', 'Face', 'ggml']);
  for (const m of R.CATALOG) (m.name + ' ' + m.repo + ' ' + m.license + ' ' + m.quant + ' ' + (m.version || '')).split(/[^A-Za-z]+/).forEach((w) => okWords.add(w));
  for (const l of LANGS) {
    await js("(function(){var m=document.querySelector('#modal');if(m&&m.classList.contains('on')){var b=document.querySelector('#mxClose');if(b)b.click()}document.querySelector('#dLang').click()})()"); await wait(400);
    await js("document.querySelector('[data-lg=\"" + l + "\"]').click()"); await wait(900);
    await open(); const s = await snap(); const lat = (s.text.match(LAT) || []).filter((w) => !okWords.has(w));
    shots[l] = { dir: s.dir, lang: s.lang, chars: s.text.length, sample: s.text.slice(0, 160), latin: l === 'ar' ? lat.slice(0, 20) : undefined };
    need('lang_' + l + '_dir', s.dir === (l === 'ar' ? 'rtl' : 'ltr') && s.lang === l && s.align === (l === 'ar' ? 'rtl' : 'ltr'));
    need('lang_' + l + '_text', s.text.length > 300 && s.open);
    if (l === 'ar') need('lang_ar_no_english_words', lat.filter((w) => !/^(Q\d.*|[A-Z]{2,5})$/.test(w)).length === 0, lat.slice(0, 20));
    else { need('lang_' + l + '_no_arabic', !ARAB.test(s.text)); if (l !== 'en') need('lang_' + l + '_no_english_leftovers', !ENG.test(s.text), (s.text.match(ENG) || [])[0] || ''); }
  }
  // change the language while the screen is open: it must redraw in the new language right away
  await js("document.querySelector('#dLang').click()"); await wait(300); await js("document.querySelector('[data-lg=\"en\"]').click()"); await wait(700); await open();
  const before = await snap();
  for (const l of ['id', 'ar', 'fr']) { await js("window.__liLang('" + l + "')"); await wait(1500); const s = await snap(); shots['live_' + l] = { dir: s.dir, sample: s.text.slice(0, 80) }; need('live_switch_' + l, s.open && s.text !== before.text && s.dir === (l === 'ar' ? 'rtl' : 'ltr') && (l === 'ar' ? ARAB.test(s.text) : !ARAB.test(s.text))); }
  await js("window.__liLang('ar')"); await wait(800);
  return ok;
};
