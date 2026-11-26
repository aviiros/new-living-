# Draws Arabic book-like test pages with an exact ground truth (every line, in reading order).
# These are DRAWN pages (real fonts, real shaping), not scans of printed books: they test the engines fairly
# and repeatably, but real scans are harder. The report says so.
import json, os, sys, random, subprocess
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np
out = sys.argv[1]; os.makedirs(out + '/raw', exist_ok=True); os.makedirs(out + '/gt', exist_ok=True)
def font(name_pats, size):
    for p in name_pats:
        r = subprocess.run(['fc-match', '-f', '%{file}', p], capture_output=True, text=True).stdout
        if r and os.path.exists(r) and p.split(':')[0].lower().replace(' ', '') in r.lower().replace(' ', '').replace('-', ''):
            return ImageFont.truetype(r, size, layout_engine=ImageFont.Layout.RAQM)
    for r in ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']:
        if os.path.exists(r): print('FALLBACK FONT', file=sys.stderr); return ImageFont.truetype(r, size, layout_engine=ImageFont.Layout.RAQM)
NASKH = ['Noto Naskh Arabic', 'Noto Sans Arabic'] ; AMIRI = ['Amiri']
W, H, M = 1240, 1754, 110
def W_(f, t): return f.getlength(t, direction='rtl', language='ar')
def line(d, f, t, xr, y, fill=0): d.text((xr - W_(f, t), y), t, font=f, fill=fill, direction='rtl', language='ar')
def page(): im = Image.new('L', (W, H), 255); return im, ImageDraw.Draw(im)
def fit(f_pats, size, lines, maxw):
    f = font(f_pats, size)
    while max(W_(f, t) for t in lines) > maxw and size > 18: size -= 1; f = font(f_pats, size)
    return f, size
def body(d, lines, pats, size, y, xr=W - M, gap=1.85, maxw=W - 2 * M):
    f, size = fit(pats, size, lines, maxw)
    for t in lines: line(d, f, t, xr, y); y += int(size * gap)
    return y, f
def save(im, pid, kind, lines, **kw):
    im.save(f'{out}/raw/{pid}.png'); json.dump(dict(kind=kind, lines=lines, **kw), open(f'{out}/gt/{pid}.json', 'w'), ensure_ascii=False)
def degrade(im, seed, ang=2.5, scale=0.6, q=32):
    rnd = np.random.RandomState(seed)
    im = im.rotate(ang, resample=Image.BICUBIC, fillcolor=255).filter(ImageFilter.GaussianBlur(0.9))
    im = im.resize((int(W * scale), int(H * scale)), Image.BILINEAR).resize((W, H), Image.BILINEAR)
    a = np.asarray(im, dtype=np.float32); yy, xx = np.mgrid[0:H, 0:W]
    a = a * (0.80 + 0.2 * (xx / W)) + rnd.normal(0, 9, a.shape)
    im = Image.fromarray(np.clip(a, 0, 255).astype('uint8'))
    import io; b = io.BytesIO(); im.save(b, 'JPEG', quality=q); return Image.open(io.BytesIO(b.getvalue())).convert('L')

HEAD = 'أثر القراءة في بناء الإنسان'
P1 = ['القراءة هي الباب الأول إلى المعرفة، ومن خلالها يتعرف الإنسان', 'على تجارب الآخرين ويوسع مداركه ويتعلم كيف يرى العالم من', 'زوايا مختلفة. وقد أثبتت الدراسات الحديثة أن الذين يقرؤون', 'بانتظام يتمتعون بقدرة أكبر على التركيز وفهم النصوص المعقدة.']
P2 = ['وفي عصر السرعة أصبح الكتاب الورقي رفيقًا هادئًا يمنح القارئ', 'فرصة للتأمل بعيدًا عن ضجيج الشاشات، ويعيد إليه متعة الصبر', 'والتدرج في اكتساب الفكرة حتى تنضج وتستقر في الذهن.']
P3 = ['ولذلك ينصح المربون بتخصيص وقت ثابت كل يوم للقراءة، ولو كان', 'قصيرًا، فإن المداومة على العادة الصغيرة تصنع بعد سنة فرقًا', 'كبيرًا في اللغة والتفكير وطريقة التعبير عن الأفكار.']
def modern(pid, deg=None):
    im, d = page(); fh = font(NASKH, 46); line(d, fh, HEAD, W - M, 130, 0)
    y = 260; allv = [HEAD]
    for p in (P1, P2, P3): y, _ = body(d, p, NASKH, 33, y); y += 50; allv += p
    if deg: im = degrade(im, deg[0], *deg[1:])
    save(im, pid, 'modern', allv, heading=HEAD)
modern('modern_clean'); modern('modern_lowq_skew', (1, 2.5, 0.55, 30))
CL = ['باب في فضل العلم', 'قال بعض الحكماء: العلم خير من المال، لأن العلم يحرسك وأنت', 'تحرس المال، والمال تنقصه النفقة والعلم يزكو على الإنفاق.', 'وقيل لأعرابي: ما أحسن ما رأيت؟ فقال: رجلًا عالمًا يجلس', 'إليه الناس ويسألونه فيجيبهم بغير ملل ولا ضجر، فكأنه', 'بحر لا ينقص بكثرة الواردين، وغيث يعم الأرض فتخضر.', 'ومن لم يصبر على ذل التعلم ساعة، تجرع كأس الجهل أبد', 'الدهر، فاطلبوا العلم من المهد إلى اللحد ولا تملوا.', 'وكان الخليل بن أحمد إذا سئل عن مسألة أطرق مليًا ثم', 'أجاب بما يشفي، وكان يقول: ما سمعت شيئًا إلا كتبته،', 'ولا كتبته إلا حفظته، ولا حفظته إلا انتفعت به.']
def classical(pid, deg=None):
    im, d = page(); f = font(AMIRI, 50); line(d, f, CL[0], W - M, 130)
    body(d, CL[1:], AMIRI, 38, 280, gap=1.9)
    if deg: im = degrade(im, deg[0], *deg[1:])
    save(im, pid, 'classical', CL, heading=CL[0])
