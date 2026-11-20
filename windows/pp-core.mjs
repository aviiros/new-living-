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
