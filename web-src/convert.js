/* Living Ideas — turn Word (.docx) and PDF files into reflowable HTML books.
   Uses the same page shell as EPUB books, so every reader feature (notes, highlights, themes,
   text size, contents, translation) works on the result. */
(function () {
  var F = window.__FMT; if (!F) return;
  var esc = F.esc, isArabic = F.isArabic, shell = F.shell;
  var NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

  // =====================================================================  DOCX
  function kids(el, name) { var o = []; for (var n = el && el.firstElementChild; n; n = n.nextElementSibling) if (!name || n.localName === name) o.push(n); return o; }
  function kid(el, name) { return kids(el, name)[0] || null; }
  function wattr(el, name) { if (!el) return null; return el.getAttributeNS(NS_W, name) || el.getAttribute('w:' + name); }
  function rattr(el, name) { if (!el) return null; for (var i = 0; i < el.attributes.length; i++) if (el.attributes[i].localName === name && /relationships/.test(el.attributes[i].namespaceURI || '')) return el.attributes[i].value; return el.getAttribute('r:' + name); }
  function on(el) { if (!el) return false; var v = wattr(el, 'val'); return !(v === '0' || v === 'false' || v === 'off' || v === 'none'); }

  function docxToHtml(buf, name) {
    var zip, rels = {}, nums = {}, styles = {}, foot = {}, images = {}, imgCount = 0;
    var parse = function (s) { return s ? new DOMParser().parseFromString(s, 'application/xml') : null; };
    return JSZip.loadAsync(buf).then(function (z) {
      zip = z; if (!zip.file('word/document.xml')) throw new Error('nodoc');
      var rd = function (n) { return zip.file(n) ? zip.file(n).async('string') : Promise.resolve(''); };
      return Promise.all([rd('word/document.xml'), rd('word/_rels/document.xml.rels'), rd('word/numbering.xml'), rd('word/styles.xml'), rd('docProps/core.xml'), rd('word/footnotes.xml')]);
    }).then(function (r) {
      var doc = parse(r[0]), relDoc = parse(r[1]), numDoc = parse(r[2]), styDoc = parse(r[3]), core = parse(r[4]), fnDoc = parse(r[5]);
      if (!doc || doc.getElementsByTagName('parsererror').length) throw new Error('bad');
      if (relDoc) kids(relDoc.documentElement, 'Relationship').forEach(function (e) { rels[e.getAttribute('Id')] = { t: e.getAttribute('Target'), m: e.getAttribute('TargetMode') }; });
      if (styDoc) kids(styDoc.documentElement, 'style').forEach(function (s) {
        var id = wattr(s, 'styleId'), nm = kid(s, 'name'), ppr = kid(s, 'pPr'), ol = ppr && kid(ppr, 'outlineLvl');
        styles[id] = { name: (nm && wattr(nm, 'val') || '').toLowerCase(), outline: ol ? +wattr(ol, 'val') : null, based: (kid(s, 'basedOn') && wattr(kid(s, 'basedOn'), 'val')) || null };
      });
      if (numDoc) {
        var abs = {}; kids(numDoc.documentElement, 'abstractNum').forEach(function (a) { var lv = {}; kids(a, 'lvl').forEach(function (l) { var f = kid(l, 'numFmt'); lv[wattr(l, 'ilvl')] = f ? wattr(f, 'val') : 'decimal'; }); abs[wattr(a, 'abstractNumId')] = lv; });
        kids(numDoc.documentElement, 'num').forEach(function (n) { var a = kid(n, 'abstractNumId'); nums[wattr(n, 'numId')] = a ? abs[wattr(a, 'val')] || {} : {}; });
      }
      var fnList = [];
      var fnText = function (id) { return foot[id] || ''; };
      // footnotes
      var fnProm = Promise.resolve();
      var ctx = { footRefs: [] };
      if (fnDoc) kids(fnDoc.documentElement, 'footnote').forEach(function (f) { var id = wattr(f, 'id'); if (+id > 0) foot[id] = kids(f, 'p').map(function (p) { return textOf(p); }).join(' ').trim(); });

      function textOf(p) { var s = ''; (function walk(n) { for (var c = n.firstElementChild; c; c = c.nextElementSibling) { if (c.localName === 't') s += c.textContent; else if (c.localName === 'tab') s += ' '; else if (c.localName !== 'instrText' && c.localName !== 'del') walk(c); } })(p); return s; }

      function styleLevel(id) {
        var guard = 0; while (id && styles[id] && guard++ < 8) { var s = styles[id]; var m = /^heading\s*(\d)/.exec(s.name) || /^(title)$/.exec(s.name); if (m) return m[1] === 'title' ? 1 : Math.min(+m[1], 4); if (/^subtitle$/.test(s.name)) return 2; if (s.outline != null && s.outline < 4) return s.outline + 1; id = s.based; }
        return 0;
      }
      function imgHtml(blip) {
        var rid = rattr(blip, 'embed'), rel = rels[rid]; if (!rel) return '';
        var path = 'word/' + rel.t.replace(/^\//, '').replace(/^word\//, ''); var key = 'IMG' + (imgCount++);
        images[key] = zip.file(path) ? zip.file(path).async('blob').then(F.typedImage).then(function (t) { return t && t.blob.size < 6e6 ? F.toDataURL(t.blob) : ''; }).catch(function () { return ''; }) : Promise.resolve('');
        return '<!--' + key + '-->';
      }
      function runsHtml(p) {
        var out = '', pending = null;
        var flush = function () { if (pending) { out += wrap(pending.t, pending.f); pending = null; } };
        var wrap = function (t, f) { if (!t) return ''; var h = esc(t).replace(/\t/g, ' '); if (f.sup) h = '<sup>' + h + '</sup>'; else if (f.sub) h = '<sub>' + h + '</sub>'; if (f.b) h = '<strong>' + h + '</strong>'; if (f.i) h = '<em>' + h + '</em>'; if (f.u) h = '<u>' + h + '</u>'; if (f.s) h = '<s>' + h + '</s>'; return h; };
        var add = function (t, f) { var k = [f.b, f.i, f.u, f.s, f.sup, f.sub].join(); if (pending && pending.k === k) pending.t += t; else { flush(); pending = { t: t, f: f, k: k }; } };
        (function walk(n, link) {
          for (var c = n.firstElementChild; c; c = c.nextElementSibling) {
            var ln = c.localName;
            if (ln === 'r') {
              var rpr = kid(c, 'rPr'), f = { b: rpr && on(kid(rpr, 'b')), i: rpr && on(kid(rpr, 'i')), u: rpr && on(kid(rpr, 'u')), s: rpr && on(kid(rpr, 'strike')) };
              var va = rpr && kid(rpr, 'vertAlign'); if (va) { var v = wattr(va, 'val'); f.sup = v === 'superscript'; f.sub = v === 'subscript'; }
              kids(c).forEach(function (x) {
                var xn = x.localName;
                if (xn === 't') add(x.textContent, f);
                else if (xn === 'tab') add(' ', f);
                else if (xn === 'br') { if (wattr(x, 'type') !== 'page') { flush(); out += '<br>'; } }
                else if (xn === 'footnoteReference') { var id = wattr(x, 'id'); if (foot[id]) { ctx.footRefs.push(id); flush(); out += '<sup><a href="#fn' + id + '" id="fr' + id + '">[' + ctx.footRefs.length + ']</a></sup>'; } }
                else if (xn === 'drawing' || xn === 'pict') { var bl = x.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip')[0]; if (bl) { flush(); out += imgHtml(bl); } }
              });
            } else if (ln === 'hyperlink') {
              var rid = rattr(c, 'id'), tgt = rid && rels[rid] && rels[rid].m === 'External' ? rels[rid].t : '';
              flush(); var before = out; out = ''; walk(c); flush(); var inner = out; out = before + (inner && /^(https?:|mailto:)/i.test(tgt) ? '<a href="' + esc(tgt) + '">' + inner + '</a>' : inner);
            } else if (ln === 'ins' || ln === 'smartTag' || ln === 'fldSimple' || ln === 'sdt' || ln === 'sdtContent' || ln === 'customXml') walk(c);
          }
        })(p);
        flush(); return out;
      }

      var blocks = [], listStack = [];
      var closeLists = function () { while (listStack.length) blocks.push('</' + listStack.pop().tag + '>'); };
      function para(p, inCell) {
        var ppr = kid(p, 'pPr'), sid = ppr && kid(ppr, 'pStyle') ? wattr(kid(ppr, 'pStyle'), 'val') : null;
        var lvl = styleLevel(sid), ol = ppr && kid(ppr, 'outlineLvl'); if (!lvl && ol) lvl = Math.min(+wattr(ol, 'val') + 1, 4);
        var h = runsHtml(p), plain = textOf(p).trim(), rtl = ppr && kid(ppr, 'bidi') && on(kid(ppr, 'bidi'));
        var num = ppr && kid(ppr, 'numPr'), dir = rtl ? ' dir="rtl"' : ' dir="auto"';
        if (!plain && !/<!--IMG|<br>/.test(h)) return inCell ? '' : (closeLists(), '');
        if (inCell) return '<span' + dir + '>' + h + '</span>';
        if (lvl && plain && plain.length < 300) { closeLists(); var l = Math.min(lvl, 3) + (lvl >= 1 ? 0 : 0); return '<h' + l + dir + (styles[sid] && /^title$/.test(styles[sid].name) ? ' class="doc-title"' : '') + ' data-lv="' + lvl + '">' + h.replace(/<\/?strong>/g, '') + '</h' + l + '>'; }
        if (num && kid(num, 'numId') && wattr(kid(num, 'numId'), 'val') !== '0') {
          var nid = wattr(kid(num, 'numId'), 'val'), il = kid(num, 'ilvl') ? +wattr(kid(num, 'ilvl'), 'val') : 0, fmt = (nums[nid] || {})[il] || 'decimal', tag = fmt === 'bullet' ? 'ul' : 'ol';
          while (listStack.length > il + 1) blocks.push('</' + listStack.pop().tag + '>');
          while (listStack.length < il + 1) { listStack.push({ tag: tag }); blocks.push('<' + tag + '>'); }
          return '<li' + dir + '>' + h + '</li>';
        }
        closeLists();
        var q = styles[sid] && /quote/.test(styles[sid].name);
        return (q ? '<blockquote' : '<p') + dir + '>' + h + (q ? '</blockquote>' : '</p>');
      }
      function table(t) {
        closeLists(); var rows = kids(t, 'tr').map(function (tr) {
          return '<tr>' + kids(tr, 'tc').map(function (tc) {
            var pr = kid(tc, 'tcPr'), gs = pr && kid(pr, 'gridSpan'), span = gs ? ' colspan="' + wattr(gs, 'val') + '"' : '';
            var inner = []; kids(tc).forEach(function (x) { if (x.localName === 'p') { var s = para(x, true); if (s) inner.push(s); } else if (x.localName === 'tbl') inner.push('[table]'); });
            return '<td' + span + '>' + inner.join('<br>') + '</td>';
          }).join('') + '</tr>';
        }).join('');
        return '<div class="li-tbl"><table>' + rows + '</table></div>';
      }
      var body = kid(doc.documentElement, 'body');
      (function walkBody(n) {
        kids(n).forEach(function (c) {
          var ln = c.localName;
          if (ln === 'p') { var s = para(c, false); if (s) blocks.push(s); }
          else if (ln === 'tbl') blocks.push(table(c));
          else if (ln === 'sdt') { var sc = kid(c, 'sdtContent'); if (sc) walkBody(sc); }
        });
      })(body);
      closeLists();
      var keys = Object.keys(images);
      return Promise.all(keys.map(function (k) { return images[k]; })).then(function (vals) {
        var map = {}; keys.forEach(function (k, i) { map[k] = vals[i]; });
        var html = blocks.join('\n').replace(/<!--(IMG\d+)-->/g, function (all, k) { return map[k] ? '<img src="' + map[k] + '" alt="">' : ''; });
        // footnotes at the end
        if (ctx.footRefs.length) {
          var title = '';
          html += '\n<h2 dir="auto" data-lv="2">__FN__</h2>\n<ol class="fn">' + ctx.footRefs.map(function (id) { return '<li id="fn' + id + '" dir="auto">' + esc(fnText(id)) + ' <a href="#fr' + id + '">↩</a></li>'; }).join('') + '</ol>';
        }
        var tmeta = core && core.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0], cmeta = core && core.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'creator')[0];
        var sample = html.replace(/<[^>]+>/g, ' ').slice(0, 6000), rtl = isArabic(sample);
        html = html.replace('__FN__', rtl ? 'الهوامش' : 'Notes');
        var title = (tmeta && tmeta.textContent.trim()) || '', first = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
        if (!title && first) title = first[1].replace(/<[^>]+>/g, '').trim();
        if (!title) title = String(name || '').replace(/\.[^.]+$/, '');
        return { html: finishBook(title, (cmeta && cmeta.textContent.trim()) || '', rtl, html), title: title, author: (cmeta && cmeta.textContent.trim()) || '', cover: null };
      });
    });
  }

  // Split flat HTML into chapters (at the top-level headings) and wrap it in the book shell.
  function finishBook(title, author, rtl, flatHtml) {
    var parts = splitChapters(flatHtml);
    var body = parts.map(function (p, i) { return '<section class="epub-ch" id="ch' + (i + 1) + '">' + p + '</section>'; }).join('\n');
    return shell(title, author, rtl ? 'ar' : 'en', rtl, body + '<style>.li-tbl{overflow-x:auto;margin:1em 0}.li-tbl table{border-collapse:collapse;width:100%;font-size:.9em}.li-tbl td{border:1px solid rgba(120,100,70,.35);padding:.35em .6em;vertical-align:top}sup a{text-decoration:none}</style>');
  }
  function splitChapters(html) {
    var re = /<h1(?![^>]*doc-title)[ >]/g, idx = [], m; while ((m = re.exec(html))) idx.push(m.index);
    var lvl = 'h1';
    if (idx.length < 2) { re = /<h2[ >]/g; idx = []; while ((m = re.exec(html))) idx.push(m.index); lvl = 'h2'; }
    if (idx.length < 2 || idx.length > 400) return [html];
    var out = [], pre = html.slice(0, idx[0]); if (pre.replace(/<[^>]+>/g, '').trim()) out.push(pre);
    idx.forEach(function (s, i) { out.push(html.slice(s, i + 1 < idx.length ? idx[i + 1] : html.length)); });
    return out;
  }

  // =====================================================================  PDF
  var pdfLib = null;
  function loadPdfJs() {
    if (pdfLib) return Promise.resolve(pdfLib);
    if (window['pdfjs-dist/build/pdf']) { pdfLib = window['pdfjs-dist/build/pdf']; return Promise.resolve(pdfLib); }
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = 'pdfjs/pdf.min.js'; s.onload = function () { pdfLib = window['pdfjs-dist/build/pdf']; pdfLib.GlobalWorkerOptions.workerSrc = 'pdfjs/pdf.worker.min.js'; res(pdfLib); }; s.onerror = function () { rej(new Error('pdfjs')); }; document.head.appendChild(s);
    });
  }
  var G = window.__PDFGEO, median = G.median, pageLines = G.pageLines, readingOrder = G.readingOrder;

  function pdfToHtml(buf, name, onProgress) {
    return loadPdfJs().then(function (lib) {
      return lib.getDocument({ data: new Uint8Array(buf.slice(0)), cMapUrl: 'pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'pdfjs/standard_fonts/' }).promise.then(function (doc) {
        var n = doc.numPages, pages = [], chars = 0, meta = {};
        var step = function (i) {
          if (i > n) return Promise.resolve();
          return doc.getPage(i).then(function (pg) {
            var vp = pg.getViewport({ scale: 1 });
            return pg.getTextContent().then(function (tc) {
              var segs = pageLines(tc.items, vp.width, vp.height); segs.forEach(function (s) { chars += s.chars; });
              pages.push({ i: i, w: vp.width, h: vp.height, segs: segs }); if (onProgress) onProgress(Math.round(i / n * 90));
              pg.cleanup(); return step(i + 1);
            });
          });
        };
        return step(1).then(function () {
          if (chars < Math.min(n, 10) * 40) { var e = new Error('scanned'); throw e; }
          return Promise.all([doc.getMetadata().catch(function () { return null; }), outlineStarts(doc)]).then(function (r) {
            meta = (r[0] && r[0].info) || {};
            var built = buildFromPages(pages, r[1]), rtl = isArabic(built.text.slice(0, 6000));
            var title = (meta.Title && /\S/.test(meta.Title) && meta.Title.length < 160 ? meta.Title.trim() : '') || built.firstHeading || String(name || '').replace(/\.[^.]+$/, '');
            var author = (meta.Author || '').trim();
            return coverBlob(doc).then(function (cv) {
              return { html: finishPdfBook(title, author, rtl, built), title: title, author: author, cover: cv };
            });
          });
        });
      });
    });
  }
  function coverBlob(doc) {
    return doc.getPage(1).then(function (pg) {
      var vp = pg.getViewport({ scale: 0.7 }), c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      return pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.then(function () { return new Promise(function (res) { c.toBlob(function (b) { res(b ? { ext: 'jpg', blob: b } : null); }, 'image/jpeg', 0.8); }); });
    }).catch(function () { return null; });
  }
  // Page index for each top-level outline entry (empty when the PDF has no outline).
  function outlineStarts(doc) {
    return doc.getOutline().then(function (ol) {
      if (!ol || ol.length < 2) return [];
      var out = [];
      return ol.reduce(function (p, it) {
        return p.then(function () {
          var d = it.dest; var get = typeof d === 'string' ? doc.getDestination(d) : Promise.resolve(d);
          return get.then(function (dd) { if (!dd) return; return doc.getPageIndex(dd[0]).then(function (ix) { out.push({ page: ix + 1, title: String(it.title || '').trim() }); }); }).catch(function () {});
        });
      }, Promise.resolve()).then(function () { out.sort(function (a, b) { return a.page - b.page; }); return out.filter(function (o, i) { return o.title && (!i || o.page !== out[i - 1].page || o.title !== out[i - 1].title); }); });
    }).catch(function () { return []; });
  }

  function buildFromPages(pages, outline) {
    var st = G.bodyStats(pages), body = st.body, pitch = st.pitch;
    // running headers / footers
    var freq = {}, norm = function (t) { return t.replace(/\d+/g, '#').replace(/\s+/g, ' ').toLowerCase().slice(0, 80); };
    pages.forEach(function (p) { var seen = {}; p.segs.forEach(function (s) { if (s.y > p.h * 0.9 || s.y < p.h * 0.1) { var k = norm(s.txt); if (!seen[k]) { seen[k] = 1; freq[k] = (freq[k] || 0) + 1; } } }); });
    var minRep = Math.max(3, Math.round(pages.length * 0.3)), out = [];
    pages.forEach(function (p) {
      var segs = p.segs.filter(function (s) {
        var edge = s.y > p.h * 0.9 || s.y < p.h * 0.1;
        if (edge && pages.length >= 4 && freq[norm(s.txt)] >= minRep) return false;
        if (edge && /^[\-–—\s]*(\d{1,4}|[ivxlc]{1,6}|page\s+\d+|صفحة\s+\d+)[\-–—\s]*$/i.test(s.txt)) return false;
        return true;
      });
      G.paragraphs(segs, p.w, p.h, body, pitch).forEach(function (it) {
        it.page = p.i; var prev = out[out.length - 1];
        if (it.cont && prev && !prev.head && !prev.li && !it.head && !it.li && !/[.!?؟:”"»)\]]$/.test(prev.txt)) prev.txt = /[A-Za-z]-$/.test(prev.txt) && /^[a-z]/.test(it.txt) ? prev.txt.slice(0, -1) + it.txt : prev.txt + ' ' + it.txt;   // the sentence continues from the previous column or page
        else out.push(it);
      });
    });
    return { items: out, text: out.map(function (o) { return o.txt; }).join('\n'), firstHeading: (out.filter(function (o) { return o.head; })[0] || {}).txt || '', outline: outline };
  }

  function finishPdfBook(title, author, rtl, built) {
    var parts = [], cur = [], chapStarts = {};
    var items = built.items, ol = built.outline || [];
    if (ol.length >= 2) ol.forEach(function (o) { chapStarts[o.page] = chapStarts[o.page] || o.title; });
    var html = [], open = null, listOpen = false;
    var closeList = function () { if (listOpen) { cur.push('</ul>'); listOpen = false; } };
    var newChapter = function (title) { closeList(); if (cur.length) parts.push(cur.join('\n')); cur = []; if (title) cur.push('<h1 dir="auto" data-lv="1">' + esc(title) + '</h1>'); };
    var started = {}, hasTop = items.some(function (i) { return i.head && i.lvl === 1; });
    items.forEach(function (it) {
      if (ol.length >= 2 && chapStarts[it.page] && !started[it.page]) {
        started[it.page] = 1;
        var t = chapStarts[it.page], tn = t.toLowerCase().replace(/\s+/g, ' ');
        if (it.head && it.txt.toLowerCase().replace(/\s+/g, ' ').indexOf(tn.slice(0, 12)) === 0) { newChapter(''); } else newChapter(t);
      } else if (ol.length < 2 && it.head && it.lvl === (hasTop ? 1 : 2) && cur.length) { newChapter(''); }
      if (it.head) { closeList(); var l = Math.min(Math.max(it.lvl, 1), 3); cur.push('<h' + l + ' dir="auto" data-lv="' + l + '">' + esc(it.txt) + '</h' + l + '>'); }
      else if (it.li) { if (!listOpen) { cur.push('<ul>'); listOpen = true; } cur.push('<li dir="auto">' + esc(it.txt.replace(/^([•●▪◦‣·\-–—*]|\(?\d{1,2}[.)]|[a-z][.)])\s+/, '')) + '</li>'); }
      else { closeList(); cur.push('<p dir="auto">' + esc(it.txt) + '</p>'); }
    });
    closeList(); if (cur.length) parts.push(cur.join('\n'));
    if (parts.length === 1 && items.length > 60) { var chunks = [], para = parts[0].split('\n'), sz = Math.ceil(para.length / Math.ceil(para.length / 40)); for (var i = 0; i < para.length; i += sz) chunks.push(para.slice(i, i + sz).join('\n')); parts = chunks; }
    var body = parts.map(function (p, i) { return '<section class="epub-ch" id="ch' + (i + 1) + '">' + p + '</section>'; }).join('\n');
    return shell(title, author, rtl ? 'ar' : 'en', rtl, body);
  }

  F.docxToHtml = docxToHtml; F.pdfToHtml = pdfToHtml; F.EXT2 = /\.(docx)$/i;
})();
