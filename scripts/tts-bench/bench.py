#!/usr/bin/env python3
"""Offline voice benchmark: one sentence per app language, several open voices each.
Writes WAV files + results.md (model, size, license note, real-time factor). Run in CI (needs pip sherpa-onnx)."""
import os, re, sys, json, time, wave, tarfile, urllib.request, glob, traceback
import numpy as np
import sherpa_onnx

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
os.makedirs(OUT, exist_ok=True)
CACHE = 'models'; os.makedirs(CACHE, exist_ok=True)
TOK = os.environ.get('GITHUB_TOKEN', '')

TEXT = {
 'ar': 'مرحبا بكم في الكتاب. العلم نور والجهل ظلام، والقراءة طريق إلى المعرفة. سنقرأ لكم هذه الصفحة بصوت واضح.',
 'ar-tashkeel': 'مَرْحَبًا بِكُمْ فِي الْكِتَابِ. الْعِلْمُ نُورٌ وَالْجَهْلُ ظَلَامٌ، وَالْقِرَاءَةُ طَرِيقٌ إِلَى الْمَعْرِفَةِ. سَنَقْرَأُ لَكُمْ هَذِهِ الصَّفْحَةَ بِصَوْتٍ وَاضِحٍ.',
 'en': 'Welcome to the book. Knowledge is light and ignorance is darkness. Reading is a path to understanding, and we will read this page aloud for you in a clear voice.',
 'fr': 'Bienvenue dans ce livre. La connaissance est une lumière et l’ignorance une obscurité. Lire est un chemin vers la compréhension, et nous allons vous lire cette page à voix haute.',
 'es': 'Bienvenido a este libro. El conocimiento es luz y la ignorancia es oscuridad. Leer es un camino hacia la comprensión, y le leeremos esta página en voz alta.',
 'it': 'Benvenuti in questo libro. La conoscenza è luce e l’ignoranza è oscurità. Leggere è un cammino verso la comprensione, e leggeremo questa pagina ad alta voce per voi.',
 'id': 'Selamat datang di buku ini. Pengetahuan adalah cahaya dan kebodohan adalah kegelapan. Membaca adalah jalan menuju pemahaman, dan kami akan membacakan halaman ini dengan suara yang jelas.',
}
# language -> [(regex on asset name, license note)]
WANT = {
 'ar': [(r'^vits-piper-ar_JO-kareem', 'Piper voice (check dataset licence)'), (r'^vits-mms-ara', 'Meta MMS, CC-BY-NC (non-commercial)')],
 'en': [(r'^vits-piper-en_US-lessac-medium', 'Piper'), (r'^vits-piper-en_US-libritts_r-medium', 'Piper'), (r'^kokoro-en-v0_19', 'Kokoro, Apache-2.0')],
 'fr': [(r'^vits-piper-fr_FR-siwis-medium', 'Piper'), (r'^vits-piper-fr_FR-upmc-medium', 'Piper'), (r'^vits-piper-fr_FR-tom', 'Piper')],
 'es': [(r'^vits-piper-es_ES-davefx-medium', 'Piper'), (r'^vits-piper-es_ES-sharvard-medium', 'Piper'), (r'^vits-piper-es_MX-claude-high', 'Piper')],
 'it': [(r'^vits-piper-it_IT-paola-medium', 'Piper'), (r'^vits-piper-it_IT-riccardo', 'Piper')],
 'id': [(r'^vits-piper-id_ID-news_tts-medium', 'Piper'), (r'^vits-mms-ind', 'Meta MMS, CC-BY-NC (non-commercial)')],
}

def api(url):
    req = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json', **({'Authorization': 'Bearer ' + TOK} if TOK else {})})
    return json.load(urllib.request.urlopen(req, timeout=60))

def assets():
    rel = api('https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/tts-models')
    out, page = [], 1
    while True:
        a = api('https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/%d/assets?per_page=100&page=%d' % (rel['id'], page))
        if not a: break
        out += a; page += 1
    return out

def fetch(a):
    d = os.path.join(CACHE, a['name'].replace('.tar.bz2', ''))
    if not os.path.isdir(d):
        p = os.path.join(CACHE, a['name'])
        urllib.request.urlretrieve(a['browser_download_url'], p)
        with tarfile.open(p, 'r:bz2') as t: t.extractall(CACHE)
        os.remove(p)
    return d

def pick(d, pat):
    f = sorted(glob.glob(os.path.join(d, pat)))
    return f[0] if f else ''

def build(d, name, threads):
    model = [m for m in sorted(glob.glob(os.path.join(d, '*.onnx'))) if 'int8' not in m] or sorted(glob.glob(os.path.join(d, '*.onnx')))
    model = model[0]; tokens = pick(d, 'tokens.txt'); data = os.path.join(d, 'espeak-ng-data'); data = data if os.path.isdir(data) else ''
    if name.startswith('kokoro'):
        k = sherpa_onnx.OfflineTtsKokoroModelConfig(model=model, voices=pick(d, 'voices.bin'), tokens=tokens, data_dir=data)
        m = sherpa_onnx.OfflineTtsModelConfig(kokoro=k, num_threads=threads, provider='cpu')
    else:
        v = sherpa_onnx.OfflineTtsVitsModelConfig(model=model, tokens=tokens, data_dir=data, lexicon=pick(d, 'lexicon.txt'))
        m = sherpa_onnx.OfflineTtsModelConfig(vits=v, num_threads=threads, provider='cpu')
    return sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=m)), os.path.getsize(model)

def wav(path, s, sr):
    s = np.clip(np.asarray(s, dtype=np.float32), -1, 1)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((s * 32767).astype('<i2').tobytes())

rows = []
al = assets()
print('assets:', len(al))
open(os.path.join(OUT, 'assets-matching.txt'), 'w').write('\n'.join(sorted(a['name'] + ' ' + str(a['size']) for a in al if re.search(r'ar_|-ara|fr_FR|es_|it_IT|id_ID|-ind|kokoro|lessac|matcha|zipvoice|pocket', a['name']))))
for lang, wants in WANT.items():
    for rx, note in wants:
        for a in [x for x in al if re.search(rx, x['name']) and x['name'].endswith('.tar.bz2')][:2]:
            name = a['name'].replace('.tar.bz2', '')
            try:
                d = fetch(a)
                texts = [(lang, TEXT[lang])] + ([('ar-tashkeel', TEXT['ar-tashkeel'])] if lang == 'ar' else [])
                for tl, txt in texts:
                    for threads in (1, 2):
                        tts, msize = build(d, name, threads)
                        t0 = time.time(); g = tts.generate(txt, sid=0, speed=1.0); dt = time.time() - t0
                        dur = len(g.samples) / g.sample_rate
                        if threads == 1: wav(os.path.join(OUT, '%s__%s.wav' % (tl, name)), g.samples, g.sample_rate)
                        rows.append((tl, name, note, round(a['size'] / 1e6), threads, round(dur, 1), round(dt, 2), round(dt / max(dur, .01), 2)))
                        print(rows[-1], flush=True)
            except Exception as e:
                traceback.print_exc(); rows.append((lang, name, note, round(a['size'] / 1e6), 0, 0, 0, 'ERROR ' + str(e)[:80]))
with open(os.path.join(OUT, 'results.md'), 'w') as f:
    f.write('| text | voice | note | download MB | threads | audio s | time s | RTF (lower is faster; <1 = faster than speech) |\n|---|---|---|---|---|---|---|---|\n')
    for r in rows: f.write('| ' + ' | '.join(map(str, r)) + ' |\n')
print(open(os.path.join(OUT, 'results.md')).read())
