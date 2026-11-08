/* Living Ideas — extra book formats: TXT/MD, FB2, CBZ, MOBI/AZW/AZW3.
   Each converter turns a file into one self-contained reading HTML (same look as the EPUB converter).
   MOBI/AZW3 parsing uses foliate-js (MIT) — see lib/FOLIATE-LICENSE.txt. */
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var isArabic = function (t) { t = String(t || '').slice(0, 4000); var a = (t.match(/[؀-ۿ]/g) || []).length, l = (t.match(/[A-Za-z]/g) || []).length; return a > l; };
  var RTL_LANG = /^(ar|fa|he|ur|ps|ku)/i;
  var CSS = 'body{font-family:"Amiri","EB Garamond",Georgia,serif;line-height:1.9;font-size:20px;max-width:760px;margin:0 auto;padding:40px 22px 90px;background:#fbf7ec;color:#14262e}.epub-ch{margin-bottom:56px;padding-bottom:36px;border-bottom:1px solid #d9cdb0}img,svg{max-width:100%;height:auto}h1,h2,h3{line-height:1.4}a{color:#a85a38}table{max-width:100%;display:block;overflow:auto}blockquote{margin:1em 0;padding:0 1em;border-inline-start:3px solid #d9cdb0;color:#3b4f57}.poem{margin:1em 0;padding:0 1em}.stanza{margin-bottom:1em}.stanza p{margin:0}p.ta{text-align:end;font-style:italic}';
  var CSS_COMIC = 'html,body{margin:0;padding:0;background:#111}img{display:block;width:100%;max-width:900px;height:auto;margin:0 auto}';
  var MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml' };
  var extOf = function (n) { var m = /\.([A-Za-z0-9]+)$/.exec(n || ''); return m ? m[1].toLowerCase() : ''; };

  function shell(title, author, lang, rtl, body, css) {
    return '<!DOCTYPE html><html lang="' + esc(lang || (rtl ? 'ar' : 'en')) + '" dir="' + (rtl ? 'rtl' : 'ltr') + '"><head><meta charset="utf-8"><title>' + esc(title) + '</title>' + (author ? '<meta name="author" content="' + esc(author) + '">' : '') + '<meta name="viewport" content="width=device-width,initial-scale=1"><style>' + (css || CSS) + '</style></head><body>' + body + '</body></html>';
  }
  function sniff(u8) {
    if (u8[0] === 0xFF && u8[1] === 0xD8) return 'jpg';
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E) return 'png';
    if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'gif';
    if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[8] === 0x57) return 'webp';
    if (u8[0] === 0x42 && u8[1] === 0x4D) return 'bmp';
    return '';
  }
  // Blob with a reliable image MIME type (MOBI resources come without one).
  function typedImage(blob) {
    return blob.slice(0, 16).arrayBuffer().then(function (ab) {
      var e = sniff(new Uint8Array(ab));
      if (!e) { var t = blob.type; return t && /^image\//.test(t) ? { ext: t.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg'), blob: blob } : null; }
      return { ext: e, blob: new Blob([blob], { type: MIME[e] }) };
    });
  }
  function toDataURL(blob) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(blob); }); }
  function b64Blob(b64, type) { var s = atob(b64.replace(/\s+/g, '')), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new Blob([u], { type: type }); }

  // ---------------- TXT / Markdown ----------------
  function decodeText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) {}
    try { var t = new TextDecoder('windows-1256').decode(buf); return t; } catch (e2) {}
    return new TextDecoder('latin1').decode(buf);
  }
  function txtToHtml(buf, name) {
    var text = decodeText(buf).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
    if (!text) return Promise.reject(new Error('empty'));
    var title = String(name || '').replace(/\.[^.]+$/, ''), blocks = text.split(/\n{2,}/);
    if (blocks.length < 4 && text.length > 2000) blocks = text.split(/\n/);   // files that use one line per paragraph
    var out = [];
    blocks.forEach(function (b) {
      b = b.trim(); if (!b) return;
      var h = /^(#{1,3})\s+(.+)$/.exec(b);
      if (h && b.indexOf('\n') < 0) { if (!out.length && h[1].length === 1) title = h[2].trim(); out.push('<h' + (h[1].length + 1) + ' dir="auto">' + esc(h[2]) + '</h' + (h[1].length + 1) + '>'); return; }
      out.push('<p dir="auto">' + esc(b).replace(/\n/g, '<br>') + '</p>');
    });
    var rtl = isArabic(text);
    return Promise.resolve({ html: shell(title, '', rtl ? 'ar' : 'en', rtl, '<section class="epub-ch">' + out.join('\n') + '</section>'), title: title, author: '', cover: null });
  }

  // ---------------- FB2 ----------------
  function fb2Text(buf) {
    var head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(300, buf.byteLength))), m = /encoding=["']([\w-]+)["']/i.exec(head), enc = m ? m[1] : 'utf-8';
    try { return new TextDecoder(enc).decode(buf); } catch (e) { return new TextDecoder('utf-8').decode(buf); }
  }
  var attr = function (el, local) { for (var i = 0; i < el.attributes.length; i++) if (el.attributes[i].localName === local) return el.attributes[i].value; return ''; };
  function fb2ToHtml(buf) {
    var doc = new DOMParser().parseFromString(fb2Text(buf), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagName('FictionBook').length) return Promise.reject(new Error('fb2'));
    var first = function (root, tag) { return root.getElementsByTagName(tag)[0]; }, txt = function (el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; };
    var ti = first(doc, 'title-info'), title = txt(ti && first(ti, 'book-title')) || 'FB2', lang = txt(ti && first(ti, 'lang'));
    var au = ti && first(ti, 'author'), author = au ? ['first-name', 'middle-name', 'last-name'].map(function (t) { return txt(first(au, t)); }).filter(Boolean).join(' ') || txt(first(au, 'nickname')) : '';
    var bins = {}; [].forEach.call(doc.getElementsByTagName('binary'), function (b) { bins[b.getAttribute('id')] = { type: b.getAttribute('content-type') || 'image/jpeg', b64: b.textContent }; });
    var imgTag = function (el) {
      var id = attr(el, 'href').replace(/^#/, ''), bn = bins[id]; if (!bn) return '';
      return '<img alt="" src="data:' + bn.type + ';base64,' + bn.b64.replace(/\s+/g, '') + '">';
    };
    var wrap = function (tag, el, cls, depth) { return '<' + tag + (cls ? ' class="' + cls + '"' : '') + '>' + kids(el, depth) + '</' + tag + '>'; };
    function kids(el, depth) { var s = ''; for (var n = el.firstChild; n; n = n.nextSibling) s += conv(n, depth); return s; }
    function conv(n, depth) {
      if (n.nodeType === 3) return esc(n.nodeValue);
      if (n.nodeType !== 1) return '';
      switch (n.localName) {
        case 'section': return depth === 0 ? wrap('section', n, 'epub-ch', depth + 1) : wrap('div', n, '', depth + 1);
        case 'title': return '<h' + Math.min(depth + 1, 4) + '>' + [].map.call(n.children, function (p) { return kids(p, depth); }).join('<br>') + '</h' + Math.min(depth + 1, 4) + '>';
        case 'subtitle': return wrap('h3', n, '', depth);
        case 'p': return wrap('p', n, '', depth);
        case 'empty-line': return '<br>';
        case 'emphasis': return wrap('em', n, '', depth);
        case 'strong': return wrap('strong', n, '', depth);
        case 'strikethrough': return wrap('s', n, '', depth);
        case 'sub': return wrap('sub', n, '', depth);
        case 'sup': return wrap('sup', n, '', depth);
        case 'code': return wrap('code', n, '', depth);
        case 'a': return attr(n, 'type') === 'note' ? '<sup>' + kids(n, depth) + '</sup>' : kids(n, depth);
        case 'image': return imgTag(n);
        case 'poem': return wrap('div', n, 'poem', depth);
        case 'stanza': return wrap('div', n, 'stanza', depth);
        case 'v': return wrap('p', n, '', depth);
        case 'text-author': return wrap('p', n, 'ta', depth);
        case 'epigraph': case 'cite': case 'annotation': return wrap('blockquote', n, '', depth);
        case 'table': case 'tr': case 'td': case 'th': return kids(n, depth);
        default: return kids(n, depth);
      }
    }
    var body = [].filter.call(doc.getElementsByTagName('body'), function (b) { return b.getAttribute('name') !== 'notes'; }).map(function (b) {
      var secs = [].filter.call(b.children, function (c) { return c.localName === 'section'; }), head = [].filter.call(b.children, function (c) { return c.localName !== 'section'; });
      return head.map(function (c) { return conv(c, 0); }).join('') + secs.map(function (c) { return conv(c, 0); }).join('\n');
    }).join('\n');
    if (txt(doc.documentElement).length < 3) return Promise.reject(new Error('fb2-empty'));
    var rtl = RTL_LANG.test(lang) || isArabic(txt(doc.getElementsByTagName('body')[0]));
    var res = { html: shell(title, author, lang, rtl, body), title: title, author: author, cover: null };
    var cp = ti && first(ti, 'coverpage'), ci = cp && first(cp, 'image'), cid = ci && attr(ci, 'href').replace(/^#/, '');
    if (cid && bins[cid]) { var t = bins[cid].type, e = (t.split('/')[1] || 'jpg').replace('jpeg', 'jpg'); try { res.cover = { ext: e, blob: b64Blob(bins[cid].b64, t) }; } catch (x) {} }
    return Promise.resolve(res);
  }

  // ---------------- CBZ (comics) ----------------
  var natural = new Intl.Collator([], { numeric: true, sensitivity: 'base' }).compare;
  // Stores every page as its own file (id/p/0001.jpg) and returns a light HTML whose <img data-page> are resolved when opening.
  function cbzImport(buf, id, fSet, name) {
    return JSZip.loadAsync(buf).then(function (zip) {
      var names = Object.keys(zip.files).filter(function (n) { return !zip.files[n].dir && /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n); }).sort(natural);
      if (!names.length) throw new Error('cbz-empty');
      var pad = function (i) { return String(i + 1).padStart(4, '0'); }, tags = [], cover = null, chain = Promise.resolve();
      names.forEach(function (n, i) {
        chain = chain.then(function () { return zip.file(n).async('blob'); }).then(function (bl) {
          var e = extOf(n).replace('jpeg', 'jpg'), blob = new Blob([bl], { type: MIME[e] || 'image/jpeg' }), p = 'p/' + pad(i) + '.' + e;
          if (i === 0) cover = { ext: e, blob: blob };
          tags.push('<img data-page="' + p + '" alt="" loading="lazy">');
          return fSet(id + '/' + p, blob);
        });
      });
      return chain.then(function () {
        var title = String(name || '').replace(/\.[^.]+$/, '');
        return { html: shell(title, '', 'en', false, tags.join('\n'), CSS_COMIC), title: title, author: '', cover: cover, pages: names.length };
      });
    });
  }

  // ---------------- MOBI / AZW / AZW3 ----------------
  function cleanSection(htmlText) {
    var doc = new DOMParser().parseFromString(htmlText, 'text/html'), body = doc.body;
    [].forEach.call(body.querySelectorAll('script,style,link,meta,title,head'), function (e) { e.remove(); });
    [].forEach.call(body.querySelectorAll('[style],[class],[width],[height]'), function (e) { e.removeAttribute('style'); e.removeAttribute('class'); if (e.tagName !== 'IMG' || true) { e.removeAttribute('width'); e.removeAttribute('height'); } });
    [].forEach.call(body.querySelectorAll('a'), function (a) { var h = a.getAttribute('href') || ''; if (/^(filepos:|kindle:)/i.test(h)) a.removeAttribute('href'); a.removeAttribute('filepos'); });
    return body;
  }
  function inlineImages(body) {
    var imgs = [].slice.call(body.querySelectorAll('img[src^="blob:"],image'));
    return imgs.reduce(function (p, img) {
      return p.then(function () {
        var attrName = img.tagName.toLowerCase() === 'image' ? (img.hasAttribute('href') ? 'href' : 'xlink:href') : 'src', url = img.getAttribute(attrName);
        if (!url || url.indexOf('blob:') !== 0) return;
        return fetch(url).then(function (r) { return r.blob(); }).then(typedImage).then(function (t) { return t ? toDataURL(t.blob) : ''; }).then(function (d) { if (d) img.setAttribute(attrName, d); else img.remove(); }).catch(function () { img.remove(); });
      });
    }, Promise.resolve());
  }
  function mobiToHtml(file) {
    return Promise.all([import('./lib/mobi.js'), import('./lib/fflate.js')]).then(function (m) {
      return m[0].isMOBI(file).then(function (ok) {
        if (!ok) throw new Error('not-mobi');
        return new m[0].MOBI({ unzlib: m[1].unzlibSync }).open(file);
      });
    }).then(function (book) {
      var enc = book.mobi && book.mobi.headers && book.mobi.headers.palmdoc && book.mobi.headers.palmdoc.encryption;
      if (enc) throw new Error('drm');
      var md = book.metadata || {}, pick = function (v) { if (!v) return ''; if (typeof v === 'string') return v; if (Array.isArray(v)) return pick(v[0]); if (v.name) return pick(v.name); var k = Object.keys(v)[0]; return k ? pick(v[k]) : ''; };
      var title = pick(md.title) || 'MOBI', author = (Array.isArray(md.author) ? md.author.map(pick) : [pick(md.author)]).filter(Boolean).join('، '), lang = pick(md.language), parts = [], chain = Promise.resolve();
      book.sections.forEach(function (s) {
        chain = chain.then(function () {
          return Promise.resolve(s.load()).then(function (url) { return fetch(url).then(function (r) { return r.text(); }); }).then(function (t) {
            var body = cleanSection(t);
            return inlineImages(body).then(function () {
              var plain = body.textContent.replace(/\s+/g, '');
              if (plain.length < 3 && !body.querySelector('img,svg')) return;
              parts.push('<section class="epub-ch">' + body.innerHTML + '</section>');
            });
          }).catch(function () {});
        });
      });
      return chain.then(function () {
        if (!parts.length) throw new Error('mobi-empty');
        var rtl = RTL_LANG.test(lang) || isArabic(parts.slice(0, 3).join('').replace(/<[^>]+>/g, ' ')), html = shell(title, author, lang, rtl, parts.join('\n'));
        var res = { html: html, title: title, author: author, cover: null };
        return Promise.resolve(book.getCover && book.getCover()).catch(function () { return null; }).then(function (cv) {
          if (!cv) return res;
          return typedImage(cv).then(function (t) { if (t) res.cover = t; return res; });
        });
      });
    });
  }

  // ---------------- CBZ pages back to HTML (used when opening) ----------------
  function resolvePages(html, loadPage, track) {
    var re = /data-page="([^"]+)"/g, names = [], m; while ((m = re.exec(html))) names.push(m[1]);
    return Promise.all(names.map(function (n) { return loadPage(n); })).then(function (blobs) {
      var map = {}; names.forEach(function (n, i) { if (blobs[i]) { var u = URL.createObjectURL(blobs[i]); track(u); map[n] = u; } });
      return html.replace(/<img data-page="([^"]+)"/g, function (all, n) { return map[n] ? '<img src="' + map[n] + '"' : all; });
    });
  }

  window.__FMT = { esc: esc, isArabic: isArabic, shell: shell, typedImage: typedImage, toDataURL: toDataURL, txtToHtml: txtToHtml, fb2ToHtml: fb2ToHtml, cbzImport: cbzImport, mobiToHtml: mobiToHtml, resolvePages: resolvePages, EXT: /\.(txt|md|fb2|cbz|mobi|azw3?|prc)$/i };
})();
