"""Grounding DINO 主体检测侧车（#3469，指南 §2.3 的附录对照方法）。

这是**冻结 benchmark evaluator** 的一部分：给一批图片按一句文字提示出主体框，别的什么都不做。
不裁图、不算嵌入、不做任何判定、不联网。裁切与判定在 TS 侧的纯函数里
（`benchmarks/design-anything/tools/evaluator/subjectSimilarity.ts`），嵌入复用 CSD 侧车的 backbone 内容向量，
拿缓存的框就能离线复算。

## 模型

Liu et al., *Grounding DINO: Marrying DINO with Grounded Pre-Training for Open-Set Object
Detection*（arXiv:2303.05499）。这里用 HuggingFace `transformers` 里的官方移植
`IDEA-Research/grounding-dino-tiny`（Swin-T 视觉骨干 + BERT 文本编码器 + DETR 解码器，172M 参数）。

## 为什么这次直接用 `transformers`，而 CSD 那支是手抄的

CSD 上游只能从 git 装、且 `__init__` 会联网下载权重，两点都与「离线、按 sha 复算」冲突，所以那支
抄了视觉塔定义、并用上游算出的黄金向量钉住转写。Grounding DINO 不一样：`transformers` 是钉得住版本的
pip 包，`from_pretrained(local_files_only=True)` 完全离线，而它的结构（可变形注意力 + 文本交叉注意力）
手抄一遍是几千行、错一处也看不出来。所以这里**用上游实现**，`transformers` 版本进 `runtime`。

代价要说清楚：本侧车的自检因此**不能**像 CSD 那样「拿上游实现验证我们的转写」——我们跑的就是上游。
它改为钉另外三件事，见 `self_test()`。

## 协议

- 输入：stdin 一份 UTF-8 JSON：

      {"weights": dir, "expectSha256": hex, "expectFiles": {name: hex, ...},
       "device": "cpu"|"cuda", "prompt": "logo.", "boxThreshold": 0.3, "textThreshold": 0.25,
       "images": [path...], "out": path}

  **阈值由请求给，没有默认值**：它们是判据的一部分，写死在两处早晚会漂。唯一写入点在 TS 侧的
  `subjectSimilarity.ts`，这里缺一个就 `ok: false`。
- 输出：框写进请求指定的 `out` 文件（Node `execFile` 的 stdout 缓冲缺省 1 MiB）；stdout **只回一行**
  状态 JSON。所有日志走 stderr。
- 输出文件里 `detections` / `failures` 都**按输入下标**（字符串 "0", "1", …）键控，不按路径：
  路径只在 TS 侧存在一份，往返编码再出问题也不会让 key 对不上。
- 框是**原图像素坐标**的 `[x0, y0, x1, y1]`（浮点、左上原点）。排序写死为「分数降序，打平按
  x0, y0, x1, y1 升序」——不留给模型的输出顺序决定。
- 每张图最多回 MAX_DETECTIONS 个框（排序后截断）。超过这个数的图对「有几个主体」这件事已经没有
  可用信息，而输出文件不该被 900 个 query 的残渣撑爆。
- **权重 sha 不符 → 不加载、`ok: false`**（fail-closed）。
- **全部输入都失败 → `ok: false`**：仪器整体失灵不叫「东西不够」。

## 为什么 sha 门锁的是一整个目录

CSD 那支只有一个 checkpoint 文件，它的 sha 门顺带是安全门（`torch.load(weights_only=False)` 等于执行
pickle）。这里的权重是 safetensors，**反序列化本身不执行代码**，所以这道门只剩一个理由，
但那一个是承重的：`config.json`（骨干层数、query 数）、`preprocessor_config.json`（缩放边长）、
`tokenizer.json` / `vocab.txt`（提示怎么切分）**每一份都改变读数**。只锁权重文件的话，换一份
preprocessor_config 就能在 sha 不变的情况下让同一批图出不同的框。所以锁的是全部被读的文件。

## 确定性 —— 说到什么程度

给定同一份权重（全部文件的 sha）、同一句提示、同一组阈值、同一张图，框的定义是唯一的。
但神经网络前向的浮点归约顺序取决于 BLAS 线程调度，**跨机器不保证逐位**；同机上线程数也影响位级
结果，所以线程数写死并写进 `runtime`。每张图**单独前向**（不按批）——批大小不同会走不同的矩阵乘核。

## Windows 陷阱

- `python3` 是商店空壳（退出码 49、无输出），TS 侧缺省调 `python`。
- 管道 stdin/stdout 缺省是 GBK：TS 侧 spawn 带 `PYTHONUTF8=1`，这里再 `reconfigure` 一次双保险。

## 隔离铁律

与 `subjectSimilarity.ts` / `setSimilarity.ts` / `identity.ts` 同款：运行时机制（#3177 runtime
auditor）**禁止**复用本侧车与这份权重 sha。运行时机制与量尺共享偏差 = 自证循环。
"""

