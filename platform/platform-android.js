/* Living Ideas — Android/web platform layer.
   Re-implements the desktop (Electron) main process inside the WebView so the very same UI runs unchanged.
   Storage: IndexedDB (library metadata + book files). Plugins (all optional): Filesystem, Share, LocalNotifications, App, Browser. */
(function () {
  'use strict';
  var PL = new Proxy({}, { get: function (t, k) { return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[k]) || undefined; } });
  var NATIVE = function () { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); };
  document.documentElement.dataset.platform = 'android';
  var DEF_SET = { theme: 'system', sort: 'recent', view: 'grid', size: 140 };
  var DEF_GOALS = { enabled: true, daily: 5, yearly: 12, days: {}, notified: '', remind: false, remindAt: '20:00', remindedOn: '' };
  var lib = { books: [], collections: [], settings: Object.assign({}, DEF_SET), goals: JSON.parse(JSON.stringify(DEF_GOALS)), seeded: [] };
  var cbState = [], cbToast = [], coverURL = {}, live = [], textCache = {};
  var M = function (ar, en) { try { if (typeof window.T === 'function') return window.T(ar, en); } catch (e) {} return (window.LANG || lib.settings.lang || 'ar') !== 'ar' ? en : ar; };
  var today = function () { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  var find = function (id) { return lib.books.find(function (b) { return b.id === id; }); };
  var toast = function (m) { cbToast.forEach(function (f) { f(m); }); };
  var push = function () { cbState.forEach(function (f) { f(lib); }); };
  var rid = function (n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); };
  // ---------- IndexedDB ----------
  var dbp = null;
  function idb() { if (dbp) return dbp; dbp = new Promise(function (res, rej) { var r = indexedDB.open('livingideas-library', 1); r.onupgradeneeded = function () { r.result.createObjectStore('kv'); r.result.createObjectStore('files'); }; r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); return dbp; }
  function tx(store, mode, fn) { return idb().then(function (db) { return new Promise(function (res, rej) { var t = db.transaction(store, mode), s = t.objectStore(store), out = fn(s); t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); }; t.onerror = function () { rej(t.error); }; }); }); }
  var kvGet = function (k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); };
  var kvSet = function (k, v) { return tx('kv', 'readwrite', function (s) { s.put(v, k); }); };
  var fGet = function (k) { return tx('files', 'readonly', function (s) { return s.get(k); }); };
  var fSet = function (k, v) { return tx('files', 'readwrite', function (s) { s.put(v, k); }); };
  var fDelPrefix = function (p) { return tx('files', 'readwrite', function (s) { s.delete(IDBKeyRange.bound(p, p + '\uffff')); }); };
  var fKeys = function (p) { return idb().then(function (db) { return new Promise(function (res) { var out = [], r = db.transaction('files', 'readonly').objectStore('files').openKeyCursor(IDBKeyRange.bound(p, p + '\uffff')); r.onsuccess = function () { var c = r.result; if (c) { out.push(c.key); c.continue(); } else res(out); }; }); }); };
  var saveT = null;
  function save(now) { clearTimeout(saveT); var w = function () { return kvSet('lib', JSON.stringify(lib)); }; if (now) return w(); saveT = setTimeout(w, 250); return Promise.resolve(); }
  addEventListener('pagehide', function () { save(true); }); document.addEventListener('visibilitychange', function () { if (document.hidden) { save(true); try { syncQuotes(false); } catch (e) {} } });
  // ---------- helpers ----------
  var unesc = function (t) { return String(t || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); }).replace(/\s+/g, ' ').trim(); };
  var baseName = function (n) { return n.replace(/\.[^.]+$/, ''); };
  var extOf = function (n) { var m = /\.([A-Za-z0-9]+)$/.exec(n || ''); return m ? m[1].toLowerCase() : ''; };
  function meta(html, name) {
    var t = unesc((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1]) || baseName(name);
    t = t.split('|')[0].replace(/\s*[·•]\s*[\d.]+\s*$/, '').trim();
    var author = unesc((/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i.exec(html) || [])[1]), parts = t.split(/\s[—–-]\s/);
    if (!author && parts.length > 1) { author = parts.slice(1).join(' — ').trim(); t = parts[0].trim(); }
    return { title: t || M('كتاب بلا عنوان', 'Untitled'), author: author };
  }
  function b64ToBlob(b64, type) { var bin = atob(b64), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: type }); }
  function bytesToB64(u8) { var s = '', CH = 0x8000; for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
  function blobToB64(b) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1]); }; r.readAsDataURL(b); }); }
  function coverFromHtml(html) { var m = /<img[^>]*class=["'][^"']*welcome-portrait[^"']*["'][^>]*src=["']data:image\/(jpeg|png|webp|svg\+xml);base64,([A-Za-z0-9+\/=]+)["']/i.exec(html); if (!m) return null; var ext = m[1] === 'svg+xml' ? 'svg' : m[1] === 'jpeg' ? 'jpg' : m[1]; return { ext: ext, blob: b64ToBlob(m[2], m[1] === 'svg+xml' ? 'image/svg+xml' : 'image/' + m[1]) }; }
  var wordCount = function (html) { return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length; };
  function setCoverURL(b, blob) { var k = b.id; if (coverURL[k]) URL.revokeObjectURL(coverURL[k].u); coverURL[k] = { u: URL.createObjectURL(blob), v: b.coverV || b.cover }; }
  var PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  // ---------- EPUB -> single HTML (port of the desktop converter) ----------
  function epubToHtml(buf) {
    return JSZip.loadAsync(buf).then(function (zip) {
      var rd = function (n, t) { var f = zip.file(n); return f ? f.async(t || 'string') : Promise.resolve(null); };
      return rd('META-INF/container.xml').then(function (cont) {
        var opfPath = (/full-path=["']([^"']+)["']/.exec(cont || '') || [])[1]; if (!opfPath) throw new Error('epub');
        return rd(opfPath).then(function (opf) {
          var dirn = opfPath.indexOf('/') > 0 ? opfPath.slice(0, opfPath.lastIndexOf('/')) + '/' : '';
          var dc = function (tag) { return unesc(((new RegExp('<dc:' + tag + '[^>]*>([\\s\\S]*?)</dc:' + tag + '>', 'i').exec(opf) || [])[1] || '')).replace(/<[^>]+>/g, ''); };
          var items = {}; (opf.match(/<item\b[^>]*>/gi) || []).forEach(function (t) { var g = function (k) { return (new RegExp(k + '=["\']([^"\']*)["\']', 'i').exec(t) || [])[1]; }; if (g('id')) { var h = g('href') || ''; try { h = decodeURIComponent(h); } catch (e) {} items[g('id')] = { href: h, type: g('media-type') || '', props: g('properties') || '' }; } });
          var spine = (opf.match(/<itemref\b[^>]*>/gi) || []).map(function (t) { return (/idref=["']([^"']+)["']/.exec(t) || [])[1]; }).filter(function (x) { return items[x]; });
          var mime = function (p) { return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[extOf(p)] || ''; };
          var norm = function (p) { var out = []; p.split('/').forEach(function (s) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s); }); return out.join('/'); };
          var lang = dc('language') || 'ar', rtl = /^(ar|fa|he|ur)/i.test(lang), out = [], chain = Promise.resolve();
          spine.forEach(function (id, i) { chain = chain.then(function () {
            var it = items[id]; if (!/x?html/.test(it.type)) return;
            return rd(dirn + it.href).then(function (h) {
              if (!h) return; var body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(h) || [null, h])[1], ddir = (dirn + it.href).indexOf('/') > 0 ? (dirn + it.href).slice(0, (dirn + it.href).lastIndexOf('/') + 1) : '';
              var x = body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/\sstyle=("[^"]*"|'[^']*')/gi, '').replace(/\son\w+=("[^"]*"|'[^']*')/gi, '').replace(/<a\b([^>]*?)href=("|')(?!#|https?:|mailto:)[^"']*\2/gi, '<a$1href="#"');
              var refs = []; x.replace(/(<(?:img|image)\b[^>]*?\b(?:xlink:)?(?:src|href)=)(["'])([^"']+)\2/gi, function (m, a, q, s) { if (!/^data:/.test(s) && mime(s)) refs.push(s); return m; });
              var uniq = refs.filter(function (v, k) { return refs.indexOf(v) === k; }), map = {};
              return Promise.all(uniq.map(function (s) { var p = norm(ddir + decodeURIComponent(s.split('#')[0])); return rd(p, 'uint8array').then(function (u8) { if (u8 && u8.length < 6e6) map[s] = 'data:' + mime(s) + ';base64,' + bytesToB64(u8); }); })).then(function () {
                x = x.replace(/(<(?:img|image)\b[^>]*?\b(?:xlink:)?(?:src|href)=)(["'])([^"']+)\2/gi, function (m, a, q, s) { return map[s] ? a + '"' + map[s] + '"' : m; });
                if (x.replace(/<[^>]+>/g, '').trim().length < 3 && !/<img/i.test(x)) return; out.push('<section class="epub-ch" id="ch' + (i + 1) + '">' + x + '</section>');
              });
            });
          }); });
          return chain.then(function () {
            if (!out.length) throw new Error('epub-empty');
            var title = dc('title') || M('كتاب EPUB', 'EPUB book'), author = dc('creator'), cm = /<meta[^>]+name=["']cover["'][^>]+content=["']([^"']+)["']/i.exec(opf) || /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']cover["']/i.exec(opf);
            var ci = Object.keys(items).map(function (k) { return items[k]; }).filter(function (v) { return /cover-image/.test(v.props); })[0] || (cm && items[cm[1]]);
            var css = 'body{font-family:"Amiri","EB Garamond",Georgia,serif;line-height:1.9;font-size:20px;max-width:760px;margin:0 auto;padding:40px 22px 90px;background:#fbf7ec;color:#14262e}.epub-ch{margin-bottom:56px;padding-bottom:36px;border-bottom:1px solid #d9cdb0}img,svg{max-width:100%;height:auto}h1,h2,h3{line-height:1.4}a{color:#a85a38}table{max-width:100%;display:block;overflow:auto}';
            var html = '<!DOCTYPE html><html lang="' + lang + '" dir="' + (rtl ? 'rtl' : 'ltr') + '"><head><meta charset="utf-8"><title>' + title.replace(/</g, '&lt;') + '</title>' + (author ? '<meta name="author" content="' + author.replace(/"/g, '&quot;') + '">' : '') + '<meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head><body>' + out.join('\n') + '</body></html>';
            var res = { html: html, title: title, author: author, cover: null };
            if (!ci) return res; return rd(dirn + ci.href, 'blob').then(function (bl) { if (bl) res.cover = { ext: (extOf(ci.href) || 'jpg').replace('jpeg', 'jpg'), blob: bl }; return res; });
          });
        });
      });
    });
  }
  // ---------- import ----------
  function sha1(buf) { return crypto.subtle.digest('SHA-1', buf).then(function (h) { return Array.prototype.map.call(new Uint8Array(h), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }); }
  var ALLOWED = /\.(html?|epub|pdf|docx|jpe?g|png|webp|bmp|txt|md|fb2|cbz|mobi|azw3?|prc|mp3|m4a|m4b|aac|ogg|opus|wav|flac)$/i;
  // ---------- progress card, photos (camera / gallery) -> OCR book ----------
  var busyUI = function (m, p, c) { try { window.__liBusy && window.__liBusy(m, p, c); } catch (e) {} }, unbusyUI = function () { try { window.__liBusy && window.__liBusy(false); } catch (e) {} }, tickUI = function () { return new Promise(function (r) { setTimeout(r, 60); }); };
  var IMGRE = /\.(jpe?g|png|webp|bmp)$/i;
  function importImages(files, nameHint) {
    var F = window.__FMT; if (!F || !F.imagesToHtml) return Promise.resolve({ err: M('تعذر قراءة الصور في هذه النسخة', 'Could not read the images in this version') });
    var base = nameHint || (files.length === 1 ? baseName(files[0].name) : baseName(files[0].name) + ' (' + files.length + ')');
    return files[0].arrayBuffer().then(sha1).then(function (h) {
      var hash = h + '-' + files.length + '-' + files.reduce(function (a, f) { return a + f.size; }, 0), dup = lib.books.filter(function (b) { return b.hash === hash; })[0]; if (dup) return { dup: dup };
      return (window.__liImportOpts ? window.__liImportOpts(base, 'img').catch(function () { return { tr: '' }; }) : Promise.resolve({ tr: '' })).then(function (o) {
        if (o.skip) return { skipped: true };
        var cx = { stop: false }; busyUI(M('جارٍ تجهيز قراءة النص…', 'Preparing text recognition…'), 0, function () { cx.stop = true; });
        return tickUI().then(function () { return F.imagesToHtml(files, base, function (p, l) { busyUI(l || M('جارٍ القراءة…', 'Reading…'), p, function () { cx.stop = true; }); }, cx); }).then(function (r) {
          var id = 'b' + rid(6), b = { id: id, hash: hash, format: 'epub', orig: 'OCR', file: 'index.html', title: r.title || base, author: '', series: '', rating: 0, hidden: false, want: false, cover: null, added: Date.now(), lastRead: 0, progress: 0, finished: false, readSec: 0, collections: [], bytes: files.reduce(function (a, f) { return a + f.size; }, 0), tpl: false, words: wordCount(r.html), ext: null, annots: [], audio: null };
          if (o.tr) { try { localStorage.setItem('li:' + id + ':li-tr-target:' + id, o.tr); } catch (e) {} }
          return fSet(id + '/index.html', new Blob([r.html], { type: 'text/html' })).then(function () {
            var cv = r.cover; var p = cv ? (b.cover = 'cover.' + cv.ext, fSet(id + '/' + b.cover, cv.blob).then(function () { setCoverURL(b, cv.blob); })) : Promise.resolve();
            return p.then(function () { lib.books.push(b); unbusyUI(); return { book: b }; });
          });
        }).catch(function (e) { unbusyUI(); var m = e && e.message; return { err: m === 'cancel' ? M('أُلغي التحويل', 'Conversion cancelled') : m === 'ocr-missing' ? M('ميزة قراءة النص غير متوفرة في هذه النسخة', 'Text recognition is not available in this version') : m === 'noText' ? M('لم أستطع قراءة نص من الصور. جرّب صورة أوضح وإضاءة أفضل', 'Could not read any text from the images. Try a clearer photo with better light') : M('تعذر تحويل الصور إلى كتاب', 'Could not turn the images into a book') }; });
      });
    });
  }
  function pickCam() {
    return new Promise(function (res) {
      var i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.setAttribute('capture', 'environment'); i.style.display = 'none'; document.body.appendChild(i);
      var done = false, fin = function (f) { if (done) return; done = true; try { i.remove(); } catch (e) {} res(f); };
      i.onchange = function () { fin([].slice.call(i.files || [])); }; i.oncancel = function () { fin([]); };
      addEventListener('focus', function once() { setTimeout(function () { if (!done && !(i.files && i.files.length)) fin([]); }, 3500); removeEventListener('focus', once); });
      i.click();
    });
  }
  function scanFlow() {
    var shots = [];
    var next = function () {
      return pickCam().then(function (f) {
        if (!f.length) return shots;
        shots.push(f[0]);
        return (window.__liScanAsk ? window.__liScanAsk(shots.length) : Promise.resolve(false)).then(function (a) { return a === 'cancel' ? [] : a ? next() : shots; });
      });
    };
    return next();
  }
  var INFL = {};
  function importFile(file, forced) {
    var key = file.name + '|' + file.size + '|' + (forced ? 'f' : ''); if (INFL[key]) return Promise.resolve({ skipped: true });
    INFL[key] = 1; var done = function (r) { delete INFL[key]; return r; };
    return importFile0(file, forced).then(done, function (e) { delete INFL[key]; throw e; });
  }
  function importFile0(file, forced) {
    if (!ALLOWED.test(file.name)) return Promise.resolve({ err: M('صيغة غير مدعومة: ', 'Unsupported format: ') + file.name });
    return file.arrayBuffer().then(function (buf) { return sha1(buf).then(function (hash) {
      var ext = extOf(file.name), dup = ext === 'pdf' ? null : lib.books.filter(function (b) { return b.hash === hash; })[0]; if (dup) return { dup: dup };
      var id = 'b' + rid(6), base = baseName(file.name);
      var b = { id: id, hash: hash, format: 'html', file: 'index.html', title: base, author: '', series: '', rating: 0, hidden: false, want: false, cover: null, added: Date.now(), lastRead: 0, progress: 0, finished: false, readSec: 0, collections: [], bytes: file.size, tpl: false, words: 0, ext: null, annots: [], audio: null };
      var finish = function (cv) { var p = cv ? (b.cover = 'cover.' + cv.ext, fSet(id + '/' + b.cover, cv.blob).then(function () { setCoverURL(b, cv.blob); })) : Promise.resolve(); return p.then(function () { lib.books.push(b); return { book: b }; }); };
      if (/^html?$/.test(ext)) { var html = new TextDecoder('utf-8').decode(buf), m = meta(html, file.name); Object.assign(b, { title: m.title, author: m.author, tpl: /id=["']li-orig-data["']|id=["']toc-list["']/.test(html), words: wordCount(html) }); return fSet(id + '/index.html', new Blob([buf], { type: 'text/html' })).then(function () { return finish(coverFromHtml(html)); }); }
      if (ext === 'epub') return epubToHtml(buf).then(function (r) { Object.assign(b, { format: 'epub', title: r.title, author: r.author, words: wordCount(r.html) }); return fSet(id + '/index.html', new Blob([r.html], { type: 'text/html' })).then(function () { return finish(r.cover); }); }).catch(function () { return { err: M('تعذر استيراد الملف: ', 'Could not import the file: ') + file.name }; });
      var F = window.__FMT, fin = function (r, orig) { Object.assign(b, { format: 'epub', orig: orig, title: r.title || base, author: r.author || '', words: orig === 'CBZ' ? 0 : wordCount(r.html) }); return fSet(id + '/index.html', new Blob([r.html], { type: 'text/html' })).then(function () { return finish(r.cover); }); };
      var bad = function (e) { return { err: (e && e.message === 'drm' ? M('ملف محمي (DRM): ', 'Protected file (DRM): ') : M('تعذر استيراد الملف: ', 'Could not import the file: ')) + file.name }; };
      var setTr = function (o) { if (o && o.tr) { try { localStorage.setItem(ext === 'pdf' && o.mode !== 'html' ? 'li-pdf-tr:' + id : 'li:' + id + ':li-tr-target:' + id, o.tr); /* same key the book page reads (its storage is prefixed per book) */ } catch (e) {} } };
      var askOpts = function () { if (forced) return Promise.resolve(forced); return window.__liImportOpts ? window.__liImportOpts(file.name, ext).catch(function () { return { mode: ext === 'pdf' ? 'pdf' : 'html', tr: '' }; }) : Promise.resolve({ mode: ext === 'pdf' ? 'pdf' : 'html', tr: '' }); };
      var busy = busyUI, unbusy = unbusyUI, tick = tickUI, cxp = null;
      var prog = function (p, l) { busy(l || M('جارٍ تحويل الملف…', 'Converting the file…'), p, cxp ? function () { cxp.stop = true; } : null); };
      var asPdf = function (o) { setTr(o); var head = new TextDecoder('latin1').decode(new Uint8Array(buf, Math.max(0, buf.byteLength - 20000))), info = function (k) { var mm = new RegExp('/' + k + '\\s*\\(([^)]{1,200})\\)').exec(head); return mm ? mm[1].replace(/\\(.)/g, '$1').trim() : ''; }; Object.assign(b, { format: 'pdf', file: 'book.pdf', title: (/^[\x20-\x7E]*$/.test(info('Title')) && info('Title')) || base, author: /^[\x20-\x7E]*$/.test(info('Author')) ? info('Author') : '' }); return fSet(id + '/book.pdf', new Blob([buf], { type: 'application/pdf' })).then(function () { return finish(null); }); };
      if (F && ext === 'docx') return askOpts().then(function (o) { if (o.skip) return { skipped: true }; busy(M('جارٍ تحويل الملف…', 'Converting the file…')); return tick().then(function () { return F.docxToHtml(buf, file.name); }).then(function (r) { setTr(o); return fin(r, 'DOCX'); }).then(function (x) { unbusy(); return x; }, function (e) { unbusy(); return bad(e); }); }).catch(bad);
      if (ext === 'pdf') return askOpts().then(function (o) {
        if (o.skip) return { skipped: true };
        var asHtml = o.mode === 'html' && F && F.pdfToHtml, same = lib.books.filter(function (x) { return x.hash === hash && (asHtml ? x.format !== 'pdf' : x.format === 'pdf'); })[0];
        if (same) return { dup: same };
        if (o.mode !== 'html' || !F || !F.pdfToHtml) return asPdf(o);
        cxp = { stop: false }; busy(M('جارٍ تحويل الملف…', 'Converting the file…'), 0);
        var run = function (ocr) { return F.pdfToHtml(buf, file.name, prog, { ocr: ocr, cancel: cxp }); };
        return tick().then(function () { return run(false); }).catch(function (e) {
          if (!(e && e.message === 'scanned')) throw e;
          unbusy();
          var ask = window.__liAsk ? window.__liAsk(M('الملف مصوّر (صور بلا نص)', 'Scanned file (images without text)'), M('سنقرأ النص من الصفحات بتقنية التعرف على النص (OCR) ثم نحوّله إلى كتاب يمكن ترجمته. تُزال العلامات المائية الفاتحة تلقائياً. قد يستغرق وقتاً (' + (e.pages || '') + ' صفحة)، ويعمل بدون إنترنت.', 'We will read the text from the pages with text recognition (OCR) and turn it into a book that can be translated. Light watermarks are removed automatically. This can take a while (' + (e.pages || '') + ' pages) and works offline.'), M('تحويل إلى نص', 'Convert to text'), M('فتحه كما هو', 'Open as it is')) : Promise.resolve(false);
          return ask.then(function (yes) { if (!yes) { var x = new Error('keep'); throw x; } cxp = { stop: false }; busy(M('جارٍ تجهيز قراءة النص…', 'Preparing text recognition…'), 0); return tick().then(function () { return run(true); }); });
        }).then(function (r) { setTr(o); return fin(r, 'PDF'); }).then(function (x) { unbusy(); return x; }, function (e) {
          unbusy(); var m = e && e.message;
          if (m === 'keep') return asPdf(o);
          if (m === 'cancel') { toast(M('أُلغي التحويل، فُتح الملف كما هو', 'Conversion cancelled. The file was opened as it is')); return asPdf(o); }
          if (m === 'ocr-missing') { toast(M('ميزة قراءة النص غير متوفرة في هذه النسخة، فُتح الملف كما هو', 'Text recognition is not available in this version. The file was opened as it is')); return asPdf(o); }
          if (m === 'noText') { toast(M('تعذّرت قراءة نص من الملف، فُتح كما هو', 'Could not read any text from the file. It was opened as it is')); return asPdf(o); }
          return bad(e);
        });
      });
      if (F && (ext === 'txt' || ext === 'md')) return F.txtToHtml(buf, file.name).then(function (r) { return fin(r, ext === 'md' ? 'MD' : 'TXT'); }).catch(bad);
      if (F && ext === 'fb2') return F.fb2ToHtml(buf).then(function (r) { return fin(r, 'FB2'); }).catch(bad);
      if (F && ext === 'cbz') return F.cbzImport(buf, id, fSet, file.name).then(function (r) { return fin(r, 'CBZ'); }).catch(function (e) { return fDelPrefix(id + '/').then(function () { return bad(e); }); });
      if (F && /^(mobi|azw3?|prc)$/.test(ext)) return F.mobiToHtml(new Blob([buf])).then(function (r) { return fin(r, ext === 'mobi' || ext === 'prc' ? 'MOBI' : 'AZW3'); }).catch(bad);
      var name = 'audio.' + ext; Object.assign(b, { format: 'audio', file: name, audio: { pos: 0, dur: 0, bm: [] } }); return fSet(id + '/' + name, new Blob([buf], { type: file.type || 'audio/mpeg' })).then(function () { return finish(null); });
    }); }).catch(function () { return { err: M('تعذر استيراد الملف: ', 'Could not import the file: ') + file.name }; });
  }
  function addMany(files, opts) {
    var n = 0, d = 0, errs = [], chain = Promise.resolve(), imgs = files.filter(function (f) { return IMGRE.test(f.name) || /^image\//.test(f.type || ''); });
    if (imgs.length) {
      files = files.filter(function (f) { return imgs.indexOf(f) < 0; });
      if (!(opts && opts.keep)) imgs.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
      chain = chain.then(function () { return importImages(imgs, opts && opts.name).then(function (r) { if (r.book) n++; else if (r.dup) d++; else if (r.err) errs.push(r.err); }); });
    }
    files.forEach(function (f) { chain = chain.then(function () { return importFile(f).then(function (r) { if (r.book) n++; else if (r.dup) d++; else if (r.err) errs.push(r.err); }); }); });
    return chain.then(function () { return save(true); }).then(function () { push(); if (n) toast(M('أُضيف ' + n + (n === 1 ? ' كتاب' : ' كتب'), 'Added ' + n + (n === 1 ? ' book' : ' books'))); if (d) toast(M('موجود مسبقاً في المكتبة (' + d + ')', 'Already in your library (' + d + ')')); errs.forEach(toast); return lib; });
  }
  function pick(accept, multiple) { return new Promise(function (res) { var i = document.createElement('input'); i.type = 'file'; if (accept) i.accept = accept; i.multiple = !!multiple; i.style.display = 'none'; document.body.appendChild(i); var done = false; i.onchange = function () { done = true; var f = [].slice.call(i.files || []); i.remove(); res(f); }; addEventListener('focus', function once() { setTimeout(function () { if (!done) { i.remove(); res([]); } }, 800); removeEventListener('focus', once); }); i.click(); }); }
  function saveBlob(name, blob) {
    if (NATIVE() && PL.Filesystem && PL.Share) return blobToB64(blob).then(function (b64) { return PL.Filesystem.writeFile({ path: name, data: b64, directory: 'CACHE' }); }).then(function (r) { return PL.Share.share({ title: name, url: r.uri, dialogTitle: name }); }).catch(function () {});
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000); return Promise.resolve();
  }
  // ---------- goals / notifications ----------
  function notify(title, body) { if (NATIVE() && PL.LocalNotifications) { PL.LocalNotifications.requestPermissions().then(function () { return PL.LocalNotifications.schedule({ notifications: [{ id: Math.floor(Math.random() * 1e6) + 10, title: title, body: body, schedule: { at: new Date(Date.now() + 400) } }] }); }).catch(function () {}); } else if (window.Notification && Notification.permission === 'granted') { try { new Notification(title, { body: body }); } catch (e) {} } }
  function syncReminder() {
    if (!(NATIVE() && PL.LocalNotifications)) return; var g = lib.goals, LN = PL.LocalNotifications;
    LN.cancel({ notifications: [{ id: 7001 }] }).catch(function () {});
    if (!g.enabled || !g.remind) return; var p = String(g.remindAt || '20:00').split(':');
    LN.requestPermissions().then(function () { return LN.schedule({ notifications: [{ id: 7001, title: M('وقت القراءة', 'Reading time'), body: M('كتابك ينتظرك — هدف اليوم ' + g.daily + ' دقيقة.', 'Your book is waiting — today’s goal is ' + g.daily + ' min.'), schedule: { on: { hour: +p[0] || 20, minute: +p[1] || 0 }, allowWhileIdle: true } }] }); }).catch(function () {});
  }
  function tickGoals(sec, bid) {
    var g = lib.goals; if (!g.enabled || !(sec > 0 && sec <= 120)) return lib; var d = today(); g.days[d] = (g.days[d] || 0) + sec; var b = find(bid); if (b) b.readSec = (b.readSec || 0) + sec;
    if (g.days[d] >= g.daily * 60 && g.notified !== d) { g.notified = d; notify(M('أحسنت! 🎉', 'Well done! 🎉'), M('أنجزتَ هدف القراءة اليومي (' + g.daily + ' دقيقة).', 'You reached your daily reading goal (' + g.daily + ' min).')); }
    save(); return lib;
  }
  // ---------- notes ----------
  function notesOf(b) {
    var rows = [], e = b.ext || {};
    (e.highlights || []).forEach(function (h) { rows.push({ type: M('تظليل', 'Highlight'), text: h.text, note: '', where: h.sectionLabel || '' }); });
    (e.notes || []).forEach(function (n) { rows.push({ type: n.kind === 'experience' ? M('تجربة شخصية', 'Personal reflection') : M('ملاحظة', 'Note'), text: n.selectedText || n.prompt || '', note: n.body || n.text || '', where: n.sectionLabel || '' }); });
    (e.bookmarks || []).forEach(function (m) { rows.push({ type: M('إشارة مرجعية', 'Bookmark'), text: m.text || '', note: '', where: m.sectionLabel || '' }); });
    (b.annots || []).forEach(function (a) { rows.push({ type: a.type === 'bm' ? M('إشارة مرجعية', 'Bookmark') : a.note ? M('ملاحظة', 'Note') : M('تظليل', 'Highlight'), text: a.quote || '', note: a.note || '', where: a.pct != null ? Math.round(a.pct) + '%' : '' }); });
    ((b.audio && b.audio.bm) || []).forEach(function (m) { rows.push({ type: M('إشارة صوتية', 'Audio bookmark'), text: '', note: m.note || '', where: Math.floor(m.t / 60) + ':' + String(Math.floor(m.t % 60)).padStart(2, '0') }); });
    return rows;
  }
  var md = function (b) { var s = '# ' + b.title + '\n' + (b.author ? '_' + b.author + '_\n' : '') + '\n'; notesOf(b).forEach(function (x) { s += '- **' + x.type + '**' + (x.where ? ' (' + x.where + ')' : '') + (x.text ? ': «' + x.text + '»' : '') + (x.note ? '\n  - ' + M('ملاحظتي', 'My note') + ': ' + x.note : '') + '\n'; }); return s + '\n'; };
  // ---------- book frames ----------
  var INJECT_JS = null;
  function getText(url) { if (textCache[url]) return Promise.resolve(textCache[url]); return fetch(url).then(function (r) { return r.text(); }).then(function (t) { return (textCache[url] = t); }); }


  window.__liTr = function (id, kind, text) { ['frame', 'pframe', 'bgframe'].forEach(function (n) { var f = document.getElementById(n); try { f.contentWindow.postMessage({ liTr: 1, id: id, kind: kind, text: text }, '*'); } catch (e) {} }); };
  window.__liTts = function (id, type, a, b) { ['frame', 'pframe'].forEach(function (n) { var f = document.getElementById(n); try { f.contentWindow.postMessage({ liTts: 1, id: id, type: type, a: a, b: b }, '*'); } catch (e) {} }); };
  // Runs INSIDE every book page: (1) saves/shares files the book creates (quote images, backups),
  // (2) rebuilds speechSynthesis on top of the phone's own text-to-speech.
  function TTSX() {
    var N = window.LiNative; if (!N || !N.speak) return;
    var seq = 0, live = {}, q = [], vc = null, ls = [], spkT = null, spkOn = false;
    // While anything is being read aloud the app keeps a notification alive, so the voice continues with the screen off or another app open.
    function note(on) { clearTimeout(spkT); if (on) { if (!spkOn) { spkOn = true; try { parent.postMessage({ liBook: 1, type: 'speak-state', on: true }, '*'); } catch (e) {} } } else spkT = setTimeout(function () { if (!S.speaking && spkOn) { spkOn = false; try { parent.postMessage({ liBook: 1, type: 'speak-state', on: false }, '*'); } catch (e) {} } }, 2500); }
    window.addEventListener('message', function (e) { var d = e.data; if (d && d.liCmd === 'spkstop') { try { S.cancel(); } catch (x) {} try { window.__liDock && window.__liDock.act('sstop'); } catch (x) {} try { window.__liPdfStop && window.__liPdfStop(); } catch (x) {} } });
    function voices() { if (vc) return vc; var a = []; try { a = JSON.parse(N.voices() || '[]'); } catch (e) {} if (!a.length) return []; vc = a.map(function (v) { return { name: v[0], lang: v[1], voiceURI: v[0], localService: true, default: false }; }); return vc; }
    function U(t) { this.text = t === undefined ? '' : String(t); this.lang = ''; this.rate = 1; this.pitch = 1; this.volume = 1; this.voice = null; this.onstart = this.onend = this.onerror = this.onboundary = this.onpause = this.onresume = null; }
    function issue(ent, from) { var id = 'u' + (++seq); live[id] = ent; ent.id = id; var u = ent.u; ent.base = from || 0; N.speak(id, u.text.slice(ent.base), u.lang || (u.voice && u.voice.lang) || '', u.voice ? u.voice.name : '', +u.rate || 1, +u.pitch || 1); }
    var S = { speaking: false, pending: false, paused: false, onvoiceschanged: null, getVoices: voices,
      speak: function (u) { var ent = { u: u, base: 0, off: 0 }; q.push(ent); S.speaking = true; note(true); if (!S.paused) issue(ent, 0); },
      cancel: function () { live = {}; q = []; S.speaking = false; S.paused = false; note(false); try { N.stop(); } catch (e) {} },
      pause: function () { if (!S.speaking || S.paused) return; S.paused = true; live = {}; try { N.stop(); } catch (e) {} q.forEach(function (e) { if (e.u.onpause && e === q[0]) try { e.u.onpause({}); } catch (x) {} }); },
      resume: function () { if (!S.paused) return; S.paused = false; var first = true; q.forEach(function (e) { issue(e, first ? e.off : 0); first = false; }); if (q[0] && q[0].u.onresume) try { q[0].u.onresume({}); } catch (x) {} },
      addEventListener: function (n, f) { if (n === 'voiceschanged') ls.push(f); }, removeEventListener: function (n, f) { ls = ls.filter(function (x) { return x !== f; }); }, dispatchEvent: function () { return true; } };
    try { Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: U }); Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: function () { return S; } }); } catch (e) { window.SpeechSynthesisUtterance = U; window.speechSynthesis = S; }
    window.addEventListener('message', function (e) {
      var d = e.data; if (!d || !d.liTts) return;
      if (d.type === 'voices') { vc = null; var ev = { type: 'voiceschanged' }; if (S.onvoiceschanged) try { S.onvoiceschanged(ev); } catch (x) {} ls.slice().forEach(function (f) { try { f(ev); } catch (x) {} }); return; }
      var ent = live[d.id]; if (!ent) return; var u = ent.u;
      if (d.type === 'start') { if (u.onstart) try { u.onstart({}); } catch (x) {} }
      else if (d.type === 'boundary') { ent.off = d.a + ent.base; if (u.onboundary) try { u.onboundary({ charIndex: d.a + ent.base, charLength: d.b, name: 'word', utterance: u }); } catch (x) {} }
      else { delete live[d.id]; q = q.filter(function (x) { return x !== ent; }); if (!q.length) { S.speaking = false; note(false); } var h = d.type === 'end' ? u.onend : u.onerror; if (h) try { h(d.type === 'end' ? {} : { error: 'synthesis-failed' }); } catch (x) {} }
    });
  }
  function SHIMX() {
    function send(name, mime, blob) { var r = new FileReader(); r.onload = function () { parent.postMessage({ liBook: 1, type: 'save-file', name: name || 'file', mime: mime || blob.type || '', data: r.result }, '*'); }; r.readAsDataURL(blob); }
    function grab(a) { var h = a.href; fetch(h).then(function (r) { return r.blob(); }).then(function (b) { send(a.getAttribute('download'), b.type, b); }).catch(function () {}); }
    var isDl = function (a) { return a && a.hasAttribute && a.hasAttribute('download') && /^(blob:|data:)/.test(a.href || ''); };
    try { var oc = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (isDl(this)) { grab(this); return; } return oc.apply(this, arguments); }; } catch (e) {}
    document.addEventListener('click', function (e) { var a = e.target && e.target.closest && e.target.closest('a[download]'); if (isDl(a)) { e.preventDefault(); e.stopPropagation(); grab(a); } }, true);
    try {
      navigator.canShare = function (d) { return !!(d && ((d.files && d.files.length) || d.text || d.url || d.title)); };
      navigator.share = function (d) {
        if (d && d.files && d.files.length) { [].forEach.call(d.files, function (f) { send(f.name, f.type, f); }); return Promise.resolve(); }
        if (d && (d.text || d.url)) { parent.postMessage({ liBook: 1, type: 'share-text', text: [d.title, d.text, d.url].filter(Boolean).join('\n') }, '*'); return Promise.resolve(); }
        return Promise.reject(new TypeError('Nothing to share'));
      };
    } catch (e) {}
    // In-page links (#section, relative links) must never navigate the book away to the app itself.
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented) return;
      var a = e.target && e.target.closest && e.target.closest('a[href]'); if (!a) return;
      var raw = a.getAttribute('href') || '';
      if (/^(blob:|data:|mailto:|tel:|javascript:|https?:)/i.test(raw)) return;
      e.preventDefault();
      var h = raw.indexOf('#') >= 0 ? raw.slice(raw.indexOf('#') + 1) : ''; if (!h) return;
      try { h = decodeURIComponent(h); } catch (x) {}
      var el = document.getElementById(h) || document.getElementsByName(h)[0];
      if (el) { try { el.scrollIntoView({ block: 'start' }); } catch (x) { el.scrollIntoView(); } try { history.replaceState(null, '', '#' + encodeURIComponent(h)); } catch (x) {} }
    }, false);
    window.addEventListener('message', function (e) {
      var d = e.data; if (!d || !d.liCmd) return;
      if (d.liCmd === 'toc') {
        var hs = [].slice.call(document.querySelectorAll('.epub-ch h1,.epub-ch h2,main h1,main h2,body > h1,body > h2,body > section > h1,body > section > h2,h1,h2')), seen = [], out = [];
        hs.forEach(function (h) { if (seen.indexOf(h) >= 0 || h.closest('.li-ui,#li-tr-ui,#toc,.bk-toc,.bk-title')) return; seen.push(h); var t = (h.textContent || '').replace(/\s+/g, ' ').trim(); if (!t || t.length > 140 || out.length >= 600) return; if (!h.id) h.id = 'li-h' + out.length; out.push({ t: t, id: h.id, l: h.tagName === 'H1' ? 1 : 2 }); });
        parent.postMessage({ liBook: 1, type: 'toc', items: out }, '*');
      } else if (d.liCmd === 'jump') { var el = document.getElementById(d.id); if (el) { try { el.scrollIntoView({ block: 'start' }); } catch (x) { el.scrollIntoView(); } } }
    });
    try { N.init(); } catch (e) {}
  }

  var TRS = (function () {
    var NAMES = { ar: 'العربية', en: 'English', fr: 'Français', es: 'Español', it: 'Italiano', id: 'Indonesia' };
    var TX = {
      ar: { hq: 'جودة أعلى على الجهاز (أبطأ)', toh: 'تحويل إلى كتاب HTML', on: 'دقة أعلى عبر الإنترنت (يرسل النص إلى Google)', tr: 'ترجمة', sh: 'حفظ الترجمة كملف HTML', sp: 'حفظ الترجمة كملف PDF', wait: 'الترجمة لم تكتمل بعد، انتظر قليلاً', orig: 'الأصل', prep: 'تجهيز اللغة (مرة واحدة)…', work: 'جارٍ الترجمة', mt: 'ترجمة آلية', fail: 'تعذرت الترجمة. اتصل بالإنترنت مرة واحدة لتحميل اللغة.', scan: 'هذا الملف صور ممسوحة بلا نص، فلا يمكن ترجمته', hl: 'التظليل متاح على النص الأصلي فقط' },
      en: { hq: 'Higher quality on this PC (slower)', toh: 'Convert to HTML book', on: 'Higher accuracy online (sends text to Google)', tr: 'Translate', sh: 'Save translation as HTML', sp: 'Save translation as PDF', wait: 'Translation is not finished yet', orig: 'Original', prep: 'Preparing language (one time)…', work: 'Translating', mt: 'Machine translation', fail: 'Translation failed. Connect to the internet once to download the language.', scan: 'This PDF is scanned images with no text, so it can’t be translated', hl: 'Highlighting works on the original text only' },
      fr: { hq: 'Qualité supérieure sur ce PC (plus lent)', toh: 'Convertir en livre HTML', on: 'Précision accrue en ligne (envoie le texte à Google)', tr: 'Traduire', sh: 'Enregistrer la traduction en HTML', sp: 'Enregistrer la traduction en PDF', wait: 'La traduction n’est pas terminée', orig: 'Original', prep: 'Préparation de la langue (une fois)…', work: 'Traduction', mt: 'Traduction automatique', fail: 'Échec. Connectez-vous une fois à Internet pour télécharger la langue.', scan: 'Ce PDF est fait d’images sans texte : traduction impossible', hl: 'Le surlignage ne fonctionne que sur le texte original' },
      es: { hq: 'Mayor calidad en este PC (más lento)', toh: 'Convertir en libro HTML', on: 'Mayor precisión en línea (envía el texto a Google)', tr: 'Traducir', sh: 'Guardar la traducción como HTML', sp: 'Guardar la traducción como PDF', wait: 'La traducción aún no ha terminado', orig: 'Original', prep: 'Preparando el idioma (una vez)…', work: 'Traduciendo', mt: 'Traducción automática', fail: 'Falló. Conéctate a Internet una vez para descargar el idioma.', scan: 'Este PDF son imágenes escaneadas sin texto; no se puede traducir', hl: 'El subrayado solo funciona en el texto original' },
      it: { hq: 'Qualità superiore su questo PC (più lento)', toh: 'Converti in libro HTML', on: 'Maggiore precisione online (invia il testo a Google)', tr: 'Traduci', sh: 'Salva la traduzione come HTML', sp: 'Salva la traduzione come PDF', wait: 'La traduzione non è ancora terminata', orig: 'Originale', prep: 'Preparazione della lingua (una volta)…', work: 'Traduzione', mt: 'Traduzione automatica', fail: 'Non riuscita. Connettiti a Internet una volta per scaricare la lingua.', scan: 'Questo PDF è fatto di immagini senza testo: non si può tradurre', hl: 'L’evidenziazione funziona solo sul testo originale' },
      id: { hq: 'Kualitas lebih tinggi di PC ini (lebih lambat)', toh: 'Ubah ke buku HTML', on: 'Akurasi lebih tinggi online (mengirim teks ke Google)', tr: 'Terjemahkan', sh: 'Simpan terjemahan sebagai HTML', sp: 'Simpan terjemahan sebagai PDF', wait: 'Terjemahan belum selesai', orig: 'Asli', prep: 'Menyiapkan bahasa (sekali saja)…', work: 'Menerjemahkan', mt: 'Terjemahan mesin', fail: 'Gagal. Sambungkan internet sekali untuk mengunduh bahasa.', scan: 'PDF ini berupa gambar pindaian tanpa teks, sehingga tidak bisa diterjemahkan', hl: 'Penyorotan hanya berfungsi pada teks asli' }
    };
    return { NAMES: NAMES, TX: TX };
  })();
  // Runs INSIDE every book page: translates the visible text in place (markup, links and layout stay as they are).
  // Text helpers shared by the book translator and the PDF translator (injected into the page as window.__TRU).
  function TRU() {
    var ABBR = /(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|cf|al|Inc|Ltd|Co|Vol|pp|ca|approx|Fig|Eq|No|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|e\.g|i\.e|Mme|Mlle|M|Sra|Sr|Sig|Dott|Ing)\.$/i;
    function sentences(t) {
      var out = [], re = /([.!?؟…]+["'”’»)\]]*)\s+(?=\S)/g, last = 0, m;
      while ((m = re.exec(t))) {
        var end = m.index + m[1].length, head = t.slice(last, end), nxt = t.charAt(m.index + m[0].length);
        if (m[1].charAt(0) === '.') {
          if (ABBR.test(head) || /(?:^|[\s(])\p{Lu}\.$/u.test(head) || /^\(?\d{1,3}[.)]$/.test(head.trim())) continue;
          if (/^[a-zà-ÿ]/.test(nxt)) continue;
        }
        out.push(head); last = m.index + m[0].length;
      }
      out.push(t.slice(last));
      return out.filter(function (x) { return x.trim(); });
    }
    function splitLong(s, max) {
      if (s.length <= max * 1.5) return [s];
      var parts = s.match(/[^;:؛]+[;:؛]?\s*/g) || [s], res = [], cur = '';
      parts.forEach(function (p) {
        if (p.length > max * 1.5) { var sub = p.match(/[^,،]+[,،]?\s*/g) || [p]; sub.forEach(function (q) { if (cur && (cur + q).length > max) { res.push(cur); cur = q; } else cur += q; }); }
        else if (cur && (cur + p).length > max) { res.push(cur); cur = p; } else cur += p;
      });
      if (cur) res.push(cur);
      var out = []; res.forEach(function (r) { while (r.length > max * 2) { var cut = r.lastIndexOf(' ', max * 1.5); if (cut < max * 0.5) cut = max; out.push(r.slice(0, cut)); r = r.slice(cut); } out.push(r); });
      return out;
    }
    // Break a paragraph into pieces of about `max` characters that end at sentence boundaries.
    function chunks(text, max) {
      max = max || 380; var out = [], cur = '';
      sentences(text.replace(/\s+/g, ' ').trim()).forEach(function (s) {
        splitLong(s, max).forEach(function (x) { x = x.trim(); if (!x) return; if (cur && (cur + ' ' + x).length > max) { out.push(cur); cur = x; } else cur = cur ? cur + ' ' + x : x; });
      });
      if (cur) out.push(cur);
      return out;
    }
    // Tidy a machine translation so it reads like the original was typeset: spacing, punctuation, digits, no stray final full stop.
    function clean(out, orig, tgt) {
      var s = String(out || '').replace(/\s+/g, ' ').trim();
      s = s.replace(/\s+([.,;:!?،؛؟…%)\]»])/g, '$1').replace(/([(\[«])\s+/g, '$1');
      if (tgt === 'ar') {
        s = s.replace(/(?<=[؀-ۿ])\s*,/g, '،').replace(/(?<=[؀-ۿ])\s*\?/g, '؟').replace(/(?<=[؀-ۿ])\s*;/g, '؛');
        s = s.replace(/(?<=[؀-ۿ] ?)"([^"]+)"/g, '«$1»');
      } else s = s.replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 1632); }).replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 1776); }).replace(/،/g, ',').replace(/؟/g, '?').replace(/؛/g, ';');
      var o = String(orig || '').trim();
      if (o && !/[.!?؟…:;"”»)\]]$/.test(o) && o.length < 140) s = s.replace(/[.。]+$/, '');   // headings and list items do not gain a full stop
      if (o && /^\p{Lu}/u.test(o) && tgt !== 'ar') s = s.charAt(0).toUpperCase() + s.slice(1);
      return s;
    }
    window.__TRU = { sentences: sentences, chunks: chunks, clean: clean };
  }

  function TRX() {
    var N = window.LiNative; if (!N || !N.translate) return;
    var UI = window.__TRS.UI || (window.__LI && window.__LI.ui) || 'ar';
    var NAMES = window.__TRS.NAMES, TX = window.__TRS.TX, U = window.__TRU, BID = window.__TRS.ID || '';
    var L = function (k) { return (TX[UI] || TX.en)[k]; };
    var STOP = { id: [' yang ', ' dan ', ' di ', ' untuk ', ' dengan ', ' ini ', ' itu ', ' dari '], fr: [' le ', ' la ', ' les ', ' des ', ' et ', ' est ', ' une ', ' que '], es: [' el ', ' los ', ' las ', ' que ', ' una ', ' por ', ' con ', ' para '], it: [' il ', ' che ', ' della ', ' una ', ' per ', ' non ', ' sono ', ' con '], en: [' the ', ' and ', ' of ', ' to ', ' is ', ' in ', ' that ', ' with '] };
    var BLK = {}; 'P,LI,H1,H2,H3,H4,H5,H6,BLOCKQUOTE,FIGCAPTION,TD,TH,DT,DD,DIV,SECTION,ARTICLE,ASIDE,CAPTION,SUMMARY,PRE,HEADER,FOOTER,NAV,UL,OL,TABLE,TR,FORM,FIELDSET,MAIN,BODY'.split(',').forEach(function (t) { BLK[t] = 1; });
    function skip(p) { return !p || p.closest('script,style,noscript,pre,code,svg,textarea,input,select,option,#li-tr-ui,[translate="no"],[data-notranslate]'); }
    function textNodes() { var out = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), n; while ((n = w.nextNode())) { var v = n.__o !== undefined ? n.__o : n.nodeValue; if (/\p{L}/u.test(v) && !/^\s*(?:https?:\/\/|www\.)\S+\s*$/i.test(v) && !skip(n.parentElement)) out.push(n); } return out; }
    function blockOf(n) { var e = n.parentElement; while (e && !BLK[e.tagName]) e = e.parentElement; return e || document.body; }
    function ov(n) { return n.__o !== undefined ? n.__o : n.nodeValue; }
    function brBetween(a, b) { try { var r = document.createRange(); r.setStartAfter(a); r.setEndBefore(b); return !!r.cloneContents().querySelector('br'); } catch (e) { return false; } }
    function bodyText() { return textNodes().map(ov).join(' '); }   // not innerText: it is empty while the page is hidden
    function detect() {
      var body = bodyText(), s = (body.slice(0, 2500) + ' ' + body.slice(Math.floor(body.length / 2), Math.floor(body.length / 2) + 2500)), ar = (s.match(/[؀-ۿ]/g) || []).length, lt = (s.match(/[A-Za-z]/g) || []).length;
      if (ar > lt) return 'ar';
      var low = ' ' + s.toLowerCase().replace(/[^a-zàâçéèêëîïôûùüÿñáíóúäöß\s]/g, ' ').replace(/\s+/g, ' ') + ' ', best = 'en', bs = -1;
      Object.keys(STOP).forEach(function (k) { var c = 0; STOP[k].forEach(function (w) { c += low.split(w).length - 1; }); if (c > bs && c > 0) { bs = c; best = k; } });
      return best;
    }
    function getSrc() { if (!SRC && bodyText().length > 200) SRC = detect(); return SRC || detect(); }
    var SRC = null, state = { tgt: null, run: 0, total: 0, done: 0, failed: false, errs: 0, bad: 0 }, pend = {}, seq = 0, inflight = 0, queue = [], units = [];
    var key = 'li-tr-target:' + BID, saved = null; try { saved = localStorage.getItem(key); } catch (e) {}
    // ---- cache (per book, on this device); "2|" marks the paragraph-level format
    var db = null, dbq = [];
    try { var rq = indexedDB.open('li-tr', 1); rq.onupgradeneeded = function () { rq.result.createObjectStore('c'); }; rq.onsuccess = function () { db = rq.result; dbq.forEach(function (f) { f(); }); dbq = []; }; rq.onerror = function () { db = false; dbq.forEach(function (f) { f(); }); dbq = []; }; } catch (e) { db = false; }
    function h(s) { var x = 5381; for (var i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; return (x >>> 0).toString(36) + '.' + s.length; }
    function cget(k, cb) { var go = function () { if (!db) return cb(null); try { var r = db.transaction('c').objectStore('c').get(k); r.onsuccess = function () { cb(r.result || null); }; r.onerror = function () { cb(null); }; } catch (e) { cb(null); } }; db === null ? dbq.push(go) : go(); }
    function cput(k, v) { if (!db) return; try { db.transaction('c', 'readwrite').objectStore('c').put(v, k); } catch (e) {} }
    function cmany(keys, cb) {
      var go = function () {
        if (!db || !keys.length) return cb({});
        try { var st = db.transaction('c').objectStore('c'), out = {}, n = keys.length, one = function () { if (--n === 0) cb(out); };
          keys.forEach(function (k) { var r = st.get(k); r.onsuccess = function () { if (r.result) out[k] = r.result; one(); }; r.onerror = one; });
        } catch (e) { cb({}); }
      };
      if (db) go(); else dbq.push(go);
    }
    // ---- UI
    var ui = document.createElement('div'); ui.id = 'li-tr-ui'; ui.setAttribute('translate', 'no');
    ui.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483000;font:600 13px/1.2 system-ui,sans-serif;direction:ltr';
    var btn = document.createElement('button'); btn.type = 'button'; btn.setAttribute('aria-label', L('tr'));
    btn.style.cssText = 'min-width:42px;height:42px;padding:0 12px;border-radius:21px;border:1px solid rgba(176,141,87,.8);background:rgba(29,43,51,.88);color:#f5eedd;font:700 15px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25);touch-action:manipulation';
    btn.textContent = 'A文'; ui.appendChild(btn);
    var menu = document.createElement('div'); menu.style.cssText = 'display:none;position:absolute;bottom:50px;left:0;min-width:170px;background:#fbf7ec;color:#1d2b33;border:1px solid #d9cdb0;border-radius:14px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.25)'; ui.appendChild(menu);
    var tip = document.createElement('div'); tip.style.cssText = 'display:none;position:absolute;bottom:50px;left:0;width:max-content;max-width:78vw;line-height:1.4;background:rgba(29,43,51,.92);color:#f5eedd;border-radius:10px;padding:7px 11px;font:600 12px system-ui,sans-serif'; ui.appendChild(tip);
    var tipT = 0; function say(t, ms) { tip.textContent = t; tip.style.display = 'block'; clearTimeout(tipT); if (ms) tipT = setTimeout(function () { tip.style.display = 'none'; }, ms); }
    function mount() { if (document.body && !ui.parentNode) document.body.appendChild(ui); }
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
    // ---- plan: paragraphs (not loose text pieces) are what gets translated
    function plan() {
      var groups = [], map = new Map();
      textNodes().forEach(function (n) { var b = blockOf(n), g = map.get(b); if (!g) { g = { b: b, nodes: [] }; map.set(b, g); groups.push(g); } g.nodes.push(n); });
      var out = [];
      groups.forEach(function (g) {
        var runs = [], cur = [];
        g.nodes.forEach(function (n, i) { if (i && brBetween(g.nodes[i - 1], n)) { runs.push(cur); cur = []; } cur.push(n); });
        if (cur.length) runs.push(cur);
        runs.forEach(function (ns) {
          var inLink = ns.some(function (n) { return n.parentElement && n.parentElement.closest('a[href]'); });
          var parts = ns.length > 1 && inLink ? ns.map(function (n) { return [n]; }) : [ns];   // links inside a sentence keep their own text
          parts.forEach(function (p) {
            var text = p.map(ov).join('').replace(/\s+/g, ' ').trim(); if (!text) return;
            var main = p.filter(function (n) { return n.parentElement === g.b; }).sort(function (a, b) { return ov(b).length - ov(a).length; })[0] || p.slice().sort(function (a, b) { return ov(b).length - ov(a).length; })[0];
            out.push({ b: g.b, nodes: p, main: main, text: text, chunks: U.chunks(text, 380), res: [], left: 0 });
          });
        });
      });
      return out;
    }
    function align(b) {
      if (b.hasAttribute('data-li-dir')) return;
      b.setAttribute('data-li-dir', b.hasAttribute('dir') ? b.getAttribute('dir') : '\u0000'); b.setAttribute('dir', 'auto');
      try { var ta = getComputedStyle(b).textAlign; if (ta === 'left' || ta === 'right') { b.setAttribute('data-li-ta', b.style.textAlign || '\u0000'); b.style.textAlign = 'start'; } } catch (e) {}
    }
    function applyUnit(u) {
      var tr = u.chunks.map(function (c, i) { return u.res[i] != null ? u.res[i] : c; }).join(' ');
      u.nodes.forEach(function (n) { if (n.__o === undefined) n.__o = n.nodeValue; });
      var o = u.main.__o, lead = (o.match(/^\s*/) || [''])[0], trail = (o.match(/\s*$/) || [''])[0];
      u.nodes.forEach(function (n) { if (n !== u.main) n.nodeValue = ''; });
      u.main.nodeValue = lead + tr + trail; align(u.b);
    }
    function progress() { var p = state.total ? Math.min(state.done >= state.total ? 100 : 99, Math.floor(state.done / state.total * 100)) : 100; btn.textContent = state.done >= state.total ? 'A文' : p + '%'; if (state.done >= state.total) { btn.style.background = 'rgba(93,101,64,.95)'; if (state.quiet) { state.quiet = false; reveal(); } else say(state.bad ? L('mt') + ' · ' + NAMES[state.tgt] + ' · ' + state.bad + ' ⚠' : L('mt') + ' · ' + NAMES[state.tgt], 3500); } }
    function finishChunk(job, text, ok) {
      var u = job.u; u.res[job.i] = text; if (!ok) state.bad++; u.left--; state.done++;
      if (u.left === 0) applyUnit(u);
      progress(); report(state.done >= state.total);
    }
    var lazy = false, budget = 1e9, rt = 0, BG = window.name === 'li-bg', lastRep = 0;
    function report(force) { var n = Date.now(); if (!force && n - lastRep < 700) return; lastRep = n;
      if (state.tgt && state.total > 0 && state.done >= state.total && state.sent !== state.run && !state.failed) { state.sent = state.run; try { parent.postMessage({ liBook: 1, type: 'tr-done', id: window.__TRS && window.__TRS.ID, tgt: state.tgt, html: exportHtml() }, '*'); } catch (e) {} }
      try { parent.postMessage({ liBook: 1, type: 'tr-state', id: window.__TRS && window.__TRS.ID, tgt: state.tgt, done: state.done, total: state.total, bg: BG }, '*'); } catch (e) {} }
    function reprio() {
      if (!queue.length) return; var vh = innerHeight, cache = new Map();
      queue.forEach(function (j) { var d = cache.get(j.u); if (d == null) { var r = j.u.b.getBoundingClientRect(); d = r.bottom < -vh * 0.3 ? 1e6 - r.bottom : Math.max(0, r.top); cache.set(j.u, d); } j._d = d; });
      queue.sort(function (a, b) { return a._d - b._d || a.i - b.i; });
    }
    window.addEventListener('scroll', function () { if (!lazy || !state.tgt) return; clearTimeout(rt); rt = setTimeout(function () { if (budget < 10) { reprio(); budget = 24; pump(state.run); } }, 350); }, { passive: true });
    function pump(run) {
      while (inflight < 3 && queue.length && run === state.run && budget > 0) {
        budget--;
        (function (job) {
          var core = job.u.chunks[job.i], k = '2|' + state.tgt + '|' + SRC + '|' + h(core);
          if (!/\p{L}/u.test(core)) { finishChunk(job, core, true); return; }
          inflight++;
          cget(k, function (c) {
            if (run !== state.run) { inflight--; return; }
            if (c && c.t === core) { inflight--; finishChunk(job, c.v, true); pump(run); return; }
            var id = (BG ? 'g' : 'r') + (++seq); pend[id] = { job: job, core: core, k: k, run: run };
            N.translate(id, core, SRC, state.tgt);
          });
        })(queue.shift());
      }
    }
    window.addEventListener('message', function (e) {
      var d = e.data; if (!d || !d.liTr) return;
      if (!d.id) { if (d.kind === 'prep') say(L('prep'), 0); else if (d.kind === 'ready') say(L('work') + '…', 1500); else if (d.kind === 'nomodel' || d.kind === 'err-all') failAll(d.text); return; }
      var p = pend[d.id]; if (!p) return; delete pend[d.id]; inflight--;
      if (p.run !== state.run) return;
      if (d.kind === 'ok' && d.text) { state.errs = 0; var v = U.clean(d.text, p.core, state.tgt); cput(p.k, { t: p.core, v: v }); finishChunk(p.job, v, true); }
      else { if (d.text && ++state.errs >= 6) { failAll(d.text); return; } finishChunk(p.job, p.core, false); }
      pump(p.run);
    });
    function failAll(why) { revert(true); state.failed = true; say(L('fail') + (why ? ' [' + String(why).slice(0, 70) + ']' : ''), 12000); }
    function reveal() { try { document.documentElement.style.visibility = ''; } catch (e) {} }
    function start(tgt, auto) {
      revert(true); state.quiet = !!auto; state.errs = 0; state.bad = 0; state.tgt = tgt; state.run++; state.failed = false; SRC = getSrc();
      if (SRC === tgt) { state.tgt = null; return; }
      units = plan();
      var vh = innerHeight, first = 0;
      for (var i = 0; i < units.length; i++) { var r = units[i].b.getBoundingClientRect(); if (r.bottom > 0 && (r.width || r.height)) { first = i; break; } }
      var ordered = units.slice(first).concat(units.slice(0, first)), jobs = [];
      ordered.forEach(function (u) { u.left = u.chunks.length; u.chunks.forEach(function (c, i) { jobs.push({ u: u, i: i }); }); });
      lazy = !BG && !!(N.slow && N.slow()); budget = lazy ? 24 : 1e9;
      queue = jobs; state.total = jobs.length; state.done = 0; window.__LI_TR = true; try { localStorage.setItem(key, tgt); } catch (e) {}
      btn.style.background = 'rgba(29,43,51,.88)'; btn.textContent = '0%'; if (!auto) say(L('work') + '…', 0);
      document.documentElement.setAttribute('data-li-lang', tgt);
      if (!jobs.length) { progress(); reveal(); return; }
      // Finished work is read back from the saved copy in one go, so reopening a translated book shows it at once instead of translating again.
      var run0 = state.run, keys = [];
      jobs.forEach(function (j) { var core = j.u.chunks[j.i]; j.core = core; j.k = /\p{L}/u.test(core) ? '2|' + tgt + '|' + SRC + '|' + h(core) : null; if (j.k) keys.push(j.k); });
      cmany(keys, function (hit) {
        if (run0 !== state.run) return;
        var rest = [];
        jobs.forEach(function (j) { var c = j.k && hit[j.k]; if (c && c.t === j.core) finishChunk(j, c.v, true); else rest.push(j); });
        if (run0 !== state.run) return;
        queue = rest; reveal();
        if (rest.length && state.quiet) { state.quiet = false; }
        pump(state.run);
      });
    }
    function revert(quiet) {
      state.run++; queue = []; pend = {}; inflight = 0; units = [];
      [].forEach.call(document.querySelectorAll('[data-li-dir]'), function (b) { var v = b.getAttribute('data-li-dir'); if (v === '\u0000') b.removeAttribute('dir'); else b.setAttribute('dir', v); b.removeAttribute('data-li-dir'); if (b.hasAttribute('data-li-ta')) { var t = b.getAttribute('data-li-ta'); b.style.textAlign = t === '\u0000' ? '' : t; b.removeAttribute('data-li-ta'); } });
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), n; while ((n = w.nextNode())) { if (n.__o !== undefined) { n.nodeValue = n.__o; delete n.__o; } }
      window.__LI_TR = false; state.tgt = null; btn.textContent = 'A文'; btn.style.background = 'rgba(29,43,51,.88)'; tip.style.display = 'none';
      document.documentElement.removeAttribute('data-li-lang');
      try { localStorage.removeItem(key); } catch (e) {} if (!quiet) say(L('orig'), 1500);
    }
    // Save the translated book: as an HTML file (opens anywhere) or as a PDF (print to PDF).
    function exportHtml() {
      var c = document.documentElement.cloneNode(true);
      [].forEach.call(c.querySelectorAll('#li-tr-ui,script,base,#li-sel-bar,.li-ui,#li-dock-css,#li-font-css,#li-pg-css'), function (x) { x.remove(); }); c.classList.remove('li-paged'); [].forEach.call(c.querySelectorAll('.li-speak'), function (x) { x.classList.remove('li-speak'); });
      [].forEach.call(c.querySelectorAll('[data-li-dir],[data-li-ta]'), function (x) { x.removeAttribute('data-li-dir'); x.removeAttribute('data-li-ta'); });
      c.style.zoom = ''; c.style.touchAction = ''; c.style.visibility = ''; if (!c.getAttribute('style')) c.removeAttribute('style'); c.setAttribute('lang', state.tgt); c.setAttribute('dir', state.tgt === 'ar' ? 'rtl' : 'ltr'); c.removeAttribute('data-li-lang');
      var st = document.createElement('style'); st.textContent = '@page{margin:18mm}@media print{#li-tr-ui{display:none}}'; (c.querySelector('head') || c).appendChild(st);
      return '<!doctype html>\n' + c.outerHTML;
    }
    function saveAs(kind) {
      if (state.done < state.total) { if (lazy) { lazy = false; budget = 1e9; pump(state.run); } say(L('wait'), 4000); return; }
      var base = (document.title || 'book').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) + ' - ' + state.tgt, html = exportHtml();
      if (kind === 'pdf') { parent.postMessage({ liBook: 1, type: 'print-pdf', name: base, html: html }, '*'); return; }
      var r = new FileReader(); r.onload = function () { parent.postMessage({ liBook: 1, type: 'save-file', name: base + '.html', mime: 'text/html', data: r.result }, '*'); }; r.readAsDataURL(new Blob([html], { type: 'text/html' }));
    }
    function showMenu() {
      SRC = getSrc(); menu.innerHTML = '';
      var items = []; if (state.tgt) { items.push(['', L('orig')]); items.push(['@html', L('sh')]); if (N.printHtml) items.push(['@pdf', L('sp')]); }
      Object.keys(NAMES).forEach(function (k) { if (k !== SRC) items.push([k, NAMES[k]]); });
      if (N.setOnline) items.push(['@online', (N.online && N.online() ? '✓ ' : '') + L('on')]); if (N.setHQ) items.push(['@hq', (N.hq && N.hq() ? '✓ ' : '') + L('hq')]);
      items.forEach(function (it) { var b = document.createElement('button'); b.type = 'button'; b.textContent = it[1]; b.style.cssText = 'display:block;width:100%;text-align:start;border:0;background:' + (it[0] === state.tgt ? '#e8dec3' : 'none') + ';padding:9px 12px;border-radius:9px;font:600 14px system-ui,sans-serif;color:#1d2b33'; b.onclick = function (ev) { ev.stopPropagation(); menu.style.display = 'none'; if (it[0] === '@html') saveAs('html'); else if (it[0] === '@pdf') saveAs('pdf'); else if (it[0] === '@online') { try { N.setOnline(!N.online()); } catch (x) {} } else if (it[0] === '@hq') { try { N.setHQ(!N.hq()); } catch (x) {} } else if (it[0]) { if (BG) start(it[0]); else parent.postMessage({ liBook: 1, type: 'tr-want', id: window.__TRS && window.__TRS.ID, tgt: it[0] }, '*'); } else revert(); }; menu.appendChild(b); });
      menu.style.display = 'block';
    }
    var lp = 0, longp = false;
    btn.addEventListener('touchstart', function () { longp = false; lp = setTimeout(function () { longp = true; showMenu(); }, 550); }, { passive: true });
    btn.addEventListener('touchend', function () { clearTimeout(lp); }, { passive: true });
    btn.addEventListener('click', function (e) {
      e.stopPropagation(); if (longp) { longp = false; return; }
      if (menu.style.display === 'block') { menu.style.display = 'none'; return; }
      if (state.tgt) { showMenu(); return; }
      SRC = getSrc(); showMenu();
    });
    document.addEventListener('click', function (e) { if (!ui.contains(e.target)) menu.style.display = 'none'; }, true);
    if (saved && NAMES[saved]) { try { document.documentElement.style.visibility = 'hidden'; } catch (e) {} setTimeout(reveal, 3500); var go0 = function () { var t0 = Date.now(); (function tryGo() { if (bodyText().length < 200 && Date.now() - t0 < 2500) { setTimeout(tryGo, 150); return; } if (getSrc() !== saved) start(saved, true); else reveal(); })(); }; setTimeout(go0, 60); }
    window.__liTrAPI = { start: start, revert: revert, state: state, menu: showMenu };
    window.addEventListener('message', function (e) { var d = e.data; if (d && d.liCmd === 'trmenu') { showMenu(); } else if (d && d.liCmd === 'trgo' && NAMES[d.tgt]) { start(d.tgt); } else if (d && d.liCmd === 'trstop') { queue.length = 0; state.run++; btn.textContent = 'A文'; } });
  }

  // Runs INSIDE the PDF viewer page: translates page text and paints it over the original text, in place.
  function PDFX() {
    var N = window.LiNative; if (!N || !N.translate) return;
    var lib = window['pdfjs-dist/build/pdf']; if (!lib) return;
    var T = window.__TRS, U = window.__TRU, NAMES = T.NAMES, UI = (window.__LI && window.__LI.ui) || 'ar', L = function (k) { return (T.TX[UI] || T.TX.en)[k]; };
    var doc = null, own = null; try { var og = lib.getDocument; lib.getDocument = function () { var t = og.apply(lib, arguments); try { t.promise.then(function (d) { doc = d; }); } catch (e) {} return t; }; } catch (e) {}
    // pdf.js may not allow patching its exports; then open the file a second time ourselves.
    function getDoc() { if (doc) return Promise.resolve(doc); if (!own) { var I = window.__LI || {}; own = lib.getDocument({ url: I.url, cMapUrl: I.base + 'cmaps/', cMapPacked: true, standardFontDataUrl: I.base + 'standard_fonts/' }).promise.then(function (d) { doc = d; return d; }); } return own; }
    var SRC = null, tgt = null, run = 0, store = {}, pend = {}, seq = 0, busy = 0, noText = 0, asked = {};
    var db = null, dbq = [];
    try { var rq = indexedDB.open('li-pdftr', 1); rq.onupgradeneeded = function () { rq.result.createObjectStore('c'); }; rq.onsuccess = function () { db = rq.result; dbq.forEach(function (f) { f(); }); dbq = []; }; rq.onerror = function () { db = false; dbq.forEach(function (f) { f(); }); dbq = []; }; } catch (e) { db = false; }
    function h(s) { var x = 5381; for (var i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; return (x >>> 0).toString(36) + '.' + s.length; }
    function cget(k, cb) { var go = function () { if (!db) return cb(null); try { var r = db.transaction('c').objectStore('c').get(k); r.onsuccess = function () { cb(r.result || null); }; r.onerror = function () { cb(null); }; } catch (e) { cb(null); } }; db === null ? dbq.push(go) : go(); }
    function cput(k, v) { if (!db) return; try { db.transaction('c', 'readwrite').objectStore('c').put(v, k); } catch (e) {} }
    var STOP = { id: [' yang ', ' dan ', ' di ', ' untuk ', ' dengan ', ' ini ', ' itu '], fr: [' le ', ' la ', ' les ', ' des ', ' et ', ' est ', ' une '], es: [' el ', ' los ', ' las ', ' que ', ' una ', ' por ', ' con '], it: [' il ', ' che ', ' della ', ' una ', ' per ', ' non ', ' sono '], en: [' the ', ' and ', ' of ', ' to ', ' is ', ' in ', ' that '] };
    function detect(s) { var ar = (s.match(/[؀-ۿ]/g) || []).length, lt = (s.match(/[A-Za-z]/g) || []).length; if (ar > lt) return 'ar'; var low = ' ' + s.toLowerCase().replace(/[^a-zàâçéèêëîïôûùüÿñáíóúäöß\s]/g, ' ').replace(/\s+/g, ' ') + ' ', best = 'en', bs = -1; Object.keys(STOP).forEach(function (k) { var c = 0; STOP[k].forEach(function (w) { c += low.split(w).length - 1; }); if (c > bs && c > 0) { bs = c; best = k; } }); return best; }
    // ---- UI
    var st = document.createElement('style'); st.textContent = '.tro{position:absolute;inset:0;pointer-events:none;overflow:hidden}body.night .tro{filter:invert(.92) hue-rotate(180deg)}body.sepia .tro{filter:sepia(.45) contrast(.95)}.tro .c{position:absolute}.tro .t{position:absolute;overflow:visible;line-height:1.18;font-family:system-ui,"Noto Naskh Arabic","Noto Sans",sans-serif;word-break:break-word}';
    document.head.appendChild(st);
    var ui = document.createElement('div'); ui.setAttribute('translate', 'no'); ui.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483000;font:600 13px/1.2 system-ui,sans-serif;direction:ltr';
    var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'A文'; btn.style.cssText = 'min-width:42px;height:42px;padding:0 12px;border-radius:21px;border:1px solid rgba(176,141,87,.8);background:rgba(29,43,51,.88);color:#f5eedd;font:700 15px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);opacity:.85'; ui.appendChild(btn);
    var menu = document.createElement('div'); menu.style.cssText = 'display:none;position:absolute;bottom:50px;left:0;min-width:150px;background:#fbf7ec;color:#1d2b33;border:1px solid #d9cdb0;border-radius:14px;padding:6px;box-shadow:0 6px 18px rgba(0,0,0,.25)'; ui.appendChild(menu);
    var tip = document.createElement('div'); tip.style.cssText = 'display:none;position:absolute;bottom:50px;left:0;max-width:78vw;background:rgba(29,43,51,.92);color:#f5eedd;border-radius:10px;padding:7px 11px;font:600 12px/1.4 system-ui,sans-serif'; ui.appendChild(tip);
    var tt = 0; function say(t, ms) { tip.textContent = t; tip.style.display = 'block'; clearTimeout(tt); if (ms) tt = setTimeout(function () { tip.style.display = 'none'; }, ms); }
    document.body.appendChild(ui);
    function label() { btn.textContent = busy > 0 ? '…' : 'A文'; }
    // ---- extract text blocks of one page
    function blocksOf(items, vp) {
      var G = window.__PDFGEO; if (G) { try { return G.pageBlocks(items, vp.width, vp.height).map(function (b) { return { text: b.txt, l: b.l, r: b.r, t: b.t, b: b.b, fs: b.fs, rtl: b.rtl }; }); } catch (e) {} }
      var its = items.filter(function (i) { return i.str && i.str.trim(); }).map(function (i) { var fs = Math.hypot(i.transform[0], i.transform[1]) || i.height || 10; return { s: i.str, x: i.transform[4], y: vp.height - i.transform[5], w: i.width || 0, fs: fs }; });
      its.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
      var lines = [], cur = null;
      its.forEach(function (i) { if (cur && Math.abs(i.y - cur.y) < Math.max(i.fs, cur.fs) * 0.45) cur.it.push(i); else { cur = { y: i.y, it: [i] }; lines.push(cur); } });
      var segs = [];
      lines.forEach(function (ln) {
        ln.it.sort(function (a, b) { return a.x - b.x; });
        var g = [ln.it[0]];
        for (var k = 1; k <= ln.it.length; k++) { var a = ln.it[k - 1], b = ln.it[k]; if (b && b.x - (a.x + a.w) <= Math.max(a.fs, b.fs) * 2.2) { g.push(b); continue; } if (g.length) { segs.push(mkSeg(g)); } g = b ? [b] : []; }
      });
      function mkSeg(g) { var raw = g.map(function (i) { return i.s; }).join(''), rtl = (raw.match(/[؀-ۿ]/g) || []).length > raw.length / 3, arr = rtl ? g.slice().reverse() : g, txt = ''; arr.forEach(function (i, n) { var p = arr[n - 1]; if (n) { var gap = rtl ? (p.x - (i.x + i.w)) : (i.x - (p.x + p.w)); if (gap > i.fs * 0.15 && !/^\s/.test(i.s) && !/\s$/.test(p.s)) txt += ' '; } txt += i.s; }); var fs = 0, l = 1e9, r = -1e9; g.forEach(function (i) { fs = Math.max(fs, i.fs); l = Math.min(l, i.x); r = Math.max(r, i.x + i.w); }); return { text: txt.replace(/\s+/g, ' ').trim(), l: l, r: r, t: g[0].y - fs * 0.85, b: g[0].y + fs * 0.25, fs: fs, rtl: rtl }; }
      segs.sort(function (a, b) { return a.t - b.t || a.l - b.l; });
      var bl = [];
      segs.forEach(function (s) {
        var best = null;
        for (var i = bl.length - 1; i >= 0 && i > bl.length - 40; i--) { var b = bl[i], ov = Math.min(b.r, s.r) - Math.max(b.l, s.l), minw = Math.min(b.r - b.l, s.r - s.l);
          if (s.t - b.b <= s.fs * 0.9 && s.t >= b.t && ov > minw * 0.4 && Math.abs(b.fs - s.fs) <= s.fs * 0.2 && (Math.abs(b.l - s.l) < s.fs * 3 || Math.abs(b.r - s.r) < s.fs * 3)) { best = b; break; } }
        if (best) { var j = /-$/.test(best.text) && /^[a-zà-ÿ]/.test(s.text) ? '' : ' '; best.text = (j ? best.text : best.text.slice(0, -1)) + j + s.text; best.l = Math.min(best.l, s.l); best.r = Math.max(best.r, s.r); best.b = s.b; }
        else bl.push({ text: s.text, l: s.l, r: s.r, t: s.t, b: s.b, fs: s.fs, rtl: s.rtl });
      });
      return bl.filter(function (b) { return /\p{L}{2}/u.test(b.text); });
    }
    function pageEl(n) { return document.querySelectorAll('.pg')[n - 1]; }
    function rect(n) { var el = pageEl(n); return el && el.clientWidth ? el : null; }
    // ---- paint translated blocks of page n
    function paint(n) {
      var d = store[n]; if (!d || !d.done || !tgt) return; var el = rect(n), cv = el && el.querySelector('canvas'); if (!el || !cv) return;
      var old = el.querySelector('.tro'); if (old) old.remove();
      var box = document.createElement('div'); box.className = 'tro'; el.appendChild(box); var k = el.clientWidth / d.w, kv = el.clientHeight / d.h, ctx = null; try { ctx = cv.getContext('2d'); } catch (e) {}
      var sx = cv.width / d.w, sy = cv.height / d.h, rtlT = tgt === 'ar';
      d.blocks.forEach(function (b, bi) {
        if (!b.tr) return; var pad = b.fs * 0.15, L0 = b.l - pad, T0 = b.t - pad * 0.6, W0 = b.r - b.l + pad * 2, H0 = b.b - b.t + pad * 1.2, bg = '#fff', fg = '#111';
        try { var px = ctx.getImageData(Math.max(0, Math.floor(L0 * sx) - 1), Math.max(0, Math.floor(T0 * sy) - 1), 1, 1).data; if (px[3]) { bg = 'rgb(' + px[0] + ',' + px[1] + ',' + px[2] + ')'; var lum = (px[0] * 299 + px[1] * 587 + px[2] * 114) / 1000; fg = lum > 140 ? '#111' : '#f5f5f5'; } } catch (e) {}
        var c = document.createElement('div'); c.className = 'c'; c.style.cssText = 'left:' + L0 * k + 'px;top:' + T0 * kv + 'px;width:' + W0 * k + 'px;height:' + H0 * kv + 'px;background:' + bg; box.appendChild(c);
        var nxt = d.blocks.reduce(function (m, o) { return (o !== b && o.t >= b.b - 1 && Math.min(o.r, b.r) - Math.max(o.l, b.l) > 0 && o.t < m) ? o.t : m; }, d.h);
        var maxH = Math.max(H0, nxt - T0 - b.fs * 0.3) * kv, t = document.createElement('div'); t.className = 't'; t.textContent = b.tr; t.dir = rtlT ? 'rtl' : 'ltr';
        var fs = b.fs * k * 0.97, minfs = fs * 0.5; t.style.cssText = 'left:' + L0 * k + 'px;top:' + T0 * kv + 'px;width:' + W0 * k + 'px;color:' + fg + ';text-align:' + (rtlT ? 'right' : 'left') + ';font-size:' + fs + 'px';
        box.appendChild(t); var guard = 0; while (t.scrollHeight > maxH && fs > minfs && guard++ < 30) { fs *= 0.93; t.style.fontSize = fs + 'px'; }
        t.style.background = 'transparent';
      });
    }
    // ---- translate one page
    function ensure(n) {
      if (!tgt) return; var s = store[n]; if (s) { if (s.done) paint(n); return; }
      s = store[n] = { done: false, blocks: [], w: 1, h: 1 }; var myRun = run; busy++; label();
      getDoc().then(function (dd) { return dd.getPage(n); }).then(function (pg) { var vp = pg.getViewport({ scale: 1 }); s.w = vp.width; s.h = vp.height; return pg.getTextContent().then(function (tc) { return blocksOf(tc.items, vp); }); }).then(function (bl) {
        if (myRun !== run) { busy--; label(); return; } s.blocks = bl;
        if (!bl.length) { noText++; s.done = true; busy--; label(); if (noText >= 2 && !asked.scan) { asked.scan = 1; say(L('scan'), 6000); } return; }
        if (!SRC) { SRC = detect(bl.map(function (b) { return b.text; }).join(' ').slice(0, 4000)); if (SRC === tgt) { busy--; label(); revert(true); return; } }
        var left = bl.length; function one() { left--; if (left <= 0) { s.done = true; busy--; label(); if (myRun === run) { paint(n); say(L('mt') + ' · ' + NAMES[tgt], 2200); } } }
        bl.forEach(function (b) {
          b.chunks = U.chunks(b.text, 380); b.res = []; b.left = b.chunks.length;
          var fin = function (ci, v) { b.res[ci] = v; if (--b.left === 0) { b.tr = b.res.join(' '); one(); } };
          b.chunks.forEach(function (core, ci) {
            if (!/\p{L}/u.test(core)) { fin(ci, core); return; }
            var k = '2|' + tgt + '|' + SRC + '|' + h(core);
            cget(k, function (c) { if (myRun !== run) return; if (c && c.t === core) { fin(ci, c.v); return; } var id = 'p' + (++seq); pend[id] = { b: b, ci: ci, core: core, k: k, run: myRun, fin: fin }; N.translate(id, core, SRC, tgt); });
          });
        });
      }).catch(function () { busy--; label(); delete store[n]; });
    }
    window.addEventListener('message', function (e) {
      var d = e.data; if (!d || !d.liTr) return;
      if (!d.id) { if (d.kind === 'prep') say(L('prep'), 0); else if (d.kind === 'ready') say(L('work') + '…', 1500); else if (d.kind === 'nomodel' || d.kind === 'err-all') { revert(true); say(L('fail') + (d.text ? ' [' + String(d.text).slice(0, 70) + ']' : ''), 12000); } return; }
      var p = pend[d.id]; if (!p) return; delete pend[d.id]; if (p.run !== run) return;
      if (d.kind === 'ok' && d.text) { var v = U.clean(d.text, p.core, tgt); cput(p.k, { t: p.core, v: v }); p.fin(p.ci, v); } else p.fin(p.ci, p.core);
    });
    function visible() { var sc = document.getElementById('sc'); if (!sc) return []; var t = sc.scrollTop, b = t + sc.clientHeight, out = []; [].forEach.call(document.querySelectorAll('.pg'), function (el, i) { var top = el.offsetTop - sc.offsetTop, bot = top + el.offsetHeight; if (bot > t - 400 && top < b + 400) out.push(i + 1); }); return out; }
    function refresh() { if (!tgt) return; var v = visible(); v.forEach(ensure); if (v.length) ensure(v[v.length - 1] + 1); }
    var rt = 0; function later() { clearTimeout(rt); rt = setTimeout(refresh, 160); }
    var sc0 = document.getElementById('sc'); if (sc0) sc0.addEventListener('scroll', later, { passive: true });
    new MutationObserver(function (ms) { if (!tgt) return; for (var i = 0; i < ms.length; i++) { var m = ms[i]; if ([].some.call(m.addedNodes, function (x) { return x.nodeType === 1 && x.tagName === 'CANVAS'; })) { later(); break; } } }).observe(document.getElementById('pages') || document.body, { childList: true, subtree: true });
    function start(t) { revert(true); tgt = t; run++; SRC = null; store = {}; noText = 0; asked = {}; btn.style.background = 'rgba(93,101,64,.95)'; say(L('work') + '…', 0); try { localStorage.setItem('li-pdf-tr:' + (window.__LI && window.__LI.id), t); } catch (e) {} refresh(); }
    function revert(quiet) { run++; pend = {}; tgt = null; store = {}; busy = 0; label(); [].forEach.call(document.querySelectorAll('.tro'), function (x) { x.remove(); }); btn.style.background = 'rgba(29,43,51,.88)'; tip.style.display = 'none'; try { localStorage.removeItem('li-pdf-tr:' + (window.__LI && window.__LI.id)); } catch (e) {} if (!quiet) say(L('orig'), 1500); }
    function sample() { return getDoc().then(function (dd) { return dd.getPage(Math.min(dd.numPages, 2)); }).then(function (pg) { return pg.getTextContent(); }).then(function (tc) { return tc.items.map(function (i) { return i.str; }).join(' ').slice(0, 3000); }).catch(function () { return ''; }); }
    function showMenu() { menu.innerHTML = ''; var items = []; if (tgt) items.push(['', L('orig')]); Object.keys(NAMES).forEach(function (k) { if (k !== SRC) items.push([k, NAMES[k]]); }); if (N.setOnline) items.push(['@online', (N.online && N.online() ? '✓ ' : '') + L('on')]); if (N.setHQ) items.push(['@hq', (N.hq && N.hq() ? '✓ ' : '') + L('hq')]); items.push(['@html', L('toh')]); items.forEach(function (it) { var b = document.createElement('button'); b.type = 'button'; b.textContent = it[1]; b.style.cssText = 'display:block;width:100%;text-align:start;border:0;background:' + (it[0] === tgt ? '#e8dec3' : 'none') + ';padding:9px 12px;border-radius:9px;font:600 14px system-ui,sans-serif;color:#1d2b33'; b.onclick = function (ev) { ev.stopPropagation(); menu.style.display = 'none'; if (it[0] === '@online') { try { N.setOnline(!N.online()); } catch (x) {} } else if (it[0] === '@hq') { try { N.setHQ(!N.hq()); } catch (x) {} } else if (it[0] === '@html') { parent.postMessage({ liBook: 1, type: 'pdf-to-html', tr: tgt || '' }, '*'); } else if (it[0]) start(it[0]); else revert(); }; menu.appendChild(b); }); menu.style.display = 'block'; }
    var lp = 0, longp = false;
    btn.addEventListener('touchstart', function () { longp = false; lp = setTimeout(function () { longp = true; sample().then(function (s) { SRC = SRC || detect(s); showMenu(); }); }, 550); }, { passive: true });
    btn.addEventListener('touchend', function () { clearTimeout(lp); }, { passive: true });
    btn.addEventListener('click', function (e) { e.stopPropagation(); if (longp) { longp = false; return; } if (menu.style.display === 'block') { menu.style.display = 'none'; return; } if (tgt) { showMenu(); return; }
      sample().then(function (s) { SRC = SRC || detect(s); showMenu(); }); });
    // ---- read aloud, page after page (works with the screen off through the notification) ----
    var LS = { on: false, tok: 0 };
    function lsay(on) { try { parent.postMessage({ liBook: 1, type: 'plisten-state', on: on }, '*'); } catch (e) {} }
    function lchunks(t) {
      var out = [], re = /[^.!?؟۔…\n]+[.!?؟۔…]*\s*/g, m, c = '';
      while ((m = re.exec(t))) { var x = m[0]; while (x.length > 240) { var cut = x.lastIndexOf(' ', 220); if (cut < 80) cut = 220; if (c) { out.push(c); c = ''; } out.push(x.slice(0, cut)); x = x.slice(cut); } if ((c + x).length > 220 && c) { out.push(c); c = x; } else c += x; }
      if (c.trim()) out.push(c); return out.length ? out : [t];
    }
    function llang(t) {
      if (/[؀-ۿ]/.test(t)) return 'ar'; var l = ' ' + t.slice(0, 1500).toLowerCase() + ' ', best = 'en', bs = 0;
      var W = { fr: [' le ', ' la ', ' les ', ' des ', ' est ', ' une '], es: [' el ', ' los ', ' que ', ' una ', ' es ', ' por '], it: [' il ', ' che ', ' di ', ' una ', ' è ', ' per '], id: [' yang ', ' dan ', ' di ', ' ini ', ' itu ', ' dengan '], en: [' the ', ' and ', ' of ', ' to ', ' is ', ' in '] };
      Object.keys(W).forEach(function (k) { var c = 0; W[k].forEach(function (w) { c += l.split(w).length - 1; }); if (c > bs) { bs = c; best = k; } }); return best;
    }
    function ptext(n) { return getDoc().then(function (d) { return d.getPage(n); }).then(function (pg) { return pg.getTextContent(); }).then(function (tc) { var o = []; tc.items.forEach(function (it) { o.push(it.str); if (it.hasEOL) o.push(' '); }); return o.join(' ').replace(/\s+/g, ' ').trim(); }); }
    function lstop() { LS.on = false; LS.tok++; try { window.speechSynthesis.cancel(); } catch (e) {} lsay(false); }
    // Pages are queued ahead (on the phone the whole rest of the document), so reading continues by itself while the page is frozen in the background.
    function lpage(n, tok) {
      var Q = { np: n, out: 0, loading: false, total: 0 }; LS.q = Q;
      function top() {
        if (!LS.on || tok !== LS.tok || Q.loading) return;
        if (Q.out >= ((window.LiNative || parent.LiNative) ? 1e6 : 400)) return;
        if (Q.total && Q.np > Q.total) { if (Q.out <= 0) lstop(); return; }
        Q.loading = true;
        getDoc().then(function (d) { Q.total = d.numPages; if (Q.np > d.numPages) return ''; return ptext(Q.np); }).then(function (t) {
          Q.loading = false; if (!LS.on || tok !== LS.tok) return;
          var pn = Q.np; Q.np++;
          if (!t) { top(); return; }
          var cs = lchunks(t), lg = llang(t), G = {}; try { G = JSON.parse(parent.localStorage.getItem('li-dock') || '{}') || {}; } catch (e) {}
          cs.forEach(function (c, k) {
            var u = new SpeechSynthesisUtterance(c); u.lang = lg === 'ar' ? 'ar-SA' : lg; u.rate = G.rate || 1;
            try { var vs = (window.speechSynthesis.getVoices() || []).filter(function (v) { return (v.lang || '').toLowerCase().indexOf(lg) === 0; }); var pick = vs.filter(function (v) { return v.name === G.voice; })[0] || vs[0]; if (pick) { u.voice = pick; u.lang = pick.lang; } } catch (e) {}
            var fin = false; Q.out++;
            u.onstart = function () { if (k === 0 && LS.on && tok === LS.tok) { try { window.__pgo && window.__pgo(pn); } catch (e) {} } };
            var done = function () { if (fin) return; fin = true; Q.out--; if (!LS.on || tok !== LS.tok) return; top(); };
            u.onend = done; u.onerror = function (ev) { if (ev && (ev.error === 'interrupted' || ev.error === 'canceled')) return; done(); };
            try { window.speechSynthesis.speak(u); } catch (e) { lstop(); }
          });
          top();
        }).catch(function () { Q.loading = false; lstop(); });
      }
      top();
    }
    window.__liPdfStop = function () { if (LS.on) lstop(); };
    window.addEventListener('message', function (e) { var d = e.data; if (d && d.liCmd === 'plisten') { if (LS.on) { lstop(); return; } if (!window.speechSynthesis) return; LS.on = true; var tok = ++LS.tok; lsay(true); lpage((window.__pcur && window.__pcur()) || 1, tok); } });
    window.addEventListener('message', function (e) { var d = e.data; if (d && d.liCmd === 'trmenu') sample().then(function (s) { SRC = SRC || detect(s); showMenu(); }); });
    document.addEventListener('click', function (e) { if (!ui.contains(e.target)) menu.style.display = 'none'; }, true);
    var saved = null; try { saved = localStorage.getItem('li-pdf-tr:' + (window.__LI && window.__LI.id)); } catch (e) {}
    if (saved && NAMES[saved]) setTimeout(function () { sample().then(function (s) { SRC = detect(s); if (SRC !== saved) start(saved); }); }, 1500);
    window.__liPdfTr = { start: start, revert: revert, store: function () { return store; } };
  }
  function GEST() {
    var y3 = null, x3 = 0, fired = false, av = function (t, k) { return (t[0][k] + t[1][k] + t[2][k]) / 3; };
    addEventListener('touchstart', function (e) { if (e.touches.length === 3) { y3 = av(e.touches, 'clientY'); x3 = av(e.touches, 'clientX'); fired = false; } }, { passive: true });
    addEventListener('touchmove', function (e) { if (e.touches.length === 3 && y3 !== null && !fired && av(e.touches, 'clientY') - y3 > 120 && Math.abs(av(e.touches, 'clientX') - x3) < 140) { fired = true; parent.postMessage({ liBook: 1, type: 'shot' }, '*'); } }, { passive: true });
    addEventListener('touchend', function (e) { if (e.touches.length === 0) y3 = null; }, { passive: true });
  }
  var SHIM = function (id) { return '<base href="about:srcdoc"><script>try{if(!window.LiNative&&parent.LiNative)window.LiNative=parent.LiNative}catch(e){}<\/script><script>(function(){try{var P="li:' + id + ':",R=window.localStorage;function keys(){var a=[];for(var i=0;i<R.length;i++){var k=R.key(i);if(k&&k.indexOf(P)===0)a.push(k.slice(P.length))}return a}var base={getItem:function(k){return R.getItem(P+k)},setItem:function(k,v){R.setItem(P+k,String(v))},removeItem:function(k){R.removeItem(P+k)},clear:function(){keys().forEach(function(k){R.removeItem(P+k)})},key:function(n){var a=keys();return a[n]===undefined?null:a[n]}};var LSP=new Proxy(base,{get:function(t,k){if(k==="length")return keys().length;if(k in t)return t[k];return R.getItem(P+String(k))},set:function(t,k,v){R.setItem(P+String(k),String(v));return true},deleteProperty:function(t,k){R.removeItem(P+String(k));return true},has:function(t,k){return k in t||R.getItem(P+String(k))!==null},ownKeys:function(){return keys()},getOwnPropertyDescriptor:function(t,k){return R.getItem(P+String(k))!==null?{value:R.getItem(P+String(k)),enumerable:true,configurable:true,writable:true}:undefined}});Object.defineProperty(window,"localStorage",{configurable:true,get:function(){return LSP}});var o=indexedDB.open.bind(indexedDB);indexedDB.open=function(n,v){return v===undefined?o(P+n):o(P+n,v)};var d=indexedDB.deleteDatabase.bind(indexedDB);indexedDB.deleteDatabase=function(n){return d(P+n)}}catch(e){}document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href]");if(a&&/^(https?:|mailto:)/i.test(a.href)&&a.origin!==location.origin){e.preventDefault();parent.postMessage({liBook:1,type:"open-url",url:a.href},"*")}},true)})();<\/script>' + '<script>(' + SHIMX.toString() + ')();<\/script><script>(' + TTSX.toString() + ')();<\/script>' + '<script>window.__TRS=' + JSON.stringify(TRS) + ';window.__TRS.UI=' + JSON.stringify(lib.settings.lang || 'ar') + ';window.__TRS.ID=' + JSON.stringify(id) + ';<\/script><script>(' + TRU.toString() + ')();<\/script><script>(' + TRX.toString() + ')();<\/script>'; };
  function revokeLive() { live.forEach(function (u) { URL.revokeObjectURL(u); }); live = []; }
  function frameSrc(b) {
    revokeLive(); var lang = (lib.settings.lang || 'ar') === 'ar' ? 'ar' : 'en';
    if (b.format === 'html' || b.format === 'epub') return Promise.all([fGet(b.id + '/index.html'), INJECT_JS ? INJECT_JS : Promise.all([getText('reader.js'), getText('dock.js').catch(function () { return ''; })]).then(function (x) { return x[0] + '\n' + x[1]; })]).then(function (r) {
      INJECT_JS = r[1]; return r[0].text().then(function (h) { return b.orig === 'CBZ' && window.__FMT ? window.__FMT.resolvePages(h, function (n) { return fGet(b.id + '/' + n); }, function (u) { live.push(u); }) : h; }).then(function (h) { var tag = '<script>window.__LI=' + JSON.stringify({ tpl: !!b.tpl, id: b.id, lang: lang, ui: lib.settings.lang || 'ar' }) + ';' + INJECT_JS + '<\/script>', shim = SHIM(b.id);
        h = /<head[^>]*>/i.test(h) ? h.replace(/<head[^>]*>/i, function (m) { return m + shim; }) : shim + h; h = /<\/body>/i.test(h) ? h.replace(/<\/body>/i, function () { return tag + '</body>'; }) : h + tag; return { srcdoc: h }; }); });
    if (b.format === 'audio') return Promise.all([fGet(b.id + '/' + b.file), getText('player.html')]).then(function (r) { var u = URL.createObjectURL(r[0]); live.push(u); var cu = (coverURL[b.id] || {}).u || ''; return { srcdoc: r[1].replace(/book:\/\/__ID__\/__file/g, u).replace(/book:\/\/__ID__\/__cover/g, cu).replace(/__ID__/g, b.id).replace(/__TITLE__/g, b.title.replace(/</g, '&lt;')).replace(/__AUTHOR__/g, (b.author || '').replace(/</g, '&lt;')).replace('__HASCOVER__', b.cover ? '1' : '0').replace(/__LANG__/g, lang) }; });
    if (b.format === 'pdf') return Promise.all([fGet(b.id + '/' + b.file), getText('pdfviewer.html'), getText('pdfgeo.js').catch(function () { return ''; })]).then(function (r) { var u = URL.createObjectURL(r[0]); live.push(u); var base = location.origin + '/pdfjs/'; var pre = '<script>try{if(!window.LiNative&&parent.LiNative)window.LiNative=parent.LiNative}catch(e){}<\/script><script>window.__TRS=' + JSON.stringify(TRS) + ';<\/script><script>(' + TTSX.toString() + ')();<\/script><script>(' + GEST.toString() + ')();<\/script><script>(' + TRU.toString() + ')();<\/script><script>' + r[2].replace(/<\/script/gi, '<\\/script') + '<\/script><script>window.__LI=' + JSON.stringify({ ui: lib.settings.lang || 'ar', id: b.id, url: u, base: base }) + ';<\/script>', post = '<script>(' + PDFX.toString() + ')();<\/script>'; return { srcdoc: r[1].replace(/book:\/\/__ID__\/__file/g, u).replace(/book:\/\/__ID__\/__pdfjs\//g, base).replace(/__ID__/g, b.id).replace(/__TITLE__/g, b.title.replace(/</g, '&lt;')).replace(/__LANG__/g, lang).replace(/(<script src="[^"]*pdf\.min\.js"><\/script>)/, function (m) { return pre + m + post; }) }; });
    return { src: 'about:blank' };
  }
  // ---------- seeds ----------
  function seeds() {
    return fetch('seed/manifest.json').then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }).then(function (list) {
      var chain = Promise.resolve(); list.forEach(function (s) { chain = chain.then(function () { if (lib.seeded.indexOf(s.file) >= 0) return; lib.seeded.push(s.file); return fetch('seed/' + s.file).then(function (r) { return r.blob(); }).then(function (bl) { return importFile(new File([bl], s.file, { type: 'text/html' })); }).then(function (r) { if (r && r.book) ['title', 'author', 'series', 'titleEn', 'authorEn'].forEach(function (k) { if (s[k] != null) r.book[k] = s[k]; }); }).catch(function () {}); }); });
      return chain.then(function () { return save(true); });
    });
  }
  // Daily quote notifications: the next 7 days are scheduled, and refreshed every time the app opens or goes to the background.
  function syncQuotes(ask) {
    if (!(NATIVE() && PL.LocalNotifications)) return; var LN = PL.LocalNotifications, ids = [];
    for (var i = 0; i < 7; i++) ids.push({ id: 7100 + i });
    LN.cancel({ notifications: ids }).catch(function () {});
    if (!lib.settings.quoteNotify) return;
    var skip = [M('إشارة مرجعية', 'Bookmark'), M('إشارة صوتية', 'Audio bookmark')], pool = [];
    lib.books.forEach(function (b) { if (b.hidden) return; notesOf(b).forEach(function (x) { var t = String(x.text || '').replace(/\s+/g, ' ').trim(); if (t.length >= 15 && skip.indexOf(x.type) < 0) pool.push({ t: t, b: b }); }); });
    if (!pool.length) return;
    for (var si = pool.length - 1; si > 0; si--) { var sj = Math.floor(Math.random() * (si + 1)), tmp = pool[si]; pool[si] = pool[sj]; pool[sj] = tmp; }
    var p = String(lib.settings.quoteAt || '09:00').split(':'), now = Date.now(), list = [], n = 0;
    for (var d = 0; d < 8 && n < 7; d++) {
      var at = new Date(); at.setDate(at.getDate() + d); at.setHours(+p[0] || 9, +p[1] || 0, 0, 0); if (at.getTime() <= now + 60000) continue;
      var q = pool[n % pool.length];
      var full = '«' + q.t + '» — ' + q.b.title; list.push({ id: 7100 + n, title: M('اقتباس اليوم', 'Quote of the day'), body: full.length > 140 ? '«' + q.t.slice(0, 120) + '…» — ' + q.b.title : full, largeBody: full, summaryText: 'Living Ideas', schedule: { at: at, allowWhileIdle: true } }); n++;
    }
    if (!list.length) return;
    var go = function () { return LN.schedule({ notifications: list }); };
    LN.checkPermissions().then(function (r) { if (r && r.display === 'granted') return go(); if (ask) return LN.requestPermissions().then(function (r2) { if (r2 && r2.display === 'granted') return go(); }); }).catch(function () {});
  }
  // ---------- init ----------
  var ready = kvGet('lib').then(function (j) { if (j) { try { var o = JSON.parse(j); lib = Object.assign(lib, o); lib.settings = Object.assign({}, DEF_SET, o.settings || {}); lib.goals = Object.assign({}, DEF_GOALS, o.goals || {}); } catch (e) {} } if (!lib.settings.lang) { var nl = (navigator.language || '').slice(0, 2).toLowerCase(); lib.settings.lang = ['ar', 'fr', 'es', 'it', 'id'].indexOf(nl) >= 0 ? nl : 'en'; } return seeds(); }).then(function () {
    return Promise.all(lib.books.filter(function (b) { return b.cover; }).map(function (b) { return fGet(b.id + '/' + b.cover).then(function (bl) { if (bl) setCoverURL(b, bl); }); }));
  }).then(function () { syncReminder(); syncQuotes(false); if (PL.App && PL.App.addListener) PL.App.addListener('backButton', function () { if (!(window.__li && window.__li.onBack && window.__li.onBack())) PL.App.exitApp(); }); history.replaceState({ root: 1 }, ''); history.pushState({ li: 1 }, ''); addEventListener('popstate', function () { if (window.__li && window.__li.onBack && window.__li.onBack()) history.pushState({ li: 1 }, ''); }); });
  var A = function (f) { return function () { var a = arguments; return ready.then(function () { return f.apply(null, a); }); }; };
  var api = {
    platform: 'android', noFullscreen: true, shareFile: function (name, blob) { return saveBlob(name, blob); },
    coverUrl: function (b) { var c = coverURL[b.id]; return c ? c.u : PIXEL; },
    frameSrc: A(frameSrc), openUrl: function (u) { if (!/^(https?:|mailto:)/i.test(u)) return; if (PL.Browser && PL.Browser.open && /^https?:/i.test(u)) PL.Browser.open({ url: u }); else window.open(u, '_blank'); },
    pathOf: function () { return ''; }, onOpen: function () {}, onState: function (f) { cbState.push(f); }, onToast: function (f) { cbToast.push(f); },
    state: A(function () { return lib; }),
    notify: function (t, b) { try { notify(t, b); } catch (e) {} return Promise.resolve(); },
    askNotif: function () { try { if (NATIVE() && PL.LocalNotifications) return PL.LocalNotifications.requestPermissions().catch(function () {}); } catch (e) {} return Promise.resolve(); },
    convertPdf: A(function (id, tr) {
      var b = lib.books.filter(function (x) { return x.id === id; })[0]; if (!b) return lib;
      return fGet(b.id + '/' + b.file).then(function (blob) { return importFile(new File([blob], (b.title || 'book') + '.pdf', { type: 'application/pdf' }), { mode: 'html', tr: tr || '' }); }).then(function (r) {
        if (r && r.book) toast(M('أُضيف كتاب HTML إلى مكتبتك' + (tr ? ' وسيُترجم عند فتحه' : ''), 'The HTML book was added to your library' + (tr ? ' and will be translated when opened' : ''))); else if (r && r.dup) toast(M('هذا الكتاب موجود بصيغة HTML', 'This book already exists as HTML')); else if (r && r.err) toast(r.err);
        return lib;
      });
    }),
    scan: A(function () { return scanFlow().then(function (f) { return f.length ? addMany(f, { name: M('مسح ضوئي ', 'Scan ') + new Date().toLocaleDateString(), keep: true }) : lib; }); }),
    add: A(function () { return pick('.jpg,.jpeg,.png,.webp,.bmp,image/*,.html,.htm,.epub,.pdf,.docx,.txt,.md,.fb2,.cbz,.mobi,.azw,.azw3,.prc,.mp3,.m4a,.m4b,.aac,.ogg,.opus,.wav,.flac,text/html,application/epub+zip,application/pdf,audio/*,*/*', true).then(function (f) { return f.length ? addMany(f) : lib; }); }),
    addPaths: A(function () { return lib; }),
    addTranslated: A(function (srcId, tgt, html, tname) {
      var src = find(srcId); if (!src || !html || html.length < 200) return { err: 1 };
      var ex = lib.books.filter(function (x) { return x.trOf === srcId && x.trLang === tgt; })[0], id = ex ? ex.id : 'b' + rid(6), title = String(src.title || '').replace(/\s*\([^()]*\)\s*$/, '') + ' (' + tname + ')';
      var b = ex || { id: id, hash: 'tr-' + srcId + '-' + tgt, format: 'html', file: 'index.html', title: title, author: src.author || '', series: src.series || '', rating: 0, hidden: false, want: false, cover: null, added: Date.now(), lastRead: 0, progress: 0, finished: false, readSec: 0, collections: (src.collections || []).slice(), bytes: html.length, tpl: false, words: 0, ext: null, annots: [], audio: null, trOf: srcId, trLang: tgt };
      b.words = wordCount(html); b.bytes = html.length;
      return fSet(id + '/index.html', new Blob([html], { type: 'text/html' })).then(function () {
        var cv = src.cover ? fGet(srcId + '/' + src.cover) : Promise.resolve(null);
        return cv.then(function (bl) { if (bl && !b.cover) { b.cover = src.cover; return fSet(id + '/' + b.cover, bl).then(function () { setCoverURL(b, bl); }); } });
      }).then(function () { if (!ex) lib.books.push(b); save(true); return { book: b, existed: !!ex }; });
    }),
    update: A(function (id, patch) { var b = find(id); if (b) { ['title', 'author', 'series', 'rating', 'hidden', 'want', 'progress', 'finished', 'finishedAt', 'lastRead', 'audio', 'pdf'].forEach(function (k) { if (k in patch) b[k] = patch[k]; }); save(); } return lib; }),
    remove: A(function (id) { var i = lib.books.findIndex(function (b) { return b.id === id; }); if (i < 0) return lib; lib.books.splice(i, 1); if (coverURL[id]) { URL.revokeObjectURL(coverURL[id].u); delete coverURL[id]; } return fDelPrefix(id + '/').then(function () { save(true); return lib; }); }),
    ext: A(function (id, x) { var b = find(id); if (b && x) { b.ext = x; if (b.tpl && typeof x.progress === 'number') b.progress = Math.max(0, Math.min(100, Math.round(x.progress))); save(); } return lib; }),
    annots: A(function (id, a) { var b = find(id); if (b && Array.isArray(a)) { b.annots = a.slice(0, 5000); save(); } return lib; }),
    tick: A(tickGoals),
    goals: A(function (g) { ['enabled', 'daily', 'yearly', 'remind', 'remindAt'].forEach(function (k) { if (k in g) lib.goals[k] = g[k]; }); lib.goals.daily = Math.max(1, Math.min(600, Math.round(lib.goals.daily) || 5)); lib.goals.yearly = Math.max(1, Math.min(999, Math.round(lib.goals.yearly) || 12)); save(); syncReminder(); return lib; }),
    clearGoals: A(function () { lib.goals.days = {}; lib.goals.notified = ''; lib.books.forEach(function (b) { b.readSec = 0; }); save(); return lib; }),
    setCover: A(function (id) { var b = find(id); if (!b) return lib; return pick('image/*', false).then(function (f) { if (!f[0]) return lib; var ext = (extOf(f[0].name) || 'png').replace('jpeg', 'jpg'), p = b.cover ? fDelPrefix(id + '/cover.') : Promise.resolve(); return p.then(function () { return fSet(id + '/cover.' + ext, f[0]); }).then(function () { b.cover = 'cover.' + ext; b.coverV = Date.now(); setCoverURL(b, f[0]); save(true); return lib; }); }); }),
    exportBook: A(function (id) { var b = find(id); if (!b) return; if (b.orig === 'CBZ') return fKeys(id + '/p/').then(function (ks) { var z = new JSZip(); return Promise.all(ks.map(function (k) { return fGet(k).then(function (bl) { z.file(k.slice(id.length + 3), bl); }); })).then(function () { return z.generateAsync({ type: 'blob' }); }); }).then(function (bl) { return saveBlob(b.title.replace(/[\\/:*?\"<>|]/g, '') + '.cbz', bl); }); return fGet(id + '/' + b.file).then(function (bl) { return saveBlob(b.title.replace(/[\\/:*?"<>|]/g, '') + (b.format === 'epub' ? '.html' : '.' + extOf(b.file)), bl); }); }),
    exportNotes: A(function (id) { var b = find(id); if (!b) return; if (!notesOf(b).length) return toast(M('لا ملاحظات لهذا الكتاب', 'This book has no notes')); return saveBlob(M('ملاحظات - ', 'Notes - ') + b.title.replace(/[\\/:*?"<>|]/g, '') + '.md', new Blob(['\ufeff' + md(b)], { type: 'text/markdown' })).then(function () { toast(M('تم تصدير الملاحظات', 'Notes exported')); }); }),
    exportAllNotes: A(function () { var bs = lib.books.filter(function (b) { return notesOf(b).length; }); if (!bs.length) return toast(M('لا ملاحظات بعد', 'No notes yet')); return saveBlob(M('ملاحظاتي - Living Ideas.md', 'My Notes - Living Ideas.md'), new Blob(['\ufeff' + bs.map(md).join('\n---\n\n')], { type: 'text/markdown' })).then(function () { toast(M('تم تصدير ملاحظات ' + bs.length + ' كتب', 'Exported notes of ' + bs.length + ' books')); }); }),
    backup: A(function () { return save(true).then(function () { var z = new JSZip(); z.file('library.json', JSON.stringify(lib)); return Promise.all(lib.books.map(function (b) { return fKeys(b.id + '/').then(function (ks) { return Promise.all(ks.map(function (k) { return fGet(k).then(function (bl) { z.file('books/' + k, bl); }); })); }); })).then(function () { return z.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } }); }); }).then(function (bl) { return saveBlob(M('Living-Ideas-نسخة-احتياطية-', 'Living-Ideas-backup-') + today() + '.lilib', bl); }).then(function () { toast(M('تم إنشاء النسخة الاحتياطية', 'Backup created')); }).catch(function () { toast(M('تعذر إنشاء النسخة الاحتياطية', 'Could not create the backup')); }); }),
    restore: A(function () { return pick('.lilib,application/zip,application/octet-stream', false).then(function (f) { if (!f[0]) return lib; return JSZip.loadAsync(f[0]).then(function (z) { return z.file('library.json').async('string').then(function (s) { var j = JSON.parse(s), n = 0, chain = Promise.resolve();
      (j.books || []).forEach(function (b) { if (!/^b[0-9a-f]+$/.test(b.id)) return; chain = chain.then(function () { var ex = lib.books.filter(function (x) { return x.hash === b.hash; })[0]; if (ex) { if ((b.lastRead || 0) > (ex.lastRead || 0)) ['progress', 'finished', 'lastRead', 'ext', 'annots', 'audio', 'rating', 'want', 'hidden', 'series', 'readSec'].forEach(function (k) { ex[k] = b[k]; }); return; }
        var ents = z.file(new RegExp('^books/' + b.id + '/')); return Promise.all(ents.map(function (e) { return e.async('blob').then(function (bl) { return fSet(e.name.slice(6), bl); }); })).then(function () { lib.books.push(b); n++; if (b.cover) return fGet(b.id + '/' + b.cover).then(function (bl) { if (bl) setCoverURL(b, bl); }); }); }); });
      return chain.then(function () { (j.collections || []).forEach(function (c) { if (!lib.collections.filter(function (x) { return x.id === c.id; })[0]) lib.collections.push(c); }); if (j.goals && j.goals.days) Object.keys(j.goals.days).forEach(function (d) { lib.goals.days[d] = Math.max(lib.goals.days[d] || 0, j.goals.days[d]); }); return save(true); }).then(function () { toast(M('تمت الاستعادة: ' + n + ' كتاب جديد', 'Restored: ' + n + ' new books')); return lib; }); }); }).catch(function () { toast(M('ملف النسخة الاحتياطية غير صالح', 'The backup file is not valid')); return lib; }); }); }),
    notify: A(notify), copy: function (t) { try { return navigator.clipboard.writeText(String(t || '')); } catch (e) { return Promise.resolve(); } },
    colAdd: A(function (n) { n = String(n || '').trim().slice(0, 60); if (n) { lib.collections.push({ id: 'c' + rid(4), name: n }); save(); } return lib; }),
    colRename: A(function (id, n) { var c = lib.collections.filter(function (x) { return x.id === id; })[0]; n = String(n || '').trim().slice(0, 60); if (c && n) { c.name = n; save(); } return lib; }),
    colDel: A(function (id) { lib.collections = lib.collections.filter(function (c) { return c.id !== id; }); lib.books.forEach(function (b) { b.collections = (b.collections || []).filter(function (x) { return x !== id; }); }); save(); return lib; }),
    colToggle: A(function (bid, cid) { var b = find(bid); if (b) { b.collections = b.collections || []; var i = b.collections.indexOf(cid); if (i >= 0) b.collections.splice(i, 1); else b.collections.push(cid); save(); } return lib; }),
    order: A(function (ids) { (ids || []).forEach(function (id, i) { var b = find(id); if (b) b.order = i; }); save(); return lib; }),
    settings: A(function (s) { Object.assign(lib.settings, s); if ('lang' in s) syncReminder(); if ('lang' in s || 'quoteNotify' in s || 'quoteAt' in s) syncQuotes(true); save(); return lib; }),
    fullscreen: function () { return Promise.resolve(); }, reveal: function () { return Promise.resolve(); }
  };
  window.api = api; window.__liReady = ready;
})();
