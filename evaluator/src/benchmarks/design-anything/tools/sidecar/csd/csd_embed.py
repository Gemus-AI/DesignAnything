"""CSD 风格向量侧车（#3374，指南 §2.3 第一层）。

这是**冻结 benchmark evaluator** 的一部分：给一批图片算 CSD 风格向量，别的什么都不做。
不算相似度、不做任何判定、不联网。相似度与判定在 TS 侧的纯函数里
（`benchmarks/design-anything/tools/evaluator/setSimilarity.ts`），拿缓存的向量就能离线复算。

## 模型

Somepalli et al., *Measuring Style Similarity in Diffusion Models*（arXiv:2404.01292）。
结构 = OpenAI CLIP ViT-L/14 视觉塔（去掉原投影）+ 一个 1024→768 的风格投影 `last_layer_style`，
输出 L2 归一化。上游代码 https://github.com/learn2phoenix/CSD（MIT）。

## 为什么不 `import clip` 而是随附视觉塔定义

上游模型类依赖 OpenAI 的 `clip` pip 包（只能从 git 装，钉不住版本），且 `__init__` 里会
`clip.load("ViT-L/14")` **联网下载** CLIP 原权重再被 checkpoint 覆盖。两点都与「离线、按 sha 复算」
冲突。所以这里随附 ViT 视觉塔的定义（按 OpenAI CLIP `model.py` 转写，MIT），从我们钉死的那一个
文件里 `strict=True` 加载全部权重。**转写的数值正确性由 `--self-test` 对黄金向量钉住**
（黄金向量由上游实现算出，见 `golden/reference_upstream.py`）—— 不靠「跑通了」。

## 协议

- 输入：stdin 一份 UTF-8 JSON：
  `{"weights": path, "expectSha256": hex, "device": "cpu"|"cuda", "images": [path...], "out": path}`
- 输出：向量写进请求指定的 `out` 文件（Node `execFile` 的 stdout 缓冲缺省 1 MiB，几十张图就超）；
  stdout **只回一行**状态 JSON：`{"ok": true, "out": path, "count": n, "failures": m}` 或
  `{"ok": false, "reason": ...}` + 非零退出码。所有日志走 stderr。
- 输出文件里 `style` / `content` / `failures` 都**按输入下标**（字符串 "0", "1", …）键控，不按路径：
  路径只在 TS 侧存在一份，往返编码再出问题也不会让 key 对不上。
- **权重 sha 不符 → 不加载、`ok: false`**（fail-closed）。`torch.load(weights_only=False)` 等于执行
  pickle，所以 sha 门必须在它之前。`--self-test` 的第一步就是**证明这一点**：拿一个假 sha 调
  `load_model`，要求它抛 `ValueError` 且 `torch.load` 一次都没被调用（自检里打了计数桩）。
  另外 `run_request` 会把请求里的 `expectSha256` 与 `weights.lock.json` 对一遍 —— 调用方传错
  也不能把这道门绕开。
- **全部输入都失败 → `ok: false`**：仪器整体失灵不叫「东西不够」。

## 确定性 —— 说到什么程度

给定同一份权重（sha）、同一份预处理（`PREPROCESS`）、同一张图，向量的定义是唯一的。
但神经网络前向的浮点归约顺序取决于 BLAS 线程调度，**跨机器不保证逐位**；同机上线程数也影响
位级结果，所以线程数在这里**写死**并写进 `runtime`。读数因此声称的是「可复现到 1e-4 余弦」，
不是「逐位相同」；实测数字由 `calibrateSetSimilarity.ts` 的副本复现检查给出。

## Windows 陷阱

- `python3` 是商店空壳（退出码 49、无输出），TS 侧缺省调 `python`。
- 管道 stdin/stdout 缺省是 GBK：TS 侧 spawn 带 `PYTHONUTF8=1`，这里再 `reconfigure` 一次双保险。

## 隔离铁律

与 `setSimilarity.ts` / `identity.ts` 同款：运行时机制（#3177 runtime auditor）**禁止**复用本侧车
与这份权重 sha。运行时机制与量尺共享偏差 = 自证循环。
"""

from __future__ import annotations

import os

# CUDA 上 `use_deterministic_algorithms(True)` 要求它在 CUDA 初始化之前存在，否则第一次矩阵乘就抛。
os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

import argparse
import hashlib
import json
import platform
import sys
from collections import OrderedDict
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
import torchvision
from PIL import Image
from torchvision import transforms
from torchvision.transforms import InterpolationMode

