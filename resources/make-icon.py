"""Generate a 128x128 marketplace icon for Claude WhatsApp Bridge.
Run: python resources/make-icon.py
"""
from PIL import Image, ImageDraw
from pathlib import Path

SIZE = 128
BG = (11, 20, 26, 255)              # WhatsApp dark mode background
BUBBLE = (37, 211, 102, 255)        # WhatsApp brand green
ACCENT = (255, 137, 76, 255)        # Codenzia / Claude orange
LINE = (255, 255, 255, 235)


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), BG)
    draw = ImageDraw.Draw(img)

    # WhatsApp-style chat bubble: rounded rectangle + small tail
    bubble_box = (14, 14, 114, 100)
    draw.rounded_rectangle(bubble_box, radius=22, fill=BUBBLE)
    # tail (triangle off bottom-left)
    draw.polygon([(28, 100), (14, 110), (38, 100)], fill=BUBBLE)

    # Inside the bubble: bookmark (Claude Tabs visual cue) in orange
    bx, by = 50, 30
    bw, bh = 32, 50
    notch_h = 10
    bookmark = [
        (bx, by),
        (bx + bw, by),
        (bx + bw, by + bh),
        (bx + bw // 2, by + bh - notch_h),
        (bx, by + bh),
    ]
    draw.polygon(bookmark, fill=ACCENT)

    # Two tiny "tab title" lines on the bookmark
    line_x1 = bx + 5
    line_x2 = bx + bw - 5
    for y in (by + 14, by + 22):
        draw.rounded_rectangle((line_x1, y, line_x2, y + 3), radius=1, fill=LINE)

    out = Path(__file__).parent / "icon-marketplace.png"
    img.save(out, "PNG")
    print(f"wrote {out} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
