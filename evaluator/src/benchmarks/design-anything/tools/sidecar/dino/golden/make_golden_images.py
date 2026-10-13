"""生成检测侧车自检用的黄金图与探针清单（#3469）—— 逐字节可重现，与模型无关。

## 图（`IMAGES`）

| 图 | 压的是什么 |
|---|---|
| `two-shapes.png` | 一张图里两个主体 —— OCCM「数对不对」的最小样例，也是排序稳定性的样例 |
| `alpha-circle.png` | **透明底**。不做 alpha 合成就把透明像素当成黑色，检出会变 —— 这是 `open_rgb` 的守卫 |
| `tall-triangle.png` | 300×900 的竖图。processor 按最短边缩放、最长边设上限，竖图会走到那个上限分支 |
| `blank.png` | 纯白，什么都没画 |

## 探针（`PROBES`）

一张图可以有多条探针（同一张图、不同提示）。`groundTruth` 是**这里画上去的矩形坐标**，
不是模型的输出；自检拿它算 IoU，那才是外部锚。

`blank.png` 上有两条，它们分别钉住两件相反的事：

- `blank-absent`（提示 `a giraffe.`）→ **零检出**。这条路径必须有样例，否则「一个都没检到」
  与「侧车挂了」在测试里长得一样。
- `blank-whole-frame`（提示 `a logo.`）→ **整幅画面被当成一个框**（实测 score 0.344）。
  这不是我们画的形状，而是 Grounding DINO 的一个真实脾气：**主体不在画面里时，它倾向于
  回一个覆盖全图的框而不是什么都不回**。它的 `groundTruth` 因此写成整幅画面的矩形。
  这条探针的作用是把这个脾气钉成一条会变红的事实 —— CIDS 的「整幅画面」守卫
  （`subjectSimilarity.ts` 的 `wholeFrame`）就是冲着它来的：检不到主体时，CIDS 会退化成
  「整图嵌入」，也就是 #3374 那一列，附录里必须说清这一点。

用法（在仓库根）：

    python benchmarks/design-anything/tools/sidecar/dino/golden/make_golden_images.py

只写 `*.png` 与 `specs.json`；黄金读数 `*.json` 由 `record_golden.py` 在钉死的权重下录。
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent

IMAGES = [
    {
        "name": "two-shapes.png",
        "size": (640, 480),
        "background": (255, 255, 255, 255),
        "shapes": [
            {"kind": "ellipse", "box": [100, 120, 260, 280], "fill": (220, 30, 30, 255)},
            {"kind": "rectangle", "box": [380, 180, 540, 340], "fill": (30, 60, 220, 255)},
        ],
    },
    {
        "name": "alpha-circle.png",
        "size": (512, 512),
        "background": (0, 0, 0, 0),
        "shapes": [{"kind": "ellipse", "box": [150, 150, 360, 360], "fill": (220, 30, 30, 255)}],
    },
    {
        "name": "tall-triangle.png",
        "size": (300, 900),
        "background": (255, 255, 255, 255),
        "shapes": [{"kind": "polygon", "points": [[150, 300], [60, 620], [240, 620]], "fill": (20, 150, 60, 255)}],
    },
    {"name": "blank.png", "size": (400, 400), "background": (255, 255, 255, 255), "shapes": []},
]

# groundTruth 按**分数降序**排，与 detect.py 的排序一致；录制脚本会核对顺序对不对得上。
PROBES = [
    {
        "id": "two-shapes",
        "image": "two-shapes.png",
        "prompt": "a red circle. a blue square.",
        "groundTruth": [[100, 120, 260, 280], [380, 180, 540, 340]],
    },
    {
        "id": "alpha-circle",
        "image": "alpha-circle.png",
        "prompt": "a red circle.",
        "groundTruth": [[150, 150, 360, 360]],
    },
    {
        "id": "tall-triangle",
        "image": "tall-triangle.png",
        "prompt": "a green triangle.",
        "groundTruth": [[60, 300, 240, 620]],
    },
    {"id": "blank-absent", "image": "blank.png", "prompt": "a giraffe.", "groundTruth": []},
    {
        "id": "blank-whole-frame",
        "image": "blank.png",
        "prompt": "a logo.",
        # 不是画上去的形状 —— 是「主体不在画面里时回一个全图框」这个脾气。见模块头
        "groundTruth": [[0, 0, 400, 400]],
    },
]


def draw(spec: dict) -> Image.Image:
    image = Image.new("RGBA", tuple(spec["size"]), tuple(spec["background"]))
    canvas = ImageDraw.Draw(image)
    for shape in spec["shapes"]:
        if shape["kind"] == "ellipse":
            canvas.ellipse(shape["box"], fill=tuple(shape["fill"]))
        elif shape["kind"] == "rectangle":
            canvas.rectangle(shape["box"], fill=tuple(shape["fill"]))
        elif shape["kind"] == "polygon":
            canvas.polygon([tuple(p) for p in shape["points"]], fill=tuple(shape["fill"]))
        else:
            raise ValueError(f"unknown shape kind {shape['kind']}")
    # 不透明背景的图存成 RGB：一张不需要 alpha 的图带着 alpha 通道，会让「透明底」这个样例失去对照
    return image if spec["background"][3] == 0 else image.convert("RGB")


def main() -> None:
    for spec in IMAGES:
        path = HERE / spec["name"]
        # optimize=False + compress_level 固定 → 同一份 PIL 下逐字节可重现
        draw(spec).save(path, format="PNG", optimize=False, compress_level=6)
        print(f"wrote {path.name} ({path.stat().st_size} bytes)")
    (HERE / "specs.json").write_text(json.dumps(PROBES, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote specs.json ({len(PROBES)} probe(s); consumed by record_golden.py)")


if __name__ == "__main__":
    main()
