(function () {
  'use strict';
  var LI = window.__LI || {}, EN = LI.lang === 'en', X = function (a, e) { return EN ? e : a }, TPL = !!LI.tpl, P = function (m) { m.liBook = 1; parent.postMessage(m, '*'); };
  var annots = [], textCache = null, prefs = { fs: 100, theme: 'original' }, lastExt = '', lastAct = 0, barT = null;
  // ---- activity / top-hover / progress ----
  function act() { var n = Date.now(); if (n - lastAct > 4000) { lastAct = n; P({ type: 'act' }); } }
  ['scroll', 'keydown', 'mousedown', 'wheel', 'touchstart'].forEach(function (e) { addEventListener(e, act, { passive: true, capture: true }); });
  var barShown = false;
  addEventListener('mousemove', function (e) { act(); if (e.clientY <= 30) { if (!barShown) { barShown = true; P({ type: 'bar', show: 1 }); } clearTimeout(barT); } else if (barShown && e.clientY > 90) { clearTimeout(barT); barT = setTimeout(function () { barShown = false; P({ type: 'bar', show: 0 }); }, 700); } }, { passive: true });
  function pct() { if (window.__liPg && window.__liPg.on) return window.__liPg.pct(); var d = document.documentElement, h = d.scrollHeight - innerHeight, s = window.scrollY || d.scrollTop || 0; return h > 0 ? Math.max(0, Math.min(100, s / h * 100)) : 0; }
  var pT; if (!TPL) addEventListener('scroll', function () { clearTimeout(pT); pT = setTimeout(function () { P({ type: 'progress', pct: Math.round(pct()), exact: pct() }); }, 400); }, { passive: true });
  addEventListener('keydown', function (e) { if ((e.ctrlKey && (e.key === 'l' || e.key === 'L')) || (e.altKey && e.key === 'ArrowLeft')) P({ type: 'back' }); else if (e.key === 'F11') { P({ type: 'fs' }); e.preventDefault(); } else if (e.ctrlKey && (e.key === 'f' || e.key === 'F') && !TPL) { P({ type: 'findkey' }); e.preventDefault(); } });
  // ---- template books: mirror their notebook/progress into the library ----
  function dumpTpl() {
    try {
      var best = null;
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i), v = localStorage.getItem(k); if (!v || v.charAt(0) !== '{') continue; try { var o = JSON.parse(v); if (o && Array.isArray(o.highlights) && Array.isArray(o.notes)) { best = o; break; } } catch (e) {} }
      if (!best) return;
      var cut = function (a, n) { return (a || []).slice(0, n).map(function (x) { return { id: x.id, kind: x.kind, text: String(x.text || '').slice(0, 1500), body: String(x.body || '').slice(0, 4000), selectedText: String(x.selectedText || '').slice(0, 1500), prompt: String(x.prompt || '').slice(0, 300), section: x.section, sectionLabel: x.sectionLabel, date: x.date, color: x.color, pidx: x.pidx }; }); };
      var ext = { progress: +best.progress || 0, lastSection: best.lastSection || '', highlights: cut(best.highlights, 3000), notes: cut(best.notes, 3000), bookmarks: cut(best.bookmarks, 3000) };
      var j = JSON.stringify(ext); if (j !== lastExt) { lastExt = j; P({ type: 'ext', ext: ext }); }
    } catch (e) {}
  }
  if (TPL) { setInterval(dumpTpl, 3000); document.addEventListener('visibilitychange', dumpTpl); addEventListener('beforeunload', dumpTpl); setTimeout(dumpTpl, 1500); }
  // ---- generic books: theme / font size ----
  var THEMES = { paper: ['#F8F1E0', '#26261f'], calm: ['#E8E0C9', '#35332a'], bold: ['#FFFFFF', '#000000'], quiet: ['#4B4F58', '#E8E6E0'], focus: ['#F3EFE4', '#1b1b1b'], night: ['#121E24', '#E8E0CC'] };
  function applyPrefs() {
    if (TPL) return; document.documentElement.style.zoom = (prefs.fs / 100); var st = document.getElementById('li-theme'); if (!st) { st = document.createElement('style'); st.id = 'li-theme'; document.head.appendChild(st); }
    var t = THEMES[prefs.theme]; st.textContent = t ? 'html,body{background:' + t[0] + '!important;color:' + t[1] + '!important}body *:not(img):not(svg):not(video):not(canvas):not(.li-ui):not(.li-ui *){color:inherit!important;background-color:transparent!important;border-color:' + t[1] + '55!important}a{text-decoration:underline}' + (prefs.theme === 'bold' ? 'body{font-weight:700!important}' : '') : '';
  }
  // ---- generic annotations ----
  var COLORS = { y: '#F6D861', g: '#A8D582', b: '#8EC5F0', p: '#F2A6C0', v: '#C3A6E8' };
  function uid() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function walk() { var nodes = [], text = '', w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: function (n) { var p = n.parentElement; if (!p || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName) || p.closest('.li-ui')) return NodeFilter.FILTER_REJECT; return NodeFilter.FILTER_ACCEPT; } }), n; while ((n = w.nextNode())) { nodes.push({ n: n, s: text.length }); text += n.nodeValue; } return { nodes: nodes, text: text }; }
  function posOf(idx, node, off) { for (var i = 0; i < idx.nodes.length; i++) if (idx.nodes[i].n === node) return idx.nodes[i].s + off; return -1; }
  function wrapRange(idx, s, e, a) {
    var segs = []; idx.nodes.forEach(function (o) { var ns = o.s, ne = o.s + o.n.nodeValue.length; if (ne <= s || ns >= e) return; segs.push({ n: o.n, a: Math.max(s, ns) - ns, b: Math.min(e, ne) - ns }); });
    segs.forEach(function (g) { var t = g.n; if (g.b < t.nodeValue.length) t.splitText(g.b); if (g.a > 0) t = t.splitText(g.a); var m = document.createElement('mark'); m.className = 'li-hl' + (a.type === 'ul' ? ' li-ul' : '') + (a.note ? ' li-has-note' : ''); m.dataset.id = a.id; m.style.cssText = a.type === 'ul' ? 'background:none;text-decoration:underline;text-decoration-color:' + (COLORS[a.color] || '#C3714C') + ';text-decoration-thickness:3px;color:inherit' : 'background:' + (COLORS[a.color] || COLORS.y) + 'cc;color:#14262e;border-radius:2px;padding:0'; t.parentNode.replaceChild(m, t); m.appendChild(t); });
  }
  function locate(a, idx) { var q = a.quote, i = -1, from = 0, best = -1; if (!q) return null; while ((i = idx.text.indexOf(q, from)) >= 0) { if (best < 0) best = i; var pre = idx.text.slice(Math.max(0, i - (a.prefix || '').length), i); if (!a.prefix || pre === a.prefix) { best = i; break; } from = i + 1; } return best < 0 ? null : [best, best + q.length]; }
  function clearMarks() { document.querySelectorAll('mark.li-hl').forEach(function (m) { var p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize(); }); }
  function applyAnnots() { if (TPL) return; clearMarks(); annots.forEach(function (a) { if (a.type === 'bm') return; var idx = walk(), r = locate(a, idx); if (r) wrapRange(idx, r[0], r[1], a); }); }
  function commit() { P({ type: 'annots', annots: annots }); }
  // toolbar
  var bar = null;
  function ui(html) { var d = document.createElement('div'); d.className = 'li-ui'; d.style.cssText = 'position:fixed;z-index:2147483000;background:#fbf7ec;color:#14262e;border:1px solid #d9cdb0;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.28);padding:6px 8px;font:13px "Segoe UI",Tahoma,sans-serif;direction:' + (EN ? 'ltr' : 'rtl') + ';display:flex;gap:6px;align-items:center'; d.innerHTML = html; document.body.appendChild(d); return d; }
  function hideBar() { if (bar) { bar.remove(); bar = null; } }
  function place(el, r) { var w = el.offsetWidth, x = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)), y = r.top - el.offsetHeight - 10; if (y < 8) y = r.bottom + 10; el.style.left = x + 'px'; el.style.top = y + 'px'; }
  function dots(sel) { return Object.keys(COLORS).map(function (k) { return '<button data-c="' + k + '" aria-label="'+X('تظليل','Highlight')+'" style="width:22px;height:22px;border-radius:50%;border:2px solid ' + (sel === k ? '#14262e' : 'transparent') + ';background:' + COLORS[k] + ';cursor:pointer;padding:0"></button>'; }).join(''); }
  var btn = 'border:0;background:none;cursor:pointer;font:inherit;color:#14262e;padding:3px 8px;border-radius:7px';
  function selPos() {
    var s = getSelection(); if (!s || s.isCollapsed || !s.rangeCount) return null; var r = s.getRangeAt(0); if (!document.body.contains(r.commonAncestorContainer) || (r.commonAncestorContainer.parentElement && r.commonAncestorContainer.parentElement.closest('.li-ui'))) return null;
    var idx = walk(), sc = r.startContainer, so = r.startOffset, ec = r.endContainer, eo = r.endOffset;
    var fix = function (c, o, end) { if (c.nodeType === 3) return posOf(idx, c, o); var ch = c.childNodes[Math.min(o, c.childNodes.length - 1)] || c; var tw = document.createTreeWalker(ch, NodeFilter.SHOW_TEXT), t = end && o > 0 ? null : tw.nextNode(); if (!t) { var last, n; tw = document.createTreeWalker(c, NodeFilter.SHOW_TEXT); while ((n = tw.nextNode())) { last = n; if (end) { } } return last ? posOf(idx, last, last.nodeValue.length) : -1; } return posOf(idx, t, 0); };
    var s0 = fix(sc, so, false), e0 = fix(ec, eo, true); if (s0 < 0 || e0 <= s0) return null; return { s: s0, e: e0, idx: idx, rect: r.getBoundingClientRect() };
  }
  function createAnnot(sp, type, color, note) { var a = { id: uid(), type: type, color: color, quote: sp.idx.text.slice(sp.s, sp.e).slice(0, 3000), prefix: sp.idx.text.slice(Math.max(0, sp.s - 24), sp.s), note: note || '', pct: Math.round(pct() * 10) / 10, date: new Date().toISOString().slice(0, 10) }; annots.push(a); getSelection().removeAllRanges(); applyAnnots(); commit(); return a; }
  function onSel(e) {
    if (TPL || (e && e.target && e.target.closest && e.target.closest('.li-ui'))) return;
    setTimeout(function () {
      var sp = selPos(); hideBar(); if (!sp) return;
      var trOn = !!window.__LI_TR, tools = '<button data-cp="1" style="' + btn + '">'+X('نسخ','Copy')+'</button><button data-sp="1" style="' + btn + '">'+X('استماع','Listen')+'</button>';
      bar = ui(trOn ? tools : dots() + '<button data-u="1" style="' + btn + ';text-decoration:underline;text-decoration-color:#C3714C;text-decoration-thickness:2px">'+X('تسطير','Underline')+'</button><button data-n="1" style="' + btn + '">'+X('ملاحظة','Note')+'</button>' + tools); place(bar, sp.rect);
      bar.onmousedown = function (ev) { ev.preventDefault(); };
      bar.onclick = function (ev) { var t = ev.target.closest('button'); if (!t) return; var s2 = selPos() || sp;
        if (t.dataset.c) { createAnnot(s2, 'hl', t.dataset.c); hideBar(); } else if (t.dataset.u) { createAnnot(s2, 'ul', 'b'); hideBar(); } else if (t.dataset.cp) { var tx = s2.idx.text.slice(s2.s, s2.e), okc = false; try { document.execCommand('copy'); okc = true; } catch (x) {} if (!okc) { try { navigator.clipboard.writeText(tx); } catch (x) {} } hideBar(); }
        else if (t.dataset.sp) { var NN = window.LiNative || (parent && parent.LiNative), tx2 = s2.idx.text.slice(s2.s, s2.e), st = window.__liTrAPI && window.__liTrAPI.state; if (NN && NN.speak) { var lg = /[\u0600-\u06FF]/.test(tx2) ? 'ar' : ((st && st.tgt) || document.documentElement.lang || 'en'); try { NN.stop(); NN.speak('sel' + Date.now(), tx2, lg, '', 1, 1); } catch (x) {} } hideBar(); }
        else if (t.dataset.n) { var a = createAnnot(s2, 'hl', 'y'); hideBar(); editNote(a); } };
    }, 10);
  }
  document.addEventListener('mouseup', onSel);
  var selT = null;
  document.addEventListener('selectionchange', function () { if (!matchMedia('(pointer:coarse)').matches) return; clearTimeout(selT); selT = setTimeout(function () { var s = getSelection(); if (s && !s.isCollapsed && !bar) onSel(null); }, 450); });
  function editNote(a) {
    hideBar(); var m = document.querySelector('mark.li-hl[data-id="' + a.id + '"]'); var r = m ? m.getBoundingClientRect() : { left: 80, top: 120, width: 200, bottom: 140 };
    bar = ui('<div style="display:flex;flex-direction:column;gap:6px;width:280px"><textarea style="width:100%;height:84px;border:1px solid #d9cdb0;border-radius:8px;padding:6px;font:inherit;background:#fff;color:#14262e;resize:none" placeholder="'+X('اكتب ملاحظتك…','Write your note…')+'"></textarea><div style="display:flex;gap:6px;justify-content:flex-start"><button data-ok="1" style="' + btn + ';background:#C3714C;color:#fff">'+X('حفظ','Save')+'</button><button data-no="1" style="' + btn + '">'+X('إلغاء','Cancel')+'</button></div></div>');
    var ta = bar.querySelector('textarea'); ta.value = a.note || ''; place(bar, r); ta.focus();
    bar.onclick = function (ev) { var t = ev.target.closest('button'); if (!t) return; if (t.dataset.ok) { a.note = ta.value.trim(); applyAnnots(); commit(); } hideBar(); };
  }
  document.addEventListener('click', function (e) {
    var m = e.target.closest && e.target.closest('mark.li-hl'); if (TPL || !m || (bar && bar.contains(e.target))) return; var sel = getSelection(); if (sel && !sel.isCollapsed) return;
    var a = annots.filter(function (x) { return x.id === m.dataset.id; })[0]; if (!a) return; hideBar();
    bar = ui(dots(a.color) + '<button data-n="1" style="' + btn + '">' + (a.note ? X('عرض الملاحظة','View note') : X('ملاحظة','Note')) + '</button><button data-d="1" style="' + btn + ';color:#b3402a">'+X('حذف','Delete')+'</button>'); place(bar, m.getBoundingClientRect());
    bar.onmousedown = function (ev) { ev.preventDefault(); };
    bar.onclick = function (ev) { var t = ev.target.closest('button'); if (!t) return; if (t.dataset.c) { a.color = t.dataset.c; if (a.type === 'ul') a.type = 'hl'; applyAnnots(); commit(); hideBar(); } else if (t.dataset.d) { annots = annots.filter(function (x) { return x.id !== a.id; }); applyAnnots(); commit(); hideBar(); } else if (t.dataset.n) editNote(a); };
  });
  addEventListener('scroll', function () { if (bar && !bar.querySelector('textarea')) hideBar(); }, { passive: true });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideBar(); });
  // ---- touch gestures: two fingers pinch = text size, three fingers swipe down = screenshot ----
  (function () {
    var d0 = 0, fs0 = 100, cur = 0, y3 = null, x3 = 0, fired = false;
    var dist = function (t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx * dx + dy * dy); };
    var avg = function (t, k) { return (t[0][k] + t[1][k] + t[2][k]) / 3; };
    if (!TPL) document.documentElement.style.touchAction = 'pan-y';
    addEventListener('touchstart', function (e) {
      if (e.touches.length === 2 && !TPL) { d0 = dist(e.touches); fs0 = prefs.fs || 100; cur = fs0; }
      else if (e.touches.length === 3) { y3 = avg(e.touches, 'clientY'); x3 = avg(e.touches, 'clientX'); fired = false; d0 = 0; }
    }, { passive: true });
    addEventListener('touchmove', function (e) {
      if (e.touches.length === 2 && d0 > 0 && !TPL) { var n = Math.max(70, Math.min(240, Math.round(fs0 * dist(e.touches) / d0 / 5) * 5)); if (n !== cur) { cur = n; prefs.fs = n; document.documentElement.style.zoom = n / 100; } }
      else if (e.touches.length === 3 && y3 !== null && !fired) { if (avg(e.touches, 'clientY') - y3 > 120 && Math.abs(avg(e.touches, 'clientX') - x3) < 140) { fired = true; P({ type: 'shot' }); } }
    }, { passive: true });
    addEventListener('touchend', function (e) { if (e.touches.length < 2 && d0 > 0 && cur !== fs0 && !TPL) { P({ type: 'fs', fs: cur }); d0 = 0; } if (e.touches.length === 0) { y3 = null; d0 = 0; } }, { passive: true });
  })();
  // ---- parent commands ----
  function visiblePara() { var els = document.querySelectorAll('p,li,h1,h2,h3,blockquote,div'), best = null; for (var i = 0; i < els.length; i++) { var r = els[i].getBoundingClientRect(); if (r.top >= 0 && r.top < innerHeight * 0.8 && els[i].textContent.trim().length > 20 && els[i].children.length < 4) { best = els[i]; break; } } return best ? best.textContent.replace(/\s+/g, ' ').trim().slice(0, 140) : ''; }
  function gotoAnnot(a) { if (a.type !== 'bm') { var m = document.querySelector('mark.li-hl[data-id="' + a.id + '"]'); if (m) { m.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(m); return; } } if (a.quote) { var idx = walk(), r = locate(a, idx); if (r) { var n = idx.nodes.filter(function (o) { return o.s <= r[0] && o.s + o.n.nodeValue.length > r[0]; })[0]; if (n && n.n.parentElement) { n.n.parentElement.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; } } } var d = document.documentElement; scrollTo({ top: (d.scrollHeight - innerHeight) * (a.pct || 0) / 100, behavior: 'smooth' }); }
  function flash(m) { var o = m.style.outline; m.style.outline = '3px solid #C3714C'; setTimeout(function () { m.style.outline = o; }, 1500); }
  window.__liRd = { getFs: function () { return prefs.fs; }, setFs: function (n) { prefs.fs = n; applyPrefs(); P({ type: 'fs', fs: n }); } };
  addEventListener('message', function (e) {
    var d = e.data; if (!d || !d.liCmd) return;
    if (d.liCmd === 'init') {
      annots = d.annots || []; prefs = Object.assign(prefs, d.prefs || {}); applyPrefs(); window.__liInitPct = d.pct;
      if (!TPL) { setTimeout(function () { applyAnnots(); if (window.__liPg && window.__liPg.on) { if (d.pct > 0 && d.pct < 99) window.__liPg.goPct(d.pct); } else if (d.pct > 0 && d.pct < 99) { var dd = document.documentElement; scrollTo(0, (dd.scrollHeight - innerHeight) * d.pct / 100); } }, 250); }
      if (TPL) dumpTpl();
    } else if (d.liCmd === 'prefs') { prefs = Object.assign(prefs, d.prefs || {}); applyPrefs(); }
    else if (d.liCmd === 'goto') {
      if (d.annot) gotoAnnot(d.annot);
      else if (TPL && d.section) { var el = document.getElementById(d.section); if (d.hlId) { var h = document.querySelector('.hl[data-id="' + d.hlId + '"]'); if (h) el = h; } if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (el.classList) { el.style.outline = '3px solid #C3714C'; setTimeout(function () { el.style.outline = ''; }, 1500); } } }
    } else if (d.liCmd === 'bookmark' && !TPL) {
      var a = { id: uid(), type: 'bm', quote: visiblePara(), prefix: '', note: '', pct: Math.round(pct() * 10) / 10, date: new Date().toISOString().slice(0, 10) }; var dup = annots.filter(function (x) { return x.type === 'bm' && Math.abs((x.pct || 0) - a.pct) < 0.4; })[0];
      if (dup) annots = annots.filter(function (x) { return x !== dup; }); else annots.push(a); commit(); P({ type: 'bm-toast', removed: !!dup });
    } else if (d.liCmd === 'delannot') { annots = annots.filter(function (x) { return x.id !== d.id; }); applyAnnots(); commit(); }
    else if (d.liCmd === 'find' && d.q) { try { window.find(d.q, false, !!d.back, true, false, false, false); } catch (x) {} }
  });
  P({ type: 'ready' });
})();
