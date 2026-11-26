import json, glob, os, re, sys
d, outf = sys.argv[1:3]
def tm(p):
    t = open(p).read(); g = lambda k: re.search(k + r'.*?:\s*([\d:.]+)', t).group(1)
    w = g('Elapsed \\(wall clock\\) time'); parts = [float(x) for x in w.split(':')]; sec = sum(v * 60 ** i for i, v in enumerate(reversed(parts)))
    return dict(wall=sec, rssMB=int(re.search(r'Maximum resident set size \(kbytes\): (\d+)', t).group(1)) // 1024, cpu=float(g('User time \\(seconds\\)')) + float(g('System time \\(seconds\\)')))
one, allt = tm(d + '/time_one.txt'), tm(d + '/time_all.txt'); res = {}
files = glob.glob(d + '/all/**/results.json', recursive=True); print(files)
R = json.load(open(files[0]))
n = len(R)
for k, pages in R.items():
    pg = pages[0] if isinstance(pages, list) else pages
    txt = '\n'.join(l['text'] for l in pg.get('text_lines', []))
    pid = re.sub(r'_\d+$', '', os.path.splitext(os.path.basename(k))[0])
    res[pid] = dict(text=re.sub(r'<[^>]+>', '', txt), sec=max(0.1, (allt['wall'] - one['wall']) / max(1, n - 1)), lines=len(pg.get('text_lines', [])))
version = open(d + '/version.txt').read().split('\n')[1] if os.path.exists(d + '/version.txt') else ''
json.dump({'raw': res, '_meta': dict(engine='surya', version=version, one_page_total_sec=one['wall'], all_total_sec=allt['wall'], maxRssMB=allt['rssMB'], cpuSec=allt['cpu'], cpu_util_pct=round(allt['cpu'] / allt['wall'] * 100), pages=n)}, open(outf, 'w'), ensure_ascii=False)
