# Regenerates the Overlay logo SVGs, app icons and docs/assets/logo-preview.png.
# Usage: python scripts/brand/generate-logo-assets.py .   (needs: pip install cairosvg pillow)
"""Generate the Overlay logo SVGs and app icons from one geometry."""
import io, os, sys
import cairosvg
from PIL import Image

REPO = sys.argv[1]
A = os.path.join(REPO, "src", "assets")
DOCS = os.path.join(REPO, "docs", "assets")
os.makedirs(DOCS, exist_ok=True)

def rrect(x, y, w, h, r, cw=True):
    if cw:
        return (f"M{x+r} {y}H{x+w-r}A{r} {r} 0 0 1 {x+w} {y+r}V{y+h-r}A{r} {r} 0 0 1 {x+w-r} {y+h}"
                f"H{x+r}A{r} {r} 0 0 1 {x} {y+h-r}V{y+r}A{r} {r} 0 0 1 {x+r} {y}Z")
    return (f"M{x+r} {y}A{r} {r} 0 0 0 {x} {y+r}V{y+h-r}A{r} {r} 0 0 0 {x+r} {y+h}"
            f"H{x+w-r}A{r} {r} 0 0 0 {x+w} {y+h-r}V{y+r}A{r} {r} 0 0 0 {x+w-r} {y}Z")

# Full mark geometry (1024 grid)
BAR1 = (132, 392, 72, 160, 36)
BAR2 = (236, 296, 72, 352, 36)
CARD = (352, 256, 520, 416, 76)
TAIL = "M352 560H452V672H508L378 768A16 16 0 0 1 352 756Z"
LINE1 = (436, 368, 320, 52, 26)
LINE2 = (436, 484, 184, 52, 26)
CARET = (656, 462, 36, 96, 18)

# Simplified mark for 16-32 px
S_BAR = (112, 368, 128, 256, 64)
S_CARD = (320, 216, 600, 480, 96)
S_TAIL = "M320 560H440V696H522L352 835A20 20 0 0 1 320 820Z"
S_LINE = (440, 404, 360, 112, 56)

def full_svg(title=True):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  {"<title>Overlay</title>" if title else ""}
  <!-- Overlay mark: a sound wave whose last beat becomes a floating answer card.
       Original artwork for Overlay (c) Ridham Jain, MIT licensed with the project. -->
  <defs>
    <linearGradient id="ovl-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9A1F36"/>
      <stop offset="1" stop-color="#6B0F1A"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="232" fill="url(#ovl-bg)"/>
  <path d="{rrect(*BAR1)}" fill="#FBF3EE" fill-opacity="0.6"/>
  <path d="{rrect(*BAR2)}" fill="#FBF3EE" fill-opacity="0.8"/>
  <path d="{rrect(*CARD)}{TAIL}" fill="#FBF3EE"/>
  <path d="{rrect(*LINE1)}" fill="#800020"/>
  <path d="{rrect(*LINE2)}" fill="#800020" fill-opacity="0.5"/>
  <path d="{rrect(*CARET)}" fill="#800020"/>
</svg>
'''

def small_svg():
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <title>Overlay</title>
  <!-- Simplified Overlay mark for 16-32 px icons. -->
  <rect width="1024" height="1024" rx="232" fill="#800020"/>
  <path d="{rrect(*S_BAR)}" fill="#FFFFFF" fill-opacity="0.8"/>
  <path d="{rrect(*S_CARD)}{S_TAIL}{rrect(*S_LINE, cw=False)}" fill="#FFFFFF"/>
</svg>
'''

# Glyph only (no tile), one colour, text lines cut out. Used for the tray template
# and the in-app BrandMark (currentColor).
GLYPH_BARS = rrect(*BAR1) + rrect(*BAR2)
GLYPH_CARD = rrect(*CARD) + TAIL + rrect(*LINE1, cw=False) + rrect(*LINE2, cw=False) + rrect(*CARET, cw=False)

def glyph_svg(color="#000000"):
    # Crop the glyph to its own box with a little margin so it fills a tray slot.
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="112 236 780 552" width="780" height="552">
  <path d="{GLYPH_BARS}" fill="{color}" fill-opacity="0.7"/>
  <path d="{GLYPH_CARD}" fill="{color}"/>
</svg>
'''

def png(svg, size, w=None, h=None):
    data = cairosvg.svg2png(bytestring=svg.encode(), output_width=w or size, output_height=h or size)
    return Image.open(io.BytesIO(data)).convert("RGBA")

full, small = full_svg(), small_svg()
open(os.path.join(A, "logo.svg"), "w").write(full)
open(os.path.join(A, "logo-small.svg"), "w").write(small)

def icon(size):
    return png(small if size <= 32 else full, size)

# PNG app icon (window icon, favicon, Linux) — 512 px
icon(512).save(os.path.join(A, "icon.png"))
# Windows .ico (also the installer and tray icon on Windows)
sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [icon(s) for s in sizes]
frames[-1].save(os.path.join(A, "icon.ico"), format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
# macOS .icns
icon(1024).save(os.path.join(A, "icon.icns"), format="ICNS")
# macOS tray template: black glyph on transparent, 48 px (16 pt @3x)
g = png(glyph_svg(), 0, w=48, h=34)
tray = Image.new("RGBA", (48, 48), (0, 0, 0, 0)); tray.paste(g, (0, 7), g)
tray.save(os.path.join(A, "iconTemplate@3x.png"))

# Preview sheet for the README / the user
W, H = 1200, 640
sheet = Image.new("RGBA", (W, H), (251, 248, 244, 255))
dark = Image.new("RGBA", (W // 2, 200), (26, 22, 23, 255)); sheet.paste(dark, (W // 2, H - 200))
big = icon(400); sheet.paste(big, (60, 60), big)
x = 520
for s in [256, 128, 64, 32, 16]:
    im = icon(s); sheet.paste(im, (x, 60 + (256 - s)), im); x += s + 24
# small sizes on dark and on light, plus 4x zoom of 16 px
x = 640
for s in [48, 32, 24, 16]:
    im = icon(s); sheet.paste(im, (x, H - 140), im); x += s + 30
z = icon(16).resize((96, 96), Image.NEAREST); sheet.paste(z, (1040, H - 170), z)
tz = tray.resize((96, 96), Image.NEAREST)
sheet.paste(tz, (520, 360), tz)
sheet.convert("RGB").save(os.path.join(DOCS, "logo-preview.png"))
print("ok")
