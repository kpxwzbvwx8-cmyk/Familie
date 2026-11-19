"""Baut die Icognito-Schrift (Familie Icognito) aus der Icognito-Tabelle scripts/fonts-src/icognito-sheet.png.

Jedes Zeichen wird aus seinem Feld der Tabelle ausgeschnitten, als Kontur nachgezeichnet und am „Auge“
(dem Punkt in der Mitte) ausgerichtet. Buchstaben A–Z (groß und klein), ! und ?.
Ausgabe: public/fonts/icognito.woff2
"""
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage
from skimage import measure
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

ROOT = Path(__file__).resolve().parent.parent
img = np.array(Image.open(ROOT / 'scripts/fonts-src/icognito-sheet.png').convert('L')) < 128

ROWS = [(25, 200), (240, 412), (452, 627), (665, 842)]
COLS = [0, 161, 310, 473, 625, 768, 917, 1080]
CHARS = ['ABCDEFG', 'HIJKLMN', 'OPQRSTU', 'VWXYZ!?']
SCALE = 6.4        # Bildpixel → Font-Einheiten
EYE_Y = 330        # Höhe des Auges über der Grundlinie
PAD = 70           # seitlicher Abstand

def contours_of(mask):
    m = np.pad(mask.astype(float), 2)
    cs = [measure.approximate_polygon(c, tolerance=0.7) for c in measure.find_contours(m, 0.5)]
    return [c - 2 for c in cs if len(c) >= 4]

def area(poly):
    y, x = poly[:, 0], poly[:, 1]
    return 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)

def inside(pt, poly):
    y, x = pt; n = len(poly); ins = False
    for i in range(n):
        y1, x1 = poly[i]; y2, x2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1:
            ins = not ins
    return ins

glyphs = {}
for (y0, y1), chars in zip(ROWS, CHARS):
    for i, ch in enumerate(chars):
        x0, x1 = COLS[i], COLS[i + 1]
        cell = img[y0:y1, x0:x1]
        lab, n = ndimage.label(cell)
        sizes = ndimage.sum(cell, lab, range(1, n + 1))
        # Auge: kleiner, kompakter Fleck (bei ! und ? der Fleck in der unteren Kugel)
        cand = [k + 1 for k in range(n) if 80 < sizes[k] < 260]
        if ch in '!?':
            cy, cx = [c for c in ndimage.center_of_mass(cell)]
            ys, xs = np.nonzero(cell)
            cy = ys.max() - 32
        else:
            k = min(cand, key=lambda k: abs(ndimage.center_of_mass(cell, lab, k)[1] - cell.shape[1] / 2) + abs(ndimage.center_of_mass(cell, lab, k)[0] - cell.shape[0] / 2) * 0.5)
            cy, cx = ndimage.center_of_mass(cell, lab, k)
        ys, xs = np.nonzero(cell)
        left, right = xs.min(), xs.max() + 1
        glyphs[ch] = (cell, cy, left, right)

def build_glyph(cell, cy, left, right):
    polys = contours_of(cell)
    pen = TTGlyphPen(None)
    for p in polys:
        depth = sum(inside(p[0], q) for q in polys if q is not p)
        a = area(p)
        # Font-Koordinaten: y nach oben
        pts = [((x - left) * SCALE + PAD, (cy - y) * SCALE + EYE_Y) for y, x in p[:-1]]
        # außen im Uhrzeigersinn, Löcher gegen den Uhrzeigersinn (TrueType)
        ccw = area(np.array([[py, px] for px, py in pts])) > 0
        if (depth % 2 == 0) == ccw: pts = pts[::-1]
        pen.moveTo((round(pts[0][0]), round(pts[0][1])))
        for x, y in pts[1:]: pen.lineTo((round(x), round(y)))
        pen.closePath()
    return pen.glyph(), int((right - left) * SCALE + 2 * PAD)

fb = FontBuilder(1000, isTTF=True)
names = ['.notdef', 'space']
cmap = {32: 'space', 160: 'space'}
for ch in glyphs:
    names.append(f'u_{ord(ch):04X}')
    cmap[ord(ch)] = f'u_{ord(ch):04X}'
    if ch.isalpha(): cmap[ord(ch.lower())] = f'u_{ord(ch):04X}'
# Umlaute wie ihre Grundbuchstaben
for um, base in (('Ä', 'A'), ('Ö', 'O'), ('Ü', 'U'), ('ä', 'A'), ('ö', 'O'), ('ü', 'U')):
    cmap[ord(um)] = f'u_{ord(base):04X}'
fb.setupGlyphOrder(names)
fb.setupCharacterMap(cmap)
tg, mt = {'.notdef': TTGlyphPen(None).glyph(), 'space': TTGlyphPen(None).glyph()}, {'.notdef': (500, 0), 'space': (380, 0)}
for ch, data in glyphs.items():
    g, adv = build_glyph(*data)
    tg[f'u_{ord(ch):04X}'] = g; mt[f'u_{ord(ch):04X}'] = (adv, 0)
fb.setupGlyf(tg)
fb.setupHorizontalMetrics(mt)
fb.setupHorizontalHeader(ascent=900, descent=-260)
fb.setupNameTable({'familyName': 'Familie Icognito', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=900, sTypoDescender=-260, usWinAscent=900, usWinDescent=260, sxHeight=600, sCapHeight=750)
fb.setupPost()
fb.font.flavor = 'woff2'
fb.save(ROOT / 'public/fonts/icognito.woff2')
print('Icognito:', len(glyphs), 'Zeichen')
