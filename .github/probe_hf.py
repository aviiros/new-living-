import json, sys, urllib.request
def get(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'LivingIdeas'}), timeout=60))
for r in ['tencent/HY-MT1.5-1.8B-GGUF', 'SalahALHaismawi/Nuqta-Arabic-OCR-0.8B-GGUF']:
    print('===', r)
    try:
        j = get('https://huggingface.co/api/models/%s?blobs=true' % r)
        cd = j.get('cardData') or {}
        print('license', cd.get('license'), cd.get('license_name'), '| langs', cd.get('language'), '| sha', (j.get('sha') or '')[:8])
        for s in j.get('siblings', []):
            if s['rfilename'].endswith('.gguf'):
                print(s['rfilename'], s.get('size'), (s.get('lfs') or {}).get('sha256'))
    except Exception as e:
        print('ERR', e)
for q in ['HY-MT1.5', 'Nuqta', 'Xiaomi-OCR']:
    print('=== search', q)
    try:
        for m in get('https://huggingface.co/api/models?search=%s&filter=gguf&limit=10' % q):
            print(m['id'], m.get('downloads'))
    except Exception as e:
        print('ERR', e)
