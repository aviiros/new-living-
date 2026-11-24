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
    var pre = 'u' + Math.floor(Math.random() * 1e6).toString(36) + '_', seq = 0, live = {}, q = [], pend = [], vc = null, ls = [], spkT = null, spkOn = false, batchOk = !!N.speakBatch;
    function note(on) { clearTimeout(spkT); if (on) { if (!spkOn) { spkOn = true; try { parent.postMessage({ liBook: 1, type: 'speak-state', on: true }, '*'); } catch (e) {} } } else spkT = setTimeout(function () { if (!S.speaking && spkOn) { spkOn = false; try { parent.postMessage({ liBook: 1, type: 'speak-state', on: false }, '*'); } catch (e) {} } }, 2500); }
    window.addEventListener('message', function (e) { var d = e.data; if (d && d.liCmd === 'spkstop') { try { S.cancel(); } catch (x) {} try { window.__liDock && window.__liDock.act('sstop'); } catch (x) {} try { window.__liPdfStop && window.__liPdfStop(); } catch (x) {} } });
    function voices() { if (vc) return vc; var a = []; try { a = JSON.parse(N.voices() || '[]'); } catch (e) {} if (!a.length) return []; vc = a.map(function (v) { return { name: v[0], lang: v[1], voiceURI: v[0], localService: true, default: false }; }); return vc; }
    function U(t) { this.text = t === undefined ? '' : String(t); this.lang = ''; this.rate = 1; this.pitch = 1; this.volume = 1; this.voice = null; this.onstart = this.onend = this.onerror = this.onboundary = this.onpause = this.onresume = null; }
    // Sentences are handed to the phone's own reader in one go (it keeps its queue and goes on by itself while this page sleeps).
    function flush() {
      var a = pend; pend = []; if (!a.length) return;
      var arr = a.map(function (ent) { var u = ent.u; return { id: ent.id, t: u.text, l: u.lang || (u.voice && u.voice.lang) || '', v: u.voice ? u.voice.name : '', r: +u.rate || 1, p: +u.pitch || 1, vo: u.volume == null ? 1 : +u.volume, g: u.__g !== undefined ? String(u.__g) : ent.id, b: u.onboundary ? 1 : 0 }; });
      try { if (batchOk) N.speakBatch(JSON.stringify(arr), false); else arr.forEach(function (o) { N.speak(o.id, o.t, o.l, o.v, o.r, o.p); }); } catch (e) {}
    }
    // A book that reads sentence by sentence starts the next one from a short timer inside its "end" handler. Hidden pages slow timers down
    // (to once a minute after a while), so such short timers started from there run at once instead and the voice never waits.
    var inEnd = false, stOrig = window.setTimeout;
    window.setTimeout = function (f, t) { if (inEnd && typeof f === 'function' && (+t || 0) <= 150) { var a = [].slice.call(arguments, 2); Promise.resolve().then(function () { f.apply(window, a); }); return 0; } return stOrig.apply(window, arguments); };
    var S = { speaking: false, pending: false, paused: false, onvoiceschanged: null, getVoices: voices,
      speak: function (u) { var id = pre + (++seq), ent = { u: u, id: id }; live[id] = ent; q.push(ent); S.speaking = true; note(true); pend.push(ent); if (pend.length === 1) Promise.resolve().then(flush); },
      cancel: function () { live = {}; q = []; pend = []; S.speaking = false; S.paused = false; note(false); try { N.stop(); } catch (e) {} },
      pause: function () { if (!S.speaking || S.paused) return; S.paused = true; try { N.ttsCmd('pause'); } catch (e) {} if (q[0] && q[0].u.onpause) try { q[0].u.onpause({}); } catch (x) {} },
      resume: function () { if (!S.paused) return; S.paused = false; try { N.ttsCmd('resume'); } catch (e) {} if (q[0] && q[0].u.onresume) try { q[0].u.onresume({}); } catch (x) {} },
      addEventListener: function (n, f) { if (n === 'voiceschanged') ls.push(f); }, removeEventListener: function (n, f) { ls = ls.filter(function (x) { return x !== f; }); }, dispatchEvent: function () { return true; } };
    try { Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: U }); Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: function () { return S; } }); } catch (e) { window.SpeechSynthesisUtterance = U; window.speechSynthesis = S; }
    window.addEventListener('message', function (e) {
      var d = e.data; if (!d || !d.liTts) return;
      if (d.type === 'voices') { vc = null; var ev = { type: 'voiceschanged' }; if (S.onvoiceschanged) try { S.onvoiceschanged(ev); } catch (x) {} ls.slice().forEach(function (f) { try { f(ev); } catch (x) {} }); return; }
      if (d.type === 'paused') { if (S.speaking) S.paused = true; return; }
      if (d.type === 'resumed') { S.paused = false; return; }
      var ent = live[d.id]; if (!ent) return; var u = ent.u;
      if (d.type === 'start') { if (u.onstart) try { u.onstart({}); } catch (x) {} }
      else if (d.type === 'boundary') { if (u.onboundary) try { u.onboundary({ charIndex: d.a, charLength: d.b, name: 'word', utterance: u }); } catch (x) {} }
      else { delete live[d.id]; q = q.filter(function (x) { return x !== ent; }); if (!q.length) { S.speaking = false; note(false); } var h = d.type === 'end' ? u.onend : u.onerror; if (h) { inEnd = true; try { h(d.type === 'end' ? {} : { error: 'synthesis-failed' }); } catch (x) {} inEnd = false; } }
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
      ar: { hq: 'الترجمة بنموذج الذكاء (متقدم: أبطأ، ويحتاج تنزيل النموذج مرة واحدة)', toh: 'تحويل إلى كتاب HTML', on: 'دقة أعلى عبر الإنترنت (يرسل النص إلى Google)', tr: 'ترجمة', sh: 'حفظ الترجمة كملف HTML', sp: 'حفظ الترجمة كملف PDF', wait: 'الترجمة لم تكتمل بعد، انتظر قليلاً', orig: 'الأصل', prep: 'تجهيز اللغة (مرة واحدة)…', work: 'جارٍ الترجمة', mt: 'ترجمة آلية', fail: 'تعذرت الترجمة. اتصل بالإنترنت مرة واحدة لتحميل اللغة.', scan: 'هذا الملف صور ممسوحة بلا نص، فلا يمكن ترجمته', hl: 'التظليل متاح على النص الأصلي فقط' },
      en: { hq: 'Translate with the AI model (advanced: slower, needs a one-time model download)', toh: 'Convert to HTML book', on: 'Higher accuracy online (sends text to Google)', tr: 'Translate', sh: 'Save translation as HTML', sp: 'Save translation as PDF', wait: 'Translation is not finished yet', orig: 'Original', prep: 'Preparing language (one time)…', work: 'Translating', mt: 'Machine translation', fail: 'Translation failed. Connect to the internet once to download the language.', scan: 'This PDF is scanned images with no text, so it can’t be translated', hl: 'Highlighting works on the original text only' },
      fr: { hq: 'Traduire avec le modèle d’IA (avancé : plus lent, téléchargement unique du modèle)', toh: 'Convertir en livre HTML', on: 'Précision accrue en ligne (envoie le texte à Google)', tr: 'Traduire', sh: 'Enregistrer la traduction en HTML', sp: 'Enregistrer la traduction en PDF', wait: 'La traduction n’est pas terminée', orig: 'Original', prep: 'Préparation de la langue (une fois)…', work: 'Traduction', mt: 'Traduction automatique', fail: 'Échec. Connectez-vous une fois à Internet pour télécharger la langue.', scan: 'Ce PDF est fait d’images sans texte : traduction impossible', hl: 'Le surlignage ne fonctionne que sur le texte original' },
      es: { hq: 'Traducir con el modelo de IA (avanzado: más lento, requiere descargar el modelo una vez)', toh: 'Convertir en libro HTML', on: 'Mayor precisión en línea (envía el texto a Google)', tr: 'Traducir', sh: 'Guardar la traducción como HTML', sp: 'Guardar la traducción como PDF', wait: 'La traducción aún no ha terminado', orig: 'Original', prep: 'Preparando el idioma (una vez)…', work: 'Traduciendo', mt: 'Traducción automática', fail: 'Falló. Conéctate a Internet una vez para descargar el idioma.', scan: 'Este PDF son imágenes escaneadas sin texto; no se puede traducir', hl: 'El subrayado solo funciona en el texto original' },
      it: { hq: 'Traduci con il modello di IA (avanzato: più lento, richiede il download del modello una volta)', toh: 'Converti in libro HTML', on: 'Maggiore precisione online (invia il testo a Google)', tr: 'Traduci', sh: 'Salva la traduzione come HTML', sp: 'Salva la traduzione come PDF', wait: 'La traduzione non è ancora terminata', orig: 'Originale', prep: 'Preparazione della lingua (una volta)…', work: 'Traduzione', mt: 'Traduzione automatica', fail: 'Non riuscita. Connettiti a Internet una volta per scaricare la lingua.', scan: 'Questo PDF è fatto di immagini senza testo: non si può tradurre', hl: 'L’evidenziazione funziona solo sul testo originale' },
      id: { hq: 'Terjemahkan dengan model AI (lanjutan: lebih lambat, perlu unduh model sekali)', toh: 'Ubah ke buku HTML', on: 'Akurasi lebih tinggi online (mengirim teks ke Google)', tr: 'Terjemahkan', sh: 'Simpan terjemahan sebagai HTML', sp: 'Simpan terjemahan sebagai PDF', wait: 'Terjemahan belum selesai', orig: 'Asli', prep: 'Menyiapkan bahasa (sekali saja)…', work: 'Menerjemahkan', mt: 'Terjemahan mesin', fail: 'Gagal. Sambungkan internet sekali untuk mengunduh bahasa.', scan: 'PDF ini berupa gambar pindaian tanpa teks, sehingga tidak bisa diterjemahkan', hl: 'Penyorotan hanya berfungsi pada teks asli' }
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
      window.__LI_TR = false; state.tgt = null; btn.textContent = 'A文'; btn.classList.remove('on'); tip.style.display = 'none';
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


  // Runs INSIDE the PDF viewer page: search, bookmarks, highlights and notes, and the contents list of a PDF opened as it is.
  // It speaks the same small messages as the HTML books, so the library's own search bar, notes panel and contents list work for PDF too.
  function PDFN() {
    var lib = window['pdfjs-dist/build/pdf'], sc = document.getElementById('sc'), pagesEl = document.getElementById('pages'); if (!lib || !sc || !pagesEl) return;
    var UI = (window.__LI && window.__LI.ui) || 'ar';
    var S = {
      ar: { ocr: 'جارٍ قراءة نص الصفحة', hl: 'تظليل', note: 'ملاحظة', copy: 'نسخ', del: 'حذف', save: 'حفظ', ph: 'اكتب ملاحظتك…', bmOn: 'أُضيفت إشارة مرجعية', bmOff: 'أُزيلت الإشارة المرجعية', none: 'لا توجد نتائج', scan: 'هذا الملف صور فقط، فلا يمكن البحث فيه. حوّله إلى كتاب HTML.', pg: 'صفحة', done: 'تم النسخ' },
      en: { ocr: 'Reading the text of page', hl: 'Highlight', note: 'Note', copy: 'Copy', del: 'Delete', save: 'Save', ph: 'Write your note…', bmOn: 'Bookmark added', bmOff: 'Bookmark removed', none: 'No results', scan: 'This file is only images, so it cannot be searched. Convert it to an HTML book.', pg: 'Page', done: 'Copied' },
      fr: { ocr: 'Lecture du texte de la page', hl: 'Surligner', note: 'Note', copy: 'Copier', del: 'Supprimer', save: 'Enregistrer', ph: 'Écrivez votre note…', bmOn: 'Signet ajouté', bmOff: 'Signet retiré', none: 'Aucun résultat', scan: 'Ce fichier ne contient que des images : recherche impossible. Convertissez-le en livre HTML.', pg: 'Page', done: 'Copié' },
      es: { ocr: 'Leyendo el texto de la página', hl: 'Subrayar', note: 'Nota', copy: 'Copiar', del: 'Eliminar', save: 'Guardar', ph: 'Escribe tu nota…', bmOn: 'Marcador añadido', bmOff: 'Marcador eliminado', none: 'Sin resultados', scan: 'Este archivo solo tiene imágenes, así que no se puede buscar. Conviértelo en libro HTML.', pg: 'Página', done: 'Copiado' },
      it: { ocr: 'Lettura del testo della pagina', hl: 'Evidenzia', note: 'Nota', copy: 'Copia', del: 'Elimina', save: 'Salva', ph: 'Scrivi la tua nota…', bmOn: 'Segnalibro aggiunto', bmOff: 'Segnalibro rimosso', none: 'Nessun risultato', scan: 'Questo file contiene solo immagini, quindi non si può cercare. Convertilo in libro HTML.', pg: 'Pagina', done: 'Copiato' },
      id: { ocr: 'Membaca teks halaman', hl: 'Sorot', note: 'Catatan', copy: 'Salin', del: 'Hapus', save: 'Simpan', ph: 'Tulis catatan Anda…', bmOn: 'Penanda ditambahkan', bmOff: 'Penanda dihapus', none: 'Tidak ada hasil', scan: 'File ini hanya gambar, jadi tidak bisa dicari. Ubah menjadi buku HTML.', pg: 'Halaman', done: 'Disalin' }
    };
    var s = S[UI] || S.en, AN = [], pg = [], dims = {}, tcs = {}, outline = null, Q = { q: '', n: '', pageNo: 0, k: -1, matches: {} };
    function P(m) { m.liBook = 1; try { parent.postMessage(m, '*'); } catch (e) {} }
    function doc() { return window.__pdoc || null; }
    function curPage() { return window.__pcur ? window.__pcur() : 1; }
    function pageEl(n) { return document.querySelectorAll('.pg')[n - 1]; }

    // ---- scanned pages (pictures only): the text is read once by the local reader, kept, and then behaves like the text of any PDF:
    // search, selection, highlights, translation and reading aloud all get it through getTextContent below.
    var ocrC = {}, ocrQ = Promise.resolve();
    function idb() { return new Promise(function (ok, no) { try { var q = indexedDB.open('li-pdf-ocr', 1); q.onupgradeneeded = function () { q.result.createObjectStore('p'); }; q.onsuccess = function () { ok(q.result); }; q.onerror = function () { no(q.error); }; } catch (e) { no(e); } }); }
    function idbGet(k) { return idb().then(function (db) { return new Promise(function (ok) { var r = db.transaction('p').objectStore('p').get(k); r.onsuccess = function () { ok(r.result || null); }; r.onerror = function () { ok(null); }; }); }).catch(function () { return null; }); }
    function idbSet(k, v) { return idb().then(function (db) { db.transaction('p', 'readwrite').objectStore('p').put(v, k); }).catch(function () {}); }
    function readRows(p, n) {
      var lp = parent && parent.liOcrLines; if (!lp) return Promise.resolve(null);
      var v1 = p.getViewport({ scale: 1 }), sc2 = Math.min(3, 2000 / Math.max(v1.width, v1.height)), vp = p.getViewport({ scale: sc2 }), cv = document.createElement('canvas'), cx = cv.getContext('2d');
      cv.width = Math.round(vp.width); cv.height = Math.round(vp.height); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
      return p.render({ canvasContext: cx, viewport: vp }).promise.then(function () { toast(s.ocr + ' ' + n + '…'); return lp(cv); }).then(function (r) { return r && r.rows ? r.rows : null; });
    }
    function toItems(p, rows) {
      var v = p.getViewport({ scale: 1 }), W = v.width, H = v.height, vw = p.view || [0, 0, W, H];
      return rows.filter(function (r) { return r.t && r.t.trim(); }).map(function (r) {
        var fs = Math.max(4, r.h * H * 0.9);
        return { str: r.t, dir: /[֐-ࣿ]/.test(r.t) ? 'rtl' : 'ltr', transform: [fs, 0, 0, fs, r.x * W + vw[0], vw[3] - (r.y + r.h * 0.82) * H], width: r.w * W, height: fs, fontName: 'ocr', hasEOL: true };
      });
    }
    function ocrItems(p, n) {
      if (ocrC[n]) return ocrC[n];
      var key = ((window.__LI && window.__LI.id) || '') + ':' + n;
      if (window.__liListening && !(window.__liPrio && window.__liPrio[n])) return idbGet(key).then(function (hit) { return hit && hit.length ? toItems(p, hit) : null; }); // the voice has the reader first
      return ocrC[n] = idbGet(key).then(function (hit) {
        if (hit) return hit;
        var job = ocrQ.then(function () { return readRows(p, n); }); ocrQ = job.catch(function () {});
        return job.then(function (rows) { if (rows && rows.length) idbSet(key, rows); return rows; });
      }).then(function (rows) { return rows && rows.length ? toItems(p, rows) : null; }).catch(function () { return null; });
    }
    var ocrReady = new Promise(function (ok) { (function installOcr() {
      var d = doc(); if (!d) return setTimeout(installOcr, 300);
      d.getPage(1).then(function (p) {
        var pr = Object.getPrototypeOf(p); if (pr.__lio) return; pr.__lio = 1; var orig = pr.getTextContent;
        pr.getTextContent = function (o) {
          var self = this;
          return orig.call(self, o).then(function (tc) {
            if (tc.items.some(function (i) { return i.str && i.str.trim(); })) return tc;
            return ocrItems(self, self.pageNumber).then(function (items) { return items ? { items: items, styles: tc.styles || {} } : tc; });
          });
        };
      }).then(ok, ok);
    })(); });
    function rid() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
    var st = document.createElement('style');
    st.textContent = '.tl,.fl,.hl{position:absolute;inset:0;overflow:hidden}.tl{z-index:3;line-height:1;-webkit-user-select:text;user-select:text}.tl span{position:absolute;white-space:pre;color:transparent;transform-origin:0 0;cursor:text}.tl span::selection{background:rgba(70,130,255,.35);color:transparent}.fl{z-index:1;pointer-events:none}.hl{z-index:2;pointer-events:none}.fl i{position:absolute;background:rgba(255,200,0,.35);border-radius:2px}.fl i.cur{background:rgba(255,120,0,.5);outline:2px solid rgba(255,120,0,.9)}.hl i{position:absolute;background:rgba(255,214,0,.42);mix-blend-mode:multiply;border-radius:2px}.hl i.n{box-shadow:0 2px 0 #c3714c}body.night .hl i{mix-blend-mode:screen;background:rgba(255,214,0,.3)}.bk{position:absolute;top:0;inset-inline-end:14px;width:18px;height:30px;background:#c3714c;clip-path:polygon(0 0,100% 0,100% 100%,50% 78%,0 100%);z-index:4;pointer-events:none}#lipop{position:fixed;z-index:20;display:none;background:var(--bar);color:var(--tx);border:1px solid var(--ln);border-radius:10px;padding:6px;box-shadow:0 4px 18px rgba(0,0,0,.35);gap:6px;font-size:13px;direction:ltr}#lipop button{border:1px solid var(--ln);background:none;color:inherit;border-radius:8px;height:30px;padding:0 10px;cursor:pointer;font:inherit}#lipop button:hover{background:rgba(195,113,76,.18)}#lipop textarea{width:230px;height:72px;font:inherit;border:1px solid var(--ln);border-radius:8px;background:transparent;color:inherit;padding:6px;resize:none}#litoast{position:fixed;z-index:21;left:50%;bottom:64px;transform:translateX(-50%);background:rgba(20,30,36,.92);color:#fff;border-radius:10px;padding:8px 14px;font-size:13px;display:none;max-width:80vw;text-align:center}';
    document.head.appendChild(st);
    var toastT = null, tEl = document.createElement('div'); tEl.id = 'litoast'; document.body.appendChild(tEl);
    function toast(t) { tEl.textContent = t; tEl.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(function () { tEl.style.display = 'none'; }, 2600); }
    function save() { P({ type: 'annots', annots: AN.slice() }); }
    // ---- page text, with its place on the page as a fraction of the page size
    function dim(n) { return dims[n] || (dims[n] = doc().getPage(n).then(function (p) { var v = p.getViewport({ scale: 1 }); return { page: p, vp: v, w: v.width, h: v.height }; })); }
    function text(n) {
      if (tcs[n]) return tcs[n];
      return tcs[n] = ocrReady.then(function () { return dim(n); }).then(function (d) {
        return d.page.getTextContent().then(function (tc) {
          var items = [], i;
          for (i = 0; i < tc.items.length; i++) {
            var it = tc.items[i]; if (!it.str) continue;
            var t = lib.Util.transform(d.vp.transform, it.transform), hh = Math.abs(it.height) || Math.hypot(t[2], t[3]) || 8, w = Math.abs(it.width) || 0;
            items.push({ str: it.str, x: t[4] / d.w, y: (t[5] - hh * 0.85) / d.h, w: w / d.w, h: hh * 1.1 / d.h, fs: hh, rtl: it.dir === 'rtl' || /[֐-ࣿ]/.test(it.str) });
          }
          var norm = '', map = [];
          items.forEach(function (it, k) {
            for (var c = 0; c < it.str.length; c++) { var ch = nz(it.str[c]); for (var q = 0; q < ch.length; q++) { norm += ch[q]; map.push([k, c]); } }
            norm += ' '; map.push([k, it.str.length]);
          });
          var sq = '', sqpos = []; for (i = 0; i < norm.length; i++) if (norm[i] !== ' ') { sq += norm[i]; sqpos.push(i); }
          return { items: items, norm: norm, map: map, has: norm.trim().length > 0, pw: d.w, sq: sq, sqpos: sqpos, glyph: items.length > 20 && sq.length / items.length < 1.6 };
        });
      });
    }
    function nz(c) { var x = c.normalize('NFKC').toLowerCase(); if (/[ً-ٰٟـ]/.test(x)) return ''; return x.replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه'); }
    function nq(q) { var o = ''; for (var i = 0; i < q.length; i++) o += nz(q[i]); return o.replace(/\s+/g, ' ').trim(); }
    function rectsOf(t, a, b, vis) { // match [a,b) in the normalised page text -> boxes (fractions of the page)
      var by = {}, out = [], k;
      for (var i = a; i < b; i++) { var m = t.map[i]; if (!m || m[0] === undefined) continue; var it = t.items[m[0]]; if (!it || m[1] >= it.str.length) continue; var o = by[m[0]] || (by[m[0]] = [1e9, -1]); if (m[1] < o[0]) o[0] = m[1]; if (m[1] > o[1]) o[1] = m[1]; }
      for (k in by) { var it2 = t.items[k], L = it2.str.length || 1, c0 = by[k][0], c1 = by[k][1] + 1, x = (it2.rtl && !vis) ? it2.x + it2.w * (1 - c1 / L) : it2.x + it2.w * (c0 / L); out.push([x, it2.y, it2.w * (c1 - c0) / L, it2.h]); }
      return out;
    }
    function pctRects(list, cls) { return list.map(function (r) { return '<i class="' + (cls || '') + '" style="left:' + (r[0] * 100).toFixed(3) + '%;top:' + (r[1] * 100).toFixed(3) + '%;width:' + (r[2] * 100).toFixed(3) + '%;height:' + (r[3] * 100).toFixed(3) + '%"></i>'; }).join(''); }
    // ---- layers on every page that has been drawn
    function build(el, n) {
      if (el.querySelector('.tl')) return;
      if (Math.abs(n - curPage()) > 1 && !tcs[n]) return; // far pages are filled when they come near
      var fl = document.createElement('div'), hl = document.createElement('div'), tl = document.createElement('div'); fl.className = 'fl'; hl.className = 'hl'; tl.className = 'tl';
      el.appendChild(fl); el.appendChild(hl); el.appendChild(tl);
      paintAnnots(el, n);
      text(n).then(function (t) {
        if (!el.contains(tl)) return;
        var W = el.offsetWidth, H = el.offsetHeight, spans = [];
        t.items.forEach(function (it) {
          if (!it.str.trim()) return;
          var sp = document.createElement('span'); sp.textContent = it.str; sp.style.cssText = 'left:' + (it.x * 100).toFixed(3) + '%;top:' + (it.y * 100).toFixed(3) + '%;font-size:' + (it.fs * W / t.pw).toFixed(2) + 'px;direction:' + (it.rtl ? 'rtl' : 'ltr');
          tl.appendChild(sp); spans.push([sp, it]);
        });
        var meas = spans.map(function (x) { return x[0].offsetWidth; });
        spans.forEach(function (x, i) { var want = x[1].w * W; if (meas[i] > 1 && want > 1) x[0].style.transform = 'scaleX(' + (want / meas[i]).toFixed(4) + ')'; });
        paintFind(el, n);
      });
    }
    function paintAnnots(el, n) {
      var hl = el.querySelector('.hl'); if (!hl) return; var h = '';
      AN.forEach(function (a) { if (a.type === 'hl' && a.page === n && a.rects) h += pctRects(a.rects, a.note ? 'n' : ''); });
      hl.innerHTML = h; var b = el.querySelector('.bk'), has = AN.some(function (a) { return a.type === 'bm' && a.page === n; });
      if (has && !b) { b = document.createElement('div'); b.className = 'bk'; el.appendChild(b); } else if (!has && b) b.remove();
    }
    function paintFind(el, n) {
      var fl = el.querySelector('.fl'); if (!fl) return;
      if (!Q.n) { fl.innerHTML = ''; return; }
      text(n).then(function (t) {
        var ms = matchesIn(t, Q.n), h = ''; ms.forEach(function (m, k) { h += pctRects(rectsOf(t, m.i, m.e, m.vis), (Q.pageNo === n && Q.k === k) ? 'cur' : ''); }); fl.innerHTML = h;
      });
    }
    // Some Arabic PDFs keep their text in the order it is drawn (letters reversed). The reversed word is searched too, and such a match is placed from the left.
    function matchesIn(t, q) {
      var out = [], i = -1, r = q.split('').reverse().join(''), ar = /[\u0600-\u06ff]/.test(q); if (!q) return out;
      while ((i = t.norm.indexOf(q, i + 1)) >= 0) out.push({ i: i, e: i + q.length, vis: false });
      if (r !== q && ar) { i = -1; while ((i = t.norm.indexOf(r, i + 1)) >= 0) out.push({ i: i, e: i + q.length, vis: true }); }
      if (t.glyph && !out.length) { // a PDF that stores every letter as its own piece: search without the spaces between pieces
        var qq = q.replace(/ /g, ''), rr = qq.split('').reverse().join('');
        [[qq, false], [rr, true]].forEach(function (c) { if (c[1] && (rr === qq || !ar)) return; i = -1; while ((i = t.sq.indexOf(c[0], i + 1)) >= 0) out.push({ i: t.sqpos[i], e: t.sqpos[i + c[0].length - 1] + 1, vis: c[1] }); });
      }
      return out.sort(function (a, b) { return a.i - b.i; });
    }
    function repaint() { [].forEach.call(document.querySelectorAll('.pg'), function (el, i) { if (el.querySelector('.tl')) { paintAnnots(el, i + 1); paintFind(el, i + 1); } }); }
    var raf = 0, pass = function () { if (raf) return; raf = requestAnimationFrame(function () { raf = 0; [].forEach.call(document.querySelectorAll('.pg'), function (el, i) { if (el.querySelector('canvas') && !el.querySelector('.tl')) { build(el, i + 1); } }); }); }, mo = new MutationObserver(pass), scT = null;
    sc.addEventListener('scroll', function () { clearTimeout(scT); scT = setTimeout(pass, 300); });
    mo.observe(pagesEl, { childList: true, subtree: true });
    function scaleBase() {}
    // ---- go to a page
    function goPage(n, y) { var el = pageEl(n); if (!el) return; sc.scrollTop = el.offsetTop - sc.offsetTop + (y ? y * el.offsetHeight - sc.clientHeight * 0.3 : -8); }
    // ---- search
    function find(q, back) {
      var nqv = nq(q || ''); if (!nqv) { Q.n = ''; Q.q = ''; Q.pageNo = 0; Q.k = -1; repaint(); return; }
      var d = doc(); if (!d) return; var total = d.numPages, fresh = nqv !== Q.n, seen = false, tok = Q.tok = (Q.tok || 0) + 1;
      Q.q = q; Q.n = nqv;
      var start = fresh ? curPage() : (Q.pageNo || curPage()), k0 = fresh ? (back ? Infinity : -1) : Q.k;
      function step(pn, k, tried) {
        if (tok !== Q.tok) return;
        if (tried > total) { toast(seen ? s.none : s.scan); Q.pageNo = 0; Q.k = -1; repaint(); return; }
        return text(pn).then(function (t) {
          if (t.has) seen = true;
          var ms = matchesIn(t, nqv), pick = back ? (k === Infinity ? ms.length - 1 : k - 1) : k + 1;
          if (pick >= 0 && pick < ms.length) {
            Q.pageNo = pn; Q.k = pick; var r = rectsOf(t, ms[pick].i, ms[pick].e, ms[pick].vis)[0];
            goPage(pn, r ? r[1] : 0); setTimeout(repaint, 350); setTimeout(repaint, 900); return;
          }
          var next = pn + (back ? -1 : 1); if (next > total) next = 1; if (next < 1) next = total;
          return step(next, back ? Infinity : -1, tried + 1);
        });
      }
      step(start, k0, 0);
    }
    // ---- bookmarks
    function bookmark() {
      var n = curPage(), i = -1; AN.forEach(function (a, k) { if (a.type === 'bm' && a.page === n) i = k; });
      var total = (doc() && doc().numPages) || 1;
      if (i >= 0) { AN.splice(i, 1); toast(s.bmOff + ' · ' + s.pg + ' ' + n); }
      else { AN.push({ id: rid(), type: 'bm', page: n, pct: total > 1 ? (n - 1) / (total - 1) * 100 : 0, quote: s.pg + ' ' + n, date: Date.now() }); toast(s.bmOn + ' · ' + s.pg + ' ' + n); }
      save(); repaint();
    }
    // ---- contents
    function flat(list, l, out) { (list || []).forEach(function (o) { out.push({ t: o.title || '', l: l, dest: o.dest }); flat(o.items, l + 1, out); }); return out; }
    function toc() {
      var d = doc(); if (!d) return P({ type: 'toc', items: [] });
      var go = outline ? Promise.resolve(outline) : d.getOutline().then(function (o) { return (outline = flat(o, 1, [])); }).catch(function () { return (outline = []); });
      go.then(function (list) { if (!list.some(function (x) { return x.dest && x.t.trim(); })) { var pgs = []; for (var k = 1; k <= d.numPages && k <= 2000; k++) pgs.push({ t: s.pg + ' ' + k, l: 1, pg: k }); list = outline = pgs; } P({ type: 'toc', items: list.filter(function (x) { return (x.dest || x.pg) && x.t.trim(); }).map(function (x, i) { x.id = i; return { id: i, t: x.t.trim(), l: Math.min(2, x.l) }; }) }); });
    }
    function jump(id) {
      var list = (outline || []).filter(function (x) { return (x.dest || x.pg) && x.t.trim(); }), it = list[id]; if (!it) return; if (it.pg) { goPage(it.pg); return; } var d = doc();
      Promise.resolve(typeof it.dest === 'string' ? d.getDestination(it.dest) : it.dest).then(function (arr) { if (!arr) return; var ref = arr[0]; return (typeof ref === 'object' && ref ? d.getPageIndex(ref) : Promise.resolve(ref | 0)).then(function (ix) { goPage(ix + 1); }); }).catch(function () {});
    }
    // ---- highlights and notes
    var pop = document.createElement('div'); pop.id = 'lipop'; document.body.appendChild(pop);
    function hide() { pop.style.display = 'none'; pop.innerHTML = ''; }
    function showAt(x, y) { pop.style.display = 'flex'; var w = pop.offsetWidth, h = pop.offsetHeight; pop.style.left = Math.max(6, Math.min(x - w / 2, innerWidth - w - 6)) + 'px'; pop.style.top = Math.max(48, Math.min(y, innerHeight - h - 10)) + 'px'; }
    function selection() {
      var sel = window.getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      var r = sel.getRangeAt(0), node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode, tl = node && node.closest && node.closest('.tl'); if (!tl) return null;
      var el = tl.parentNode, n = [].indexOf.call(document.querySelectorAll('.pg'), el) + 1, b = el.getBoundingClientRect(), rs = [].slice.call(r.getClientRects()).filter(function (q) { return q.width > 1 && q.height > 2; });
      if (!rs.length) return null;
      rs = rs.filter(function (q) { return q.top >= b.top - 2 && q.bottom <= b.bottom + 2; });
      // join the pieces of one line
      rs.sort(function (a, c) { return a.top - c.top || a.left - c.left; }); var lines = [];
      rs.forEach(function (q) { var l = lines[lines.length - 1]; if (l && Math.abs(l.top - q.top) < q.height * 0.5 && q.left <= l.right + 6) { l.left = Math.min(l.left, q.left); l.right = Math.max(l.right, q.right); l.top = Math.min(l.top, q.top); l.bottom = Math.max(l.bottom, q.bottom); } else lines.push({ left: q.left, right: q.right, top: q.top, bottom: q.bottom }); });
      return { n: n, text: sel.toString().replace(/\s+/g, ' ').trim(), rects: lines.map(function (l) { return [(l.left - b.left) / b.width, (l.top - b.top) / b.height, (l.right - l.left) / b.width, (l.bottom - l.top) / b.height]; }), at: [lines[0].left + (lines[0].right - lines[0].left) / 2, lines[0].top - 46] };
    }
    function addAnnot(sl, note) {
      var total = (doc() && doc().numPages) || 1;
      AN.push({ id: rid(), type: 'hl', page: sl.n, rects: sl.rects, quote: sl.text.slice(0, 600), note: note || '', pct: total > 1 ? (sl.n - 1) / (total - 1) * 100 : 0, date: Date.now() });
      save(); repaint(); try { window.getSelection().removeAllRanges(); } catch (e) {} hide();
    }
    var selT = null;
    document.addEventListener('selectionchange', function () {
      clearTimeout(selT); selT = setTimeout(function () {
        if (pop.querySelector('textarea')) return;
        var sl = selection(); if (!sl || !sl.text) { if (!pop.querySelector('textarea')) hide(); return; }
        pop.innerHTML = '<button data-a="hl">' + s.hl + '</button><button data-a="nt">' + s.note + '</button><button data-a="cp">' + s.copy + '</button>'; showAt(sl.at[0], sl.at[1]);
        pop.onclick = function (e) {
          var a = e.target.getAttribute && e.target.getAttribute('data-a'); if (!a) return;
          if (a === 'hl') addAnnot(sl); else if (a === 'cp') { try { navigator.clipboard.writeText(sl.text); } catch (x) {} toast(s.done); hide(); }
          else if (a === 'nt') { pop.innerHTML = '<textarea placeholder="' + s.ph + '"></textarea><button data-a="sv">' + s.save + '</button>'; var ta = pop.querySelector('textarea'); ta.focus(); pop.onclick = function (e2) { if (e2.target.getAttribute && e2.target.getAttribute('data-a') === 'sv') addAnnot(sl, ta.value.trim()); }; }
        };
      }, 300);
    });
    // a tap on a highlight opens it: edit the note, copy, delete
    sc.addEventListener('click', function (e) {
      if (pop.contains(e.target)) return; var sel = window.getSelection(); if (sel && !sel.isCollapsed) return;
      var el = e.target.closest && e.target.closest('.pg'); if (!el) { hide(); return; }
      var n = [].indexOf.call(document.querySelectorAll('.pg'), el) + 1, b = el.getBoundingClientRect(), fx = (e.clientX - b.left) / b.width, fy = (e.clientY - b.top) / b.height, hit = null;
      AN.forEach(function (a) { if (a.type === 'hl' && a.page === n) (a.rects || []).forEach(function (r) { if (fx >= r[0] && fx <= r[0] + r[2] && fy >= r[1] && fy <= r[1] + r[3]) hit = a; }); });
      if (!hit) { hide(); return; }
      pop.innerHTML = '<textarea placeholder="' + s.ph + '"></textarea><button data-a="sv">' + s.save + '</button><button data-a="cp">' + s.copy + '</button><button data-a="dl">' + s.del + '</button>';
      var ta = pop.querySelector('textarea'); ta.value = hit.note || ''; showAt(e.clientX, e.clientY + 14);
      pop.onclick = function (e2) { var a = e2.target.getAttribute && e2.target.getAttribute('data-a'); if (!a) return;
        if (a === 'sv') { hit.note = ta.value.trim(); save(); repaint(); hide(); } else if (a === 'dl') { AN = AN.filter(function (x) { return x !== hit; }); save(); repaint(); hide(); } else if (a === 'cp') { try { navigator.clipboard.writeText(hit.quote || ''); } catch (x) {} toast(s.done); hide(); } };
    });
    // ---- messages from the library
    window.addEventListener('message', function (e) {
      var d = e.data; if (!d || !d.liCmd) return;
      if (d.liCmd === 'init') { AN = Array.isArray(d.annots) ? d.annots.slice() : []; scaleBase(); repaint(); }
      else if (d.liCmd === 'find') find(String(d.q || ''), !!d.back);
      else if (d.liCmd === 'bookmark') bookmark();
      else if (d.liCmd === 'toc') toc();
      else if (d.liCmd === 'jump') jump(d.id | 0);
      else if (d.liCmd === 'goto') { var a = d.annot; if (a && a.page) { goPage(a.page, a.rects && a.rects[0] ? a.rects[0][1] : 0); } }
      else if (d.liCmd === 'delannot') { AN = AN.filter(function (x) { return x.id !== d.id; }); save(); repaint(); }
    });
    window.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); P({ type: 'findkey' }); } else if (e.key === 'Escape') hide(); }, true);
    setTimeout(scaleBase, 1500);
  }

  // Runs INSIDE the PDF viewer page: guided reading. A dark mask leaves a bright band of a few lines; the page moves under it by buttons, keys, a tap on the dark area, or by itself at a chosen speed.
  function PDFG() {
    var UI = (window.__LI && window.__LI.ui) || 'ar', $ = function (i) { return document.getElementById(i); };
    var S = {
      ar: { t: 'القراءة الموجهة', n: 'التالي', p: 'السابق', a: 'تلقائي', x: 'إغلاق', w: 'كلمة/د', b: 'أسطر' },
      en: { t: 'Guided reading', n: 'Next', p: 'Previous', a: 'Auto', x: 'Close', w: 'wpm', b: 'lines' },
      fr: { t: 'Lecture guidée', n: 'Suivant', p: 'Précédent', a: 'Auto', x: 'Fermer', w: 'mots/min', b: 'lignes' },
      es: { t: 'Lectura guiada', n: 'Siguiente', p: 'Anterior', a: 'Auto', x: 'Cerrar', w: 'palabras/min', b: 'líneas' },
      it: { t: 'Lettura guidata', n: 'Avanti', p: 'Indietro', a: 'Auto', x: 'Chiudi', w: 'parole/min', b: 'righe' },
      id: { t: 'Membaca terpandu', n: 'Berikutnya', p: 'Sebelumnya', a: 'Otomatis', x: 'Tutup', w: 'kata/mnt', b: 'baris' }
    };
    var s = S[UI] || S.en, sc = $('sc'), bar = $('bar'); if (!sc || !bar) return;
    var st = { on: false, auto: false, wpm: 180, band: 3, timer: null, lh: 0, wpl: 8 }, mt = null, mb = null, pn = null, key = 'li-pdf-guide';
    try { var sv = JSON.parse(localStorage.getItem(key) || '{}'); if (sv.wpm) st.wpm = sv.wpm; if (sv.band) st.band = sv.band; } catch (e) {}
    var save = function () { try { localStorage.setItem(key, JSON.stringify({ wpm: st.wpm, band: st.band })); } catch (e) {} };
    var btn = document.createElement('button'); btn.id = 'gd'; btn.title = s.t; btn.setAttribute('aria-label', s.t); btn.textContent = '▤'; bar.appendChild(btn);
    var bandTop = function () { return Math.round(bar.offsetHeight + sc.clientHeight * 0.26); };
    var bandPx = function () { return Math.round(st.band * (st.lh || 26)); };
    // line height and words per line of the page now on screen, from its text (a scanned page without text keeps the defaults)
    function measure() {
      var d = window.__pdoc, n = window.__pcur ? window.__pcur() : 1; if (!d) return;
      d.getPage(n).then(function (pg) {
        var vp1 = pg.getViewport({ scale: 1 }), el = document.querySelectorAll('.pg')[n - 1], r = el ? el.offsetHeight / vp1.height : 1;
        return pg.getTextContent().then(function (tc) {
          var hs = [], rows = {}, words = 0;
          tc.items.forEach(function (it) { if (!it.str || !it.str.trim()) return; if (it.height > 2) hs.push(it.height); var y = Math.round(it.transform[5] / 3); rows[y] = 1; words += it.str.trim().split(/\s+/).length; });
          if (!hs.length) return; hs.sort(function (a, b) { return a - b; });
          st.lh = Math.max(14, hs[hs.length >> 1] * r * 1.35); var nr = Object.keys(rows).length; st.wpl = Math.max(3, words / Math.max(1, nr));
        });
      }).catch(function () {});
    }
    function masks() {
      if (!mt) {
        mt = document.createElement('div'); mb = document.createElement('div');
        [mt, mb].forEach(function (m) { m.style.cssText = 'position:fixed;left:0;right:0;z-index:6;background:rgba(0,0,0,.58);cursor:pointer'; document.body.appendChild(m); });
        mt.addEventListener('click', function () { move(-1); }); mb.addEventListener('click', function () { move(1); });
      }
      var t = bandTop(), h = bandPx(); mt.style.top = bar.offsetHeight + 'px'; mt.style.height = (t - bar.offsetHeight) + 'px'; mb.style.top = (t + h) + 'px'; mb.style.bottom = '0';
    }
    function panel() {
      if (pn) return; pn = document.createElement('div');
      pn.style.cssText = 'position:fixed;z-index:7;left:50%;bottom:12px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:12px;background:var(--bar);border:1px solid var(--ln);color:var(--tx);font-size:13px;direction:ltr;box-shadow:0 4px 18px rgba(0,0,0,.35)';
      var b = function (id, txt, ttl) { return '<button id="' + id + '" title="' + ttl + '" aria-label="' + ttl + '" style="border:1px solid var(--ln);background:none;color:inherit;border-radius:8px;height:30px;min-width:34px;cursor:pointer;font:inherit">' + txt + '</button>'; };
      pn.innerHTML = b('gdp', '▲', s.p) + b('gda', '▶', s.a) + b('gdn', '▼', s.n) + '<input id="gdw" type="range" min="80" max="450" step="10" style="width:90px" title="' + s.w + '"><span id="gdv" style="min-width:74px"></span>' + b('gdb', '3 ' + s.b, s.b) + b('gdx', '✕', s.x);
      document.body.appendChild(pn);
      var up = function () { $('gdv').textContent = st.wpm + ' ' + s.w; $('gda').textContent = st.auto ? '❚❚' : '▶'; $('gdb').textContent = st.band + ' ' + s.b; $('gdw').value = st.wpm; };
      pn.up = up; up();
      $('gdp').onclick = function () { move(-1); }; $('gdn').onclick = function () { move(1); }; $('gdx').onclick = stop;
      $('gda').onclick = function () { st.auto = !st.auto; up(); sched(); };
      $('gdw').oninput = function () { st.wpm = +this.value; save(); up(); };
      $('gdb').onclick = function () { st.band = st.band >= 5 ? 2 : st.band + 1; save(); up(); masks(); };
    }
    function sched() { clearTimeout(st.timer); st.timer = null; if (!st.on || !st.auto) return; var ms = Math.max(900, st.wpl * st.band * 0.9 / st.wpm * 60000); st.timer = setTimeout(function () { move(1); }, ms); }
    function move(dir) { sc.scrollBy({ top: dir * bandPx() * 0.9, behavior: 'smooth' }); setTimeout(measure, 500); sched(); }
    function start() { st.on = true; measure(); masks(); panel(); btn.style.background = 'rgba(195,113,76,.3)'; }
    function stop() { st.on = false; st.auto = false; clearTimeout(st.timer); [mt, mb, pn].forEach(function (x) { if (x) x.remove(); }); mt = mb = pn = null; btn.style.background = ''; }
    btn.onclick = function () { st.on ? stop() : start(); };
    window.addEventListener('resize', function () { if (st.on) masks(); });
    window.addEventListener('keydown', function (e) {
      if (!st.on) return;
      if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') { move(1); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'ArrowUp' || e.key === 'PageUp') { move(-1); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'Escape') stop();
    }, true);
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
    var IC = { tr: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h9M8.5 3v2M6 5c.6 3.3 2.7 6 5.5 7.5M12 5c-.7 3.4-3 6.2-6.4 8M13 20l4-9 4 9M14.6 17h4.8"/></svg>',
      sp: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h3.5l5 4v-13l-5 4z"/><path d="M16 9a4 4 0 0 1 0 6M18.7 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
      pl: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5.2v13.6a1 1 0 0 0 1.5.9l11-6.8a1 1 0 0 0 0-1.8l-11-6.8A1 1 0 0 0 8 5.2z"/></svg>',
      pa: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>',
      pv: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><rect x="5" y="5" width="2.6" height="14" rx="1"/><path d="M19 6v12a.8.8 0 0 1-1.25.65L9.4 12.65a.8.8 0 0 1 0-1.3l8.35-6A.8.8 0 0 1 19 6z"/></svg>',
      nx: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><rect x="16.4" y="5" width="2.6" height="14" rx="1"/><path d="M5 6v12a.8.8 0 0 0 1.25.65l8.35-6a.8.8 0 0 0 0-1.3l-8.35-6A.8.8 0 0 0 5 6z"/></svg>',
      x: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
      mn: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></svg>',
      mx: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14.5l6-6 6 6"/></svg>' };
    var st2 = document.createElement('style'); st2.textContent = ':root{--lx-bg:rgba(251,247,236,.97);--lx-fg:#14262e;--lx-ln:#d9cdb0;--lx-ac:#b08d57;--lx-soft:rgba(20,38,46,.07)}body.night{--lx-bg:rgba(26,42,50,.97);--lx-fg:#f5eedd;--lx-ln:#2c3f48;--lx-soft:rgba(245,238,221,.09)}'
      + '.lix{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:44px;height:44px;padding:0;border-radius:22px;border:1px solid var(--lx-ln);background:var(--lx-bg);color:var(--lx-fg);font:700 13px system-ui,sans-serif;box-shadow:0 3px 12px rgba(0,0,0,.25);cursor:pointer;-webkit-tap-highlight-color:transparent}.lix:active{transform:scale(.94)}.lix.on{background:var(--lx-ac);color:#fff;border-color:var(--lx-ac)}'
      + '@keyframes lxp{0%{box-shadow:0 0 0 0 rgba(176,141,87,.55)}100%{box-shadow:0 0 0 12px rgba(176,141,87,0)}}.lix.live{animation:lxp 1.6s ease-out infinite}'
      + '#li-pl{display:none;position:fixed;left:50%;bottom:66px;transform:translateX(-50%);z-index:2147483001;width:min(94vw,350px);box-sizing:border-box;background:var(--lx-bg);color:var(--lx-fg);border:1px solid var(--lx-ln);border-radius:22px;box-shadow:0 8px 28px rgba(0,0,0,.3);padding:10px 12px 12px;font:13px system-ui,sans-serif}'
      + '#li-pl .hd{display:flex;align-items:center;gap:8px;direction:ltr}#li-pl .hd b{flex:1;font-weight:700;text-align:center}#li-pl .ib{width:34px;height:34px;min-width:34px;border-radius:17px;border:0;background:var(--lx-soft);color:var(--lx-fg);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}'
      + '#li-pl .cr{display:flex;align-items:center;justify-content:center;gap:14px;margin:10px 0 4px;direction:ltr}#li-pl .cr button{width:46px;height:46px;border-radius:23px;border:0;background:var(--lx-soft);color:var(--lx-fg);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}#li-pl .cr button.big{width:60px;height:60px;border-radius:30px;background:var(--lx-ac);color:#fff}'
      + '#li-pl .rw{display:flex;align-items:center;gap:10px;margin-top:10px}#li-pl .rw span{min-width:70px;opacity:.85}#li-pl .rw b{min-width:38px;text-align:center}#li-pl input[type=range]{direction:ltr;flex:1;accent-color:var(--lx-ac);height:28px}#li-pl select{flex:1;min-width:0;height:34px;border-radius:10px;border:1px solid var(--lx-ln);background:var(--lx-soft);color:var(--lx-fg)}'
      + '#li-pl.mini{display:flex!important;direction:ltr!important;align-items:center;gap:6px;width:auto;max-width:94vw;padding:6px 10px;border-radius:30px}#li-pl.mini .hd,#li-pl.mini .cr{display:contents}#li-pl.mini .hd b,#li-pl.mini .rw,#li-pl.mini [data-r=nv],#li-pl.mini [data-r=st],#li-pl.mini [data-a=html]{display:none!important}#li-pl.mini .cr button{width:38px;height:38px;border-radius:19px}#li-pl.mini .cr button.big{width:44px;height:44px;border-radius:22px}#li-pl.mini .ib[data-a=x]{order:9}#li-pl.mini .hd .hx{order:0}#li-pl.mini .cr button[data-a=pv]{order:1}#li-pl.mini .cr button[data-a=pp]{order:2}#li-pl.mini .cr button[data-a=nx]{order:3}';
    document.head.appendChild(st2);
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'lix'; btn.innerHTML = IC.tr; btn.setAttribute('aria-label', L('tr')); ui.appendChild(btn); ui.style.display = 'flex'; ui.style.gap = '10px'; ui.style.alignItems = 'center';
    var menu = document.createElement('div'); menu.style.cssText = 'display:none;position:absolute;bottom:50px;left:0;min-width:150px;background:#fbf7ec;color:#1d2b33;border:1px solid #d9cdb0;border-radius:14px;padding:6px;box-shadow:0 6px 18px rgba(0,0,0,.25)'; ui.appendChild(menu);
    var tip = document.createElement('div'); tip.style.cssText = 'display:none;position:absolute;bottom:50px;left:0;max-width:78vw;background:rgba(29,43,51,.92);color:#f5eedd;border-radius:10px;padding:7px 11px;font:600 12px/1.4 system-ui,sans-serif'; ui.appendChild(tip);
    var tt = 0; function say(t, ms) { tip.textContent = t; tip.style.display = 'block'; clearTimeout(tt); if (ms) tt = setTimeout(function () { tip.style.display = 'none'; }, ms); }
    document.body.appendChild(ui);
    function label() { if (busy > 0) btn.textContent = '…'; else btn.innerHTML = IC.tr; }
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
    function start(t) { revert(true); tgt = t; run++; SRC = null; store = {}; noText = 0; asked = {}; btn.classList.add('on'); say(L('work') + '…', 0); try { localStorage.setItem('li-pdf-tr:' + (window.__LI && window.__LI.id), t); } catch (e) {} refresh(); }
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
      if (c.trim()) out.push(c); out = out.filter(function (x) { return /[A-Za-z0-9\u00C0-\u024F\u0600-\u06FF]/.test(x); }); return out;
    }
    function llang(t) {
      if (/[؀-ۿ]/.test(t)) return 'ar'; var l = ' ' + t.slice(0, 1500).toLowerCase() + ' ', best = 'en', bs = 0;
      var W = { fr: [' le ', ' la ', ' les ', ' des ', ' est ', ' une '], es: [' el ', ' los ', ' que ', ' una ', ' es ', ' por '], it: [' il ', ' che ', ' di ', ' una ', ' è ', ' per '], id: [' yang ', ' dan ', ' di ', ' ini ', ' itu ', ' dengan '], en: [' the ', ' and ', ' of ', ' to ', ' is ', ' in '] };
      Object.keys(W).forEach(function (k) { var c = 0; W[k].forEach(function (w) { c += l.split(w).length - 1; }); if (c > bs) { bs = c; best = k; } }); return best;
    }
    // Text of a page in reading order, ready for the voice. Lines are rebuilt from the item positions; Arabic lines that some PDF makers store
    // in screen order (letters or words reversed) are turned back by checking which order gives real Arabic words (the same word list the converter uses).
    var AR = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/, DG = /[0-9٠-٩۰-۹]+/g;
    function revDigits(t) { return t.replace(DG, function (m) { return m.split('').reverse().join(''); }); }
    function arScore(t, ar) { var w = t.split(/[^؀-ۿ]+/).filter(function (x) { return x.length > 1; }); if (!w.length || !ar) return -1; var nm = parent.liArFixNorm || function (z) { return z; }, k = 0; w.forEach(function (x) { if (ar.known(nm(x))) k++; }); return k / w.length; }
    function joinItems(its) {
      var o = '', prev = null;
      its.forEach(function (it) {
        if (!it.s) return;
        if (prev && !/^\s/.test(it.s) && !/\s$/.test(prev.s)) { var gap = Math.max(it.x - (prev.x + prev.w), prev.x - (it.x + it.w)); if (gap > 0.22 * Math.max(it.h, prev.h, 1) || (prev.s.length > 2 && it.s.length > 2 && gap > -0.1 * it.h)) o += ' '; }
        o += it.s; prev = it;
      });
      return o;
    }
    function lineText(its, ar) {
      var A = joinItems(its); if (!AR.test(A)) return A;
      var R = its.slice().reverse(), B = revDigits(joinItems(R)), C = revDigits(joinItems(R.map(function (it) { return { s: it.s.split('').reverse().join(''), x: it.x, w: it.w, h: it.h }; })));
      var D = joinItems(its.map(function (it) { return { s: it.s.split('').reverse().join(''), x: it.x, w: it.w, h: it.h }; }));
      var cand = [A, B, C, D], sc = cand.map(function (c) { return arScore(c, ar); }), best = 0;
      if (sc[0] < 0) return A;
      for (var i = 1; i < 4; i++) if (sc[i] > sc[best] + 0.15) best = i; // keep the stored order unless another order is clearly better
      return cand[best];
    }
    // Words stored letter-by-letter in screen order: keep the order that gives real Arabic words.
    function fixPara(t, ar) {
      if (!ar || !AR.test(t)) return t;
      var rv = t.replace(/[؀-ۿ]+/g, function (w) { return w.split('').reverse().join(''); });
      return arScore(rv, ar) > arScore(t, ar) + 0.2 ? revDigits(rv) : t;
    }
    function ptextLines(tc, ar) {
      var lines = [], cur = null;
      tc.items.forEach(function (it) {
        var str = String(it.str == null ? '' : it.str).normalize('NFKC'); if (!str) return;
        var tr = it.transform || [1, 0, 0, 1, 0, 0], h = Math.abs(it.height) || Math.hypot(tr[2], tr[3]) || 8, o = { s: str, x: tr[4], y: tr[5], w: Math.abs(it.width) || 0, h: h };
        if (cur && Math.abs(cur.y - o.y) < 0.55 * Math.max(cur.h, h)) cur.its.push(o); else { cur = { y: o.y, h: h, its: [o] }; lines.push(cur); }
        if (it.hasEOL) cur = null;
      });
      return lines.map(function (l) { return lineText(l.its, ar).replace(/\s+/g, ' ').trim(); }).filter(Boolean).join(' ');
    }
    // Text of a page in reading order: the same page geometry as the HTML converter (columns, headers and page numbers left out), then the Arabic order check.
    function ptext(n) {
      var arP = Promise.resolve(null); try { arP = parent.liArFix ? parent.liArFix.load().catch(function () { return null; }) : arP; } catch (e) {}
      window.__liPrio = window.__liPrio || {}; window.__liPrio[n] = 1;
      return Promise.all([getDoc().then(function (d) { return d.getPage(n); }), arP]).then(function (r) {
        var pg = r[0], ar = r[1], G = window.__PDFGEO;
        return pg.getTextContent().then(function (tc) {
          delete window.__liPrio[n]; var vp = pg.getViewport({ scale: 1 }), out = '';
          if (G) { try { out = G.pageBlocks(tc.items, vp.width, vp.height).map(function (b) { return fixPara(b.txt, ar); }).join('. ').replace(/\s+/g, ' ').trim(); } catch (e) { out = ''; } }
          if (!out) out = ptextLines(tc, ar).replace(/\s+/g, ' ').trim();
          return out;
        });
      });
    }
    function lstop() { LS.on = false; window.__liListening = false; LS.wait = null; LS.paused = false; LS.tok++; try { window.speechSynthesis.cancel(); } catch (e) {} lsay(false); lpanel(); }
    // Pages are queued ahead (on the phone the whole rest of the document), so reading continues by itself while the page is frozen in the background.
    function lpage(n, tok) {
      var Q = { np: n, out: 0, loading: false, total: 0 }; LS.q = Q;
      function top() {
        if (!LS.on || tok !== LS.tok || Q.loading) return;
        if (Q.out >= (Q.slow ? 80 : ((window.LiNative || parent.LiNative) ? 1e6 : 400))) return;
        if (Q.total && Q.np > Q.total) { if (Q.out <= 0) lstop(); return; }
        Q.loading = true; var t0 = Date.now(), tm = setInterval(function () { if (!Q.loading || !LS.on || tok !== LS.tok) { clearInterval(tm); return; } LS.wait = { n: Q.np, s: Math.round((Date.now() - t0) / 1000) }; lpanel(); }, 1000);
        getDoc().then(function (d) { Q.total = d.numPages; if (Q.np > d.numPages) return ''; return ptext(Q.np); }).then(function (t) {
          Q.loading = false; LS.wait = null; if (Date.now() - t0 > 500) Q.slow = true; if (!LS.on || tok !== LS.tok) return;
          var pn = Q.np; Q.np++;
          if (!t) { LS.note = { n: pn, at: Date.now() }; lpanel(); top(); return; }
          var cs = lchunks(t), lg = llang(t), G = {}; try { G = JSON.parse(parent.localStorage.getItem('li-dock') || '{}') || {}; } catch (e) {}
          cs.forEach(function (c, k) {
            var u = new SpeechSynthesisUtterance(c); u.__g = 'p' + pn; u.lang = lg === 'ar' ? 'ar-SA' : lg; u.rate = G.rate || 1; u.volume = (G.vol == null ? 1 : G.vol); LS.lg = lg;
            try { var vs = (window.speechSynthesis.getVoices() || []).filter(function (v) { return (v.lang || '').toLowerCase().indexOf(lg) === 0; }); var pick = vs.filter(function (v) { return v.name === G.voice; })[0] || vs[0]; if (pick) { u.voice = pick; u.lang = pick.lang; } } catch (e) {}
            var fin = false; Q.out++;
            u.onstart = function () { if (k === 0 && LS.on && tok === LS.tok) { LS.cur = pn; lpanel(); try { window.__pgo && window.__pgo(pn); } catch (e) {} } };
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
    window.__liPtext = ptext;
    // ---- player: entry button + control panel (play/pause, previous/next page, speed, volume, voice), like the book reader's dock
    var PL = { en: { l: 'Listen', pp: 'Play / pause', pv: 'Previous page', nx: 'Next page', sp: 'Speed', vo: 'Volume', vc: 'Voice', x: 'Stop', pg: 'Page', au: 'Automatic', nv: 'No voice for this language is installed on this device. Add one in the system speech settings.', prep: 'Reading the text of page #…', nt: 'Page # has no readable text — skipped', toh: 'Convert to an HTML book (faster, better listening)', mn: 'Minimize', mx: 'Expand' },
      ar: { l: 'استماع', pp: 'تشغيل / إيقاف مؤقت', pv: 'الصفحة السابقة', nx: 'الصفحة التالية', sp: 'السرعة', vo: 'مستوى الصوت', vc: 'الصوت', x: 'إيقاف', pg: 'الصفحة', au: 'تلقائي', nv: 'لا يوجد صوت لهذه اللغة على هذا الجهاز. أضف صوتًا من إعدادات النطق في النظام.', prep: 'جارٍ قراءة نص الصفحة #…', nt: 'الصفحة # بلا نص مقروء — تم تخطيها', toh: 'تحويل إلى كتاب HTML (استماع أسرع وأدق)', mn: 'تصغير', mx: 'تكبير' },
      fr: { l: 'Écouter', pp: 'Lecture / pause', pv: 'Page précédente', nx: 'Page suivante', sp: 'Vitesse', vo: 'Volume', vc: 'Voix', x: 'Arrêter', pg: 'Page', au: 'Automatique', nv: 'Aucune voix pour cette langue n’est installée. Ajoutez-en une dans les paramètres vocaux du système.', prep: 'Lecture du texte de la page #…', nt: 'La page # n’a pas de texte lisible — ignorée', toh: 'Convertir en livre HTML (écoute plus rapide et plus précise)', mn: 'Réduire', mx: 'Agrandir' },
      es: { l: 'Escuchar', pp: 'Reproducir / pausa', pv: 'Página anterior', nx: 'Página siguiente', sp: 'Velocidad', vo: 'Volumen', vc: 'Voz', x: 'Detener', pg: 'Página', au: 'Automático', nv: 'No hay una voz instalada para este idioma. Añade una en los ajustes de voz del sistema.', prep: 'Leyendo el texto de la página #…', nt: 'La página # no tiene texto legible — omitida', toh: 'Convertir en libro HTML (escucha más rápida y precisa)', mn: 'Minimizar', mx: 'Ampliar' },
      it: { l: 'Ascolta', pp: 'Riproduci / pausa', pv: 'Pagina precedente', nx: 'Pagina successiva', sp: 'Velocità', vo: 'Volume', vc: 'Voce', x: 'Ferma', pg: 'Pagina', au: 'Automatico', nv: 'Nessuna voce installata per questa lingua. Aggiungine una nelle impostazioni vocali del sistema.', prep: 'Lettura del testo della pagina #…', nt: 'La pagina # non ha testo leggibile — saltata', toh: 'Converti in libro HTML (ascolto più rapido e preciso)', mn: 'Riduci', mx: 'Espandi' },
      id: { l: 'Dengarkan', pp: 'Putar / jeda', pv: 'Halaman sebelumnya', nx: 'Halaman berikutnya', sp: 'Kecepatan', vo: 'Volume', vc: 'Suara', x: 'Berhenti', pg: 'Halaman', au: 'Otomatis', nv: 'Belum ada suara untuk bahasa ini di perangkat. Tambahkan di pengaturan suara sistem.', prep: 'Membaca teks halaman #…', nt: 'Halaman # tidak memiliki teks yang terbaca — dilewati', toh: 'Ubah ke buku HTML (mendengarkan lebih cepat dan akurat)', mn: 'Perkecil', mx: 'Perbesar' } };
    var P = PL[UI] || PL.en;
    var lb = document.createElement('button'); lb.type = 'button'; lb.id = 'li-pl-btn'; lb.className = 'lix'; lb.title = P.l; lb.setAttribute('aria-label', P.l); lb.innerHTML = IC.sp; ui.insertBefore(lb, btn.nextSibling);
    var pn = document.createElement('div'); pn.id = 'li-pl'; pn.setAttribute('translate', 'no'); pn.style.direction = UI === 'ar' ? 'rtl' : 'ltr';
    var mini = false; try { mini = localStorage.getItem('li-pl-mini') === '1'; } catch (e) {}
    function ab(a, t, c) { return '<button type="button" data-a="' + a + '" title="' + t + '" aria-label="' + t + '"' + (c ? ' class="' + c + '"' : '') + '>' + IC[a] + '</button>'; }
    pn.innerHTML = '<div class="hd"><button type="button" class="ib hx" data-a="mn" aria-label="' + P.mn + '" title="' + P.mn + '">' + IC.mn + '</button><b data-r="pg"></b><button type="button" class="ib" data-a="x" aria-label="' + P.x + '" title="' + P.x + '">' + IC.x + '</button></div>'
      + '<div class="cr"><button type="button" data-a="pv" title="' + P.pv + '" aria-label="' + P.pv + '">' + IC.pv + '</button><button type="button" class="big" data-a="pp" title="' + P.pp + '" aria-label="' + P.pp + '">' + IC.pa + '</button><button type="button" data-a="nx" title="' + P.nx + '" aria-label="' + P.nx + '">' + IC.nx + '</button></div>'
      + '<div data-r="st" style="display:none;margin-top:8px;font-size:12px;line-height:1.5;text-align:center;opacity:.9"></div><button type="button" data-a="html" style="display:none;width:100%;margin-top:6px;padding:8px 10px;border-radius:12px;border:0;background:var(--lx-soft);color:var(--lx-fg);font:600 12px system-ui,sans-serif;cursor:pointer">' + P.toh + '</button>'
      + '<label class="rw"><span>' + P.sp + '</span><input data-r="sp" type="range" min="0.6" max="2" step="0.1"><b data-r="spv"></b></label>'
      + '<label class="rw"><span>' + P.vo + '</span><input data-r="vo" type="range" min="0" max="1" step="0.05"><b data-r="vov"></b></label>'
      + '<label class="rw"><span>' + P.vc + '</span><select data-r="vc"></select></label><div data-r="nv" style="display:none;margin-top:8px;padding:8px 10px;border-radius:10px;background:rgba(176,60,40,.12);font-size:12px;line-height:1.5">' + P.nv + '</div>';
    document.body.appendChild(pn);
    function gset(k, v) { var G = {}; try { G = JSON.parse(parent.localStorage.getItem('li-dock') || '{}') || {}; } catch (e) {} G[k] = v; try { parent.localStorage.setItem('li-dock', JSON.stringify(G)); } catch (e) {} }
    function gget() { var G = {}; try { G = JSON.parse(parent.localStorage.getItem('li-dock') || '{}') || {}; } catch (e) {} return G; }
    function q(r) { return pn.querySelector('[data-r="' + r + '"]'); }
    function fillVoices() {
      var sel = q('vc'), G = gget(), vs = []; try { vs = window.speechSynthesis.getVoices() || []; } catch (e) {}
      var f = LS.lg ? vs.filter(function (v) { return (v.lang || '').toLowerCase().indexOf(LS.lg) === 0; }) : []; if (!f.length) f = vs;
      q('nv').style.display = (vs.length && LS.lg && !vs.some(function (v) { return (v.lang || '').toLowerCase().indexOf(LS.lg) === 0; })) ? 'block' : 'none'; var key = f.map(function (v) { return v.name; }).join('|'); if (sel.__k === key) { sel.value = G.voice || ''; return; } sel.__k = key;
      sel.innerHTML = ''; var o = document.createElement('option'); o.value = ''; o.textContent = P.au; sel.appendChild(o);
      f.forEach(function (v) { var x = document.createElement('option'); x.value = v.name; x.textContent = v.name + ' (' + v.lang + ')'; sel.appendChild(x); }); sel.value = G.voice || '';
    }
    function lpanel() {
      lb.classList.toggle('live', !!LS.on && !LS.paused); lb.classList.toggle('on', !!LS.on);
      if (!LS.on) { pn.classList.remove('mini'); pn.style.display = 'none'; return; }
      pn.style.display = 'block'; pn.classList.toggle('mini', mini); var G = gget(), hx = pn.querySelector('.hx'); hx.innerHTML = mini ? IC.mx : IC.mn; hx.title = mini ? P.mx : P.mn;
      q('sp').value = G.rate || 1; q('spv').textContent = (+(G.rate || 1)).toFixed(1) + '×'; q('vo').value = G.vol == null ? 1 : G.vol; q('vov').textContent = Math.round((G.vol == null ? 1 : G.vol) * 100) + '%';
      q('pg').textContent = P.pg + ' ' + (LS.cur || '') + (LS.q && LS.q.total ? ' / ' + LS.q.total : '') + (LS.q && LS.q.loading && LS.on && !LS.paused ? '  …' : ''); pn.querySelector('[data-a="pp"]').innerHTML = LS.paused ? IC.pl : IC.pa; if (!mini) fillVoices();
      var stE = q('st'), hb = pn.querySelector('[data-a="html"]'), w = LS.wait, nt = LS.note && Date.now() - LS.note.at < 6000 ? LS.note : null;
      stE.style.display = (w || nt) ? 'block' : 'none'; stE.textContent = w ? P.prep.replace('#', w.n) + (w.s > 2 ? ' · ' + w.s + 's' : '') : (nt ? P.nt.replace('#', nt.n) : ''); hb.style.display = (w && w.s > 40) ? 'block' : 'none';
    }
    function lrestart(n) { if (!LS.on) return; LS.paused = false; var tok = ++LS.tok; try { window.speechSynthesis.cancel(); } catch (e) {} LS.cur = n; lpanel(); setTimeout(function () { if (LS.on && tok === LS.tok) lpage(n, tok); }, 120); }
    function lstart() { if (LS.on) { lstop(); return; } if (!window.speechSynthesis) return; LS.on = true; window.__liListening = true; mini = false; try { localStorage.setItem('li-pl-mini', '0'); } catch (x) {} LS.paused = false; var tok = ++LS.tok; lsay(true); LS.cur = (window.__pcur && window.__pcur()) || 1; lpanel(); lpage(LS.cur, tok); }
    var plt = 0; function plLater(f) { clearTimeout(plt); plt = setTimeout(f, 450); }
    pn.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-a]') : null; if (!b) return; var a = b.getAttribute('data-a'), n = LS.cur || 1;
      if (a === 'html') { try { parent.postMessage({ liBook: 1, type: 'pdf-to-html', tr: '' }, '*'); } catch (x) {} } else if (a === 'x') lstop(); else if (a === 'mn') { mini = !mini; try { localStorage.setItem('li-pl-mini', mini ? '1' : '0'); } catch (x) {} lpanel(); } else if (a === 'pv') lrestart(Math.max(1, n - 1)); else if (a === 'nx') lrestart(Math.min((LS.q && LS.q.total) || 1e6, n + 1));
      else if (a === 'pp') { if (LS.paused) lrestart(n); else { LS.paused = true; LS.tok++; try { window.speechSynthesis.cancel(); } catch (x) {} lpanel(); } }
    });
    q('sp').addEventListener('input', function () { gset('rate', +this.value); q('spv').textContent = (+this.value).toFixed(1) + '×'; plLater(function () { if (LS.on && !LS.paused) lrestart(LS.cur || 1); }); });
    q('vo').addEventListener('input', function () { gset('vol', +this.value); q('vov').textContent = Math.round(this.value * 100) + '%'; plLater(function () { if (LS.on && !LS.paused) lrestart(LS.cur || 1); }); });
    q('vc').addEventListener('change', function () { gset('voice', this.value); if (LS.on && !LS.paused) lrestart(LS.cur || 1); });
    try { window.speechSynthesis.addEventListener('voiceschanged', function () { if (LS.on) fillVoices(); }); } catch (e) {}
    lb.addEventListener('click', function (e) { e.stopPropagation(); if (LS.on && mini) { mini = false; try { localStorage.setItem('li-pl-mini', '0'); } catch (x) {} lpanel(); return; } lstart(); });
    window.__liPdfListen = lstart;
    window.addEventListener('message', function (e) { var d = e.data; if (d && d.liCmd === 'plisten') lstart(); });
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
    if (b.format === 'pdf') return Promise.all([fGet(b.id + '/' + b.file), getText('pdfviewer.html'), getText('pdfgeo.js').catch(function () { return ''; })]).then(function (r) { var u = URL.createObjectURL(r[0]); live.push(u); var base = location.origin + '/pdfjs/'; var pre = '<script>try{if(!window.LiNative&&parent.LiNative)window.LiNative=parent.LiNative}catch(e){}<\/script><script>window.__TRS=' + JSON.stringify(TRS) + ';<\/script><script>(' + TTSX.toString() + ')();<\/script><script>(' + GEST.toString() + ')();<\/script><script>(' + TRU.toString() + ')();<\/script><script>' + r[2].replace(/<\/script/gi, '<\\/script') + '<\/script><script>window.__LI=' + JSON.stringify({ ui: lib.settings.lang || 'ar', id: b.id, url: u, base: base }) + ';<\/script>', post = '<script>(' + PDFX.toString() + ')();<\/script><script>(' + PDFG.toString() + ')();<\/script><script>(' + PDFN.toString() + ')();<\/script>'; return { srcdoc: r[1].replace(/book:\/\/__ID__\/__file/g, u).replace(/book:\/\/__ID__\/__pdfjs\//g, base).replace(/__ID__/g, b.id).replace(/__TITLE__/g, b.title.replace(/</g, '&lt;')).replace(/__LANG__/g, lang).replace(/(<script src="[^"]*pdf\.min\.js"><\/script>)/, function (m) { return pre + m + post; }) }; });
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
