"""生成 App 图标与启动图（PNG），供 PWA manifest 与 @capacitor/assets 使用。

用法：python tools/make_icons.py
产物：
    web/icons/icon-192.png / icon-512.png        PWA 图标
    assets/icon-only.png / icon-foreground.png / icon-background.png / splash.png
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
WEB_ICONS = ROOT / "web" / "icons"
ASSETS = ROOT / "assets"

BLUE = (37, 99, 235, 255)
DEEP = (29, 78, 216, 255)
WHITE = (255, 255, 255, 255)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def rounded_icon(size: int, *, radius_ratio: float = 0.22, glyph: str = "题") -> Image.Image:
    """蓝底圆角 + 白色汉字。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = int(size * radius_ratio)
    draw.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=radius, fill=BLUE)
    # 左下角加深一点，做出层次
    draw.rounded_rectangle(
        [(0, int(size * 0.55)), (size - 1, size - 1)],
        radius=radius,
        fill=DEEP,
    )
    draw.rounded_rectangle([(0, 0), (size - 1, int(size * 0.72))], radius=radius, fill=BLUE)

    font = load_font(int(size * 0.58))
    text = glyph
    bbox = draw.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    draw.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]), text, font=font, fill=WHITE)
    return img


def foreground(size: int, glyph: str = "题") -> Image.Image:
    """Android 自适应图标前景（透明底 + 居中汉字，留出安全边距）。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = load_font(int(size * 0.34))
    bbox = draw.textbbox((0, 0), glyph, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    draw.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]), glyph, font=font, fill=WHITE)
    return img


def splash(width: int = 2732, height: int = 2732) -> Image.Image:
    img = Image.new("RGBA", (width, height), BLUE)
    icon = rounded_icon(int(width * 0.28))
    img.alpha_composite(icon, (int((width - icon.width) / 2), int((height - icon.height) / 2)))
    return img


def main() -> None:
    WEB_ICONS.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)

    rounded_icon(192).save(WEB_ICONS / "icon-192.png")
    rounded_icon(512).save(WEB_ICONS / "icon-512.png")
    rounded_icon(1024).save(ASSETS / "icon-only.png")
    foreground(1024).save(ASSETS / "icon-foreground.png")
    Image.new("RGBA", (1024, 1024), BLUE).save(ASSETS / "icon-background.png")
    splash().save(ASSETS / "splash.png")
    splash(1284, 2778).save(ASSETS / "splash-dark.png")

    # 安卓启动图标（由 scripts/patch-android.mjs 覆盖到生成的工程里）
    densities = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for name, size in densities.items():
        out_dir = ROOT / "resources" / "android" / f"mipmap-{name}"
        out_dir.mkdir(parents=True, exist_ok=True)
        rounded_icon(size).save(out_dir / "ic_launcher.png")
        rounded_icon(size, radius_ratio=0.5).save(out_dir / "ic_launcher_round.png")
        foreground(int(size * 2.25)).save(out_dir / "ic_launcher_foreground.png")

    targets = list(WEB_ICONS.glob("*.png")) + list(ASSETS.glob("*.png")) + list(
        (ROOT / "resources").rglob("*.png")
    )
    for path in sorted(targets):
        print(f"已生成：{path.relative_to(ROOT)}　{path.stat().st_size} 字节")


if __name__ == "__main__":
    main()
