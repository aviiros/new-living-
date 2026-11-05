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
  var M = function (ar, en) { return lib.settings.lang === 'en' ? en : ar; };
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
  var ALLOWED = /\.(html?|epub|pdf|txt|md|fb2|cbz|mobi|azw3?|prc|mp3|m4a|m4b|aac|ogg|opus|wav|flac)$/i;
  function importFile(file) {
    if (!ALLOWED.test(file.name)) return Promise.resolve({ err: 'صيغة غير مدعومة: ' + file.name });
    return file.arrayBuffer().then(function (buf) { return sha1(buf).then(function (hash) {
      var dup = lib.books.filter(function (b) { return b.hash === hash; })[0]; if (dup) return { dup: dup };
      var id = 'b' + rid(6), ext = extOf(file.name), base = baseName(file.name);
      var b = { id: id, hash: hash, format: 'html', file: 'index.html', title: base, author: '', series: '', rating: 0, hidden: false, want: false, cover: null, added: Date.now(), lastRead: 0, progress: 0, finished: false, readSec: 0, collections: [], bytes: file.size, tpl: false, words: 0, ext: null, annots: [], audio: null };
      var finish = function (cv) { var p = cv ? (b.cover = 'cover.' + cv.ext, fSet(id + '/' + b.cover, cv.blob).then(function () { setCoverURL(b, cv.blob); })) : Promise.resolve(); return p.then(function () { lib.books.push(b); return { book: b }; }); };
      if (/^html?$/.test(ext)) { var html = new TextDecoder('utf-8').decode(buf), m = meta(html, file.name); Object.assign(b, { title: m.title, author: m.author, tpl: /id=["']li-orig-data["']|id=["']toc-list["']/.test(html), words: wordCount(html) }); return fSet(id + '/index.html', new Blob([buf], { type: 'text/html' })).then(function () { return finish(coverFromHtml(html)); }); }
      if (ext === 'epub') return epubToHtml(buf).then(function (r) { Object.assign(b, { format: 'epub', title: r.title, author: r.author, words: wordCount(r.html) }); return fSet(id + '/index.html', new Blob([r.html], { type: 'text/html' })).then(function () { return finish(r.cover); }); }).catch(function () { return { err: 'تعذر استيراد الملف: ' + file.name }; });
      if (ext === 'pdf') { var head = new TextDecoder('latin1').decode(new Uint8Array(buf, Math.max(0, buf.byteLength - 20000))), info = function (k) { var mm = new RegExp('/' + k + '\\s*\\(([^)]{1,200})\\)').exec(head); return mm ? mm[1].replace(/\\(.)/g, '$1').trim() : ''; }; Object.assign(b, { format: 'pdf', file: 'book.pdf', title: (/^[\x20-\x7E]*$/.test(info('Title')) && info('Title')) || base, author: /^[\x20-\x7E]*$/.test(info('Author')) ? info('Author') : '' }); return fSet(id + '/book.pdf', new Blob([buf], { type: 'application/pdf' })).then(function () { return finish(null); }); }
      var F = window.__FMT, fin = function (r, orig) { Object.assign(b, { format: 'epub', orig: orig, title: r.title || base, author: r.author || '', words: orig === 'CBZ' ? 0 : wordCount(r.html) }); return fSet(id + '/index.html', new Blob([r.html], { type: 'text/html' })).then(function () { return finish(r.cover); }); };
      var bad = function (e) { return { err: (e && e.message === 'drm' ? 'ملف محمي (DRM): ' : 'تعذر استيراد الملف: ') + file.name }; };
      if (F && (ext === 'txt' || ext === 'md')) return F.txtToHtml(buf, file.name).then(function (r) { return fin(r, ext === 'md' ? 'MD' : 'TXT'); }).catch(bad);
      if (F && ext === 'fb2') return F.fb2ToHtml(buf).then(function (r) { return fin(r, 'FB2'); }).catch(bad);
      if (F && ext === 'cbz') return F.cbzImport(buf, id, fSet, file.name).then(function (r) { return fin(r, 'CBZ'); }).catch(function (e) { return fDelPrefix(id + '/').then(function () { return bad(e); }); });
      if (F && /^(mobi|azw3?|prc)$/.test(ext)) return F.mobiToHtml(new Blob([buf])).then(function (r) { return fin(r, ext === 'mobi' || ext === 'prc' ? 'MOBI' : 'AZW3'); }).catch(bad);
      var name = 'audio.' + ext; Object.assign(b, { format: 'audio', file: name, audio: { pos: 0, dur: 0, bm: [] } }); return fSet(id + '/' + name, new Blob([buf], { type: file.type || 'audio/mpeg' })).then(function () { return finish(null); });
    }); }).catch(function () { return { err: 'تعذر استيراد الملف: ' + file.name }; });
  }
  function addMany(files) {
    var n = 0, d = 0, errs = [], chain = Promise.resolve();
    files.forEach(function (f) { chain = chain.then(function () { return importFile(f).then(function (r) { if (r.book) n++; else if (r.dup) d++; else if (r.err) errs.push(r.err); }); }); });
    return chain.then(function () { return save(true); }).then(function () { push(); if (n) toast('أُضيف ' + n + (n === 1 ? ' كتاب' : ' كتب')); if (d) toast('موجود مسبقاً في المكتبة (' + d + ')'); errs.forEach(toast); return lib; });
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
  var SHIM = function (id) { return '<script>(function(){try{var P="li:' + id + ':",R=window.localStorage;function keys(){var a=[];for(var i=0;i<R.length;i++){var k=R.key(i);if(k&&k.indexOf(P)===0)a.push(k.slice(P.length))}return a}var base={getItem:function(k){return R.getItem(P+k)},setItem:function(k,v){R.setItem(P+k,String(v))},removeItem:function(k){R.removeItem(P+k)},clear:function(){keys().forEach(function(k){R.removeItem(P+k)})},key:function(n){var a=keys();return a[n]===undefined?null:a[n]}};var LSP=new Proxy(base,{get:function(t,k){if(k==="length")return keys().length;if(k in t)return t[k];return R.getItem(P+String(k))},set:function(t,k,v){R.setItem(P+String(k),String(v));return true},deleteProperty:function(t,k){R.removeItem(P+String(k));return true},has:function(t,k){return k in t||R.getItem(P+String(k))!==null},ownKeys:function(){return keys()},getOwnPropertyDescriptor:function(t,k){return R.getItem(P+String(k))!==null?{value:R.getItem(P+String(k)),enumerable:true,configurable:true,writable:true}:undefined}});Object.defineProperty(window,"localStorage",{configurable:true,get:function(){return LSP}});var o=indexedDB.open.bind(indexedDB);indexedDB.open=function(n,v){return v===undefined?o(P+n):o(P+n,v)};var d=indexedDB.deleteDatabase.bind(indexedDB);indexedDB.deleteDatabase=function(n){return d(P+n)}}catch(e){}document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href]");if(a&&/^(https?:|mailto:)/i.test(a.href)&&a.origin!==location.origin){e.preventDefault();parent.postMessage({liBook:1,type:"open-url",url:a.href},"*")}},true)})();<\/script>'; };
  function revokeLive() { live.forEach(function (u) { URL.revokeObjectURL(u); }); live = []; }
  function frameSrc(b) {
    revokeLive(); var lang = lib.settings.lang || 'ar';
    if (b.format === 'html' || b.format === 'epub') return Promise.all([fGet(b.id + '/index.html'), INJECT_JS ? INJECT_JS : getText('reader.js')]).then(function (r) {
      INJECT_JS = r[1]; return r[0].text().then(function (h) { return b.orig === 'CBZ' && window.__FMT ? window.__FMT.resolvePages(h, function (n) { return fGet(b.id + '/' + n); }, function (u) { live.push(u); }) : h; }).then(function (h) { var tag = '<script>window.__LI=' + JSON.stringify({ tpl: !!b.tpl, id: b.id, lang: lang }) + ';' + INJECT_JS + '<\/script>', shim = SHIM(b.id);
        h = /<head[^>]*>/i.test(h) ? h.replace(/<head[^>]*>/i, function (m) { return m + shim; }) : shim + h; h = /<\/body>/i.test(h) ? h.replace(/<\/body>/i, function () { return tag + '</body>'; }) : h + tag; return { srcdoc: h }; }); });
    if (b.format === 'audio') return Promise.all([fGet(b.id + '/' + b.file), getText('player.html')]).then(function (r) { var u = URL.createObjectURL(r[0]); live.push(u); var cu = (coverURL[b.id] || {}).u || ''; return { srcdoc: r[1].replace(/book:\/\/__ID__\/__file/g, u).replace(/book:\/\/__ID__\/__cover/g, cu).replace(/__ID__/g, b.id).replace(/__TITLE__/g, b.title.replace(/</g, '&lt;')).replace(/__AUTHOR__/g, (b.author || '').replace(/</g, '&lt;')).replace('__HASCOVER__', b.cover ? '1' : '0').replace(/__LANG__/g, lang) }; });
    if (b.format === 'pdf') return Promise.all([fGet(b.id + '/' + b.file), getText('pdfviewer.html')]).then(function (r) { var u = URL.createObjectURL(r[0]); live.push(u); var base = location.origin + '/pdfjs/'; return { srcdoc: r[1].replace(/book:\/\/__ID__\/__file/g, u).replace(/book:\/\/__ID__\/__pdfjs\//g, base).replace(/__ID__/g, b.id).replace(/__TITLE__/g, b.title.replace(/</g, '&lt;')).replace(/__LANG__/g, lang) }; });
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
  var ready = kvGet('lib').then(function (j) { if (j) { try { var o = JSON.parse(j); lib = Object.assign(lib, o); lib.settings = Object.assign({}, DEF_SET, o.settings || {}); lib.goals = Object.assign({}, DEF_GOALS, o.goals || {}); } catch (e) {} } if (!lib.settings.lang) lib.settings.lang = /^ar/i.test(navigator.language || '') ? 'ar' : 'en'; return seeds(); }).then(function () {
    return Promise.all(lib.books.filter(function (b) { return b.cover; }).map(function (b) { return fGet(b.id + '/' + b.cover).then(function (bl) { if (bl) setCoverURL(b, bl); }); }));
  }).then(function () { syncReminder(); syncQuotes(false); if (PL.App && PL.App.addListener) PL.App.addListener('backButton', function () { if (!(window.__li && window.__li.onBack && window.__li.onBack())) PL.App.exitApp(); }); history.replaceState({ root: 1 }, ''); history.pushState({ li: 1 }, ''); addEventListener('popstate', function () { if (window.__li && window.__li.onBack && window.__li.onBack()) history.pushState({ li: 1 }, ''); }); });
  var A = function (f) { return function () { var a = arguments; return ready.then(function () { return f.apply(null, a); }); }; };
  var api = {
    platform: 'android', noFullscreen: true, shareFile: function (name, blob) { return saveBlob(name, blob); },
    coverUrl: function (b) { var c = coverURL[b.id]; return c ? c.u : PIXEL; },
    frameSrc: A(frameSrc), openUrl: function (u) { if (!/^(https?:|mailto:)/i.test(u)) return; if (PL.Browser && PL.Browser.open && /^https?:/i.test(u)) PL.Browser.open({ url: u }); else window.open(u, '_blank'); },
    pathOf: function () { return ''; }, onOpen: function () {}, onState: function (f) { cbState.push(f); }, onToast: function (f) { cbToast.push(f); },
    state: A(function () { return lib; }),
    add: A(function () { return pick('.html,.htm,.epub,.pdf,.txt,.md,.fb2,.cbz,.mobi,.azw,.azw3,.prc,.mp3,.m4a,.m4b,.aac,.ogg,.opus,.wav,.flac,text/html,application/epub+zip,application/pdf,audio/*,*/*', true).then(function (f) { return f.length ? addMany(f) : lib; }); }),
    addPaths: A(function () { return lib; }),
    update: A(function (id, patch) { var b = find(id); if (b) { ['title', 'author', 'series', 'rating', 'hidden', 'want', 'progress', 'finished', 'finishedAt', 'lastRead', 'audio', 'pdf'].forEach(function (k) { if (k in patch) b[k] = patch[k]; }); save(); } return lib; }),
    remove: A(function (id) { var i = lib.books.findIndex(function (b) { return b.id === id; }); if (i < 0) return lib; lib.books.splice(i, 1); if (coverURL[id]) { URL.revokeObjectURL(coverURL[id].u); delete coverURL[id]; } return fDelPrefix(id + '/').then(function () { save(true); return lib; }); }),
    ext: A(function (id, x) { var b = find(id); if (b && x) { b.ext = x; if (b.tpl && typeof x.progress === 'number') b.progress = Math.max(0, Math.min(100, Math.round(x.progress))); save(); } return lib; }),
    annots: A(function (id, a) { var b = find(id); if (b && Array.isArray(a)) { b.annots = a.slice(0, 5000); save(); } return lib; }),
    tick: A(tickGoals),
    goals: A(function (g) { ['enabled', 'daily', 'yearly', 'remind', 'remindAt'].forEach(function (k) { if (k in g) lib.goals[k] = g[k]; }); lib.goals.daily = Math.max(1, Math.min(600, Math.round(lib.goals.daily) || 5)); lib.goals.yearly = Math.max(1, Math.min(999, Math.round(lib.goals.yearly) || 12)); save(); syncReminder(); return lib; }),
    clearGoals: A(function () { lib.goals.days = {}; lib.goals.notified = ''; lib.books.forEach(function (b) { b.readSec = 0; }); save(); return lib; }),
    setCover: A(function (id) { var b = find(id); if (!b) return lib; return pick('image/*', false).then(function (f) { if (!f[0]) return lib; var ext = (extOf(f[0].name) || 'png').replace('jpeg', 'jpg'), p = b.cover ? fDelPrefix(id + '/cover.') : Promise.resolve(); return p.then(function () { return fSet(id + '/cover.' + ext, f[0]); }).then(function () { b.cover = 'cover.' + ext; b.coverV = Date.now(); setCoverURL(b, f[0]); save(true); return lib; }); }); }),
    exportBook: A(function (id) { var b = find(id); if (!b) return; if (b.orig === 'CBZ') return fKeys(id + '/p/').then(function (ks) { var z = new JSZip(); return Promise.all(ks.map(function (k) { return fGet(k).then(function (bl) { z.file(k.slice(id.length + 3), bl); }); })).then(function () { return z.generateAsync({ type: 'blob' }); }); }).then(function (bl) { return saveBlob(b.title.replace(/[\\/:*?\"<>|]/g, '') + '.cbz', bl); }); return fGet(id + '/' + b.file).then(function (bl) { return saveBlob(b.title.replace(/[\\/:*?"<>|]/g, '') + (b.format === 'epub' ? '.html' : '.' + extOf(b.file)), bl); }); }),
    exportNotes: A(function (id) { var b = find(id); if (!b) return; if (!notesOf(b).length) return toast('لا ملاحظات لهذا الكتاب'); return saveBlob(M('ملاحظات - ', 'Notes - ') + b.title.replace(/[\\/:*?"<>|]/g, '') + '.md', new Blob(['\ufeff' + md(b)], { type: 'text/markdown' })).then(function () { toast('تم تصدير الملاحظات'); }); }),
    exportAllNotes: A(function () { var bs = lib.books.filter(function (b) { return notesOf(b).length; }); if (!bs.length) return toast('لا ملاحظات بعد'); return saveBlob(M('ملاحظاتي - Living Ideas.md', 'My Notes - Living Ideas.md'), new Blob(['\ufeff' + bs.map(md).join('\n---\n\n')], { type: 'text/markdown' })).then(function () { toast('تم تصدير ملاحظات ' + bs.length + ' كتب'); }); }),
    backup: A(function () { return save(true).then(function () { var z = new JSZip(); z.file('library.json', JSON.stringify(lib)); return Promise.all(lib.books.map(function (b) { return fKeys(b.id + '/').then(function (ks) { return Promise.all(ks.map(function (k) { return fGet(k).then(function (bl) { z.file('books/' + k, bl); }); })); }); })).then(function () { return z.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } }); }); }).then(function (bl) { return saveBlob(M('Living-Ideas-نسخة-احتياطية-', 'Living-Ideas-backup-') + today() + '.lilib', bl); }).then(function () { toast('تم إنشاء النسخة الاحتياطية'); }).catch(function () { toast('تعذر إنشاء النسخة الاحتياطية'); }); }),
    restore: A(function () { return pick('.lilib,application/zip,application/octet-stream', false).then(function (f) { if (!f[0]) return lib; return JSZip.loadAsync(f[0]).then(function (z) { return z.file('library.json').async('string').then(function (s) { var j = JSON.parse(s), n = 0, chain = Promise.resolve();
      (j.books || []).forEach(function (b) { if (!/^b[0-9a-f]+$/.test(b.id)) return; chain = chain.then(function () { var ex = lib.books.filter(function (x) { return x.hash === b.hash; })[0]; if (ex) { if ((b.lastRead || 0) > (ex.lastRead || 0)) ['progress', 'finished', 'lastRead', 'ext', 'annots', 'audio', 'rating', 'want', 'hidden', 'series', 'readSec'].forEach(function (k) { ex[k] = b[k]; }); return; }
        var ents = z.file(new RegExp('^books/' + b.id + '/')); return Promise.all(ents.map(function (e) { return e.async('blob').then(function (bl) { return fSet(e.name.slice(6), bl); }); })).then(function () { lib.books.push(b); n++; if (b.cover) return fGet(b.id + '/' + b.cover).then(function (bl) { if (bl) setCoverURL(b, bl); }); }); }); });
      return chain.then(function () { (j.collections || []).forEach(function (c) { if (!lib.collections.filter(function (x) { return x.id === c.id; })[0]) lib.collections.push(c); }); if (j.goals && j.goals.days) Object.keys(j.goals.days).forEach(function (d) { lib.goals.days[d] = Math.max(lib.goals.days[d] || 0, j.goals.days[d]); }); return save(true); }).then(function () { toast('تمت الاستعادة: ' + n + ' كتاب جديد'); return lib; }); }); }).catch(function () { toast('ملف النسخة الاحتياطية غير صالح'); return lib; }); }); }),
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
