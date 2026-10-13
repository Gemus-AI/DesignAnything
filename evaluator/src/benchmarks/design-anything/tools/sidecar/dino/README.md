# Grounding DINO 主体检测侧车（#3469）

冻结 benchmark evaluator 的一部分：给一批图片按一句文字提示出主体框，别的什么都不做。选框、裁切规则
与判定在 TS 侧的纯函数里（`benchmarks/design-anything/tools/evaluator/subjectSimilarity.ts`），进程调用与缓存在
`benchmarks/design-anything/tools/evaluator/dinoSidecar.ts`，裁切落盘在 `benchmarks/design-anything/tools/evaluator/subjectCrop.ts`。

它服务的是**附录对照方法**，不是主表的一列：把主体裁出来算嵌入余弦（CIDS），与 `identity.ts` 的双图
身份判定在同一批产物上比一致率与 Cohen's κ。驱动脚本是 `benchmarks/design-anything/tools/compareIdentityRulers.ts`。

## 权重（只接受这一份）

| 项 | 值 |
|---|---|
| 来源 | https://huggingface.co/IDEA-Research/grounding-dino-tiny |
| 结构 | Swin-T 视觉骨干 + BERT 文本编码器 + DETR 解码器，172,250,626 参数 |
| `model.safetensors` sha256 | `1a2412ef99bd74bcd3c2a246fa1e48581f8889a1300c9051974741314fc042f3` |
| 字节 | 689,359,096 |
| 许可证 | Apache-2.0（IDEA-Research/GroundingDINO） |

**锁的不只是权重文件。** `config.json` / `preprocessor_config.json` / `tokenizer.json` /
`tokenizer_config.json` / `special_tokens_map.json` / `added_tokens.json` / `vocab.txt` 各自的 sha 也在
`weights.lock.json` 的 `files` 里，每一份都改变读数（骨干形状、缩放边长、提示怎么切分）。只锁权重的话，
换一份 preprocessor_config 就能在 sha 不变的情况下让同一批图出不同的框。

下载与核对：

```bash
mkdir -p tmp/bench-weights/grounding-dino-tiny
cd tmp/bench-weights/grounding-dino-tiny
for f in config.json preprocessor_config.json tokenizer.json tokenizer_config.json \
         special_tokens_map.json added_tokens.json vocab.txt model.safetensors; do
  curl -sSL -o "$f" "https://huggingface.co/IDEA-Research/grounding-dino-tiny/resolve/main/$f"
done
sha256sum model.safetensors   # 必须等于上表那串
```

> ⚠️ **别用 `curl -C -` 续传到一个下了一半的文件上**：本地实测那样会把新内容追加在残缺内容后面，
> 得到一个 780 MB 的坏文件，`safetensors` 报 `incomplete metadata, file not fully covered`。
> 重下就删掉重来。

缺省路径就是 `tmp/bench-weights/grounding-dino-tiny/`（`tmp/` 已 gitignore）。放在别处时：

```bash
export BENCH_DINO_WEIGHTS=<weights-dir>/grounding-dino-tiny
```

## 环境

系统 `python`（Windows 上 **不是** `python3`，那是商店空壳）。需要的包见 `requirements.txt`，本机
2026-09-06 所用版本：Python 3.11.4、torch 2.7.1+cu118、torchvision 0.22.1+cu118、transformers 5.16.1、
Pillow 11.2.1。不建 venv；换机器按 `requirements.txt` 的版本装。版本进每份读数的 `runtime` 字段。

解释器可用 `BENCH_PYTHON` 覆盖。

## 自检

```bash
BENCH_DINO_WEIGHTS=... python benchmarks/design-anything/tools/sidecar/dino/detect.py --self-test
```

它钉三件事，**层次不同，要分开看**：

1. **sha 门在 `from_pretrained` 之前**。给加载函数打计数桩，用一个假 sha 调一次，要求它抛
   `ValueError` 且计数为 0。这里的理由不是「反序列化会执行代码」（safetensors 不会），而是读数的
   可复算性 —— 门在加载之后等于没有门。
2. **外部真值**：`golden/*.png` 是 `make_golden_images.py` 画出来的合成图（逐字节可重现），
   `groundTruth` 就是那几个矩形的坐标，**与本实现无关**。要求检出框与它的 IoU ≥ 0.85。
   2026-09-06 实测最差 0.936。
