/* Arabic word check for scanned pages. The reader sometimes swaps look-alike letters (ب ت ث ن ي, ج ح خ, ...).
   A word that is not in the word list is changed only when exactly ONE single-letter swap gives a known word.
   Word list: Ayaspell Arabic (GPL 2 / LGPL 2.1 / MPL 1.1), stems without marks, ar-words.txt.gz. */
(function (root) {
  var norm = function (w) { return w.replace(/[ً-ٰٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه'); };
  var G = ['بتثني', 'جحخ', 'دذ', 'رز', 'سش', 'صض', 'طظ', 'عغ', 'فق', 'وؤ', 'اله', 'مه'];
  var SW = {}; G.forEach(function (g) { for (var i = 0; i < g.length; i++) SW[g[i]] = g.replace(g[i], ''); });
  var PRE = ['', 'و', 'ف', 'ب', 'ل', 'ك', 'ال', 'وال', 'بال', 'كال', 'فال', 'لل', 'ولل', 'س', 'ي', 'ت', 'ن', 'ا', 'سي', 'ست', 'وي', 'وت', 'ون', 'ول', 'وب', 'فا'];
  var SUF = ['', 'ه', 'ها', 'هم', 'هما', 'هن', 'كم', 'ك', 'نا', 'ني', 'ي', 'ات', 'ون', 'ين', 'ان', 'ا', 'وا', 'ت', 'تم', 'تن', 'ن', 'ما', 'هما', 'ته', 'تها', 'تهم', 'اته', 'اتها', 'اتهم'];
  function make(set) {
    var known = function (w) {
      if (set.has(w)) return true;
      for (var i = 0; i < PRE.length; i++) { var p = PRE[i]; if (p && w.indexOf(p) !== 0) continue; var r = w.slice(p.length);
        for (var j = 0; j < SUF.length; j++) { var s = SUF[j]; if (s && (r.length <= s.length + 1 || r.slice(-s.length) !== s)) continue; var c = s ? r.slice(0, -s.length) : r; if (c.length >= 2 && (set.has(c) || set.has(c + 'ه') || set.has(c + 'ا'))) return true; } }
      return false;
    };
    var word = function (raw) {
      if (/[ً-ٟ]/.test(raw)) return raw;               // marked words are left alone
      var w = norm(raw); if (w.length < 4 || known(w)) return raw;
      var hit = null, n = 0;
      for (var i = 0; i < w.length; i++) { var alt = SW[w[i]]; if (!alt) continue;
        for (var k = 0; k < alt.length; k++) { var c = w.slice(0, i) + alt[k] + w.slice(i + 1); if (known(c)) { if (hit !== c) n++; hit = c; } } }
      if (n !== 1) return raw;
      // apply the swap to the original letters, keeping its own forms (ة ى أ ...)
      for (var x = 0; x < raw.length; x++) { var rn = norm(raw[x]); if (rn !== hit[x] && rn.length === 1) return raw.slice(0, x) + hit[x] + raw.slice(x + 1); }
      return raw;
    };
    return { known: known, fix: function (text) { return String(text).replace(/[ء-ي]+/g, word); } };
  }
  root.liArFixMake = make; root.liArFixNorm = norm;
  var inst = null, pending = null;
  root.liArFix = {
    load: function () {
      if (inst) return Promise.resolve(inst);
      if (pending) return pending;
      pending = fetch(new URL('ar-words.txt.gz', document.baseURI).href).then(function (r) { if (!r.ok) throw new Error('no list'); return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text(); })
        .then(function (t) { inst = make(new Set(t.split('\n'))); return inst; }).catch(function () { pending = null; return null; });
      return pending;
    },
    fix: function (text) { return inst ? inst.fix(text) : text; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
