"""Baut die Game-Boy-Pixelschrift (Familie GB) aus scripts/fonts-src/gameboy-sheet.png.

Das Bild ist ein 10-px-Raster: jedes Feld ist ein Pixel der Schrift. Ergänzt werden Umlaute, ß und
ein paar fehlende Zeichen im gleichen Stil. Ausgabe: public/fonts/familie-gb.woff2
"""
from pathlib import Path
import numpy as np
from PIL import Image
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

ROOT = Path(__file__).resolve().parent.parent
a = np.array(Image.open(ROOT / 'scripts/fonts-src/gameboy-sheet.png').convert('L')) < 128
grid = a[8 + 5::10, 2 + 5::10]  # ein Wert je Schriftpixel

# Zeilenbänder (Oberkante, Grundlinie = letzte Zeile der Großbuchstaben, Unterlänge 1 px)
BANDS = [
    (6, 'AaBbCcDdEe'), (14, 'FfGgHhIiJj'), (22, 'KkLlMmNnOo'), (30, 'PpQqRrSsTt'),
    (38, 'UuVvWwXxYy'), (46, 'Zz0123456789'), (54, '(!₽&,.:;’)'),
]
glyphs = {}
for top, chars in BANDS:
    band = grid[top - 1:top + 8]  # 1 Zeile darüber (Umlaut-Platz) … 7 Zeilen + 1 Unterlänge
    cols = band[1:].any(0)
    segs, start = [], None
    for x, v in enumerate(list(cols) + [False]):
        if v and start is None: start = x
        if not v and start is not None: segs.append((start, x)); start = None
    assert len(segs) == len(chars), (chars, len(segs))
    for ch, (s, e) in zip(chars, segs):
        g = band[:, s:e].copy()  # Zeile 0 = über Großbuchstaben, 1–7 = Höhe, 8 = Unterlänge
        g[0, :] = False          # Zeile 0 gehört im Bild zur Unterlänge der Zeile darüber
        glyphs[ch] = g

def bm(rows):
    """Zeichen aus Textmuster (9 Zeilen: 1 oben, 7 Höhe, 1 Unterlänge)."""
    return np.array([[c == '#' for c in r] for r in rows])

# Ergänzungen im gleichen Stil
glyphs['?'] = bm(['.....', '.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..', '.....'])
glyphs['-'] = bm(['.....', '.....', '.....', '.....', '#####', '.....', '.....', '.....', '.....'])
glyphs['/'] = bm(['.....', '....#', '....#', '...#.', '..#..', '.#...', '#....', '#....', '.....'])
glyphs['"'] = bm(['...', '#.#', '#.#', '...', '...', '...', '...', '...', '...'])
glyphs["'"] = glyphs['’']
glyphs['+'] = bm(['.....', '.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....', '.....'])
glyphs['='] = bm(['.....', '.....', '.....', '#####', '.....', '#####', '.....', '.....', '.....'])
glyphs['%'] = bm(['.......', '##...#.', '##..#..', '...#...', '..#....', '.#..##.', '#...##.', '.......', '.......'])
glyphs['_'] = bm(['......', '......', '......', '......', '......', '......', '......', '######', '......'])
glyphs['…'] = bm(['.......', '.......', '.......', '.......', '.......', '.......', '#.#.#..', '.......', '.......'])
glyphs['–'] = bm(['......', '......', '......', '......', '######', '......', '......', '......', '......'])
glyphs['ß'] = bm(['......', '.###..', '#...#.', '#..#..', '#.##..', '#...#.', '#...#.', '#.##..', '......'])

def with_dots(base, upper):
    g = base.copy()
    w = g.shape[1]
    row = 0 if upper else 1  # Großbuchstaben: Zeile über der Versalhöhe · klein: mit Abstand über der x-Höhe
    g[row, :] = False
    xs = (1, w - 2) if w >= 5 else (0, w - 1)
    g[row, xs[0]] = g[row, xs[1]] = True
    return g

for src, dst, up in (('A', 'Ä', True), ('O', 'Ö', True), ('U', 'Ü', True), ('a', 'ä', False), ('o', 'ö', False), ('u', 'ü', False)):
    glyphs[dst] = with_dots(glyphs[src], up)

PX = 100            # Schriftpixel in Font-Einheiten
BASE = 7            # Index der Grundlinie (Zeile 7 = unterste Zeile der Großbuchstaben)

fb = FontBuilder(1000, isTTF=True)
names = ['.notdef', 'space'] + [f'uni{ord(c):04X}' for c in glyphs]
fb.setupGlyphOrder(names)
cmap = {32: 'space', 160: 'space'}
cmap.update({ord(c): f'uni{ord(c):04X}' for c in glyphs})
fb.setupCharacterMap(cmap)
ttglyphs, metrics = {}, {}
empty = TTGlyphPen(None); ttglyphs['.notdef'] = empty.glyph(); metrics['.notdef'] = (500, 0)
sp = TTGlyphPen(None); ttglyphs['space'] = sp.glyph(); metrics['space'] = (4 * PX, 0)
for ch, g in glyphs.items():
    pen = TTGlyphPen(None)
    h, w = g.shape
    for y in range(h):
        x = 0
        while x < w:
            if g[y, x]:
                x0 = x
                while x < w and g[y, x]: x += 1
                top = (BASE - y + 1) * PX
                bot = (BASE - y) * PX
                pen.moveTo((x0 * PX, bot)); pen.lineTo((x0 * PX, top)); pen.lineTo((x * PX, top)); pen.lineTo((x * PX, bot)); pen.closePath()
            else:
                x += 1
    ttglyphs[f'uni{ord(ch):04X}'] = pen.glyph()
    metrics[f'uni{ord(ch):04X}'] = ((w + 1) * PX, 0)
fb.setupGlyf(ttglyphs)
fb.setupHorizontalMetrics(metrics)
fb.setupHorizontalHeader(ascent=900, descent=-200)
fb.setupNameTable({'familyName': 'Familie GB', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=900, sTypoDescender=-200, usWinAscent=900, usWinDescent=200, sxHeight=500, sCapHeight=700)
fb.setupPost()
fb.font.flavor = 'woff2'
fb.save(ROOT / 'public/fonts/familie-gb.woff2')
print('Familie GB:', len(glyphs), 'Zeichen')
