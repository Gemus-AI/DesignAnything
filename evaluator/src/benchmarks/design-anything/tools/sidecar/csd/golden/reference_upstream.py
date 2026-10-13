"""用**上游实现**算黄金向量（#3374）—— 一次性脚本，不进日常路径。

`csd_embed.py` 随附了一份 ViT 视觉塔定义；这个脚本用上游原版（OpenAI `clip` 包 + learn2phoenix/CSD
的 `CSD_CLIP` 类）对同一批图算风格向量并写成 `golden/*.json`。之后 `csd_embed.py --self-test`
拿它逐维比对。两份实现给出同样的数才证明转写是对的；一份实现「跑通了」证明不了任何事。

运行环境（一次性、用完即删，不进 requirements）：
    python -m venv --system-site-packages <tmp>/csdref
    <tmp>/csdref/Scripts/pip install "git+https://github.com/openai/CLIP.git" huggingface_hub ftfy regex tqdm
    git clone --depth 1 https://github.com/learn2phoenix/CSD.git <tmp>/csd-upstream
    <tmp>/csdref/Scripts/python golden/reference_upstream.py --csd-repo <tmp>/csd-upstream --weights <lock 里那份>

注意上游 `CSD_CLIP.__init__` 会 `clip.load("ViT-L/14")` 联网下载 CLIP 原权重到 ~/.cache/clip
（随后被 checkpoint 覆盖）—— 这正是侧车不 import 上游的原因之一。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
LOCK = json.loads((HERE.parent / "weights.lock.json").read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csd-repo", required=True, help="learn2phoenix/CSD 的克隆目录")
    parser.add_argument("--weights", required=True)
    args = parser.parse_args()

    weights = Path(args.weights)
    actual = sha256_file(weights)
    if actual != LOCK["sha256"]:
        print(f"weights sha mismatch: {actual} != {LOCK['sha256']}", file=sys.stderr)
        return 2

    sys.path.insert(0, str(Path(args.csd_repo).resolve()))
    from CSD.loss_utils import transforms_branch0  # type: ignore  # noqa: E402
    from CSD.model import CSD_CLIP  # type: ignore  # noqa: E402
    from CSD.utils import convert_state_dict  # type: ignore  # noqa: E402

    torch.set_grad_enabled(False)
    model = CSD_CLIP("vit_large", "default")
    checkpoint = torch.load(str(weights), map_location="cpu", weights_only=False)
    message = model.load_state_dict(convert_state_dict(checkpoint["model_state_dict"]), strict=False)
    print(f"upstream load: {message}", file=sys.stderr)
    # 上游 `clip.load` 在有 GPU 的机器上默认把 backbone 放到 CUDA；黄金向量按 CPU fp32 算，与侧车缺省一致
    model = model.to("cpu").float()
    model.eval()

    from PIL import Image  # noqa: E402

    for image_path in sorted(HERE.glob("*.png")):
        image = Image.open(image_path)
        image.load()
        # 与侧车同一条 alpha 纪律：合成到白底。上游 loader 用的是 `.convert("RGB")`，但上游数据集里没有
        # 带 alpha 的图；黄金向量要钉的是网络，不是上游 loader 对 alpha 的（未定义的）行为。
        if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
            rgba = image.convert("RGBA")
            bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            image = Image.alpha_composite(bg, rgba).convert("RGB")
        else:
            image = image.convert("RGB")
        tensor = transforms_branch0(image).unsqueeze(0)
        _, _, style = model(tensor)
        vector = style[0].float().tolist()
        out = image_path.with_suffix(".json")
        out.write_text(
            json.dumps(
                {
                    "image": image_path.name,
                    "imageSha256": sha256_file(image_path),
                    "weightsSha256": actual,
                    "producedBy": "upstream learn2phoenix/CSD CSD_CLIP(vit_large) + openai/CLIP ViT-L/14, transforms_branch0",
                    "style": vector,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        print(f"wrote {out.name} (dim {len(vector)}, |v|={sum(v * v for v in vector) ** 0.5:.6f})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