from __future__ import annotations

import os

# CUDA 上 `use_deterministic_algorithms(True)` 要求它在 CUDA 初始化之前存在，否则第一次矩阵乘就抛。
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
# 侧车是离线的：任何一次「顺手去 hub 看一眼」都会让读数取决于网络状态。
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import argparse
import hashlib
import json
import platform
import sys
from pathlib import Path

import torch
import torchvision
import transformers
from PIL import Image
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

MODEL_ID = "grounding-dino-tiny"
# 预处理是判据的一部分：改了这一串必须同时 bump TS 侧的 SUBJECT_RULE_VERSION。
PREPROCESS = "alpha-composite-on-white,rgb,hf-grounding-dino-processor(preprocessor_config.json)"
# 线程数写死：它影响位级结果，不能取决于跑在谁的机器上。与 CSD 侧车同一个数。
THREADS = 8
# 每张图最多回多少个框（排序后截断）。见模块头。
MAX_DETECTIONS = 50

# 自检的三条容差，含义见 self_test()
GOLDEN_MIN_IOU = 0.85
GOLDEN_BOX_TOLERANCE = 0.5
GOLDEN_SCORE_TOLERANCE = 1e-3

SIDECAR_DIR = Path(__file__).resolve().parent
LOCK_FILE = SIDECAR_DIR / "weights.lock.json"
GOLDEN_DIR = SIDECAR_DIR / "golden"


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# 加载
# ---------------------------------------------------------------------------


def load_model(weights: Path, expect_sha256: str, expect_files: dict, device: str):
    """sha 门 → `from_pretrained`。**顺序不可交换**（见模块头「为什么 sha 门锁的是一整个目录」）。"""
    if not weights.is_dir():
        raise FileNotFoundError(f"weights directory not found: {weights}")
    primary = weights / "model.safetensors"
    if not primary.is_file():
        raise FileNotFoundError(f"model.safetensors not found under {weights}")
    actual = sha256_file(primary)
    if actual != expect_sha256.lower():
        raise ValueError(
            f"model.safetensors sha256 mismatch: expected {expect_sha256}, got {actual} — refusing to load"
        )
    for name in sorted(expect_files):
        companion = weights / name
        if not companion.is_file():
            raise FileNotFoundError(f"locked companion file missing: {companion}")
        got = sha256_file(companion)
        if got != str(expect_files[name]).lower():
            raise ValueError(
                f"{name} sha256 mismatch: expected {expect_files[name]}, got {got} — refusing to load"
            )

    processor = AutoProcessor.from_pretrained(str(weights), local_files_only=True)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(str(weights), local_files_only=True)
    model.eval()
    model.to(device)
    return processor, model, actual


# ---------------------------------------------------------------------------
# 预处理与前向
# ---------------------------------------------------------------------------


def open_rgb(path: Path) -> Image.Image:
    """带 alpha 的图先合成到不透明白底再转 RGB —— 与 CSD 侧车逐字同一条理由。

    直接 `convert("RGB")` 只是丢弃 alpha：透明像素底下的 RGB 是编码器随手留的任意值，
    会让一张透明底 logo 检不检得出来取决于编码器而不是画面。
    """
    image = Image.open(path)
    image.load()
    has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
    if has_alpha:
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")
    return image.convert("RGB")


