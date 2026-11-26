# Absir Arabic OCR Mini 0.7B on CPU (2 cores), prompt/decoding exactly as in its model card. Pages saved as they finish.
import sys, os, time, json, resource, re, threading
import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor
imgdir, outf = sys.argv[1:3]; torch.set_num_threads(2)
repo = 'g3ida/absir-arabic-ocr-mini'; MAXT = float(os.environ.get('PAGE_MAXSEC', 900)); NEW = int(os.environ.get('NEW_TOKENS', 4096))
t0 = time.time(); model = AutoModel.from_pretrained(repo, trust_remote_code=True, dtype=torch.float32).eval(); proc = AutoProcessor.from_pretrained(repo, trust_remote_code=True)
load = time.time() - t0; rss = lambda: resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
print('loaded', load, 'rssMB', rss(), flush=True)
PROMPT = '</s><s><no_bbox><no_classes><output_markdown><predict_no_text_in_pic>'
def enlarge(im):
    s = min(1664 / im.width, 2048 / im.height); return im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS) if s > 1 else im
res = {}; meta = dict(engine='absir-mini', model_load_sec=load, load_rssMB=rss())
for f in sorted(os.listdir(imgdir)):
    if not f.endswith('_0.png'): continue
    pid = f[:-6]; im = enlarge(Image.open(f'{imgdir}/{f}').convert('RGB')); t = time.time()
    try:
        inp = proc(images=[im], text=PROMPT, return_tensors='pt', add_special_tokens=False)
        with torch.inference_mode(): out = model.generate(**inp, max_new_tokens=NEW, do_sample=False, repetition_penalty=1.0, max_time=MAXT)
        txt = proc.batch_decode(out, skip_special_tokens=True)[0]; ntok = int(out.shape[-1])
    except Exception as e: txt, ntok = '', 0; print('ERR', pid, repr(e)[:400], flush=True); res[pid] = dict(text='', sec=time.time() - t, error=repr(e)[:300]); continue
    sec = time.time() - t; res[pid] = dict(text=re.sub(r'<[^>]+>', ' ', txt), html=txt[:3000], sec=sec, tokens=ntok, hit_time_cap=sec >= MAXT - 2)
    meta.update(maxRssMB=rss(), cpuSec=time.process_time()); print(pid, round(sec), 's', ntok, 'tok', flush=True)
    json.dump({'raw': res, '_meta': meta}, open(outf, 'w'), ensure_ascii=False)
json.dump({'raw': res, '_meta': meta}, open(outf, 'w'), ensure_ascii=False)
