# Image-processing variants (item 5). Nothing here is allowed to remove dots or marks: no binarisation, no strong blur.
import cv2, json, os, sys, numpy as np
src, out = sys.argv[1], sys.argv[2]
def deskew(g):
    s = cv2.resize(g, None, fx=0.4, fy=0.4, interpolation=cv2.INTER_AREA); ink = (255 - s).astype(np.float32); best, ba = -1, 0
    h, w = ink.shape
    for a in np.arange(-6, 6.01, 0.25):
        M = cv2.getRotationMatrix2D((w / 2, h / 2), a, 1); r = cv2.warpAffine(ink, M, (w, h)); v = np.var(r.sum(1))
        if v > best: best, ba = v, a
    M = cv2.getRotationMatrix2D((g.shape[1] / 2, g.shape[0] / 2), ba, 1)
    return cv2.warpAffine(g, M, (g.shape[1], g.shape[0]), flags=cv2.INTER_CUBIC, borderValue=255), float(ba)
def crop_margins(g):
    m = g < 170; ys, xs = np.where(m)
    if len(ys) < 50: return g
    p = 25; return g[max(0, ys.min() - p):ys.max() + p, max(0, xs.min() - p):xs.max() + p]
def split_cols(g):
    m = (g < 170).sum(0); w = len(m); a, b = int(w * .3), int(w * .7); z = m[a:b] == 0; best = (0, 0); run = 0
    for i, v in enumerate(z):
        run = run + 1 if v else 0
        if run > best[0]: best = (run, i)
    if best[0] >= 24 and m[:a].sum() > 500 and m[b:].sum() > 500:
        cut = a + best[1] - best[0] // 2; return [g[:, cut:], g[:, :cut]], True   # right column first
    return [g], False
V = {}
for f in sorted(os.listdir(src)):
    pid = f[:-4]; g = cv2.imread(f'{src}/{f}', 0); d, ang = deskew(g)
    clahe = cv2.createCLAHE(2.0, (8, 8)).apply(d)
    vs = {'raw': g, 'deskew': d, 'deskew_clahe': clahe, 'deskew_up2': cv2.resize(d, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC),
          'deskew_denoise': cv2.fastNlMeansDenoising(d, None, 7, 7, 21), 'deskew_down': cv2.resize(d, None, fx=.6, fy=.6, interpolation=cv2.INTER_AREA)}
    cols, did = split_cols(crop_margins(d)); vs['cropcols'] = cols
    for k, v in vs.items():
        os.makedirs(f'{out}/{k}', exist_ok=True); L = v if isinstance(v, list) else [v]; fl = []
        for i, im in enumerate(L): p = f'{out}/{k}/{pid}_{i}.png'; cv2.imwrite(p, im); fl.append(p)
        V.setdefault(k, {})[pid] = fl
    print(pid, 'skew', round(ang, 2), 'columns', did)
json.dump(V, open(f'{out}/manifest.json', 'w'))