3. **流水线钉死**：框与分数要与 `golden/golden-*.json` 里记录的逐项吻合（≤ 0.5 px / 1e-3）。
   2026-09-06 实测两次独立进程都是 0.0（同机逐位相同）。

第 3 条单独看是自指的（黄金读数就是本实现录的），配上第 2 条才构成一个有外部锚的自检。
这一点与 CSD 侧车**不同**：那一支是手抄的转写，黄金向量由上游实现算出，所以它的自检直接验证转写；
这一支跑的就是上游实现，没有转写可验。

**不是空转绿**：把 `open_rgb` 的 alpha 合成关掉（透明底当黑色），自检立刻红 ——
`alpha-circle.png` 的框偏 0.513 px、分数偏 6.1e-3，都越界。

黄金件的重录（**只在换权重时**）：

```bash
python benchmarks/design-anything/tools/sidecar/dino/golden/make_golden_images.py          # 出 *.png 与 specs.json
BENCH_DINO_WEIGHTS=... python benchmarks/design-anything/tools/sidecar/dino/golden/record_golden.py   # 出 golden-*.json
```

`record_golden.py` 落盘前会自己核一遍外部真值（IoU + 检出个数），核不过就拒绝写 —— 一份录错的黄金
会让之后每一次自检都在钉一个错的东西。

## 协议

stdin 一份 UTF-8 JSON（TS 侧 spawn 带 `PYTHONUTF8=1`，否则 Windows 管道是 GBK）：

```json
{ "weights": "…/grounding-dino-tiny", "expectSha256": "1a24…", "expectFiles": { "config.json": "eec8…" },
  "device": "cpu", "prompt": "logo.", "boxThreshold": 0.3, "textThreshold": 0.25,
  "images": ["…png"], "out": "…json" }
```

**两个阈值没有默认值**，缺一个就 `ok: false`：它们是判据的一部分，唯一写入点在
`subjectSimilarity.ts` 的 `DETECT_BOX_THRESHOLD` / `DETECT_TEXT_THRESHOLD`。

框写进 `out` 文件（`execFile` 的 stdout 缓冲只有 1 MiB），stdout 只回一行状态 JSON。输出文件里
`detections`（每项 `{box, score, label}`，框是原图像素坐标 `[x0,y0,x1,y1]`）与 `failures` 都按**输入下标**
键控。每张图最多回 50 个框，排序写死为「分数降序，打平按坐标升序」。全部输入失败 → `ok: false`。

## 一个必须知道的模型脾气

**主体不在画面里时，它不会什么都不回，而是回一个覆盖整幅画面的框。** `golden/` 里有一条探针
（`blank-whole-frame`）专门钉住它：纯白图 + 提示 `a logo.` → 全图框、score 0.344。

这对 CIDS 是承重的：全图框上的「主体嵌入」就是整图嵌入，也就是 #3374 已经交付的 CSD 内容向量那一列。
所以 `subjectSimilarity.ts` 的每条读数都带 `wholeFrame` 标记，附录里必须报「有多少对是在全图上比的」——
否则「CIDS 与身份尺一致」可能只是「整图嵌入与身份尺一致」，那不是一个独立的对照。

同一张纯白图上提示 `a giraffe.` 则是零检出（另一条探针 `blank-absent`），可见这个脾气与提示词和画面
的语义距离有关，不是无条件的。

## 确定性说到什么程度

- 权重与全部伴生文件的 sha、预处理串（`PREPROCESS`）、两个阈值、线程数（8）、**每张图单独前向**
  （不按批）都写死；改任一处要 bump TS 侧的 `SUBJECT_RULE_VERSION`。
- 同机同设置：2026-09-06 实测五条黄金探针两个独立进程逐位相同（`max|Δbox|` = 0.0、`max|Δscore|` = 0.0）。
  跨机器不逐位，读数带 `runtime`。

## 隔离铁律

运行时机制（#3177 runtime auditor）**禁止**复用本侧车与这份权重 sha。运行时机制与量尺共享偏差 =
自证循环。守卫在 `benchmarks/design-anything/tools/__tests__/setSimilarity.test.ts`（扫 `src/` 有无 `subjectSimilarity` /
`dinoSidecar` / `weights.lock` 等探针）。