def runtime_info(device: str) -> dict:
    return {
        "python": platform.python_version(),
        "torch": torch.__version__,
        "torchvision": torchvision.__version__,
        "transformers": transformers.__version__,
        "device": device,
        "threads": torch.get_num_threads(),
    }


def configure_torch(device: str) -> None:
    torch.set_num_threads(THREADS)
    torch.set_grad_enabled(False)
    torch.use_deterministic_algorithms(True)
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("device=cuda requested but torch.cuda.is_available() is False")


def normalize_prompt(prompt: str) -> str:
    """Grounding DINO 的提示约定：小写、以 `.` 结尾。原样传会让同义写法出不同结果。"""
    text = " ".join(prompt.lower().split())
    return text if text.endswith(".") else text + "."


def detect_one(processor, model, device, image_path, prompt, box_threshold, text_threshold):
    image = open_rgb(image_path)
    inputs = processor(images=image, text=prompt, return_tensors="pt").to(device)
    outputs = model(**inputs)
    # target_sizes 是 (height, width)，回来的框就是原图像素坐标
    results = processor.post_process_grounded_object_detection(
        outputs,
        inputs["input_ids"],
        threshold=box_threshold,
        text_threshold=text_threshold,
        target_sizes=[(image.height, image.width)],
    )[0]
    labels = results["text_labels"] if "text_labels" in results else results["labels"]
    detections = []
    for box, score, label in zip(results["boxes"], results["scores"], labels):
        detections.append(
            {"box": [float(v) for v in box.tolist()], "score": float(score), "label": str(label)}
        )
    # 排序写死：分数降序，打平按坐标升序。模型的输出顺序不进读数
    detections.sort(key=lambda d: (-d["score"], d["box"][0], d["box"][1], d["box"][2], d["box"][3]))
    return detections[:MAX_DETECTIONS]


