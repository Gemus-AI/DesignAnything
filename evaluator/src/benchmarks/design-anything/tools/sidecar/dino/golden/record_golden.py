"""录一份黄金检测读数（#3469）—— **只在换权重时跑**，跑完把 `*.json` 一起 commit。

它做的事：拿 `weights.lock.json` 钉死的那份权重，对 `specs.json` 里每张黄金图跑一次检测，
把框、分数、标签连同权重 sha 与图片 sha 写进 `golden-<id>.json`。`detect.py --self-test` 之后
就拿这份文件比。

**先跑 `make_golden_images.py`**（它写 `*.png` 与 `specs.json`），再跑这支。

    BENCH_DINO_WEIGHTS=<weights-dir>/grounding-dino-tiny \
      python benchmarks/design-anything/tools/sidecar/dino/golden/record_golden.py

录制时会当场核一遍外部真值：每个检出框与 `specs.json` 里那个「画上去的矩形」的 IoU 必须
≥ `detect.py` 的 GOLDEN_MIN_IOU，检出个数必须与真值个数相等。**核不过就不落盘** ——
一份录错的黄金会让之后每一次自检都在钉一个错的东西。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from detect import (  # noqa: E402 —— 必须先把侧车目录放进 sys.path
    GOLDEN_MIN_IOU,
    LOCK_FILE,
    configure_torch,
    detect_one,
    iou,
    load_model,
    normalize_prompt,
    runtime_info,
    sha256_file,
)


def main() -> int:
    weights = os.environ.get("BENCH_DINO_WEIGHTS")
    if not weights:
        print("set BENCH_DINO_WEIGHTS to the model directory", file=sys.stderr)
        return 1
    lock = json.loads(LOCK_FILE.read_text(encoding="utf-8"))
    locked_files = {k: str(v).lower() for k, v in lock["files"].items()}
    specs = json.loads((HERE / "specs.json").read_text(encoding="utf-8"))

    configure_torch("cpu")
    processor, model, sha = load_model(Path(weights), str(lock["sha256"]), locked_files, "cpu")

    for spec in specs:
        image = HERE / spec["image"]
        prompt = normalize_prompt(spec["prompt"])
        box_threshold = float(spec.get("boxThreshold", 0.3))
        text_threshold = float(spec.get("textThreshold", 0.25))
        detections = detect_one(processor, model, "cpu", image, prompt, box_threshold, text_threshold)

        truth = spec["groundTruth"]
        if len(detections) != len(truth):
            print(f"{spec['id']}: {len(detections)} detection(s) but {len(truth)} ground-truth box(es) — refusing to record", file=sys.stderr)
            return 2
        for expected, actual in zip(truth, detections):
            overlap = iou(expected, actual["box"])
            if overlap < GOLDEN_MIN_IOU:
                print(f"{spec['id']}: IoU {overlap:.3f} < {GOLDEN_MIN_IOU} against the expected rectangle — refusing to record", file=sys.stderr)
                return 2

        payload = {
            "id": spec["id"],
            "image": spec["image"],
            "imageSha256": sha256_file(image),
            "weightsSha256": sha,
            "prompt": prompt,
            "boxThreshold": box_threshold,
            "textThreshold": text_threshold,
            "groundTruth": truth,
            "detections": detections,
            "runtime": runtime_info("cpu"),
        }
        out = HERE / f"golden-{spec['id']}.json"
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"wrote {out.name}: {len(detections)} detection(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
