/* Page reader with the PaddleOCR models, inside the page (Android): ONNX Runtime Web (WebAssembly), no server and no Python.
   PP-OCRv6 small (Latin scripts) + PP-OCRv5 mobile (Arabic). About 44 MB, downloaded once and kept on the phone (Cache Storage).
   window.liPP = { have(), prep(onProgress), page(canvas, lang) -> Promise<markdown>, stop() }                                   */
(function () {
  var HF = 'https://huggingface.co/PaddlePaddle/', VER = 'li-pp-v1';
  var F = {
    det6: ['PP-OCRv6_small_det_onnx', 9880512], rec6: ['PP-OCRv6_small_rec_onnx', 21159378],
    det5: ['PP-OCRv5_mobile_det_onnx', 4826518], recar: ['arabic_PP-OCRv5_mobile_rec_onnx', 7998947]
  };
  var Y = { det6: 'PP-OCRv6_small_det_onnx', rec6: 'PP-OCRv6_small_rec_onnx', det5: 'PP-OCRv5_mobile_det_onnx', recar: 'arabic_PP-OCRv5_mobile_rec_onnx' };
  var SPEC = { pipelines: { latin: { det: 'det6', detYml: 'det6', rec: 'rec6', recYml: 'rec6' }, arabic: { det: 'det5', detYml: 'det5', rec: 'recar', recYml: 'recar', reverse: true } } };
  var ort = null, core = null, reader = null, sessions = {}, confs = {}, charsC = {}, buffers = {}, chain = Promise.resolve();
  function url(k, f) { return HF + F[k][0] + '/resolve/main/' + f; }
  function cache() { return (window.caches && caches.open) ? caches.open(VER) : Promise.reject(new Error('no-cache')); }
  // minimal reader of the parts of a PaddleOCR inference.yml that the reader needs (settings and the character list)
  function parseYml(t) {
    var out = { PostProcess: {} }, lines = String(t).replace(/\r/g, '').split('\n'), inPP = false, inDict = false, P = out.PostProcess;
    var unq = function (v) {
      v = v.trim();
      if (v[0] === "'" && v[v.length - 1] === "'" && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
      if (v[0] === '"' && v[v.length - 1] === '"' && v.length >= 2) { try { return JSON.parse(v); } catch (e) { return v.slice(1, -1); } }
      return v;
    };
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i]; if (!l.trim()) continue;
      if (/^\S/.test(l)) { inPP = /^PostProcess\s*:/.test(l); inDict = false; continue; }
      if (!inPP) continue;
      var m = /^\s+([A-Za-z_]+)\s*:\s*(.*)$/.exec(l);
      if (m && !/^\s*-/.test(l)) {
        inDict = m[1] === 'character_dict'; if (inDict) { P.character_dict = []; continue; }
        var v = m[2].trim(); if (v !== '' && !isNaN(Number(v))) P[m[1]] = Number(v); else if (v !== '') P[m[1]] = unq(v);
        continue;
      }
      if (inDict) { var d = /^[ \t]*- ?(.*)$/.exec(l); if (d) P.character_dict.push(d[1].length && !d[1].trim() ? d[1] : unq(d[1])); }
    }
    return out;
  }
  function fetchTo(k, f, bytes, onP) {
    return cache().then(function (c) {
      var u = url(k, f);
      return c.match(u).then(function (hit) {
        if (hit) return hit.arrayBuffer();
        return fetch(u).then(function (r) {
          if (!r.ok) throw new Error('http ' + r.status);
          var total = Number(r.headers.get('content-length')) || bytes, got = 0, parts = [], rd = r.body && r.body.getReader ? r.body.getReader() : null;
          if (!rd) return r.arrayBuffer();
          var pump = function () { return rd.read().then(function (x) { if (x.done) return; parts.push(x.value); got += x.value.length; if (onP) onP(got, total); return pump(); }); };
          return pump().then(function () {
            var buf = new Uint8Array(got), o = 0; parts.forEach(function (p) { buf.set(p, o); o += p.length; });
            if (bytes && buf.length !== bytes) throw new Error('size ' + buf.length + ' != ' + bytes);
            return c.put(u, new Response(buf.buffer.slice(0), { headers: { 'content-length': String(buf.length) } })).then(function () { return buf.buffer; });
          });
        });
      });
    });
  }
  function have() {
    return cache().then(function (c) {
      return Promise.all(Object.keys(F).reduce(function (a, k) { return a.concat([c.match(url(k, 'inference.onnx')), c.match(url(k, 'inference.yml'))]); }, [])).then(function (r) { return r.every(Boolean); });
    }).catch(function () { return false; });
  }
  function prep(onP) {
    var keys = Object.keys(F), total = keys.reduce(function (s, k) { return s + F[k][1]; }, 0), done = 0;
    var next = function (i) {
      if (i >= keys.length) return Promise.resolve();
      var k = keys[i], base = done;
      return fetchTo(k, 'inference.yml', 0).then(function (t) { confs[k] = parseYml(new TextDecoder().decode(t)); })
        .then(function () { return fetchTo(k, 'inference.onnx', F[k][1], function (g) { if (onP) onP(Math.min(99, Math.round((base + g) / total * 100))); }); })
        .then(function (b) { buffers[k] = b; done += F[k][1]; return next(i + 1); });
    };
    return next(0).then(function () { return init(); });
  }
  function loadScript(src) { return new Promise(function (ok, no) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { no(new Error('script ' + src)); }; document.head.appendChild(s); }); }
  function init() {
    if (reader) return Promise.resolve();
    var base = (window.__ppBase || 'ort/');
    return (window.ort ? Promise.resolve() : loadScript(base + 'ort.wasm.min.js')).then(function () {
      ort = window.ort; ort.env.wasm.wasmPaths = new URL(base, document.baseURI).href; ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
      return import(new URL('pp-core.mjs', document.baseURI).href);
    }).then(function (m) {
      core = m;
      var ensure = function (k) { return buffers[k] ? Promise.resolve() : Promise.all([fetchTo(k, 'inference.onnx', F[k][1]), fetchTo(k, 'inference.yml', 0)]).then(function (r) { buffers[k] = r[0]; confs[k] = parseYml(new TextDecoder().decode(r[1])); }); };
      return Promise.all(Object.keys(F).map(ensure)).then(function () {
        reader = core.makeReader({
          Tensor: ort.Tensor,
          session: function (k) { return sessions[k] || (sessions[k] = ort.InferenceSession.create(buffers[k], { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })); },
          chars: function (k) { return charsC[k] || (charsC[k] = core.charsOf(confs[k])); },
          conf: function (k) { return confs[k].PostProcess || {}; }
        });
      });
    });
  }
  // canvas (any size) -> markdown text, pages one after the other
  function page(cv, lang) {
    var run = function () {
      return init().then(function () {
        var c = cv.getContext('2d'), d = c.getImageData(0, 0, cv.width, cv.height);
        return reader({ w: cv.width, h: cv.height, data: d.data }, lang || 'auto', SPEC);
      }).then(function (r) { return r.md; });
    };
    var p = chain.then(run, run); chain = p.catch(function () {}); return p;
  }
  function stop() { sessions = {}; reader = null; buffers = {}; }
  window.liPP = { have: have, prep: prep, page: page, stop: stop, parseYml: parseYml, _F: F, _Y: Y };
})();
