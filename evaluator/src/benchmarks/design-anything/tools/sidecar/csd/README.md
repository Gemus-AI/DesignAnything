# CSD 风格向量侧车（#3374）

冻结 benchmark evaluator 的一部分：给一批图片算 CSD 风格向量（Somepalli et al., *Measuring Style Similarity in
Diffusion Models*, arXiv:2404.01292），别的什么都不做。相似度与判定在 TS 侧的纯函数里
（`benchmarks/design-anything/tools/evaluator/setSimilarity.ts`），进程调用与缓存在 `benchmarks/design-anything/tools/evaluator/csdSidecar.ts`。

## 权重（只接受一份）

| 项 | 值 |
|---|---|
| 来源 | https://huggingface.co/tomg-group-umd/CSD-ViT-L/resolve/main/pytorch_model.bin |
| sha256 | `40e92fad63a361b8136100cd234c42d401ef9b34ff1748234318929ebcc7e7a1` |
| 字节 | 2,438,228,893 |
| 许可证 | 权重 CC-BY-4.0（HF 模型卡）；上游代码 MIT（github.com/learn2phoenix/CSD） |

sha 只写在 `weights.lock.json` 一处；TS 侧读它放进请求，Python 侧只认请求里的值，**不符就不加载**。

下载与核对：

```bash
mkdir -p tmp/bench-weights/csd-vit-l
curl -L -o tmp/bench-weights/csd-vit-l/pytorch_model.bin \
  https://huggingface.co/tomg-group-umd/CSD-ViT-L/resolve/main/pytorch_model.bin
sha256sum tmp/bench-weights/csd-vit-l/pytorch_model.bin   # 必须等于上面那串
```

缺省路径就是 `tmp/bench-weights/csd-vit-l/pytorch_model.bin`（`tmp/` 已 gitignore）。放在别处时：

```bash
export BENCH_CSD_WEIGHTS=<weights-dir>/csd-vit-l/pytorch_model.bin
```

checkpoint 是训练期存档：顶层 `model_state_dict` / `opt_bb` / `opt_proj` / `iter` / `args` / `fp16_scaler`；
`model_state_dict` 297 个张量、304,752,640 个 fp32 参数、key 带 DataParallel 的 `module.` 前缀，含完整
ViT-L/14 视觉塔（无 `backbone.proj`）、`last_layer_style` 1024×768、`last_layer_content` 1024×768（本列不用）。
侧车只取 `model_state_dict`、剥 `module.`、丢 `last_layer_content`，对随附的视觉塔定义 `strict=True` 加载。
顶层带 argparse `Namespace`，所以 `torch.load` 必须 `weights_only=False`，且**只能在 sha 门之后**。

## 环境

系统 `python`（Windows 上 **不是** `python3`，那是商店空壳）。需要的包见 `requirements.txt`，本机
2026-09-06 校准所用版本：Python 3.11.4、torch 2.7.1+cu118、torchvision 0.22.1+cu118、Pillow 11.2.1。
不建 venv、不 pip install；换机器按 `requirements.txt` 的版本装。版本进每份读数的 `runtime` 字段。

解释器可用 `BENCH_PYTHON` 覆盖。

## 自检（黄金向量）

侧车随附了一份 ViT 视觉塔定义（按 OpenAI CLIP `model.py` 转写，MIT），而不是 `import clip`（上游 pip 包只能从
git 装、且 `__init__` 会联网下载 CLIP 原权重）。转写的数值正确性由 `golden/` 钉住：

```bash
BENCH_CSD_WEIGHTS=... python benchmarks/design-anything/tools/sidecar/csd/csd_embed.py --self-test
```

`golden/*.png` 是四张合成图（宽 / 竖 / 方 / 带 alpha，`make_golden_images.py` 生成，逐字节可重现），
`golden/*.json` 是**上游实现**（`golden/reference_upstream.py`，一次性 venv 里跑）对同一批图算出的风格向量。
自检要求逐维 `max|Δ| ≤ 1e-4`；2026-09-06 实测 4e-7。把 QuickGELU 换成 `nn.GELU` 时自检变红（`max|Δ|` 0.07），
所以它不是空转绿。

## 协议

stdin 一份 UTF-8 JSON（TS 侧 spawn 带 `PYTHONUTF8=1`，否则 Windows 管道是 GBK）：

```json
{ "weights": "...", "expectSha256": "40e9…", "device": "cpu", "images": ["...png"], "out": "...json" }
```

向量写进 `out` 文件（`execFile` 的 stdout 缓冲只有 1 MiB），stdout 只回一行状态 JSON。输出文件里 `style`
（768 维）、`content`（1024 维 backbone 池化向量，只给校准作对照）、`failures` 都按**输入下标**键控。
全部输入失败 → `ok: false`。

## 确定性说到什么程度

- 权重 sha、预处理串（`PREPROCESS`）、线程数（8）、**每张图单独前向**（不按批 —— 批大小不同会走不同的矩阵乘核，
  CUDA 上实测同一张图在不同批里位级结果不同）都写死；改任一处要 bump `STYLE_RULE_VERSION`。
- 同机同设置：2026-09-06 实测 148 张图两个独立进程逐位相同（CUDA 与 CPU 各自成立）。跨设备不逐位：
  同一批 362 个文件 CPU vs CUDA 的向量最大分量偏差 1.4e-5、最大余弦偏差 2.3e-9。跨机器不保证，
  本列声称的是「可复现到 1e-4 余弦」，读数带 `runtime`。

## 隔离铁律

运行时机制（#3177 runtime auditor）**禁止**复用本侧车与这份权重 sha。运行时机制与量尺共享偏差 = 自证循环。
守卫在 `benchmarks/design-anything/tools/__tests__/setSimilarity.test.ts`（扫 `src/` 有无 `setSimilarity` / `csdSidecar` / `weights.lock`）。
