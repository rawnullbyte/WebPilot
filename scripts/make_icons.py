#!/usr/bin/env python3
"""Generate WebPilot's icon set.

The mark is Font Awesome's solid `paper-plane`: "sent somewhere and did
something", which is what the extension does to a page.

Where the path comes from
-------------------------
`@fortawesome/free-solid-svg-icons` (7.3.1), `faPaperPlane.icon[4]`, kept as a
devDependency purely so `--check` can re-derive it. The SVG path data is baked in
below so this script has no runtime dependency on that package.

Why the viewBox is not the upstream one
---------------------------------------
Upstream declares `viewBox="0 0 576 512"`, and the path data does not fit inside
it: the leading motion is `M536.4-26.3`, and the rendered ink runs from y=-28 to
y=528. Rendering at the declared box **clips the nose of the plane** — measured,
not assumed: rasterising with a padded viewBox shows 28px of shape above the
declared top edge. The corrected box below is the true ink bounds with a square
aspect, so everything drawn is actually visible.

Run with:  python3 scripts/make_icons.py [--check]
Requires:  rsvg-convert (librsvg) on PATH, and Pillow.
Writes to: src/icons/
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw

OUT = pathlib.Path(__file__).resolve().parent.parent / "src" / "icons"
SIZES = [16, 32, 48, 96, 128]

# Supersampling factor for the composited tile. The icon is rasterised crisp at
# each size by librsvg (much better than scaling a bitmap), so this only needs to
# smooth the tile's rounded corners and gradient.
SS = 4

# ---------------------------------------------------------------------------
# The mark
# ---------------------------------------------------------------------------

# Font Awesome 7.3.1, free-solid, `paper-plane`.
ICON_PATH = (
    "M536.4-26.3c9.8-3.5 20.6-1 28 6.3s9.8 18.2 6.3 28l-178 496.9c-5 13.9-18.1 23.1-32.8 23.1"
    "-14.2 0-27-8.6-32.3-21.7l-64.2-158c-4.5-11-2.5-23.6 5.2-32.6l94.5-112.4c5.1-6.1 4.7-15-.9"
    "-20.6s-14.6-6-20.6-.9L229.2 276.1c-9.1 7.6-21.6 9.6-32.6 5.2L38.1 216.8c-13.1-5.3-21.7"
    "-18.1-21.7-32.3 0-14.7 9.2-27.8 23.1-32.8l496.9-178z"
)

# The true ink bounds of ICON_PATH, in the path's own coordinate space, as
# measured by rasterising with a padded viewBox and taking the alpha bounding
# box. A square box (557 on each side) so the plane is not distorted.
VIEW = (16, -28, 557, 557)

BG_TOP = (47, 111, 237)      # brand blue
BG_BOTTOM = (30, 64, 175)    # deeper blue, giving the tile a little depth
GLYPH = (255, 255, 255)


def svg_document(size: int) -> str:
    """A square SVG with the plane fitted to the frame."""
    x, y, side, _ = VIEW
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{x} {y} {side} {side}" width="{size}" height="{size}">'
        f'<path d="{ICON_PATH}" fill="rgb({GLYPH[0]},{GLYPH[1]},{GLYPH[2]})"/>'
        f"</svg>"
    )


def rasterise(size: int) -> Image.Image:
    """Renders the glyph at `size` px using librsvg.

    Rendering the vector directly at the target size keeps the diagonals clean at
    16px, where scaling a bitmap down would blur them into mush.
    """
    if not shutil.which("rsvg-convert"):
        sys.exit(
            "rsvg-convert is required (package: librsvg2-bin).\n"
            "Icons are committed, so this is only needed when regenerating them."
        )

    with tempfile.TemporaryDirectory() as tmp:
        svg = pathlib.Path(tmp) / "g.svg"
        png = pathlib.Path(tmp) / "g.png"
        svg.write_text(svg_document(size))
        subprocess.run(
            ["rsvg-convert", "-o", str(png), "-w", str(size), "-h", str(size), str(svg)],
            check=True,
        )
        return Image.open(png).convert("RGBA")


def gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        grad.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return grad.resize((size, size), Image.NEAREST)


def rounded_mask(size: int, radius_frac: float = 0.22) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=max(1, round(size * radius_frac)), fill=255
    )
    return mask


def render(size: int) -> Image.Image:
    n = size * SS

    # The tile: a vertical gradient clipped to a rounded square.
    tile = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    tile.paste(gradient(n, BG_TOP, BG_BOTTOM), (0, 0), rounded_mask(n))

    # The plane, inset from the edges so it does not crowd the rounded corners.
    glyph = rasterise(round(n * 0.70))

    # A soft drop shadow keeps the glyph legible on the lighter top of the tile,
    # where white-on-blue contrast is weakest.
    shadow = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 80), (0, 0), glyph.split()[3])
    tile.alpha_composite(shadow, (round(n * 0.62), round(n * 0.62) + max(1, round(n * 0.012))))

    offset = (n - glyph.width) // 2
    tile.alpha_composite(glyph, (offset, offset))

    return tile.resize((size, size), Image.LANCZOS)


def check() -> int:
    """Confirms the baked path still matches the installed Font Awesome package."""
    repo = pathlib.Path(__file__).resolve().parent.parent
    if not (repo / "node_modules/@fortawesome/free-solid-svg-icons").exists():
        print("  ! @fortawesome/free-solid-svg-icons is not installed; cannot verify.")
        print("    Run: npm install")
        return 1

    probe = subprocess.run(
        [
            "node",
            "-e",
            "const{faPaperPlane}=require('@fortawesome/free-solid-svg-icons');"
            "process.stdout.write(faPaperPlane.icon[4])",
        ],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    upstream = probe.stdout.strip()
    if upstream != ICON_PATH:
        print("  ! the baked path no longer matches Font Awesome's.")
        print(f"    baked:    {ICON_PATH[:60]}…")
        print(f"    upstream: {upstream[:60]}…")
        print("    Re-derive VIEW by rasterising with a padded viewBox and measuring")
        print("    the ink bounding box, then update both constants.")
        return 1

    print("  ✓ the baked path matches the installed Font Awesome release")
    return 0


def main() -> None:
    if "--check" in sys.argv:
        sys.exit(check())

    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon-{size}.png"
        render(size).save(path, "PNG", optimize=True)
        print(f"  wrote {path.relative_to(OUT.parent.parent)} ({size}x{size})")


if __name__ == "__main__":
    main()