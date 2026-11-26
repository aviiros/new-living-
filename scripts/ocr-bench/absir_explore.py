from huggingface_hub import HfApi, hf_hub_download
import json, sys
a = HfApi()
for rid in ['g3ida/absir-arabic-ocr-mini', 'g3ida/absir-arabic-ocr']:
    try:
        i = a.model_info(rid, files_metadata=True); print('==', rid, 'license:', i.card_data.get('license') if i.card_data else None, 'tags:', i.tags[:12], 'gated:', i.gated)
        for s in i.siblings: print('  ', s.rfilename, s.size)
        for f in ['README.md', 'config.json']:
            try: print('---', f); print(open(hf_hub_download(rid, f)).read()[:6000])
            except Exception as e: print('no', f, e)
    except Exception as e: print('ERR', rid, e)
