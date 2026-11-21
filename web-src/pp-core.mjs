// Pure helpers for reading pages with the PaddleOCR models (detector + recognizer) in plain JavaScript:
// image to tensor, text-box finding, CTC decoding, line / paragraph assembly. No Python and no extra runtime.

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

// Bilinear resize of a region of an RGBA image into a CHW float tensor in BGR order (as the models were trained).
// mode 'det': (x/255 - mean) / std     mode 'rec': (x/255 - 0.5) / 0.5
export function toTensor(img, region, dw, dh, mode, out, off, outW) {
  const { w: sw, h: sh, data } = img, [x0, y0, x1, y1] = region || [0, 0, sw, sh];
  const rw = Math.max(1, x1 - x0), rh = Math.max(1, y1 - y0), plane = dh * (outW || dw), W = outW || dw;
  const t = out || new Float32Array(3 * plane), base = off || 0, fx = rw / dw, fy = rh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, y0 + (y + 0.5) * fy - 0.5)), iy = Math.floor(sy), jy = Math.min(sh - 1, iy + 1), wy = sy - iy;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, x0 + (x + 0.5) * fx - 0.5)), ix = Math.floor(sx), jx = Math.min(sw - 1, ix + 1), wx = sx - ix;
      const a = (iy * sw + ix) * 4, b = (iy * sw + jx) * 4, c = (jy * sw + ix) * 4, d = (jy * sw + jx) * 4;
      for (let k = 0; k < 3; k++) { // k = 0 is blue
        const ch = 2 - k, v = (data[a + ch] * (1 - wx) + data[b + ch] * wx) * (1 - wy) + (data[c + ch] * (1 - wx) + data[d + ch] * wx) * wy;
        t[base + k * plane + y * W + x] = mode === 'det' ? (v / 255 - MEAN[k]) / STD[k] : (v / 255 - 0.5) / 0.5;
      }
    }
  }
  return t;
}

// Size for the detector: long side between 960 and 1600, both sides multiples of 32.
export function detSize(w, h, longSide) {
  const m = Math.max(w, h), L = longSide || Math.min(1600, Math.max(960, m)), r = L / m;
  const r32 = (v) => Math.max(32, Math.round(v * r / 32) * 32);
  return { dw: r32(w), dh: r32(h) };
}

// Finds text boxes in the detector's probability map (DB post-processing for upright text: connected areas, score, grow).
export function dbBoxes(prob, dw, dh, o) {
  const thresh = o.thresh || 0.3, boxThresh = o.boxThresh || 0.6, unclip = o.unclip || 1.5, minSide = o.minSide || 3;
  const seen = new Uint8Array(dw * dh), stack = new Int32Array(dw * dh), boxes = [];
  for (let s = 0; s < dw * dh; s++) {
    if (seen[s] || prob[s] <= thresh) continue;
    let sp = 0, n = 0, sum = 0, minx = dw, miny = dh, maxx = 0, maxy = 0; stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const p = stack[--sp], x = p % dw, y = (p - x) / dw; n++; sum += prob[p];
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x > 0 && !seen[p - 1] && prob[p - 1] > thresh) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < dw - 1 && !seen[p + 1] && prob[p + 1] > thresh) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && !seen[p - dw] && prob[p - dw] > thresh) { seen[p - dw] = 1; stack[sp++] = p - dw; }
      if (y < dh - 1 && !seen[p + dw] && prob[p + dw] > thresh) { seen[p + dw] = 1; stack[sp++] = p + dw; }
    }
    const w = maxx - minx + 1, h = maxy - miny + 1;
    if (n < 10 || Math.min(w, h) < minSide || sum / n < boxThresh) continue;
    const d = (w * h * unclip) / (2 * (w + h)); // grow the shrunk text area back to full size
    boxes.push([Math.max(0, minx - d), Math.max(0, miny - d), Math.min(dw, maxx + 1 + d), Math.min(dh, maxy + 1 + d), sum / n]);
    if (boxes.length >= (o.max || 1000)) break;
  }
  return boxes;
}

