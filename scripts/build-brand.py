# Builds WasteZero logo SVGs with the wordmark converted to outlines (Inter Display Bold, SIL OFL).
import sys, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
INK, GREEN, PAPER, WHITE, MINT = "#14161B", "#0B7A53", "#FBFBF9", "#FFFFFF", "#3DDC97"
font = TTFont("/usr/share/fonts/opentype/inter/InterDisplay-Bold.otf")
gs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font["hmtx"]
upm = font["head"].unitsPerEm
kern = {}
try:
    for lookup in font["GPOS"].table.LookupList.Lookup:
        pass
except Exception: pass

def text_path(text, size, x0, baseline, tracking=-0.02):
    scale = size / upm
    x, parts = x0, []
    for ch in text:
        g = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[g].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        parts.append(pen.getCommands())
        x += hmtx[g][0] * scale + tracking * size
    return " ".join(parts), x - x0 - tracking * size

def mark(cx, cy, s, ring, cut, arrow):
    # s = overall size. Ring = "zero"; arrow = costs going down, cutting through the zero.
    k = s / 64.0
    T = lambda v: v * k
    return f'''<g transform="translate({cx - 32*k},{cy - 32*k})">
  <circle cx="{T(32)}" cy="{T(32)}" r="{T(21)}" fill="none" stroke="{ring}" stroke-width="{T(8.5)}"/>
  <path d="M{T(15)} {T(15)} L{T(44)} {T(44)}" stroke="{cut}" stroke-width="{T(14)}" stroke-linecap="round"/>
  <path d="M{T(15)} {T(15)} L{T(43)} {T(43)}" stroke="{arrow}" stroke-width="{T(6.5)}" stroke-linecap="round"/>
  <path d="M{T(48)} {T(31)} L{T(48)} {T(48)} L{T(31)} {T(48)}" fill="none" stroke="{arrow}" stroke-width="{T(6.5)}" stroke-linecap="round" stroke-linejoin="round"/>
</g>'''

def svg(w, h, body, bg=None):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}" width="{w:.0f}" height="{h:.0f}">' + (f'<rect width="100%" height="100%" fill="{bg}"/>' if bg else "") + body + "</svg>\n"

def write(name, content):
    open(os.path.join(OUT, name), "w").write(content)

# Mark only
write("wastezero-mark.svg", svg(64, 64, mark(32, 32, 64, GREEN, PAPER, INK)))
write("wastezero-mark-on-dark.svg", svg(64, 64, mark(32, 32, 64, MINT, INK, WHITE), INK))
write("favicon.svg", svg(64, 64, f'<rect width="64" height="64" rx="14" fill="{PAPER}"/>' + mark(32, 32, 56, GREEN, PAPER, INK)))
# App/profile icon: white mark on green
write("wastezero-icon.svg", svg(512, 512, f'<rect width="512" height="512" fill="{GREEN}"/>' + mark(256, 256, 330, WHITE, GREEN, INK)))

# Horizontal logo
def horizontal(word_waste, word_zero, ring, cut, arrow, bg=None):
    size = 44
    p1, w1 = text_path("Waste", size, 64 + 14, 47)
    p2, w2 = text_path("Zero", size, 64 + 14 + w1 + 0.5, 47)
    W = 64 + 14 + w1 + w2 + 6
    body = mark(32, 32, 60, ring, cut, arrow) + f'<path d="{p1}" fill="{word_waste}"/><path d="{p2}" fill="{word_zero}"/>'
    return svg(W, 64, body, bg), W
h, W = horizontal(INK, GREEN, GREEN, PAPER, INK)
write("wastezero-logo.svg", h)
h2, _ = horizontal(WHITE, MINT, MINT, INK, WHITE, INK)
write("wastezero-logo-on-dark.svg", h2)
# Wordmark only
p1, w1 = text_path("Waste", 44, 0, 47); p2, w2 = text_path("Zero", 44, w1 + 0.5, 47)
write("wastezero-wordmark.svg", svg(w1 + w2 + 4, 64, f'<path d="{p1}" fill="{INK}"/><path d="{p2}" fill="{GREEN}"/>'))
print("ok", round(W))
