// Reading dock for every ordinary book (converted PDF/Word, EPUB, translated copies):
// continuous listening, guided reading, page ("book") mode and typography.
// Injected after reader.js into the book frame. Template books (their own engine) are left alone.
(function () {
  'use strict';
  var LI = window.__LI || {}; if (LI.tpl) return;
  var D = document, root = D.documentElement;
  var P = function (m) { m.liBook = 1; try { parent.postMessage(m, '*'); } catch (e) {} };
  var T = function (a, e) { try { if (parent && typeof parent.T === 'function') return parent.T(a, e); } catch (x) {} return (LI.ui || 'ar') === 'ar' ? a : e; };
  var GS = null; try { GS = parent.localStorage; } catch (e) {}
  var G = {}; try { G = JSON.parse(GS.getItem('li-dock') || '{}') || {}; } catch (e) {}
  function saveG() { try { GS.setItem('li-dock', JSON.stringify(G)); } catch (e) {} }
  function bget(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function bset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function SSf() { return window.speechSynthesis; }
  var RD = function () { return window.__liRd || {}; };

  // ---------- styles ----------
  var css = D.createElement('style'); css.id = 'li-dock-css';
  css.textContent = [
    '.li-dock{position:fixed;left:50%;bottom:calc(10px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:2147483001;display:flex;gap:2px;background:rgba(251,247,236,.97);color:#14262e;border:1px solid #d9cdb0;border-radius:26px;box-shadow:0 6px 22px rgba(0,0,0,.26);padding:4px 6px;font:13px "Segoe UI",Tahoma,sans-serif;direction:ltr;transition:opacity .25s,transform .25s}',
    '.li-dock.min{opacity:.0;pointer-events:none;transform:translateX(-50%) translateY(14px)}',
    '.li-dock button,.li-pn button,.li-pn select{font:inherit;color:inherit;border:0;background:transparent;cursor:pointer}',
    '.li-dock>button{width:42px;height:40px;border-radius:20px;display:flex;align-items:center;justify-content:center}',
    '.li-dock>button.on{background:#14262e;color:#fbf7ec}.li-dock svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
    '.li-handle{position:fixed;left:50%;bottom:0;transform:translateX(-50%);z-index:2147483000;width:64px;height:18px;opacity:.0}',
    '.li-pn{position:fixed;left:50%;bottom:calc(66px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:2147483001;width:min(94vw,420px);max-height:60vh;overflow:auto;background:#fbf7ec;color:#14262e;border:1px solid #d9cdb0;border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,.3);padding:12px;font:13px "Segoe UI",Tahoma,sans-serif;display:none}',
    '.li-pn.on{display:block}.li-pn h4{margin:10px 0 6px;font-size:12px;opacity:.7;font-weight:600}.li-pn h4:first-child{margin-top:0}',
    '.li-pn .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.li-pn .row.c{justify-content:center}',
    '.li-pn .ch{padding:7px 11px;border-radius:14px;border:1px solid #d9cdb0;background:#fff}.li-pn .ch.on{background:#14262e;color:#fbf7ec;border-color:#14262e}',
    '.li-pn .big{width:46px;height:46px;border-radius:23px;background:#14262e;color:#fbf7ec;display:flex;align-items:center;justify-content:center}',
    '.li-pn .big svg,.li-pn .sm svg{width:22px;height:22px;fill:currentColor;stroke:none}',
    '.li-pn .sm{width:40px;height:40px;border-radius:20px;border:1px solid #d9cdb0;background:#fff;display:flex;align-items:center;justify-content:center}',
    '.li-pn select{width:100%;padding:8px;border:1px solid #d9cdb0;border-radius:10px;background:#fff}',
    '.li-pn .hint{font-size:12px;opacity:.75;line-height:1.5;margin-top:6px}.li-pn input[type=range]{width:100%}',
    '.li-speak{background:rgba(255,196,64,.34)!important;box-shadow:0 0 0 4px rgba(255,196,64,.34)!important;border-radius:4px}',
    '.li-ms{position:fixed;left:0;right:0;z-index:2147482990;background:rgba(10,14,18,.62);touch-action:pan-y}',
    '.li-pg{position:fixed;left:50%;bottom:calc(58px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:2147482990;font:12px "Segoe UI",Tahoma,sans-serif;background:rgba(20,38,46,.8);color:#fff;padding:2px 10px;border-radius:10px;pointer-events:none}',
    'html.li-paged{overflow:hidden!important;height:100%!important}',
    'html.li-paged body{margin:0!important;height:100%!important;box-sizing:border-box!important;column-fill:auto!important;overflow:hidden!important;max-width:none!important;width:auto!important;position:static!important}',
    'html.li-paged body img,html.li-paged body svg,html.li-paged body video,html.li-paged body table{max-width:100%!important;max-height:86%!important;object-fit:contain;break-inside:avoid}',
    'html.li-paged body p,html.li-paged body li,html.li-paged body blockquote{orphans:2;widows:2}'
  ].join('\n');
  D.head.appendChild(css);

  var ICON = {
    listen: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 010 7"/><path d="M19 6a8.5 8.5 0 010 12"/></svg>',
    guide: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 18h16"/><rect x="4" y="10" width="16" height="4" rx="1"/></svg>',
    book: '<svg viewBox="0 0 24 24"><path d="M12 6c-2-1.5-5-2-8-1.5V18c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V4.5C17 4 14 4.5 12 6z"/><path d="M12 6v13.5"/></svg>',
    fmt: '<svg viewBox="0 0 24 24"><path d="M4 19l5.5-14L15 19M6 14h7"/><path d="M17 8h4M19 8v11"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>', pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>', prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>', next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 6l8 10H4z"/></svg>', down: '<svg viewBox="0 0 24 24"><path d="M12 18L4 8h16z"/></svg>'
  };

  // ---------- helpers ----------
  var SEL = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,dd,dt,figcaption,pre,td,th';
  var units = [];
  function ctext(e) { return (e.textContent || '').replace(/\s+/g, ' ').trim(); }
  function nwords(t) { return t ? t.split(/\s+/).filter(Boolean).length : 0; }
  function collect() {
    units = [].filter.call(D.body.querySelectorAll(SEL), function (e) { return !e.closest('.li-ui,script,style,nav,#li-tr-ui,.li-dock,.li-pn') && !e.querySelector(SEL) && ctext(e).length > 1; });
    if (units.length < 3) units = [].filter.call(D.body.querySelectorAll('div,section,article'), function (e) { if (e.closest('.li-ui,.li-dock,.li-pn,#li-tr-ui') || e.querySelector(SEL + ',div')) return false; return ctext(e).length > 1; });
    return units;
  }
  function visible(e) { var r = e.getBoundingClientRect(); return r.bottom > 40 && r.top < innerHeight - 70 && r.right > 0 && r.left < innerWidth; }
  function firstVisible() { collect(); for (var i = 0; i < units.length; i++) if (visible(units[i])) return i; return 0; }
  function isRtl() { try { return getComputedStyle(D.body).direction === 'rtl'; } catch (e) { return false; } }
  function btn(h, cls, id) { return '<button' + (id ? ' id="' + id + '"' : '') + (cls ? ' class="' + cls + '"' : '') + '>' + h + '</button>'; }

  // ---------- dock + panels ----------
  var dock = D.createElement('div'); dock.className = 'li-ui li-dock';
  dock.innerHTML = btn(ICON.listen, '', 'dkL').replace('<button', '<button aria-label="' + T('استماع', 'Listen') + '" title="' + T('استماع', 'Listen') + '"') +
    btn(ICON.guide, '', 'dkG').replace('<button', '<button aria-label="' + T('القراءة الموجهة', 'Guided reading') + '" title="' + T('القراءة الموجهة', 'Guided reading') + '"') +
    btn(ICON.book, '', 'dkB').replace('<button', '<button aria-label="' + T('وضع الكتاب', 'Book mode') + '" title="' + T('وضع الكتاب', 'Book mode') + '"') +
    btn(ICON.fmt, '', 'dkF').replace('<button', '<button aria-label="' + T('التنسيق', 'Formatting') + '" title="' + T('التنسيق', 'Formatting') + '"');
  var pn = D.createElement('div'); pn.className = 'li-ui li-pn'; pn.setAttribute('dir', (LI.ui || 'ar') === 'ar' ? 'rtl' : 'ltr');
  var handle = D.createElement('div'); handle.className = 'li-ui li-handle';
  function mount() { D.body.appendChild(dock); D.body.appendChild(pn); D.body.appendChild(handle); }
  var cur = '', hideT = null;
  function wake() { dock.classList.remove('min'); clearTimeout(hideT); hideT = setTimeout(function () { if (!cur && !S.on && !GD.on) dock.classList.add('min'); }, 4500); }
  ['touchstart', 'mousemove', 'keydown', 'click'].forEach(function (e) { addEventListener(e, function (ev) { if (e === 'mousemove' && ev.clientY < innerHeight - 140) return; wake(); }, { passive: true, capture: true }); });
  handle.addEventListener('click', wake); handle.addEventListener('touchstart', wake, { passive: true });
  function open(name) { cur = cur === name ? '' : name; render(); wake(); }
  function render() {
    ['L', 'G', 'B', 'F'].forEach(function (k) { dock.querySelector('#dk' + k).classList.toggle('on', cur === k || (k === 'L' && S.on) || (k === 'G' && GD.on) || (k === 'B' && PG.on)); });
    pn.classList.toggle('on', !!cur); if (!cur) return;
    pn.innerHTML = cur === 'L' ? panelL() : cur === 'G' ? panelG() : cur === 'B' ? panelB() : panelF();
  }
  dock.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; if (b.id === 'dkL') open('L'); else if (b.id === 'dkG') open('G'); else if (b.id === 'dkB') open('B'); else if (b.id === 'dkF') open('F'); });
  pn.addEventListener('click', function (e) { var b = e.target.closest('[data-a]'); if (!b) return; act(b.dataset.a, b.dataset.v); });
  pn.addEventListener('change', function (e) { var s = e.target.closest('[data-a]'); if (s) act(s.dataset.a, s.value); });
  pn.addEventListener('input', function (e) { var s = e.target.closest('input[data-a]'); if (s) act(s.dataset.a, s.value); });
  var chip = function (a, v, label, on) { return '<button class="ch' + (on ? ' on' : '') + '" data-a="' + a + '" data-v="' + v + '">' + label + '</button>'; };

  // ---------- listening ----------
  var S = { on: false, paused: false, i: 0, k: 0, tok: 0, stop: Infinity };
  function chunks(t) {
    var out = [], re = /[^.!?؟۔…\n]+[.!?؟۔…]*\s*/g, m, cur2 = '';
    while ((m = re.exec(t))) { var s = m[0]; while (s.length > 240) { var cut = s.lastIndexOf(' ', 220); if (cut < 80) cut = 220; if (cur2) { out.push(cur2); cur2 = ''; } out.push(s.slice(0, cut)); s = s.slice(cut); } if ((cur2 + s).length > 220 && cur2) { out.push(cur2); cur2 = s; } else cur2 += s; }
    if (cur2.trim()) out.push(cur2); return out.length ? out : [t];
  }
  function voices() { try { return SSf() ? SSf().getVoices() || [] : []; } catch (e) { return []; } }
  function langOf(t) { return /[؀-ۿ]/.test(t) ? 'ar' : ((root.getAttribute('lang') || 'en').slice(0, 2).toLowerCase()); }
  function voiceFor(lang) {
    var vs = voices().filter(function (v) { return (v.lang || '').toLowerCase().indexOf(lang) === 0; }); if (!vs.length) return null;
    var pick = G.voice && vs.filter(function (v) { return v.name === G.voice; })[0]; if (pick) return pick;
    vs.sort(function (a, b) { var sa = (/natural|online/i.test(a.name) ? 2 : 0) + (a.localService ? 1 : 0), sb = (/natural|online/i.test(b.name) ? 2 : 0) + (b.localService ? 1 : 0); return sb - sa; }); return vs[0];
  }
  function mark(el) { [].forEach.call(D.querySelectorAll('.li-speak'), function (x) { x.classList.remove('li-speak'); }); if (el) { el.classList.add('li-speak'); if (GD.on && GD.voice) { var ix = units.indexOf(el); if (ix >= 0 && (ix !== GD.i || GD.off)) { GD.i = ix; GD.off = 0; gShow(); } } else reveal(el); } }
  function reveal(el) {
    if (PG.on) { PG.toEl(el); return; }
    var r = el.getBoundingClientRect(); if (r.top < 70 || r.bottom > innerHeight - 130) { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); } }
  }
  function speakUnit(i, k0) {
    if (!SSf()) { S.on = false; render(); return; }
    if (i >= units.length || i > S.stop) { return endSpeak(true); }
    S.i = i; var el = units[i], t = ctext(el), lang = langOf(t), cs = chunks(t), tok = ++S.tok; mark(el); var n = k0 || 0;
    (function next() {
      if (tok !== S.tok || !S.on) return;
      if (n >= cs.length) { bset('li-spk', String(i + 1)); return speakUnit(i + 1, 0); }
      S.k = n; var u = new SpeechSynthesisUtterance(cs[n++]); u.lang = lang === 'ar' ? 'ar-SA' : lang; u.rate = G.rate || 1; var v = voiceFor(lang); if (v) { u.voice = v; u.lang = v.lang; }
      u.onend = function () { if (tok === S.tok && S.on) next(); };
      u.onerror = function (e) { if (e && (e.error === 'interrupted' || e.error === 'canceled')) return; if (tok === S.tok && S.on) next(); };
      try { SSf().speak(u); } catch (e) { endSpeak(); }
    })();
  }
  function cancelSpeech() { try { SSf() && SSf().cancel(); } catch (e) {} }
  function endSpeak(done) { S.on = false; S.paused = false; S.tok++; cancelSpeech(); mark(null); if (done) bset('li-spk', '0'); render(); }
  function startSpeak(from) {
    if (!SSf()) { alert(T('القراءة الصوتية غير متاحة على هذا الجهاز', 'Text to speech is not available on this device')); return; }
    collect(); if (!units.length) return; if (GD.on && !GD.voice) stopGuide(); S.stop = Infinity;
    if (G.scope === 'ch') { var h = null; for (var j = from + 1; j < units.length; j++) if (/^H[1-3]$/.test(units[j].tagName)) { h = j; break; } if (h) S.stop = h - 1; }
    S.on = true; S.paused = false; cancelSpeech(); speakUnit(from, 0); render(); wake();
  }
  function selUnit() { var s = getSelection(); if (!s || s.isCollapsed || !s.anchorNode) return -1; collect(); var n = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement; for (var i = 0; i < units.length; i++) if (units[i] === n || units[i].contains(n)) return i; return -1; }
  function panelL() {
    var rates = [0.75, 1, 1.25, 1.5, 1.75], saved = parseInt(bget('li-spk') || '0', 10) || 0, lang = langOf(units.length ? ctext(units[0]) : (root.lang || 'en')), vs = voices().filter(function (v) { return (v.lang || '').toLowerCase().indexOf(lang) === 0; });
    var h = '<h4>' + T('الاستماع', 'Listen') + '</h4><div class="row c">' + btn(ICON.prev, 'sm', '') .replace('<button', '<button data-a="sprev" aria-label="' + T('السابق', 'Previous') + '"') + btn(S.on && !S.paused ? ICON.pause : ICON.play, 'big', '').replace('<button', '<button data-a="splay" aria-label="' + T('تشغيل / إيقاف مؤقت', 'Play / pause') + '"') + btn(ICON.next, 'sm', '').replace('<button', '<button data-a="snext" aria-label="' + T('التالي', 'Next') + '"') + btn(ICON.stop, 'sm', '').replace('<button', '<button data-a="sstop" aria-label="' + T('إيقاف', 'Stop') + '"') + '</div>';
    if (saved > 0 && !S.on) h += '<div class="row c" style="margin-top:8px">' + chip('sresume', '1', T('استئناف من آخر نقطة', 'Resume where I stopped'), false) + chip('sfromsel', '1', T('من النص المحدد / الظاهر', 'From selection / screen'), false) + '</div>';
    h += '<h4>' + T('السرعة', 'Speed') + '</h4><div class="row">' + rates.map(function (r) { return chip('srate', r, r + '×', (G.rate || 1) === r); }).join('') + '</div>';
    h += '<h4>' + T('المدى', 'Scope') + '</h4><div class="row">' + chip('sscope', 'all', T('حتى نهاية الكتاب', 'To the end of the book'), G.scope !== 'ch') + chip('sscope', 'ch', T('هذا الفصل فقط', 'This chapter only'), G.scope === 'ch') + '</div>';
    h += '<h4>' + T('الصوت', 'Voice') + '</h4>';
    if (vs.length) h += '<select data-a="svoice"><option value="">' + T('تلقائي — أفضل صوت متاح', 'Automatic — best available voice') + '</option>' + vs.map(function (v) { return '<option value="' + v.name.replace(/"/g, '') + '"' + (G.voice === v.name ? ' selected' : '') + '>' + v.name + '</option>'; }).join('') + '</select>';
    else h += '<div class="hint">' + T('لا يوجد صوت مثبت لهذه اللغة. على ويندوز: الإعدادات ← الوقت واللغة ← الكلام ← إضافة أصوات. على أندرويد: إعدادات الهاتف ← تحويل النص إلى كلام.', 'No voice is installed for this language. On Windows: Settings → Time & language → Speech → Add voices. On Android: Phone settings → Text-to-speech.') + '</div>';
    return h;
  }

  // ---------- guided reading ----------
  var GD = { on: false, i: 0, off: 0, timer: null, auto: false, voice: false }, mt = null, mb = null;
  function bandTop() { return Math.round(innerHeight * 0.26); }
  function lineH() { var el = units[GD.i] || D.body, cs = getComputedStyle(el), lh = parseFloat(cs.lineHeight); return lh > 0 ? lh : (parseFloat(cs.fontSize) || 16) * 1.7; }
  function bandH() { return Math.round(Math.max(1.5, G.band || 3) * lineH()); }
  function maskUp() {
    if (!mt) { mt = D.createElement('div'); mt.className = 'li-ui li-ms'; mb = D.createElement('div'); mb.className = 'li-ui li-ms'; D.body.appendChild(mt); D.body.appendChild(mb); mt.addEventListener('click', function () { gMove(-1); }); mb.addEventListener('click', function () { gMove(1); }); }
    var bt = bandTop(), bh = bandH(); mt.style.top = '0'; mt.style.height = bt + 'px'; mb.style.top = (bt + bh) + 'px'; mb.style.bottom = '0';
  }
  function gShow() {
    var el = units[GD.i]; if (!el) return; maskUp(); var r = el.getBoundingClientRect(), y = r.top + (window.scrollY || root.scrollTop || 0) + GD.off - bandTop();
    try { scrollTo({ top: Math.max(0, y), behavior: 'smooth' }); } catch (e) { scrollTo(0, Math.max(0, y)); }
    if (gtimer) { clearTimeout(gtimer); gtimer = null; } if (GD.auto && !(GD.voice && S.on)) gSchedule();
  }
  var gtimer = null;
  function gSchedule() {
    var el = units[GD.i]; if (!el) return; var h = el.getBoundingClientRect().height || 1, w = nwords(ctext(el)), part = Math.min(1, bandH() / h), ms = Math.max(900, w * part / (G.wpm || 180) * 60000);
    gtimer = setTimeout(function () { if (GD.on && GD.auto) gMove(1); }, ms);
  }
  function gMove(dir) {
    var el = units[GD.i]; if (!el) return; var h = el.getBoundingClientRect().height, bh = bandH(); GD.off += dir * bh * 0.9;
    if (GD.off >= h - 4) { if (GD.i + 1 >= units.length) { stopGuide(); return; } GD.i++; GD.off = 0; } else if (GD.off < 0) { if (GD.i === 0) GD.off = 0; else { GD.i--; var pr = units[GD.i].getBoundingClientRect().height; GD.off = Math.max(0, pr - bh); } }
    gShow();
  }
  function startGuide() { if (S.on) endSpeak(); GD.voice = false; if (PG.on) exitPaged(); collect(); if (!units.length) return; GD.on = true; GD.i = firstVisible(); GD.off = 0; gShow(); render(); wake(); }
  function stopGuide() { if (GD.voice && S.on) endSpeak(); GD.on = false; GD.auto = false; GD.voice = false; clearTimeout(gtimer); [mt, mb].forEach(function (x) { if (x) x.remove(); }); mt = mb = null; render(); }
  function panelG() {
    var h = '<h4>' + T('القراءة الموجهة', 'Guided reading') + '</h4>';
    if (!GD.on) return h + '<div class="hint">' + T('يضيء شريطًا صغيرًا على النص ويعتم الباقي لتركّز على سطرين أو ثلاثة فقط، ثم تنتقل بالأزرار أو بلمس المنطقة المعتمة، أو يتحرك الشريط وحده بسرعة تختارها.', 'Highlights a small band of text and dims the rest so you focus on two or three lines. Move with the buttons or by tapping the dimmed area, or let it advance on its own at your speed.') + '</div><div class="row c" style="margin-top:10px">' + chip('gstart', '1', T('ابدأ القراءة الموجهة', 'Start guided reading'), false) + '</div>';
    h += '<div class="row c">' + btn(ICON.up, 'sm', '').replace('<button', '<button data-a="gprev" aria-label="' + T('السابق', 'Previous') + '"') + btn(GD.auto ? ICON.pause : ICON.play, 'big', '').replace('<button', '<button data-a="gauto" aria-label="' + T('تلقائي', 'Auto') + '"') + btn(ICON.down, 'sm', '').replace('<button', '<button data-a="gnext" aria-label="' + T('التالي', 'Next') + '"') + btn(ICON.stop, 'sm', '').replace('<button', '<button data-a="gstop" aria-label="' + T('خروج', 'Exit') + '"') + '</div>';
    h += '<div class="row c" style="margin-top:8px">' + chip('gvoice', '1', (GD.voice ? '✓ ' : '') + T('قراءة صوتية مع الشريط', 'Read aloud with the band'), GD.voice) + '</div>';
    h += '<h4>' + T('سرعة التحرك التلقائي', 'Auto speed') + ': ' + (G.wpm || 180) + ' ' + T('كلمة/دقيقة', 'wpm') + '</h4><input type="range" min="80" max="450" step="10" value="' + (G.wpm || 180) + '" data-a="gwpm">';
    h += '<h4>' + T('حجم الشريط', 'Band size') + '</h4><div class="row">' + [2, 3, 4, 5].map(function (n) { return chip('gband', n, n + ' ' + T('أسطر', 'lines'), (G.band || 3) === n); }).join('') + '</div>';
    return h;
  }

  // ---------- book (paged) mode ----------
  var PG = { on: false, step: 0, pages: 1, page: 0, anim: false };
  PG.rtl = function () { return isRtl(); };
  PG.cw = function () { return D.body.clientWidth || innerWidth; };
  var pgcss = D.createElement('style'); pgcss.id = 'li-pg-css'; D.head.appendChild(pgcss);
  PG.layout = function () {
    root.classList.add('li-paged'); pgcss.textContent = 'html.li-paged body{padding:0!important;column-width:auto!important}';
    var cw = PG.cw(), pad = Math.max(14, Math.round(cw * 0.05)), cols = cw >= 1000 ? 2 : 1, gap = pad * 2, colW = Math.floor((cw - 2 * pad - (cols - 1) * gap) / cols);
    pgcss.textContent = 'html.li-paged body{padding:' + pad + 'px ' + pad + 'px 74px!important;column-width:' + colW + 'px!important;column-gap:' + gap + 'px!important}';
    PG.step = PG.cw(); PG.pages = Math.max(1, Math.ceil((D.body.scrollWidth - 2) / PG.step));
  };
  PG.pos = function () { var l = Math.abs(D.body.scrollLeft); return Math.min(PG.pages - 1, Math.max(0, Math.round(l / (PG.step || 1)))); };
  PG.pct = function () { return PG.pages > 1 ? PG.pos() / (PG.pages - 1) * 100 : 0; };
  PG.go = function (n, instant) { n = Math.max(0, Math.min(PG.pages - 1, n)); PG.page = n; D.body.scrollTo({ left: (PG.rtl() ? -1 : 1) * n * PG.step, behavior: 'auto' }); PG.status(); };
  PG.goPct = function (p) { PG.go(Math.round(p / 100 * (PG.pages - 1))); };
  PG.status = function () { var el = D.querySelector('.li-pg'); if (!el) { el = D.createElement('div'); el.className = 'li-ui li-pg'; el.setAttribute('dir', 'ltr'); D.body.appendChild(el); } el.textContent = (PG.page + 1) + ' / ' + PG.pages; P({ type: 'progress', pct: Math.round(PG.pct()), exact: PG.pct() }); };
  PG.toEl = function (el) { if (!PG.on) return; var r = el.getBoundingClientRect(), cx = r.left + r.width / 2, d = Math.floor(cx / PG.step); PG.go(PG.pos() + (PG.rtl() ? -d : d)); };
  function enterPaged() {
    if (PG.on) return; if (S.on) { /* keep listening */ } if (GD.on) stopGuide();
    var vis = units.length ? units[firstVisible()] : null;
    PG.on = true; window.__liPg = PG; PG.layout(); PG.go(0);
    if (vis) PG.toEl(vis); PG.status(); render();
  }
  function exitPaged() {
    if (!PG.on) return; var vis = null; collect(); for (var i = 0; i < units.length; i++) { var r = units[i].getBoundingClientRect(); if (r.left >= -2 && r.left < innerWidth) { vis = units[i]; break; } }
    PG.on = false; window.__liPg = null; root.classList.remove('li-paged'); pgcss.textContent = ''; var pg = D.querySelector('.li-pg'); if (pg) pg.remove(); D.body.scrollLeft = 0;
    if (vis) { try { vis.scrollIntoView({ block: 'start' }); } catch (e) {} } render();
  }
  PG.turn = function (dir) { if (!PG.on) return; var n = PG.pos() + dir; if (n < 0 || n > PG.pages - 1) return; PG.go(n); };
  var tx = 0, ty = 0, tt = 0;
  addEventListener('touchstart', function (e) { if (!PG.on || e.touches.length !== 1) return; tx = e.touches[0].clientX; ty = e.touches[0].clientY; tt = Date.now(); }, { passive: true });
  addEventListener('touchend', function (e) {
    if (!PG.on || !e.changedTouches.length) return; var dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4 && Date.now() - tt < 700) PG.turn(PG.rtl() ? (dx > 0 ? 1 : -1) : (dx < 0 ? 1 : -1));
  }, { passive: true });
  addEventListener('click', function (e) {
    if (!PG.on || e.target.closest('a,button,input,select,.li-ui,mark')) return; var s = getSelection(); if (s && !s.isCollapsed) return;
    var x = e.clientX / innerWidth; if (x < 0.22) PG.turn(PG.rtl() ? 1 : -1); else if (x > 0.78) PG.turn(PG.rtl() ? -1 : 1);
  });
  addEventListener('wheel', function (e) { if (!PG.on) return; e.preventDefault(); if (PG.anim) return; PG.anim = true; setTimeout(function () { PG.anim = false; }, 260); PG.turn(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1); }, { passive: false });
  addEventListener('keydown', function (e) {
    if (/INPUT|SELECT|TEXTAREA/.test((e.target || {}).tagName || '')) return;
    if (PG.on) { var k = e.key; if (k === 'ArrowRight') { PG.turn(PG.rtl() ? -1 : 1); e.preventDefault(); } else if (k === 'ArrowLeft') { PG.turn(PG.rtl() ? 1 : -1); e.preventDefault(); } else if (k === 'PageDown' || k === ' ' || k === 'ArrowDown') { PG.turn(1); e.preventDefault(); } else if (k === 'PageUp' || k === 'ArrowUp') { PG.turn(-1); e.preventDefault(); } }
    else if (GD.on) { var k2 = e.key; if (k2 === 'ArrowDown' || k2 === ' ' || k2 === 'PageDown') { gMove(1); e.preventDefault(); } else if (k2 === 'ArrowUp' || k2 === 'PageUp') { gMove(-1); e.preventDefault(); } else if (k2 === 'Escape') stopGuide(); }
  }, true);
  addEventListener('resize', function () { if (PG.on) { var p = PG.pct(); PG.layout(); PG.goPct(p); } if (GD.on) gShow(); });
  function panelB() {
    var h = '<h4>' + T('وضع الكتاب', 'Book mode') + '</h4><div class="hint">' + T('يعرض الكتاب صفحاتٍ تقلبها بالسحب أو بلمس الحافة أو بالأسهم، بدل التمرير الطويل. على الشاشات العريضة تظهر صفحتان معًا.', 'Shows the book as pages you turn by swiping, tapping the edge or with the arrow keys instead of long scrolling. Wide screens show two pages side by side.') + '</div><div class="row c" style="margin-top:10px">' + chip('bmode', PG.on ? 'scroll' : 'book', PG.on ? T('العودة إلى التمرير', 'Back to scrolling') : T('تفعيل وضع الكتاب', 'Turn on book mode'), false) + '</div>';
    if (PG.on) h += '<div class="row c" style="margin-top:10px">' + chip('bprev', '1', T('الصفحة السابقة', 'Previous page'), false) + chip('bnext', '1', T('الصفحة التالية', 'Next page'), false) + '</div><div class="hint" style="text-align:center">' + (PG.page + 1) + ' / ' + PG.pages + '</div>';
    return h;
  }

  // ---------- typography ----------
  var FF = { def: '', amiri: '"LiAmiri",Amiri,"Traditional Arabic",serif', garamond: '"LiGaramond","EB Garamond",Georgia,serif', serif: 'Georgia,"Times New Roman",serif', sans: '"Segoe UI",system-ui,Roboto,Arial,sans-serif' };
  var fcss = D.createElement('style'); fcss.id = 'li-font-css'; D.head.appendChild(fcss);
  var fontBase = ''; try { fontBase = new URL('fonts/', parent.location.href).href; } catch (e) {}
  function applyType() {
    var r = '';
    if (fontBase) r += '@font-face{font-family:LiAmiri;src:url("' + fontBase + 'Amiri-Regular.ttf")}@font-face{font-family:LiAmiri;font-weight:700;src:url("' + fontBase + 'Amiri-Bold.ttf")}@font-face{font-family:LiGaramond;src:url("' + fontBase + 'EBGaramond12-Regular.otf")}@font-face{font-family:LiGaramond;font-weight:700;src:url("' + fontBase + 'EBGaramond12-Bold.otf")}';
    var ff = FF[G.ff || 'def'];
    if (ff) r += 'html body,html body p,html body li,html body blockquote,html body div,html body span,html body td{font-family:' + ff + '!important}';
    if (G.lh) r += 'html body p,html body li,html body blockquote,html body dd{line-height:' + G.lh + '!important}';
    if (G.just) r += 'html body p,html body li,html body blockquote{text-align:justify!important;hyphens:auto}';
    if (G.w && !PG.on) r += 'html body{max-width:' + ({ n: '34em', m: '44em', w: '58em' }[G.w] || 'none') + '!important;margin-left:auto!important;margin-right:auto!important}';
    fcss.textContent = r; if (PG.on) { var p = PG.pct(); PG.layout(); PG.goPct(p); }
  }
  function panelF() {
    var fs = (RD().getFs ? RD().getFs() : 100), th = G.theme;
    var h = '<h4>' + T('حجم الخط', 'Text size') + ': ' + fs + '%</h4><div class="row c">' + chip('fsm', '1', 'A−', false) + chip('fsp', '1', 'A+', false) + '</div>';
    h += '<h4>' + T('الخط', 'Font') + '</h4><div class="row">' + chip('ff', 'def', T('الأصلي', 'Original'), !G.ff || G.ff === 'def') + chip('ff', 'amiri', T('نسخ (أميري)', 'Naskh (Amiri)'), G.ff === 'amiri') + chip('ff', 'garamond', 'Garamond', G.ff === 'garamond') + chip('ff', 'serif', T('مسنّن', 'Serif'), G.ff === 'serif') + chip('ff', 'sans', T('غير مسنّن', 'Sans'), G.ff === 'sans') + '</div>';
    h += '<h4>' + T('تباعد الأسطر', 'Line spacing') + '</h4><div class="row">' + [['', T('الأصلي', 'Original')], ['1.5', '1.5'], ['1.8', '1.8'], ['2.1', '2.1'], ['2.4', '2.4']].map(function (x) { return chip('lh', x[0] || '0', x[1], (G.lh || '') === x[0]); }).join('') + '</div>';
    if (!PG.on) h += '<h4>' + T('عرض النص', 'Text width') + '</h4><div class="row">' + chip('w', 'o', T('الأصلي', 'Original'), !G.w) + chip('w', 'n', T('ضيق', 'Narrow'), G.w === 'n') + chip('w', 'm', T('متوسط', 'Medium'), G.w === 'm') + chip('w', 'w', T('واسع', 'Wide'), G.w === 'w') + '</div>';
    h += '<h4>' + T('المحاذاة', 'Alignment') + '</h4><div class="row">' + chip('just', '0', T('الأصلية', 'Original'), !G.just) + chip('just', '1', T('ضبط الجانبين', 'Justified'), !!G.just) + '</div>';
    h += '<div class="row c" style="margin-top:12px">' + chip('full', '1', T('ملء الشاشة', 'Full screen'), false) + chip('treset', '1', T('إعادة الضبط', 'Reset'), false) + '</div>';
    return h;
  }

  // ---------- actions ----------
  function act(a, v) {
    if (a === 'splay') { if (!S.on) { var u = selUnit(); startSpeak(u >= 0 ? u : firstVisible()); } else if (S.paused) { S.paused = false; S.tok++; cancelSpeech(); speakUnit(S.i, S.k); } else { S.paused = true; S.tok++; cancelSpeech(); } render(); return; }
    if (a === 'sstop') { endSpeak(); return; }
    if (a === 'snext' || a === 'sprev') { collect(); var n = (S.on ? S.i : firstVisible()) + (a === 'snext' ? 1 : -1); n = Math.max(0, Math.min(units.length - 1, n)); startSpeak(n); return; }
    if (a === 'sresume') { startSpeak(Math.min(units.length - 1, parseInt(bget('li-spk') || '0', 10) || 0)); return; }
    if (a === 'sfromsel') { var u2 = selUnit(); startSpeak(u2 >= 0 ? u2 : firstVisible()); return; }
    if (a === 'srate') { G.rate = +v; saveG(); if (S.on && !S.paused) { S.tok++; cancelSpeech(); speakUnit(S.i, S.k); } render(); return; }
    if (a === 'sscope') { G.scope = v; saveG(); render(); return; }
    if (a === 'svoice') { G.voice = v || ''; saveG(); if (S.on && !S.paused) { S.tok++; cancelSpeech(); speakUnit(S.i, S.k); } return; }
    if (a === 'gstart') { startGuide(); return; }
    if (a === 'gnext') { gMove(1); return; } if (a === 'gprev') { gMove(-1); return; } if (a === 'gstop') { stopGuide(); return; }
    if (a === 'gauto') { GD.auto = !GD.auto; clearTimeout(gtimer); if (GD.auto) gSchedule(); render(); return; }
    if (a === 'gwpm') { G.wpm = +v; saveG(); var h4 = pn.querySelector('h4:nth-of-type(2)'); if (h4) h4.textContent = T('سرعة التحرك التلقائي', 'Auto speed') + ': ' + G.wpm + ' ' + T('كلمة/دقيقة', 'wpm'); return; }
    if (a === 'gvoice') { if (GD.voice) { GD.voice = false; endSpeak(); } else { GD.voice = true; GD.auto = false; clearTimeout(gtimer); startSpeak(GD.i); } render(); return; }
    if (a === 'gband') { G.band = +v; saveG(); if (GD.on) gShow(); render(); return; }
    if (a === 'bmode') { G.mode = v; saveG(); if (v === 'book') enterPaged(); else exitPaged(); applyType(); render(); return; }
    if (a === 'bnext') { PG.turn(1); render(); return; } if (a === 'bprev') { PG.turn(-1); render(); return; }
    if (a === 'fsm' || a === 'fsp') { var cur2 = RD().getFs ? RD().getFs() : 100, nf = Math.max(70, Math.min(240, cur2 + (a === 'fsp' ? 10 : -10))); if (RD().setFs) RD().setFs(nf); if (PG.on) { var p = PG.pct(); PG.layout(); PG.goPct(p); } render(); return; }
    if (a === 'ff') { G.ff = v; saveG(); applyType(); render(); return; }
    if (a === 'lh') { G.lh = v === '0' ? '' : v; saveG(); applyType(); render(); return; }
    if (a === 'w') { G.w = v === 'o' ? '' : v; saveG(); applyType(); render(); return; }
    if (a === 'just') { G.just = v === '1' ? 1 : 0; saveG(); applyType(); render(); return; }
    if (a === 'full') { P({ type: 'fs' }); return; }
    if (a === 'treset') { G.ff = ''; G.lh = ''; G.w = ''; G.just = 0; saveG(); applyType(); render(); return; }
  }

  // book frame scroll in paged mode: keep progress in sync if something jumped the view (TOC, search, notes)
  var snapT = null;
  function bodyScrolled() { if (!PG.on) return; clearTimeout(snapT); snapT = setTimeout(function () { var n = PG.pos(); if (Math.abs(Math.abs(D.body.scrollLeft) - n * PG.step) > 2) PG.go(n); else PG.status(); }, 160); }
  addEventListener('message', function (e) { var d = e.data; if (d && d.liCmd === 'spkstop') { try { endSpeak(); } catch (x) {} } });
  function init() {
    mount(); applyType(); wake(); D.body.addEventListener('scroll', bodyScrolled, { passive: true });
    try { if (SSf() && SSf().onvoiceschanged !== undefined) SSf().onvoiceschanged = function () { if (cur === 'L') render(); }; } catch (e) {}
    if (G.mode === 'book') { collect(); setTimeout(function () { enterPaged(); var ip = window.__liInitPct; if (ip > 0 && ip < 99) PG.goPct(ip); applyType(); }, 350); }
    window.__liDock = { act: act, open: open, state: function () { return { speaking: S.on, paused: S.paused, guide: GD.on, paged: PG.on, page: PG.page, pages: PG.pages, i: S.i, gi: GD.i }; }, PG: PG };
  }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init); else init();
  addEventListener('beforeunload', function () { cancelSpeech(); });
})();