// Greedy CTC decoding of one sample: data (flat T x C), index 0 is the blank. Returns text in the order the model wrote it.
export function ctcDecode(data, off, T, C, chars) {
  let prev = -1, out = '', sum = 0, n = 0;
  for (let t = 0; t < T; t++) {
    const b = off + t * C; let best = 0, bv = data[b];
    for (let c = 1; c < C; c++) { const v = data[b + c]; if (v > bv) { bv = v; best = c; } }
    if (best !== 0 && best !== prev) { out += chars[best] == null ? '' : chars[best]; sum += bv; n++; }
    prev = best;
  }
  return { text: out, conf: n ? sum / n : 0 };
}

// Arabic models write in visual order (left to right as drawn). This puts it back in reading order (as PaddleOCR does).
export function reverseVisual(s) {
  const parts = []; let cur = '';
  for (const ch of s) {
    if (!/[a-zA-Z0-9 :*./%+-]/.test(ch)) { if (cur) parts.push(cur); parts.push(ch); cur = ''; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.reverse().join('');
}

export const arabicShare = (s) => { const L = (s.match(/\p{L}/gu) || []).length; if (!L) return 0; return (s.match(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g) || []).length / L; };
export const letters = (s) => (s.match(/\p{L}/gu) || []).length;

// Boxes with text -> Markdown. rtl: Arabic reading order (right to left).
// lines are grouped by height, paragraphs by the gap between lines and by the indent of the first line; big short lines become headings.
export function toMarkdown(items, rtl) {
  const it = items.filter((x) => x.text && x.text.trim());
  if (!it.length) return '';
  const hs = it.map((x) => x.box[3] - x.box[1]).sort((a, b) => a - b), medH = hs[Math.floor(hs.length / 2)] || 20;
  it.sort((a, b) => (a.box[1] + a.box[3]) - (b.box[1] + b.box[3]));
  const lines = [];
  for (const x of it) {
    const cy = (x.box[1] + x.box[3]) / 2, L = lines[lines.length - 1];
    if (L && Math.abs(cy - L.cy) < Math.max(x.box[3] - x.box[1], L.h) * 0.5) { L.parts.push(x); L.cy = (L.cy * (L.parts.length - 1) + cy) / L.parts.length; L.h = Math.max(L.h, x.box[3] - x.box[1]); }
    else lines.push({ parts: [x], cy, h: x.box[3] - x.box[1] });
  }
  for (const L of lines) {
    L.parts.sort((a, b) => (rtl ? b.box[0] - a.box[0] : a.box[0] - b.box[0]));
    L.text = L.parts.map((p) => p.text.trim()).join(' ');
    L.x0 = Math.min(...L.parts.map((p) => p.box[0])); L.x1 = Math.max(...L.parts.map((p) => p.box[2]));
    L.top = Math.min(...L.parts.map((p) => p.box[1])); L.bot = Math.max(...L.parts.map((p) => p.box[3]));
  }
  const edge = rtl ? Math.max(...lines.map((l) => l.x1)) : Math.min(...lines.map((l) => l.x0)), paras = []; let cur = null, prev = null;
  for (const L of lines) {
    const big = L.h > medH * 1.45 && L.text.length < 90, gap = prev ? L.top - prev.bot : 0, indent = rtl ? edge - L.x1 : L.x0 - edge;
    const newPara = !cur || big || cur.head || gap > medH * 0.9 || indent > medH * 1.3;
    if (newPara) { cur = { head: big, text: L.text }; paras.push(cur); }
    else cur.text = /[-­]$/.test(cur.text) && !rtl ? cur.text.slice(0, -1) + L.text : cur.text + ' ' + L.text;
    prev = L;
  }
  return paras.map((p) => (p.head ? '## ' : '') + p.text).join('\n\n');
}

// ---- The whole page reader, shared by the Windows reader process and the in-page reader (Android):
// env = { Tensor, session(key) -> Promise<InferenceSession>, chars(key) -> [string], conf(key) -> PostProcess settings }
// spec.pipelines = { latin|arabic: { det, detYml, rec, recYml, reverse } } (keys name the files)
export function makeReader(env) {
  async function detect(img, P) {
    const post = env.conf(P.detYml) || {}, { dw, dh } = detSize(img.w, img.h), s = await env.session(P.det);
    const x = new env.Tensor('float32', toTensor(img, null, dw, dh, 'det'), [1, 3, dh, dw]);
    const out = await s.run({ [s.inputNames[0]]: x }), prob = out[s.outputNames[0]].data;
    const bx = dbBoxes(prob, dw, dh, { thresh: post.thresh, boxThresh: post.box_thresh, unclip: post.unclip_ratio, max: post.max_candidates });
    const fx = img.w / dw, fy = img.h / dh;
    return bx.map((b) => [Math.max(0, Math.floor(b[0] * fx)), Math.max(0, Math.floor(b[1] * fy)), Math.min(img.w, Math.ceil(b[2] * fx)), Math.min(img.h, Math.ceil(b[3] * fy))]).filter((b) => b[2] - b[0] > 4 && b[3] - b[1] > 4);
  }
  async function recognize(img, boxes, recKey, ymlKey, reverse) {
    const s = await env.session(recKey), ch = env.chars(ymlKey), H = 48, res = new Array(boxes.length);
    const order = boxes.map((b, i) => i).sort((a, b) => (boxes[a][2] - boxes[a][0]) / (boxes[a][3] - boxes[a][1]) - (boxes[b][2] - boxes[b][0]) / (boxes[b][3] - boxes[b][1]));
    for (let i = 0; i < order.length; i += 6) {
      const grp = order.slice(i, i + 6), ratios = grp.map((k) => (boxes[k][2] - boxes[k][0]) / (boxes[k][3] - boxes[k][1]));
      const W = Math.min(3200, Math.max(320, Math.ceil(H * Math.max(...ratios)))), data = new Float32Array(grp.length * 3 * H * W);
      grp.forEach((k, j) => { const w = Math.min(W, Math.max(8, Math.ceil(H * ratios[j]))); toTensor(img, boxes[k], w, H, 'rec', data, j * 3 * H * W, W); });
      const out = await s.run({ [s.inputNames[0]]: new env.Tensor('float32', data, [grp.length, 3, H, W]) }), o = out[s.outputNames[0]], [B, T, Cn] = o.dims;
      grp.forEach((k, j) => { const r = ctcDecode(o.data, j * T * Cn, T, Cn, ch); res[k] = { text: reverse ? reverseVisual(r.text) : r.text, conf: r.conf }; });
    }
    return res;
  }
  // img = { w, h, data (RGBA) }; lang = auto | ar | latin
  return async function readPage(img, lang, spec) {
    const t0 = Date.now(), A = spec.pipelines.arabic, L = spec.pipelines.latin;
    let script = lang === 'ar' ? 'arabic' : (lang === 'latin' ? 'latin' : 'auto'), items = [];
    const run = async (P, rev) => { const boxes = await detect(img, P), rs = await recognize(img, boxes, P.rec, P.recYml, rev); return boxes.map((b, i) => ({ box: b, text: rs[i].text, conf: rs[i].conf })); };
    if (script === 'latin') items = await run(L, false);
    else {
      items = await run(A, A.reverse !== false);
      const all = items.map((x) => x.text).join(' '), share = arabicShare(all);
      if (script === 'auto') {
        if (letters(all) >= 8 && share < 0.1) { items = await run(L, false); script = 'latin'; }
        else {
          script = 'arabic';
          const idx = items.map((x, i) => i).filter((i) => letters(items[i].text) >= 3 && arabicShare(items[i].text) < 0.3);
          if (idx.length) { const rs = await recognize(img, idx.map((i) => items[i].box), L.rec, L.recYml, false); idx.forEach((i, j) => { if (rs[j].conf >= items[i].conf - 0.02) items[i] = Object.assign(items[i], rs[j]); }); }
        }
      } else script = 'arabic';
    }
    items = items.filter((x) => x.conf >= 0.3 && x.text.trim());
    return { md: toMarkdown(items, script === 'arabic'), lines: items.length, script, ms: Date.now() - t0 };
  };
}
// dictionary of a recognizer from its settings: blank first, space last
export const charsOf = (conf) => [''].concat(((conf.PostProcess || {}).character_dict || []).map(String), [' ']);