MODEL_ID = "csd-vit-l"
# 预处理是判据的一部分：改了这一串必须同时 bump TS 侧的 STYLE_RULE_VERSION。
PREPROCESS = "alpha-composite-on-white,rgb,resize224-bicubic,centercrop224,clip-mean-std"
# 线程数写死：CPU 上 MKL 归约顺序随线程数变，不写死则同一台机器换个负载就换个位级结果。
THREADS = 8
# 每张图单独前向，**不按批**：批大小不同会走不同的矩阵乘核（CUDA 上实测同一张图在 16 张一批与
# 尾批里给出不同的位级结果，29 组副本包里 4 组不一致）。一张图的向量不能取决于同一请求里还有哪些图 ——
# 否则缓存里的向量与重算的向量会不一样。代价是吞吐，冻结评估器要的是可复算。
BATCH = 1
GOLDEN_TOLERANCE = 1e-4

CLIP_MEAN = (0.48145466, 0.4578275, 0.40821073)
CLIP_STD = (0.26862954, 0.26130258, 0.27577711)

HERE = Path(__file__).resolve().parent
LOCK_FILE = HERE / "weights.lock.json"
GOLDEN_DIR = HERE / "golden"


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# 随附的 CLIP ViT-L/14 视觉塔（按 OpenAI CLIP model.py 转写，MIT）
# ---------------------------------------------------------------------------


class QuickGELU(nn.Module):
    """CLIP 用的是 x·σ(1.702x)，**不是** `nn.GELU`。两者输出差在小数点后二三位，黄金向量会抓到。"""

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x * torch.sigmoid(1.702 * x)


class ResidualAttentionBlock(nn.Module):
    def __init__(self, d_model: int, n_head: int) -> None:
        super().__init__()
        self.attn = nn.MultiheadAttention(d_model, n_head)
        self.ln_1 = nn.LayerNorm(d_model)
        self.mlp = nn.Sequential(
            OrderedDict(
                [
                    ("c_fc", nn.Linear(d_model, d_model * 4)),
                    ("gelu", QuickGELU()),
                    ("c_proj", nn.Linear(d_model * 4, d_model)),
                ]
            )
        )
        self.ln_2 = nn.LayerNorm(d_model)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.ln_1(x)
        x = x + self.attn(y, y, y, need_weights=False)[0]
        return x + self.mlp(self.ln_2(x))


class Transformer(nn.Module):
    def __init__(self, width: int, layers: int, heads: int) -> None:
        super().__init__()
        self.resblocks = nn.Sequential(*[ResidualAttentionBlock(width, heads) for _ in range(layers)])

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.resblocks(x)


