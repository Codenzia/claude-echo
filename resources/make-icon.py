"""Generate a 128x128 marketplace icon for Claude Echo.
Run: python resources/make-icon.py
"""
from PIL import Image, ImageDraw
from pathlib import Path

SIZE = 128
BG = (24, 28, 36, 255)           # dark slate
BUBBLE = (236, 240, 245, 255)    # off-white speech bubble
ACCENT = (255, 137, 76, 255)     # Codenzia / Claude orange


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), BG)
    draw = ImageDraw.Draw(img)

    # Speech bubble (rounded rect + small tail bottom-left)
    bubble_box = (12, 14, 116, 96)
    draw.rounded_rectangle(bubble_box, radius=20, fill=BUBBLE)
    draw.polygon([(28, 96), (16, 110), (40, 96)], fill=BUBBLE)

    # Echo "spark": three concentric expanding arcs in orange — represents sound/echo pulses
    cx, cy = 64, 54
    # Inner solid dot
    draw.ellipse((cx - 8, cy - 8, cx + 8, cy + 8), fill=ACCENT)
    # Two echo rings (open arcs)
    for r, w in [(18, 3), (28, 3)]:
        draw.arc((cx - r, cy - r, cx + r, cy + r), start=-55, end=55, fill=ACCENT, width=w)
        draw.arc((cx - r, cy - r, cx + r, cy + r), start=125, end=235, fill=ACCENT, width=w)

    out = Path(__file__).parent / "icon-marketplace.png"
    img.save(out, "PNG")
    print(f"wrote {out} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