classical('classical_clean'); classical('classical_lowq', (2, -1.8, 0.6, 35))
TS = ['الْعِلْمُ نُورٌ يَهْدِي صَاحِبَهُ إِلَى سَوَاءِ السَّبِيلِ،', 'وَالْجَهْلُ ظَلَامٌ يَحْجُبُ عَنِ الْإِنْسَانِ طَرِيقَهُ.', 'قَالَ الشَّاعِرُ: تَعَلَّمْ فَلَيْسَ الْمَرْءُ يُولَدُ عَالِمًا،', 'وَلَيْسَ أَخُو عِلْمٍ كَمَنْ هُوَ جَاهِلُ.', 'وَإِنَّ كَبِيرَ الْقَوْمِ لَا عِلْمَ عِنْدَهُ،', 'صَغِيرٌ إِذَا الْتَفَّتْ عَلَيْهِ الْمَحَافِلُ.']
im, d = page(); body(d, TS, AMIRI, 46, 200, gap=2.1); save(im, 'tashkeel', 'tashkeel', TS)
MX = ['يعمل مهندسو شركة Google على تطوير نظام Android الجديد منذ عام 2023،', 'وقد أعلنوا أن الإصدار 15 سيدعم تقنية Artificial Intelligence بشكل أوسع.', 'ويمكنك زيارة الموقع www.example.com للحصول على مزيد من المعلومات،', 'أو مراسلتنا عبر البريد support@example.com خلال ساعات العمل.', 'وبلغت المبيعات 1,250 وحدة في الربع الأول، بزيادة قدرها 18% عن العام الماضي.']
im, d = page(); body(d, MX, NASKH, 32, 200); save(im, 'mixed_english', 'mixed', MX, latin=['Google', 'Android', 'Artificial', 'Intelligence', 'www.example.com', 'support@example.com', '2023', '1,250', '15', '18%'])
# table: heading + grid, cells read right to left, row by row
TH = 'جدول المبيعات'; ROWS = [['المنتج', 'الكمية', 'السعر'], ['كتاب', '12', '45'], ['قلم', '30', '7'], ['دفتر', '18', '15'], ['حقيبة', '5', '120']]
im, d = page(); fh = font(NASKH, 44); line(d, fh, TH, W - M, 140); f = font(NASKH, 34)
cw, rh, x0, y0 = 300, 90, W - M - 3 * 300, 260
for r in range(len(ROWS) + 1): d.line([(x0, y0 + r * rh), (x0 + 3 * cw, y0 + r * rh)], fill=0, width=2)
for c in range(4): d.line([(x0 + c * cw, y0), (x0 + c * cw, y0 + len(ROWS) * rh)], fill=0, width=2)
for r, row in enumerate(ROWS):
    for c, t in enumerate(row): xr = x0 + 3 * cw - c * cw; w = W_(f, t); d.text((xr - (cw + w) / 2, y0 + r * rh + 22), t, font=f, fill=0, direction='rtl', language='ar')
save(im, 'table', 'table', [TH] + [' '.join(r) for r in ROWS], heading=TH, cells=[c for r in ROWS for c in r])
FB = ['ويرى بعض الباحثين أن نشأة الوراقة في بغداد كانت سببًا مباشرًا(1)', 'في ازدهار حركة التأليف، إذ توافر الورق وتكاثر النساخون(2)', 'حتى صارت المكتبات تضاهي دور الحكمة في سعتها وتنوعها.']
FN = ['(1) انظر: ابن النديم، الفهرست، تحقيق رضا تجدد، ص 45.', '(2) راجع: القلقشندي، صبح الأعشى، ج 2، ص 475.']
im, d = page(); y, _ = body(d, FB, AMIRI, 40, 300, gap=2.0); d.line([(W - M - 300, 1300), (W - M, 1300)], fill=0, width=2); body(d, FN, NASKH, 24, 1330, gap=1.9)
save(im, 'footnotes', 'footnotes', FB + FN)
CR = ['في بدايات القرن الماضي', 'ظهرت الصحافة الأدبية في', 'المدن الكبرى فكانت منبرًا', 'للكتّاب الشباب يعرضون', 'فيه أفكارهم ونصوصهم.']
CLf = ['ثم تطورت الطباعة بعد ذلك', 'فانتشرت الكتب بأسعار', 'مناسبة وازداد عدد القراء', 'وتنوعت موضوعات الكتابة', 'بين الأدب والعلم والتاريخ.']
im, d = page(); body(d, CR, NASKH, 34, 300, xr=W - M, maxw=470); body(d, CLf, NASKH, 34, 300, xr=M + 520, maxw=470); d.line([(W // 2, 280), (W // 2, 900)], fill=140, width=1)
save(im, 'two_columns', 'columns', CR + CLf)
print(os.listdir(out + '/raw'))
