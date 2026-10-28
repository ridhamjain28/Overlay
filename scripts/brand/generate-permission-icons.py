# Regenerates the maroon onboarding permission tiles (mic, accessibility, system audio).
# Usage: python scripts/brand/generate-permission-icons.py .   (needs: pip install cairosvg pillow)
import io, cairosvg, sys
from PIL import Image
A = sys.argv[1] + "/src/assets/"
TILE = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 88" width="88" height="88">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9A1F36"/><stop offset="1" stop-color="#6B0F1A"/></linearGradient></defs>
<rect width="88" height="88" rx="22" fill="url(#g)"/>
<g fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">{}</g></svg>'''
GLYPHS = {
 # microphone
 "onboarding-permission-microphone.webp": '<rect x="35" y="18" width="18" height="32" rx="9" fill="#FFFFFF" stroke="none"/><path d="M26 42a18 18 0 0 0 36 0"/><path d="M44 60v10"/>',
 # accessibility: person in a circle
 "onboarding-permission-accessibility.webp": '<circle cx="44" cy="44" r="27"/><circle cx="44" cy="30" r="4" fill="#FFFFFF" stroke="none"/><path d="M30 40l14 3 14-3"/><path d="M44 43v9l-7 12"/><path d="M44 52l7 12"/>',
 # system audio: speaker with waves
 "onboarding-permission-system-audio.webp": '<path d="M22 37h10l13-11v36L32 51H22Z" fill="#FFFFFF"/><path d="M54 36a11 11 0 0 1 0 16"/><path d="M61 29a21 21 0 0 1 0 30"/>',
}

for i, (name, g) in enumerate(GLYPHS.items()):
    im = Image.open(io.BytesIO(cairosvg.svg2png(bytestring=TILE.format(g).encode()))).convert("RGBA")
    im.save(A + name, "WEBP", lossless=True)

