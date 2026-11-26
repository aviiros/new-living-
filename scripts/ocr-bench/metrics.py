import json, os, re, sys, unicodedata, glob
from rapidfuzz import fuzz
from rapidfuzz.distance import Levenshtein as L
MARK = re.compile('[ً-ٰٟـ]')
FAM = {}
for g in ['بتثنيئى', 'جحخ', 'دذ', 'رز', 'سش', 'صض', 'طظ', 'عغ', 'فق', 'هة']:
    for ch in g: FAM[ch] = g[0]
def norm(s, keep=False):
    s = unicodedata.normalize('NFKC', s); s = re.sub(r'[#*_`>|\\]', '', s).replace('<br>', ' ')
    s = s.translate(str.maketrans('٠١٢٣٤٥٦٧٨٩٪٬٫', '0123456789%,.'))
    if not keep: s = MARK.sub('', s)
    s = re.sub(r'[‎‏‪-‮⁦-⁩]', '', s); return re.sub(r'\s+', '', s)
def words(s): return [w for w in re.sub(r'[^\w@.%,]', ' ', MARK.sub('', unicodedata.normalize('NFKC', s)).translate(str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789'))).split() if w]
def cer(r, h, keep=False):
    r, h = norm(r, keep), norm(h, keep); return L.distance(r, h) / max(1, len(r)) * 100
def wer(r, h): r, h = words(r), words(h); return L.distance(r, h) / max(1, len(r)) * 100
def dots(r, h):
    r, h = norm(r), norm(h); d = o = 0
    for op in L.opcodes(r, h):
        if op.tag == 'replace' and op.src_end - op.src_start == op.dest_end - op.dest_start:
            for a, b in zip(r[op.src_start:op.src_end], h[op.dest_start:op.dest_end]):
                if a != b: (d := d + 1) if (a in FAM and FAM.get(a) == FAM.get(b)) else (o := o + 1)
    return d, o
def order_missing(lines, hyp):
    H = norm(hyp); pos = []; miss = 0
    for l in lines:
        n = norm(l)
        if not n: continue
        a = fuzz.partial_ratio_alignment(n, H)
        if a is None or a.score < 62: miss += 1; continue
        pos.append(a.dest_start)
    ok = tot = 0
    for i in range(len(pos)):
        for j in range(i + 1, len(pos)): tot += 1; ok += pos[i] < pos[j]
    return (ok / tot * 100 if tot else 100.0), miss
def line_cer(line, hyp):
    n, H = norm(line), norm(hyp); a = fuzz.partial_ratio_alignment(n, H)
    if not a: return 100.0
    return L.distance(n, H[a.dest_start:a.dest_end]) / max(1, len(n)) * 100
def missing_words(ref, hyp):
    from collections import Counter
    r, h = Counter(words(ref)), Counter(words(hyp)); return sum((r - h).values()), sum(r.values())
def score(gt, text):
    ref = ' '.join(gt['lines']); o, miss = order_missing(gt['lines'], text); d, other = dots(ref, text); mw, nw = missing_words(ref, text)
    r = dict(cer=cer(ref, text), wer=wer(ref, text), order=o, missing_lines=miss, lines=len(gt['lines']), dot_err=d, letter_err=other, missing_words=mw, words=nw)
    if gt['kind'] == 'tashkeel': r['cer_marks'] = cer(ref, text, True)
    if gt.get('heading'): r['heading_cer'] = line_cer(gt['heading'], text)
    if gt.get('cells'):
        from collections import Counter
        hw = Counter(words(text)); r['table_cells'] = sum(1 for c in gt['cells'] if hw[c] > 0 or norm(c) in norm(text)) / len(gt['cells']) * 100
    if gt.get('latin'):
        r['latin_ok'] = sum(1 for t in gt['latin'] if t.lower() in text.lower()) / len(gt['latin']) * 100
    return r
if __name__ == '__main__':
    pages, resdir, outp = sys.argv[1:4]
    GT = {os.path.basename(f)[:-5]: json.load(open(f)) for f in glob.glob(pages + '/gt/*.json')}
    rows = []; meta = {}
    for rf in sorted(glob.glob(resdir + '/*.json')):
        name = os.path.basename(rf)[:-5]; R = json.load(open(rf)); meta[name] = R.pop('_meta', {})
        for var, pg in R.items():
            for pid, v in pg.items():
                if pid in GT and isinstance(v, dict) and 'text' in v: rows.append(dict(engine=name, variant=var, page=pid, sec=v.get('sec'), **score(GT[pid], v['text'])))
    json.dump(dict(rows=rows, meta=meta), open(outp + '.json', 'w'), ensure_ascii=False, indent=1)
    import collections
    agg = collections.defaultdict(list)
    for r in rows: agg[(r['engine'], r['variant'])].append(r)
    mean = lambda L_, k: sum(x[k] for x in L_ if x.get(k) is not None) / max(1, len([x for x in L_ if x.get(k) is not None]))
    out = ['# OCR comparison (drawn Arabic book pages, exact ground truth)\n', '| engine | image variant | CER% | WER% | reading order% | missing lines | dot errs | other letter errs | sec/page |', '|---|---|---|---|---|---|---|---|---|']
    for (e, v), L_ in sorted(agg.items()):
        out.append(f"| {e} | {v} | {mean(L_,'cer'):.1f} | {mean(L_,'wer'):.1f} | {mean(L_,'order'):.0f} | {sum(x['missing_lines'] for x in L_)}/{sum(x['lines'] for x in L_)} | {sum(x['dot_err'] for x in L_)} | {sum(x['letter_err'] for x in L_)} | {mean(L_,'sec'):.1f} |")
    out += ['', '## Per page (CER% / WER% / order%)', '']
    pages_ = sorted({r['page'] for r in rows}); keys = sorted(agg)
    out.append('| page | ' + ' | '.join(f'{e}/{v}' for e, v in keys) + ' |'); out.append('|---|' + '---|' * len(keys))
    for p in pages_:
        cells = []
        for k in keys:
            m = [x for x in agg[k] if x['page'] == p]; cells.append(f"{m[0]['cer']:.1f} / {m[0]['wer']:.0f} / {m[0]['order']:.0f}" if m else '-')
        out.append(f'| {p} | ' + ' | '.join(cells) + ' |')
    out += ['', '## Special measures', '']
    for r in rows:
        if r['variant'] in ('raw', 'deskew') and any(k in r for k in ('cer_marks', 'table_cells', 'latin_ok', 'heading_cer')):
            out.append(f"- {r['engine']}/{r['variant']}/{r['page']}: " + ', '.join(f'{k}={r[k]:.1f}' for k in ('cer_marks', 'table_cells', 'latin_ok', 'heading_cer') if k in r))
    out += ['', '## Resources', '', json.dumps(meta, ensure_ascii=False, indent=1)]
    open(outp + '.md', 'w').write('\n'.join(out)); print('\n'.join(out))
