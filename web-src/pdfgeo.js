/* PDF page geometry: turns pdf.js text items into ordered lines, columns and paragraphs. Used by the HTML converter and by the PDF translation overlay. */
(function () {
  var isArabic = function (t) { t = String(t || '').slice(0, 4000); var a = (t.match(/[؀-ۿ]/g) || []).length, l = (t.match(/[A-Za-z]/g) || []).length; return a > l; };
  var median = function (a) { if (!a.length) return 0; a = a.slice().sort(function (x, y) { return x - y; }); return a[a.length >> 1]; };

  // One page → text segments (a line, or one column's part of a line) with geometry and a column mark.
  function makeSeg(its, y, arabic, col) {
    its = its.slice().sort(function (a, b) { return arabic ? b.x - a.x : a.x - b.x; });
    var out = [], cur = null;
    its.forEach(function (it) {
      var gap = cur ? (arabic ? cur.x0 - (it.x + it.w) : it.x - cur.x1) : 0, fs = Math.max(it.fs, cur ? cur.fs : 0);
      if (!cur || gap > fs * 3) { cur = { y: y, x0: it.x, x1: it.x + it.w, fs: it.fs, txt: it.s, rtl: arabic, chars: it.s.length, col: col }; out.push(cur); }
      else {
        var needSpace = gap > fs * 0.12 && !/\s$/.test(cur.txt) && !/^\s/.test(it.s);
        cur.txt += (needSpace ? ' ' : '') + it.s; cur.x0 = Math.min(cur.x0, it.x); cur.x1 = Math.max(cur.x1, it.x + it.w); cur.fs = Math.max(cur.fs, it.fs); cur.chars += it.s.length;
      }
    });
    return out;
  }
  function pageLines(items, vw, vh) {
    var its = [];
    items.forEach(function (it) {
      if (typeof it.str !== 'string' || !it.str.length) return;
      var t = it.transform, fs = Math.hypot(t[0], t[1]) || it.height || 10; if (!isFinite(fs) || fs < 1) fs = it.height || 10;
      if (Math.abs(t[1]) > Math.abs(t[0]) * 0.5) return;   // rotated text (side stamps)
      its.push({ s: it.str.normalize('NFKC'), x: t[4], y: t[5], w: it.width || 0, fs: fs });   // NFKC turns Arabic presentation forms back into normal letters
    });
    its.sort(function (a, b) { return b.y - a.y || a.x - b.x; });
    var rows = [];
    its.forEach(function (it) {
      var ln = null;
      for (var i = rows.length - 1; i >= 0 && i >= rows.length - 6; i--) { if (Math.abs(rows[i].y - it.y) <= Math.max(1.5, Math.min(rows[i].fs, it.fs) * 0.45)) { ln = rows[i]; break; } }
      if (!ln) { ln = { y: it.y, items: [], fs: 0 }; rows.push(ln); }
      ln.items.push(it); ln.fs = Math.max(ln.fs, it.fs);
    });
    rows.sort(function (a, b) { return b.y - a.y; });
    // find a column gutter: x position where many consecutive rows have text on both sides and nothing crossing
    var cls = function (row, cx) {
      if (row.y > vh * 0.9 || row.y < vh * 0.1) return 'X';   // running header / footer rows are never columns
      var l = 0, r = 0, le = -1e9, rs = 1e9;
      for (var i = 0; i < row.items.length; i++) { var it = row.items[i]; if (!/\S/.test(it.s)) continue; if (it.x + it.w <= cx + 1) { l++; le = Math.max(le, it.x + it.w); } else if (it.x >= cx - 1) { r++; rs = Math.min(rs, it.x); } else return 'X'; }
      if (l && r) return rs - le >= Math.max(14, row.fs * 1.4) ? 'S' : 'X';   // a real gutter, not a stretched word space
      return l ? 'L' : 'R';
    };
    var bestCx = 0, bestRegions = [], bestN = 0;
    if (rows.length >= 10) for (var cx = Math.floor(vw * 0.3); cx <= vw * 0.7; cx += 3) {
      var regions = [], start = -1, lastS = -1, n = 0, sCount = 0;
      var close = function () { if (start >= 0 && sCount >= 3) { regions.push([start, lastS]); n += sCount; } start = -1; lastS = -1; sCount = 0; };
      for (var i = 0; i < rows.length; i++) {
        var c = cls(rows[i], cx);
        if (c === 'X') close();
        else if (c === 'S') { if (start < 0) start = i; lastS = i; sCount++; }
        else if (start < 0) { /* one-sided row before a region: ignore */ }
      }
      close();
      if (n > bestN) { bestN = n; bestCx = cx; bestRegions = regions; }
    }
    var segs = [], inRegion = function (i) { for (var k = 0; k < bestRegions.length; k++) if (i >= bestRegions[k][0] && i <= bestRegions[k][1]) return true; return false; };
    rows.forEach(function (row, i) {
      var arabic = isArabic(row.items.map(function (x) { return x.s; }).join(''));
      if (bestN >= 3 && inRegion(i) && !(row.y > vh * 0.9 || row.y < vh * 0.1)) {
        var L = row.items.filter(function (it) { return it.x + it.w <= bestCx + 1; }), R = row.items.filter(function (it) { return it.x + it.w > bestCx + 1; });
        if (L.length) segs.push.apply(segs, makeSeg(L, row.y, arabic, 'L'));
        if (R.length) segs.push.apply(segs, makeSeg(R, row.y, arabic, 'R'));
      } else segs.push.apply(segs, makeSeg(row.items, row.y, arabic, 'W'));
    });
    segs.forEach(function (s) { s.txt = s.txt.replace(/\s+/g, ' ').trim(); });
    return segs.filter(function (s) { return s.txt; });
  }

  // Reading order from the column marks: wide stretches read straight down; two-column stretches read left column, then right (reverse for Arabic).
  function readingOrder(segs, vw) {
    var byY = function (a, b) { return b.y - a.y; }, all = segs.slice().sort(byY);
    if (!all.some(function (s) { return s.col !== 'W'; })) return { cols: [all], twoCol: false };
    var rtl = isArabic(all.slice(0, 40).map(function (s) { return s.txt; }).join(' ')), cols = [], run = null;
    var flush = function () { if (!run) return; if (run.t === 'W') cols.push(run.W); else { if (run.L.length || run.R.length) { var a = rtl ? run.R : run.L, b = rtl ? run.L : run.R; if (a.length) cols.push(a); if (b.length) cols.push(b); } } run = null; };
    all.forEach(function (s) {
      var t = s.col === 'W' ? 'W' : 'N';
      if (!run || run.t !== t) { flush(); run = { t: t, W: [], L: [], R: [] }; }
      if (t === 'W') run.W.push(s); else run[s.col].push(s);
    });
    flush();
    return { cols: cols, twoCol: true };
  }


  // Group one page's ordered segments into paragraphs / headings / list items with their boxes (top-left origin).
  function paragraphs(segs, pw, ph, body, pitch) {
    var out = [], ord = readingOrder(segs, pw);
    ord.cols.forEach(function (col, ci) {
      var left = col.reduce(function (m, s) { return Math.min(m, s.x0); }, 1e9), right = col.reduce(function (m, s) { return Math.max(m, s.x1); }, 0), prev = null, cur = null;
      var rtl = isArabic(col.slice(0, 30).map(function (s) { return s.txt; }).join(' '));
      var box = function (it, s) { var tp = ph - (s.y + s.fs * 0.82), bt = ph - (s.y - s.fs * 0.25); it.l = Math.min(it.l == null ? 1e9 : it.l, s.x0); it.r = Math.max(it.r == null ? 0 : it.r, s.x1); it.t = Math.min(it.t == null ? 1e9 : it.t, tp); it.b = Math.max(it.b == null ? -1e9 : it.b, bt); it.fs = Math.max(it.fs || 0, s.fs); it.rtl = rtl; };
      col.forEach(function (s, k) {
        var big = s.fs / body, isHead = (big >= 1.22 && s.txt.length < 140) || (big >= 1.12 && s.txt.length < 70 && !/[.,،;:]$/.test(s.txt));
        var bullet = /^([•●▪◦‣·\-–—*]|\(?\d{1,2}[.)]|[a-z][.)])\s+\S/.test(s.txt) && s.txt.length > 3;
        var lineH = prev ? prev.y - s.y : 0, gap = prev ? lineH > Math.max(pitch * 1.42, s.fs * 1.25) : false;
        var indent = rtl ? (right - s.x1) > s.fs * 0.9 : (s.x0 - left) > s.fs * 0.9;
        var prevShort = prev && (rtl ? (prev.x0 - left) : (right - prev.x1)) > (right - left) * 0.25 && /[.!?؟:”"»)]$/.test(prev.txt);
        var sizeShift = prev && Math.abs(prev.fs - s.fs) > 1.2;
        if (isHead) {
          var lvl = big >= 1.7 ? 1 : big >= 1.35 ? 2 : 3;
          if (cur && cur.head && cur.lvl === lvl && Math.abs(cur.lastY - s.y) < s.fs * 1.9) { cur.txt += ' ' + s.txt; cur.lastY = s.y; box(cur, s); }
          else { cur = { head: true, lvl: lvl, txt: s.txt, lastY: s.y }; box(cur, s); out.push(cur); }
        } else if (!cur || cur.head || gap || indent || bullet || prevShort || sizeShift) {
          cur = { head: false, li: bullet, txt: s.txt, cont: k === 0 && !bullet && !indent }; box(cur, s); out.push(cur);
        } else {
          var t = cur.txt; cur.txt = /[A-Za-z]-$/.test(t) && /^[a-z]/.test(s.txt) ? t.slice(0, -1) + s.txt : t + ' ' + s.txt; box(cur, s);
        }
        prev = s;
      });
    });
    return out;
  }
  function bodyStats(pageSegs) {
    var sizes = {}; pageSegs.forEach(function (p) { p.segs.forEach(function (s) { var k = Math.round(s.fs * 2) / 2; sizes[k] = (sizes[k] || 0) + s.chars; }); });
    var body = 12, bc = 0; Object.keys(sizes).forEach(function (k) { if (sizes[k] > bc) { bc = sizes[k]; body = +k; } });
    var deltas = []; pageSegs.forEach(function (p) { var o = readingOrder(p.segs, p.w); o.cols.forEach(function (c) { for (var i = 1; i < c.length; i++) { var d = c[i - 1].y - c[i].y; if (d > 0 && d < body * 2.6 && Math.abs(c[i].fs - body) < 1.5 && Math.abs(c[i - 1].fs - body) < 1.5) deltas.push(d); } }); });
    return { body: body, pitch: Math.max(median(deltas) || body * 1.3, body * 1.05) };
  }
  // For the translated overlay on the original PDF: paragraphs of one page with their boxes.
  function pageBlocks(rawItems, w, h) {
    var segs = pageLines(rawItems, w, h).filter(function (s) { var edge = s.y > h * 0.93 || s.y < h * 0.05; return !(edge && /^[\-–—\s]*(\d{1,4}|[ivxlc]{1,6})[\-–—\s]*$/i.test(s.txt)); });
    var st = bodyStats([{ segs: segs, w: w }]);
    return paragraphs(segs, w, h, st.body, st.pitch).filter(function (b) { return /\p{L}{2}/u.test(b.txt); });
  }
  window.__PDFGEO = { pageLines: pageLines, readingOrder: readingOrder, paragraphs: paragraphs, bodyStats: bodyStats, pageBlocks: pageBlocks, median: median };
})();
