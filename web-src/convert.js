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
  function finishBook(title, author, rtl, flatHtml, kind) { return bookPage(title, author, rtl, splitChapters(flatHtml), kind || 'DOCX'); }
  // ---- the finished book page: title page, contents, chapters, previous/next, responsive typography ----
  var BOOK_CSS = ':root{--ink:#1c2b33;--paper:#fbf7ec;--mute:rgba(90,84,66,.78);--line:rgba(130,112,80,.32);--acc:#a85a38}' +
    '*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}' +
    'body{margin:0;background:var(--paper);color:var(--ink);font-family:"Noto Naskh Arabic","Amiri","Traditional Arabic","Iowan Old Style","Palatino Linotype",Georgia,serif;font-size:clamp(17px,calc(15px + .55vw),21px);line-height:1.95;overflow-wrap:break-word;word-break:normal;text-rendering:optimizeLegibility}' +
    '.bk{max-width:42rem;margin:0 auto;padding:0 clamp(16px,5vw,36px)}' +
    '.bk-title{min-height:92vh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:12vh 0 8vh;border-bottom:1px solid var(--line)}' +
    '.bk-orn{width:64px;height:1px;background:var(--acc);margin:0 auto 26px;position:relative}.bk-orn:after{content:"";position:absolute;left:50%;top:-4px;width:9px;height:9px;margin-left:-4px;background:var(--acc);transform:rotate(45deg)}' +
    '.bk-title h1{font-size:clamp(1.9rem,6.4vw,3rem);line-height:1.3;margin:0 0 .5em;font-weight:700;text-wrap:balance}' +
    '.bk-by{font-size:1.2em;color:var(--acc);margin:0 0 1.2em}.bk-meta{font-size:.82em;opacity:.7;margin:0 0 2.2em}' +
    '.bk-go{display:inline-block;padding:.65em 2em;border:1px solid var(--acc);border-radius:999px;color:var(--acc);text-decoration:none;font-weight:700;font-size:.95em}.bk-go:active{opacity:.7}' +
    '.bk-toc{padding:44px 0 20px;border-bottom:1px solid var(--line)}.bk-toc h2{text-align:center;font-size:1.35em;margin:0 0 1em}' +
    '.bk-toc ol{list-style:none;margin:0;padding:0;counter-reset:c}.bk-toc li{counter-increment:c;border-bottom:1px dashed var(--line)}' +
    '.bk-toc a{display:flex;gap:.8em;align-items:baseline;padding:.55em .2em;color:inherit;text-decoration:none;font-size:.95em;line-height:1.6}.bk-toc a:before{content:counter(c);min-width:2em;text-align:center;opacity:.55;font-size:.85em}.bk-toc a:hover{color:var(--acc)}' +
    '.epub-ch{padding:54px 0 30px;border-bottom:1px solid var(--line);scroll-margin-top:12px}.epub-ch:last-of-type{border-bottom:0}' +
    '.bk-k{text-align:center;font-size:.78em;letter-spacing:.14em;text-transform:uppercase;color:var(--acc);margin:0 0 .6em;font-family:system-ui,"Segoe UI",sans-serif}' +
    'h1,h2,h3,h4{line-height:1.45;font-weight:700;text-wrap:balance}' +
    '.epub-ch>h1:first-child,.epub-ch>h2:first-child{text-align:center;font-size:1.75em;margin:.2em 0 1.1em}.epub-ch>h1:first-child:after,.epub-ch>h2:first-child:after{content:"";display:block;width:48px;height:1px;background:var(--acc);margin:.6em auto 0}' +
    'h1{font-size:1.6em;margin:1.6em 0 .6em}h2{font-size:1.35em;margin:1.7em 0 .5em}h3{font-size:1.15em;margin:1.5em 0 .4em}h4{font-size:1em;margin:1.3em 0 .3em}' +
    'p{margin:0 0 1.05em;text-align:justify;hyphens:auto;-webkit-hyphens:auto;orphans:3;widows:3}[dir=ltr] p+p{text-indent:0}' +
    'ul,ol{margin:0 0 1.1em;padding-inline-start:1.6em}li{margin:.25em 0}li>p{margin:0}' +
    'blockquote{margin:1.2em 0;padding:.2em 1.1em;border-inline-start:3px solid var(--acc);opacity:.92}' +
    'img,svg,video{max-width:100%;height:auto;display:block;margin:1.2em auto;border-radius:4px}figure{margin:1.2em 0}figcaption{text-align:center;font-size:.85em;opacity:.75}' +
    'pre,code{font-family:ui-monospace,Consolas,monospace;font-size:.85em;direction:ltr;text-align:left}pre{overflow:auto;padding:.8em 1em;border:1px solid var(--line);border-radius:8px;white-space:pre-wrap}' +
    'a{color:var(--acc)}hr{border:0;border-top:1px solid var(--line);margin:2em 0}' +
    '.bk-nav{display:flex;justify-content:space-between;gap:12px;margin:2.2em 0 0;padding-top:1.1em;border-top:1px solid var(--line);font-size:.88em;font-family:system-ui,"Segoe UI",Tahoma,sans-serif}' +
    '.bk-nav a{color:inherit;text-decoration:none;padding:.5em .9em;border:1px solid var(--line);border-radius:10px;max-width:46%;line-height:1.4;overflow:hidden;text-overflow:ellipsis}.bk-nav a:hover{border-color:var(--acc);color:var(--acc)}.bk-nav .up{margin:0 auto}' +
    '@media(max-width:520px){p{text-align:start}.bk-title{min-height:86vh}.epub-ch{padding-top:40px}}' +
    '@media print{.bk-title,.epub-ch{min-height:0;border:0;page-break-after:always}.bk-nav,.bk-go{display:none}body{font-size:12pt}}';
  function plainOf(h) { return String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&quot;/g, "'").replace(/\s+/g, ' ').trim(); }
  function bookPage(title, author, rtl, parts, kind) {
    var ar = !!rtl, T = function (a, e) { return ar ? a : e; }, N = function (n) { return ar ? String(n).replace(/\d/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'[d]; }) : String(n); };
    var heads = parts.map(function (p, i) { var m = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(p); var t = m ? plainOf(m[1]) : ''; return t && t.length < 140 ? t : T('القسم ', 'Part ') + N(i + 1); });
    var words = plainOf(parts.join(' ')).split(' ').length, mins = Math.max(1, Math.round(words / (ar ? 180 : 230)));
    var h = ['<main class="bk">'];
    h.push('<header class="bk-title"><div class="bk-orn"></div><h1 dir="auto">' + esc(title) + '</h1>' + (author ? '<p class="bk-by" dir="auto">' + esc(author) + '</p>' : '') +
      '<p class="bk-meta">' + esc(kind) + ' · ' + N(parts.length) + ' ' + T(parts.length === 1 ? 'قسم' : 'أقسام', parts.length === 1 ? 'section' : 'sections') + ' · ' + T('نحو ', '~') + N(mins) + ' ' + T('دقيقة قراءة', 'min read') + '</p>' +
      '<a class="bk-go" href="#' + (parts.length > 1 ? 'toc' : 'ch1') + '">' + T('ابدأ القراءة', 'Start reading') + '</a></header>');
    if (parts.length > 1) h.push('<nav class="bk-toc" id="toc" aria-label="' + T('المحتويات', 'Contents') + '"><h2>' + T('المحتويات', 'Contents') + '</h2><ol>' + heads.map(function (t, i) { return '<li><a href="#ch' + (i + 1) + '" dir="auto">' + esc(t) + '</a></li>'; }).join('') + '</ol></nav>');
    parts.forEach(function (p, i) {
      var nav = '';
      if (parts.length > 1) nav = '<div class="bk-nav">' + (i > 0 ? '<a href="#ch' + i + '" dir="auto">' + (ar ? '→ ' : '← ') + esc(heads[i - 1]) + '</a>' : '<span></span>') + '<a class="up" href="#toc">' + T('المحتويات', 'Contents') + '</a>' + (i + 1 < parts.length ? '<a href="#ch' + (i + 2) + '" dir="auto">' + esc(heads[i + 1]) + (ar ? ' ←' : ' →') + '</a>' : '<span></span>') + '</div>';
      h.push('<section class="epub-ch" id="ch' + (i + 1) + '">' + p + nav + '</section>');
    });
    h.push('</main>');
    return shell(title, author, ar ? 'ar' : 'en', rtl, h.join('\n') + '<style>.li-tbl{overflow-x:auto;margin:1.2em 0;-webkit-overflow-scrolling:touch}.li-tbl table{border-collapse:collapse;width:100%;font-size:.88em;line-height:1.55}.li-tbl td,.li-tbl th{border:1px solid var(--line);padding:.4em .65em;vertical-align:top;text-align:start}.li-tbl th{font-weight:700;background:rgba(130,112,80,.1)}</style>', BOOK_CSS);
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

  // ================= OCR: scanned / photographed pages -> text (works offline) =================
  var absUrl = function (u) { return new URL(u, location.href).href; };
  function loadTess() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise(function (res, rej) { var sc = document.createElement('script'); sc.src = 'ocr/tesseract.min.js'; sc.onload = res; sc.onerror = function () { rej(new Error('ocr-missing')); }; document.head.appendChild(sc); });
  }
  function makeWorker(langs, onP) {
    return loadTess().then(function () {
      return window.Tesseract.createWorker(langs, 1, { workerPath: absUrl('ocr/worker.min.js'), corePath: absUrl('ocr/'), langPath: absUrl('ocr/lang/'), gzip: true, workerBlobURL: false, logger: function (m) { if (onP && m && m.status === 'recognizing text') onP(m.progress || 0); } });
    });
  }
  // Removes light watermarks, stamps and paper texture, keeping only the dark text.
  function cleanCanvas(cv) {
    var w = cv.width, h = cv.height, ctx = cv.getContext('2d'), im = ctx.getImageData(0, 0, w, h), d = im.data, n = w * h, lum = new Uint8Array(n), hist = new Array(256).fill(0), i, j;
    for (i = 0, j = 0; j < n; i += 4, j++) { var l = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; lum[j] = l; hist[l]++; }
    // three-class Otsu: dark text | watermark / shading | paper
    var P = new Array(257).fill(0), S = new Array(257).fill(0); for (i = 0; i < 256; i++) { P[i + 1] = P[i] + hist[i]; S[i + 1] = S[i] + i * hist[i]; }
    var tot = P[256], mt = S[256] / tot, best = -1, t1 = 90, t2 = 190;
    var cls = function (a, b) { var wgt = P[b] - P[a]; if (!wgt) return 0; var m = (S[b] - S[a]) / wgt; return wgt * (m - mt) * (m - mt); };
    for (var a = 20; a < 200; a += 2) for (var b = a + 12; b < 250; b += 2) { var v = cls(0, a) + cls(a, b) + cls(b, 256); if (v > best) { best = v; t1 = a; t2 = b; } }
    var T = Math.max(100, Math.min(175, Math.round(t1 + (t2 - t1) * 0.5)));
    for (i = 0, j = 0; j < n; i += 4, j++) {
      var mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]), dark = lum[j] < T && !(mx - mn > 50 && lum[j] > 60);
      var vv = dark ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = vv; d[i + 3] = 255;
    }
    ctx.putImageData(im, 0, 0); return cv;
  }
  function drawBitmap(bm, maxSide) {
    var sc = Math.min(1.6, maxSide / Math.max(bm.width, bm.height)), cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(bm.width * sc)); cv.height = Math.max(1, Math.round(bm.height * sc));
    var c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height); c.drawImage(bm, 0, 0, cv.width, cv.height); return cv;
  }
  function blobBitmap(b) { return (window.createImageBitmap ? createImageBitmap(b, { imageOrientation: 'from-image' }).catch(function () { return createImageBitmap(b); }) : Promise.reject(new Error('nobitmap'))); }
  var arRe = /[؀-ۿ]/g, laRe = /[A-Za-z]/g;
  // One recognised page -> paragraphs [{t, big}]
  function pageParas(data) {
    var out = [], lines = [];
    var blocks = data && data.blocks;
    if (blocks && blocks.length) {
      blocks.forEach(function (bk) { (bk.paragraphs || []).forEach(function (pa) {
        var ls = (pa.lines || []).map(function (ln) { var bb = ln.bbox || {}; return { t: String(ln.text || '').replace(/\s+/g, ' ').trim(), h: (bb.y1 || 0) - (bb.y0 || 0) }; }).filter(function (x) { return x.t; });
        if (ls.length) { out.push({ ls: ls }); ls.forEach(function (x) { if (x.h > 0) lines.push(x.h); }); }
      }); });
    }
    if (!out.length) { String((data && data.text) || '').split(/\n\s*\n/).forEach(function (blk) { var ls = blk.split('\n').map(function (t) { return { t: t.replace(/\s+/g, ' ').trim(), h: 0 }; }).filter(function (x) { return x.t; }); if (ls.length) out.push({ ls: ls }); }); }
    var med = median(lines) || 0;
    return out.map(function (pa) {
      var txt = '', hs = pa.ls.map(function (x) { return x.h; }).filter(Boolean);
      pa.ls.forEach(function (x, i) { if (!i) txt = x.t; else if (/[A-Za-z]-$/.test(txt) && /^[a-z]/.test(x.t)) txt = txt.slice(0, -1) + x.t; else txt += ' ' + x.t; });
      var ph = median(hs) || 0;
      return { t: txt.trim(), big: !!(med && ph && ph > med * 1.3 && pa.ls.length <= 3 && txt.length < 120) };
    }).filter(function (x) { var L = (x.t.match(arRe) || []).length + (x.t.match(laRe) || []).length; return L >= 2 && !/^[\d\s.\-–—]+$/.test(x.t); });
  }
  function ocrBuild(pagesParas) {
    var items = [], last = null;
    pagesParas.forEach(function (pp, pi) {
      pp.forEach(function (x, k) {
        var txt = String(x.t || '').normalize('NFKC').replace(/[|¦]+/g, ' ').replace(/\s+/g, ' ').trim(); if (!txt) return;
        if (x.big) { items.push({ txt: txt, head: true, lvl: 2, page: pi + 1 }); last = null; return; }
        if (last && k === 0 && !/[.!?؟:…"”»)\]]$/.test(last.txt) && !last.head) { last.txt += ' ' + txt; return; }
        last = { txt: txt, page: pi + 1 }; items.push(last);
      });
    });
    return { items: items, text: items.map(function (o) { return o.txt; }).join('\n'), firstHeading: (items.filter(function (o) { return o.head; })[0] || {}).txt || '', outline: [] };
  }
  // Picks the OCR language pack from the first recognised page (Arabic letters, or common words of each Latin language).
  var STOP = { eng: /\b(the|and|of|to|is|that|with|for|are|was)\b/gi, fra: /\b(le|la|les|des|est|une|et|que|pour|dans|qui)\b/gi, spa: /\b(el|los|las|del|una|que|por|con|para|es|se)\b/gi, ita: /\b(il|gli|della|che|per|con|una|sono|non|di|le)\b/gi, ind: /\b(yang|dan|di|ini|itu|dengan|untuk|dari|pada|adalah)\b/gi };
  function detectLang(tx) {
    if (!tx || tx.length < 60) return '';
    var a = (tx.match(arRe) || []).length, l = (tx.match(laRe) || []).length;
    if (a > l) return 'ara+eng';
    var best = 'eng', bs = -1; Object.keys(STOP).forEach(function (k) { var c = (tx.match(STOP[k]) || []).length; if (c > bs) { bs = c; best = k; } });
    return bs >= 3 ? (best === 'eng' ? 'eng' : best + '+eng') : 'ara+eng+fra+spa+ita+ind';
  }
  // pages: array of {canvas()} producers. Returns built structure. onP(pct,label)
  function ocrRun(count, getCanvas, onP, cx) {
    var t0 = Date.now(), all = [], worker = null, langs = 'ara+eng+fra+spa+ita+ind', done = 0;
    var eta = function () { if (!done) return ''; var per = (Date.now() - t0) / done, left = Math.max(0, Math.round(per * (count - done) / 60000)); return left ? (' · ' + (EN() ? '~' + left + ' min left' : 'متبقي نحو ' + left + ' دقيقة')) : ''; };
    var label = function (i) { return (EN() ? 'Reading text from page ' : 'جارٍ قراءة النص من الصفحة ') + i + (EN() ? ' of ' : ' من ') + count + eta(); };
    var step = function (i) {
      if (i > count) return Promise.resolve();
      if (cx && cx.stop) return Promise.reject(new Error('cancel'));
      if (onP) onP(Math.round((i - 1) / count * 95), label(i));
      return getCanvas(i).then(function (cv) {
        cleanCanvas(cv);
        return worker.recognize(cv, {}, { blocks: true, text: true }).then(function (r) {
          cv.width = cv.height = 1;
          var pp = pageParas(r.data); all.push(pp); done++;
          if (i === 1 && count > 1) {
            var nl = detectLang(pp.map(function (x) { return x.t; }).join(' '));
            if (nl && nl !== langs) { langs = nl; return worker.terminate().then(function () { return makeWorker(nl); }).then(function (w) { worker = w; }); }
          }
        });
      }).then(function () { return step(i + 1); });
    };
    return makeWorker(langs).then(function (w) { worker = w; return step(1); }).then(function () { return worker.terminate().catch(function () {}); }, function (e) { try { worker && worker.terminate(); } catch (x) {} throw e; }).then(function () { return ocrBuild(all); });
  }
  var EN = function () { try { return typeof LANG !== 'undefined' && LANG !== 'ar'; } catch (e) { return false; } };
  function ocrPdf(doc, name, onP, cx) {
    return ocrRun(doc.numPages, function (i) {
      return doc.getPage(i).then(function (pg) {
        var v1 = pg.getViewport({ scale: 1 }), sc = Math.min(3, 2300 / Math.max(v1.width, v1.height)), vp = pg.getViewport({ scale: sc }), cv = document.createElement('canvas');
        cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
        var c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
        return pg.render({ canvasContext: c, viewport: vp }).promise.then(function () { pg.cleanup(); return cv; });
      });
    }, onP, cx);
  }
  // Photos / images (camera or gallery) -> book
  function imagesToHtml(files, name, onP, cx) {
    var list = [].slice.call(files);
    return ocrRun(list.length, function (i) { return blobBitmap(list[i - 1]).then(function (bm) { var cv = drawBitmap(bm, 2400); try { bm.close(); } catch (e) {} return cv; }); }, onP, cx).then(function (built) {
      if (!built.items.length) throw new Error('noText');
      var rtl = isArabic(built.text.slice(0, 6000)), title = String(name || '').replace(/\.[^.]+$/, '') || built.firstHeading || 'Scan';
      return blobBitmap(list[0]).then(function (bm) { var cv = drawBitmap(bm, 520); try { bm.close(); } catch (e) {} return new Promise(function (res) { cv.toBlob(function (b) { res(b ? { ext: 'jpg', blob: b } : null); }, 'image/jpeg', 0.82); }); }).catch(function () { return null; }).then(function (cv) {
        return { html: finishPdfBook(title, '', rtl, built), title: title, author: '', cover: cv };
      });
    });
  }

  function pdfToHtml(buf, name, onProgress, opts) {
    opts = opts || {};
    return loadPdfJs().then(function (lib) {
      return lib.getDocument({ data: new Uint8Array(buf.slice(0)), cMapUrl: 'pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'pdfjs/standard_fonts/' }).promise.then(function (doc) {
        var n = doc.numPages, pages = [], chars = 0, meta = {};
        var step = function (i) {
          if (i > n) return Promise.resolve();
          return doc.getPage(i).then(function (pg) {
            var vp = pg.getViewport({ scale: 1 });
            return pg.getTextContent().then(function (tc) {
              var segs = pageLines(tc.items, vp.width, vp.height); segs.forEach(function (s) { chars += s.chars; });
              pages.push({ i: i, w: vp.width, h: vp.height, segs: segs }); if (onProgress && !opts.ocr) onProgress(Math.round(i / n * 90));
              pg.cleanup(); return step(i + 1);
            });
          });
        };
        return step(1).then(function () {
          if (chars < Math.min(n, 10) * 40) {
            if (!opts.ocr) { var e = new Error('scanned'); e.pages = n; throw e; }
            return doc.getMetadata().catch(function () { return null; }).then(function (mm) {
              return ocrPdf(doc, name, onProgress, opts.cancel).then(function (built) {
                if (!built.items.length) throw new Error('noText');
                var meta2 = (mm && mm.info) || {}, rtl = isArabic(built.text.slice(0, 6000));
                var title = (meta2.Title && /\S/.test(meta2.Title) && meta2.Title.length < 160 ? meta2.Title.trim() : '') || String(name || '').replace(/\.[^.]+$/, '');
                return coverBlob(doc).then(function (cv) { return { html: finishPdfBook(title, (meta2.Author || '').trim(), rtl, built), title: title, author: (meta2.Author || '').trim(), cover: cv, ocr: true }; });
              });
            });
          }
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
    return bookPage(title, author, rtl, parts, 'PDF');
  }

  F.docxToHtml = docxToHtml; F.pdfToHtml = pdfToHtml; F.imagesToHtml = imagesToHtml; F._ocr = { cleanCanvas: cleanCanvas, pageParas: pageParas, ocrBuild: ocrBuild }; F.IMG = /\.(jpe?g|png|webp|bmp)$/i; F.EXT2 = /\.(docx)$/i;
})();
