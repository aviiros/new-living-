import json, glob, os, re, sys
d, outf, ver = sys.argv[1:4]
def tm(p):
    t = open(p).read(); w = re.search(r'Elapsed \(wall clock\) time.*?: ([\d:.]+)', t).group(1); parts = [float(x) for x in w.split(':')]
    return dict(wall=sum(v * 60 ** i for i, v in enumerate(reversed(parts))), rssMB=int(re.search(r'Maximum resident set size \(kbytes\): (\d+)', t).group(1)) // 1024,
                cpu=float(re.search(r'User time \(seconds\): ([\d.]+)', t).group(1)) + float(re.search(r'System time \(seconds\): ([\d.]+)', t).group(1)), exit=int(re.search(r'Exit status: (\d+)', t).group(1)))
base = tm(d + '/time_blank.txt') if os.path.exists(d + '/time_blank.txt') else dict(wall=0)
res, mem, cpu = {}, 0, 0
for tf in sorted(glob.glob(d + '/time_*.txt')):
    pid = os.path.basename(tf)[5:-4]
    if pid == 'blank': continue
    t = tm(tf); fs = glob.glob(f'{d}/res_{pid}/**/results.json', recursive=True)
    if t['exit'] != 0 or not fs: res[pid] = dict(text='', sec=t['wall'], error='exit %d' % t['exit'], lines=0); continue
    R = json.load(open(fs[0])); print('STRUCT', pid, json.dumps(R, ensure_ascii=False)[:500])
    def walk(o, acc):
        if isinstance(o, dict):
            if isinstance(o.get('text'), str): acc.append(dict(text=o['text']))
            else:
                for v in o.values(): walk(v, acc)
        elif isinstance(o, list):
            for v in o: walk(v, acc)
        return acc
    lines = walk(R, [])
    res[re.sub(r'_\d+$', '', pid)] = dict(text=re.sub(r'<[^>]+>', '', '\n'.join(l.get('text', '') for l in lines)), sec=max(0.1, t['wall'] - base['wall']), sec_with_load=t['wall'], lines=len(lines))
    mem, cpu = max(mem, t['rssMB']), cpu + t['cpu']
ver_txt = open(d + '/version.txt').read().split('\n')
json.dump({'raw': res, '_meta': dict(engine='surya', pip=ver, version=ver_txt[1] if len(ver_txt) > 1 else '', model_load_sec=base['wall'], load_rssMB=base.get('rssMB'), maxRssMB=mem, pages=len(res))}, open(outf, 'w'), ensure_ascii=False)

for k,v in res.items(): print(k, v.get('sec'), v.get('lines'), v.get('error'), repr(v['text'][:150]))
print(open(outf).read()[-400:])