def detect_all(processor, model, device, images, prompt, box_threshold, text_threshold):
    """逐张单独前向（不按批，见模块头）。单张失败只记这一张。"""
    detections: dict = {}
    failures: dict = {}
    for index, path in enumerate(images):
        try:
            detections[str(index)] = detect_one(
                processor, model, device, path, prompt, box_threshold, text_threshold
            )
        except Exception as error:  # noqa: BLE001 —— 单张图的任何解码/前向错误都只记这一张
            failures[str(index)] = f"{type(error).__name__}: {error}"
    return detections, failures


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def emit(status: dict, code: int) -> int:
    sys.stdout.write(json.dumps(status, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return code


def run_request() -> int:
    try:
        request = json.load(sys.stdin)
        device = request.get("device", "cpu")
        images = [Path(p) for p in request["images"]]
        out = Path(request["out"])
        expect = str(request["expectSha256"]).lower()
        expect_files = {k: str(v).lower() for k, v in (request.get("expectFiles") or {}).items()}
        prompt = normalize_prompt(str(request["prompt"]))
        # 阈值没有默认值：判据的一部分只许有一个写入点（TS 侧）
        box_threshold = float(request["boxThreshold"])
        text_threshold = float(request["textThreshold"])
    except Exception as error:  # noqa: BLE001 —— 畸形请求也要走协议回话，不能吐一个 traceback
        return emit({"ok": False, "reason": f"malformed request: {type(error).__name__}: {error}"}, 1)
    try:
        # 调用方传来的 sha 必须就是锁文件里那些：fail-closed 不能靠「调用方会传对」
        lock = json.loads(LOCK_FILE.read_text(encoding="utf-8"))
        if expect != str(lock["sha256"]).lower():
            raise ValueError(f"expectSha256 {expect} does not match {LOCK_FILE.name} ({lock['sha256']})")
        locked_files = {k: str(v).lower() for k, v in lock["files"].items()}
        if expect_files != locked_files:
            raise ValueError(f"expectFiles does not match {LOCK_FILE.name}")
        configure_torch(device)
        processor, model, sha = load_model(Path(request["weights"]), expect, locked_files, device)
    except Exception as error:  # noqa: BLE001 —— 侧车整体不可用，理由原样交给 TS 写进读数
        return emit({"ok": False, "reason": f"{type(error).__name__}: {error}"}, 2)

    detections, failures = detect_all(processor, model, device, images, prompt, box_threshold, text_threshold)
    if images and not detections:
        return emit(
            {
                "ok": False,
                "reason": f"every input failed ({len(failures)}/{len(images)}): "
                + json.dumps(failures, ensure_ascii=False)[:500],
            },
            3,
        )

    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "model": MODEL_ID,
        "weightsSha256": sha,
        "runtime": runtime_info(device),
        "preprocess": PREPROCESS,
        "prompt": prompt,
        "boxThreshold": box_threshold,
        "textThreshold": text_threshold,
        "maxDetections": MAX_DETECTIONS,
        "detections": detections,
        "failures": failures,
    }
    tmp = out.with_suffix(out.suffix + f".{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, out)
    finally:
        # rename 成功后 tmp 已不存在；失败时不留一个半截文件在临时目录里
        tmp.unlink(missing_ok=True)
    return emit({"ok": True, "out": str(out), "count": len(detections), "failures": len(failures)}, 0)


# ---------------------------------------------------------------------------
# 自检
# ---------------------------------------------------------------------------


def iou(a, b) -> float:
    x0 = max(a[0], b[0])
    y0 = max(a[1], b[1])
    x1 = min(a[2], b[2])
    y1 = min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def assert_sha_gate_precedes_load(weights: Path, locked_files: dict) -> None:
    """证明 sha 门在 `from_pretrained` 之前 —— 不是声称，是当场跑一遍。

    这里的理由不是「反序列化会执行代码」（safetensors 不会），而是**读数的可复算性**：
    换一份 config / preprocessor / tokenizer 就是换了一把尺子。门在加载之后 = 门形同虚设。
    给 `from_pretrained` 打计数桩，用一个假 sha 调 `load_model`，要求它抛 `ValueError` 且计数为 0。
    """
    calls = 0
    real_processor = AutoProcessor.from_pretrained
    real_model = AutoModelForZeroShotObjectDetection.from_pretrained

    def counting(real):
        def wrapper(*args, **kwargs):
            nonlocal calls
            calls += 1
            return real(*args, **kwargs)

        return wrapper

    AutoProcessor.from_pretrained = counting(real_processor)
    AutoModelForZeroShotObjectDetection.from_pretrained = counting(real_model)
    try:
        load_model(weights, "0" * 64, locked_files, "cpu")
    except ValueError:
        pass
    else:
        raise AssertionError("load_model accepted a wrong sha256")
    finally:
        AutoProcessor.from_pretrained = real_processor
        AutoModelForZeroShotObjectDetection.from_pretrained = real_model
    if calls != 0:
        raise AssertionError(f"from_pretrained ran {calls} time(s) before the sha gate rejected the weights")


def self_test(weights: Path, device: str) -> int:
    """自检钉三件事。

    1. **sha 门在加载之前**（见 `assert_sha_gate_precedes_load`）。
    2. **外部真值**：黄金图里的形状是 `golden/make_golden_images.py` 画上去的，`groundTruth`
       就是那几个矩形的坐标 —— 与本实现无关。要求检出框与真值的 IoU ≥ GOLDEN_MIN_IOU。
       这一条不是自说自话：它验证「这条流水线确实在检测画面里那个东西」。
    3. **流水线钉死**：`box` / `score` 与随附读数逐项吻合（≤ 0.5 px / 1e-3）。这一条才是回归门 ——
       改坏预处理（例如去掉 alpha 合成、换缩放边长）时 IoU 可能还过得去，分数一定会动。

    与 CSD 侧车的自检**不在同一层**，必须说清：那一支拿上游实现验证我们的转写；这一支跑的就是上游
    实现，所以第 2 条验的是「模型 + 我们这套调用」在已知真值上对不对，第 3 条验的是「今天与录黄金
    那天一样」。第 3 条单独看是自指的，配上第 2 条才构成一个有外部锚的自检。
    """
    lock = json.loads(LOCK_FILE.read_text(encoding="utf-8"))
    locked_files = {k: str(v).lower() for k, v in lock["files"].items()}
    goldens = sorted(GOLDEN_DIR.glob("golden-*.json"))
    if not goldens:
        return emit({"ok": False, "reason": f"no golden detections under {GOLDEN_DIR}"}, 4)
    try:
        assert_sha_gate_precedes_load(weights, locked_files)
        log("  sha gate precedes from_pretrained: ok")
        configure_torch(device)
        processor, model, _ = load_model(weights, str(lock["sha256"]), locked_files, device)
    except Exception as error:  # noqa: BLE001
        return emit({"ok": False, "reason": f"{type(error).__name__}: {error}"}, 2)

    worst_iou = 1.0
    worst_box_delta = 0.0
    worst_score_delta = 0.0
    report = []
    for golden_file in goldens:
        golden = json.loads(golden_file.read_text(encoding="utf-8"))
        # 黄金读数必须是**这一份**权重算出来的：换了 checkpoint 再拿旧框比，比的是两件不相干的事
        if str(golden["weightsSha256"]).lower() != str(lock["sha256"]).lower():
            return emit(
                {
                    "ok": False,
                    "reason": f"golden {golden_file.name} was produced under weights "
                    f"{golden['weightsSha256']}, not the locked {lock['sha256']}",
                },
                5,
            )
        image = GOLDEN_DIR / golden["image"]
        actual_sha = sha256_file(image)
        if actual_sha != golden["imageSha256"]:
            return emit(
                {"ok": False, "reason": f"golden image {image.name} sha mismatch ({actual_sha} != {golden['imageSha256']})"},
                5,
            )
        got = detect_one(
            processor, model, device, image, golden["prompt"], golden["boxThreshold"], golden["textThreshold"]
        )
        if len(got) != len(golden["detections"]):
            return emit(
                {"ok": False, "reason": f"golden {image.name}: expected {len(golden['detections'])} detection(s), got {len(got)}"},
                6,
            )
        image_box_delta = 0.0
        for expected, actual in zip(golden["detections"], got):
            if expected["label"] != actual["label"]:
                return emit(
                    {"ok": False, "reason": f"golden {image.name}: label {actual['label']!r} != {expected['label']!r}"},
                    6,
                )
            image_box_delta = max(image_box_delta, max(abs(e - a) for e, a in zip(expected["box"], actual["box"])))
            worst_score_delta = max(worst_score_delta, abs(expected["score"] - actual["score"]))
        worst_box_delta = max(worst_box_delta, image_box_delta)
        ious = [iou(t, y["box"]) for t, y in zip(golden.get("groundTruth", []), got)]
        if ious:
            worst_iou = min(worst_iou, min(ious))
        report.append(
            {
                "image": image.name,
                "detections": len(got),
                "maxBoxDelta": image_box_delta,
                "minIou": min(ious) if ious else None,
            }
        )
        log(f"  {image.name}: {len(got)} detection(s), max|Δbox| = {image_box_delta:.3f} px, min IoU = {report[-1]['minIou']}")

    ok = (
        worst_iou >= GOLDEN_MIN_IOU
        and worst_box_delta <= GOLDEN_BOX_TOLERANCE
        and worst_score_delta <= GOLDEN_SCORE_TOLERANCE
    )
    return emit(
        {
            "ok": ok,
            "worstIou": worst_iou,
            "worstBoxDelta": worst_box_delta,
            "worstMaxAbsDelta": worst_score_delta,
            "minIou": GOLDEN_MIN_IOU,
            "boxTolerance": GOLDEN_BOX_TOLERANCE,
            "scoreTolerance": GOLDEN_SCORE_TOLERANCE,
            "runtime": runtime_info(device),
            "images": report,
        },
        0 if ok else 6,
    )


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--self-test", action="store_true", help="对 golden/ 下的黄金框做自检，不读 stdin")
    parser.add_argument(
        "--weights", default=os.environ.get("BENCH_DINO_WEIGHTS"), help="自检用的权重目录（缺省 BENCH_DINO_WEIGHTS）"
    )
    parser.add_argument("--device", default="cpu", choices=("cpu", "cuda"))
    args = parser.parse_args()
    if args.self_test:
        if not args.weights:
            return emit({"ok": False, "reason": "--self-test needs --weights or BENCH_DINO_WEIGHTS"}, 1)
        return self_test(Path(args.weights), args.device)
    return run_request()


if __name__ == "__main__":
    sys.exit(main())