class VisionTransformer(nn.Module):
    """ViT-L/14 视觉塔到 `ln_post(CLS)` 为止（1024 维）。原 CLIP 的 `proj` 在 CSD 里被拿掉了。"""

    def __init__(self, input_resolution: int = 224, patch_size: int = 14, width: int = 1024, layers: int = 24, heads: int = 16) -> None:
        super().__init__()
        self.conv1 = nn.Conv2d(3, width, kernel_size=patch_size, stride=patch_size, bias=False)
        scale = width**-0.5
        self.class_embedding = nn.Parameter(scale * torch.randn(width))
        self.positional_embedding = nn.Parameter(scale * torch.randn((input_resolution // patch_size) ** 2 + 1, width))
        self.ln_pre = nn.LayerNorm(width)
        self.transformer = Transformer(width, layers, heads)
        self.ln_post = nn.LayerNorm(width)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.conv1(x)  # [B, width, grid, grid]
        x = x.reshape(x.shape[0], x.shape[1], -1).permute(0, 2, 1)  # [B, grid², width]
        cls = self.class_embedding.to(x.dtype) + torch.zeros(x.shape[0], 1, x.shape[-1], dtype=x.dtype, device=x.device)
        x = torch.cat([cls, x], dim=1)
        x = x + self.positional_embedding.to(x.dtype)
        x = self.ln_pre(x)
        x = x.permute(1, 0, 2)  # NLD → LND
        x = self.transformer(x)
        x = x.permute(1, 0, 2)  # LND → NLD
        return self.ln_post(x[:, 0, :])


class CsdStyleModel(nn.Module):
    """backbone + 风格投影。参数名与 checkpoint 的 `module.` 剥掉后的 key **完全一致**，故能 strict 加载。"""

    def __init__(self) -> None:
        super().__init__()
        self.backbone = VisionTransformer()
        self.last_layer_style = nn.Parameter(torch.empty(1024, 768))

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        feature = self.backbone(x)
        style = F.normalize(feature @ self.last_layer_style, dim=1, p=2)
        # 校准用的**内容对照**：不过风格投影的 backbone 池化向量。评估器读数不持久化它。
        content = F.normalize(feature, dim=1, p=2)
        return style, content


def load_model(weights: Path, expect_sha256: str, device: str) -> tuple[CsdStyleModel, str]:
    """sha 门 → `torch.load` → strict 加载。**顺序不可交换**：`weights_only=False` 等于执行 pickle。"""
    if not weights.is_file():
        raise FileNotFoundError(f"weights not found: {weights}")
    actual = sha256_file(weights)
    if actual != expect_sha256.lower():
        raise ValueError(f"weights sha256 mismatch: expected {expect_sha256}, got {actual} — refusing to load")
    # checkpoint 顶层带 argparse Namespace，`weights_only=True`（torch ≥ 2.6 缺省）会抛；sha 门已保证
    # 反序列化的是我们钉住的那份字节。`mmap=True` 避免把 1.2 GB 优化器状态读进内存。
    checkpoint = torch.load(str(weights), map_location="cpu", mmap=True, weights_only=False)
    state = checkpoint["model_state_dict"]
    cleaned = OrderedDict()
    for key, value in state.items():
        name = key[len("module.") :] if key.startswith("module.") else key
        if name == "last_layer_content":
            continue
        cleaned[name] = value
    model = CsdStyleModel()
    model.load_state_dict(cleaned, strict=True)
    model.eval()
    model.to(device)
    return model, actual


# ---------------------------------------------------------------------------
# 预处理（上游 `CSD/loss_utils.py` 的 transforms_branch0，外加 alpha 的明确处理）
# ---------------------------------------------------------------------------

_TRANSFORM = transforms.Compose(
    [
        transforms.Resize(224, interpolation=InterpolationMode.BICUBIC),
        transforms.CenterCrop(224),
        transforms.ToTensor(),
        transforms.Normalize(CLIP_MEAN, CLIP_STD),
    ]
)


def open_rgb(path: Path) -> Image.Image:
    """带 alpha 的图先合成到不透明白底再转 RGB。

    直接 `convert("RGB")` 只是丢弃 alpha：透明像素底下的 RGB 是编码器随手留的任意值，
    会让一张透明底 logo 的「风格」取决于编码器而不是画面。
    """
    image = Image.open(path)
    image.load()
    has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
    if has_alpha:
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")
    return image.convert("RGB")


def preprocess(path: Path) -> torch.Tensor:
    return _TRANSFORM(open_rgb(path))


def runtime_info(device: str) -> dict:
    return {
        "python": platform.python_version(),
        "torch": torch.__version__,
        "torchvision": torchvision.__version__,
        "device": device,
        "threads": torch.get_num_threads(),
    }


def configure_torch(device: str) -> None:
    torch.set_num_threads(THREADS)
    torch.set_grad_enabled(False)
    torch.use_deterministic_algorithms(True)
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("device=cuda requested but torch.cuda.is_available() is False")


def embed_all(model: CsdStyleModel, device: str, images: list[Path]) -> tuple[dict, dict, dict]:
    """逐张预处理（单张失败进 failures），按批前向。返回 (style, content, failures)，全部按下标键控。"""
    style: dict[str, list[float]] = {}
    content: dict[str, list[float]] = {}
    failures: dict[str, str] = {}
    ready: list[tuple[int, torch.Tensor]] = []
    for index, path in enumerate(images):
        try:
            ready.append((index, preprocess(path)))
        except Exception as error:  # noqa: BLE001 —— 单张图的任何解码错误都只记这一张
            failures[str(index)] = f"{type(error).__name__}: {error}"
    for start in range(0, len(ready), BATCH):
        chunk = ready[start : start + BATCH]
        batch = torch.stack([tensor for _, tensor in chunk]).to(device)
        style_out, content_out = model(batch)
        style_out = style_out.float().cpu()
        content_out = content_out.float().cpu()
        for row, (index, _) in enumerate(chunk):
            style[str(index)] = style_out[row].tolist()
            content[str(index)] = content_out[row].tolist()
    return style, content, failures


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
    except Exception as error:  # noqa: BLE001 —— 畸形请求也要走协议回话，不能吐一个 traceback
        return emit({"ok": False, "reason": f"malformed request: {type(error).__name__}: {error}"}, 1)
    try:
        # 调用方传来的 expectSha256 必须就是锁文件里那一串：fail-closed 不能靠「调用方会传对」
        locked = json.loads(LOCK_FILE.read_text(encoding="utf-8"))["sha256"].lower()
        if expect != locked:
            raise ValueError(f"expectSha256 {expect} does not match {LOCK_FILE.name} ({locked})")
        configure_torch(device)
        model, sha = load_model(Path(request["weights"]), expect, device)
    except Exception as error:  # noqa: BLE001 —— 侧车整体不可用，理由原样交给 TS 写进读数
        return emit({"ok": False, "reason": f"{type(error).__name__}: {error}"}, 2)

    style, content, failures = embed_all(model, device, images)
    if images and not style:
        return emit({"ok": False, "reason": f"every input failed ({len(failures)}/{len(images)}): {json.dumps(failures, ensure_ascii=False)[:500]}"}, 3)

    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "model": MODEL_ID,
        "weightsSha256": sha,
        "runtime": runtime_info(device),
        "preprocess": PREPROCESS,
        "style": style,
        "content": content,
        "failures": failures,
    }
    tmp = out.with_suffix(out.suffix + f".{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, out)
    finally:
        # rename 成功后 tmp 已不存在；失败时不留一个半截文件在临时目录里
        tmp.unlink(missing_ok=True)
    return emit({"ok": True, "out": str(out), "count": len(style), "failures": len(failures)}, 0)


def assert_sha_gate_precedes_load(weights: Path) -> None:
    """证明 sha 门在 `torch.load` 之前 —— 不是声称，是当场跑一遍。

    `weights_only=False` 等于执行 pickle，所以「先验 sha 再反序列化」这个顺序是承重的。
    这里给 `torch.load` 打一个计数桩，用一个假 sha 调 `load_model`，要求它抛 `ValueError`
    且计数为 0。改坏顺序时这一步立刻红。
    """
    calls = 0
    real_load = torch.load

    def counting_load(*args: object, **kwargs: object) -> object:
        nonlocal calls
        calls += 1
        return real_load(*args, **kwargs)  # type: ignore[arg-type]

    torch.load = counting_load  # type: ignore[assignment]
    try:
        load_model(weights, "0" * 64, "cpu")
    except ValueError:
        pass
    else:
        raise AssertionError("load_model accepted a wrong sha256")
    finally:
        torch.load = real_load  # type: ignore[assignment]
    if calls != 0:
        raise AssertionError(f"torch.load ran {calls} time(s) before the sha gate rejected the weights")


def self_test(weights: Path, device: str) -> int:
    """自检两件事：sha 门在反序列化之前；随附定义算出的向量与上游实现逐维吻合（≤ GOLDEN_TOLERANCE）。"""
    lock = json.loads(LOCK_FILE.read_text(encoding="utf-8"))
    goldens = sorted(GOLDEN_DIR.glob("*.json"))
    if not goldens:
        return emit({"ok": False, "reason": f"no golden vectors under {GOLDEN_DIR}"}, 4)
    try:
        assert_sha_gate_precedes_load(weights)
        log("  sha gate precedes torch.load: ok")
        configure_torch(device)
        model, _ = load_model(weights, lock["sha256"], device)
    except Exception as error:  # noqa: BLE001
        return emit({"ok": False, "reason": f"{type(error).__name__}: {error}"}, 2)

    worst = 0.0
    report = []
    for golden_file in goldens:
        golden = json.loads(golden_file.read_text(encoding="utf-8"))
        # 黄金向量必须是**这一份**权重算出来的：换了 checkpoint 再拿旧向量比，比的是两件不相干的事
        if golden["weightsSha256"].lower() != lock["sha256"].lower():
            return emit({"ok": False, "reason": f"golden {golden_file.name} was produced under weights {golden['weightsSha256']}, not the locked {lock['sha256']}"}, 5)
        image = GOLDEN_DIR / golden["image"]
        actual_sha = sha256_file(image)
        if actual_sha != golden["imageSha256"]:
            return emit({"ok": False, "reason": f"golden image {image.name} sha mismatch ({actual_sha} != {golden['imageSha256']})"}, 5)
        style, _, failures = embed_all(model, device, [image])
        if failures:
            return emit({"ok": False, "reason": f"golden image {image.name} failed: {failures}"}, 5)
        expected = torch.tensor(golden["style"])
        got = torch.tensor(style["0"])
        delta = float((expected - got).abs().max())
        worst = max(worst, delta)
        report.append({"image": image.name, "maxAbsDelta": delta})
        log(f"  {image.name}: max|Δ| = {delta:.3e}")
    ok = worst <= GOLDEN_TOLERANCE
    return emit({"ok": ok, "worstMaxAbsDelta": worst, "tolerance": GOLDEN_TOLERANCE, "runtime": runtime_info(device), "images": report}, 0 if ok else 6)


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--self-test", action="store_true", help="对 golden/ 下的黄金向量做数值自检，不读 stdin")
    parser.add_argument("--weights", default=os.environ.get("BENCH_CSD_WEIGHTS"), help="自检用的权重路径（缺省 BENCH_CSD_WEIGHTS）")
    parser.add_argument("--device", default="cpu", choices=("cpu", "cuda"))
    args = parser.parse_args()
    if args.self_test:
        if not args.weights:
            return emit({"ok": False, "reason": "--self-test needs --weights or BENCH_CSD_WEIGHTS"}, 1)
        return self_test(Path(args.weights), args.device)
    return run_request()


if __name__ == "__main__":
    sys.exit(main())
