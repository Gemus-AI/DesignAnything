# Changes from the scored source tree

The files under `src/` are byte-for-byte the files of the original repository at commit `a64a40530`, with two exceptions.

1. `evaluator/src/benchmarks/design-anything/tools/evaluator/vlm.ts` is the original file (git object id `7c3809811f53f5ef7e376a39a9954217dcaafe27`) with the scoring-only judge-switch patch of commit `7f88b8eb9` applied by a clean three-way merge. `README.md` describes the patch.
2. Absolute paths on the authors' machines (a drive letter followed by a directory) were replaced by a placeholder. Every replacement is listed below. The original text is deliberately not reproduced; the "original blob" column is the git object id of the unmodified file, so anyone holding the original tree can verify the list.

All replacements are in comments, documentation or usage examples; none changes program behaviour.

| File | Line | Original blob (git object id) | Replaced by |
| --- | --- | --- | --- |
| `evaluator/src/benchmarks/design-anything/tools/deliveryTier.ts` | 41 | `cd82b4b03450f8fa809f18cab74fc21b129c8ab1` | `<batch-root>` |
| `evaluator/src/benchmarks/design-anything/tools/evaluator/sidecarPreflight.ts` | 28 | `d8568b14ff2e86a4bdf5306758853dbff29168f1` | `<weights-dir>` |
| `evaluator/src/benchmarks/design-anything/tools/importExternalRun.ts` | 47 | `8dc0edb1a058f9bfc51d3b9b07b9af8719ea3446` | `<export-dir>` |
| `evaluator/src/benchmarks/design-anything/tools/sidecar/csd/README.md` | 30 | `48b9327105096e4cb4774505277032b801cba1e2` | `<weights-dir>` |
| `evaluator/src/benchmarks/design-anything/tools/sidecar/dino/README.md` | 44 | `f63f60283397c7ba256b0e2c13864cf4461f81e5` | `<weights-dir>` |
| `evaluator/src/benchmarks/design-anything/tools/sidecar/dino/golden/record_golden.py` | 9 | `84f1cd06e7b0e36708092ee1e06b401c572a8a13` | `<weights-dir>` |
