"""生成黄金向量用的固定图片（#3374）。

四张**合成**图，没有版权问题，且刻意覆盖侧车预处理的分支：宽图（Resize 短边 + CenterCrop 会裁掉左右）、
竖图、方图、带 alpha 的 PNG（走 alpha 合成到白底那一支）。像素由固定种子决定，重跑逐字节相同。

这些图只用来钉住「随附的 ViT 定义与上游实现数值一致」；它们长什么样与「风格」无关。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent


def gradient_wide() -> Image.Image:
    height, width = 180, 320
    x = np.linspace(0, 255, width, dtype=np.float32)[None, :].repeat(height, axis=0)
    y = np.linspace(0, 255, height, dtype=np.float32)[:, None].repeat(width, axis=1)
    rgb = np.stack([x, y, 255 - x], axis=-1).astype(np.uint8)
    return Image.fromarray(rgb, "RGB")


def checker_tall() -> Image.Image:
    height, width, cell = 300, 200, 25
    rows = (np.arange(height) // cell)[:, None]
    cols = (np.arange(width) // cell)[None, :]
    mask = ((rows + cols) % 2 == 0)
    rgb = np.where(mask[..., None], np.array([30, 60, 200], np.uint8), np.array([240, 200, 40], np.uint8))
    return Image.fromarray(rgb.astype(np.uint8), "RGB")


def noise_square() -> Image.Image:
    rng = np.random.default_rng(3374)
    rgb = rng.integers(0, 256, size=(256, 256, 3), dtype=np.uint8)
    return Image.fromarray(rgb, "RGB")


def circle_rgba() -> Image.Image:
    size = 240
    yy, xx = np.mgrid[0:size, 0:size]
    inside = (xx - size / 2) ** 2 + (yy - size / 2) ** 2 <= (size * 0.35) ** 2
    rgba = np.zeros((size, size, 4), np.uint8)
    rgba[..., 0] = 200
    rgba[..., 1] = 40
    rgba[..., 2] = 90
    rgba[..., 3] = np.where(inside, 255, 0).astype(np.uint8)
    # 透明区底下故意放一个显眼的 RGB —— 若侧车只是丢 alpha 而没合成白底，这个值会进模型，黄金向量对不上
    rgba[~inside, 0:3] = (0, 255, 0)
    return Image.fromarray(rgba, "RGBA")


def main() -> None:
    images = {
        "gradient-wide.png": gradient_wide(),
        "checker-tall.png": checker_tall(),
        "noise-square.png": noise_square(),
        "circle-rgba.png": circle_rgba(),
    }
    for name, image in images.items():
        image.save(HERE / name, format="PNG", optimize=False)
        print(f"wrote {name} {image.size} {image.mode}")


if __name__ == "__main__":
    main()
