"""Build the Icognito web font. Requires FontTools and Brotli."""

from pathlib import Path
from string import ascii_uppercase

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen


# The outer frames distinguish three groups of nine letters.
FRAMES = (
    ((100, 380), (360, 565), (620, 380), (360, 195)),
    ((100, 380), (225, 545), (495, 545), (620, 380), (495, 215), (225, 215)),
    ((100, 380), (235, 525), (485, 525), (620, 380), (485, 235), (235, 235)),
)
MARKS = ((360,), (260, 460), (230, 360, 490))
CENTER = (360, 380)


def polygon(pen, points):
    pen.moveTo(points[0])
    for point in points[1:]:
        pen.lineTo(point)
    pen.closePath()


def diamond(pen, x, y, size):
    polygon(pen, ((x - size, y), (x, y + size), (x + size, y), (x, y - size)))


def glyph(index, accents=()):
    pen = TTGlyphPen(None)
    frame = FRAMES[index // 9]
    if index // 9 == 2:
        # Round the third frame into an almond with curved upper and lower lids.
        for scale, reverse in ((1, False), (0.76, True)):
            left = (round(360 - 260 * scale), 380)
            right = (round(360 + 260 * scale), 380)
            start, end = (right, left) if reverse else (left, right)
            height = round(190 * scale)
            pen.moveTo(start)
            pen.qCurveTo((360, 380 + height * 2), end)
            pen.qCurveTo((360, 380 - height * 2), start)
            pen.closePath()
    else:
        polygon(pen, frame)
        inner = tuple(
            (round(360 + (x - 360) * 0.74), round(380 + (y - 380) * 0.70))
            for x, y in reversed(frame)
        )
        polygon(pen, inner)
    diamond(pen, *CENTER, 66)
    for x in MARKS[index // 3 % 3]:
        diamond(pen, x, 635, 40)
    for x in MARKS[index % 3]:
        diamond(pen, x, 125, 40)
    for x, y in accents:
        diamond(pen, x, y, 39)
    return pen.glyph()


def punctuation(question):
    pen = TTGlyphPen(None)
    if question:
        polygon(pen, ((160, 600), (360, 760), (560, 600), (360, 440), (360, 320),
                      (295, 320), (295, 467), (453, 600), (360, 674), (201, 548)))
    else:
        polygon(pen, ((292, 760), (428, 760), (390, 320), (330, 320)))
    diamond(pen, 360, 160, 66)
    return pen.glyph()


def build():
    glyphs = {'.notdef': TTGlyphPen(None).glyph(), 'space': TTGlyphPen(None).glyph()}
    cmap = {32: 'space'}
    for index, letter in enumerate(ascii_uppercase):
        glyphs[letter] = glyph(index)
        cmap[ord(letter)] = cmap[ord(letter.lower())] = letter
    for base, letter in zip('AOUS', 'ÄÖÜẞ'):
        name = f'{base}.accent'
        glyphs[name] = glyph(ascii_uppercase.index(base), ((285, 752), (435, 752)))
        cmap[ord(letter)] = cmap[ord(letter.lower())] = name
    for char, name in (('!', 'exclam'), ('?', 'question')):
        glyphs[name] = punctuation(char == '?')
        cmap[ord(char)] = name
    font = FontBuilder(1000, isTTF=True)
    font.setupGlyphOrder(list(glyphs))
    font.setupCharacterMap(cmap)
    font.setupGlyf(glyphs)
    font.setupHorizontalMetrics({name: (360 if name == 'space' else 720, glyphs[name].xMin)
                                 for name in glyphs})
    font.setupHorizontalHeader(ascent=850, descent=-150)
    font.setupNameTable({'familyName': 'Familie Icognito', 'styleName': 'Regular',
                         'uniqueFontIdentifier': 'Familie Icognito Regular 1.0',
                         'fullName': 'Familie Icognito Regular', 'psName': 'FamilieIcognito-Regular'})
    font.setupOS2(sTypoAscender=850, sTypoDescender=-150, usWinAscent=850, usWinDescent=150)
    font.setupPost()
    font.font.flavor = 'woff2'
    font.save(Path(__file__).resolve().parents[1] / 'public/fonts/icognito.woff2')


if __name__ == '__main__':
    build()
