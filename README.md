# DesignAnything-Bench

DesignAnything-Bench is the benchmark introduced in the paper *Design Anything, Design at Scale*. It contains 228 design tasks across 19 design domains. Each task gives a system an English client brief, supplied materials and a list of requested deliverables, and the evaluator scores the files the system delivers.

Project page: <https://designanything.gemus.ai>

## What this repository contains

| Path | Contents | Status |
| --- | --- | --- |
| `benchmark/` | The 228 tasks exactly as the evaluated agents received them (`brief.md`, `scenario.json`, `spec.json` per task), the scoring corpus the official scores were computed against, and an index | Released |
| `benchmark/KNOWN_ISSUES.md` | Where the scoring corpus differs from the tasks the agents received, and other caveats | Released |
| `protocol/PROTOCOL.md` | The evaluation protocol: task format, export-pack format, measures, judge configuration | Released |
| `evaluator/` | Source snapshot of evaluator v1.18 as used for the official scores, with notes on its provenance and on the internal modules it depends on | Released as readable source; it does not run on its own |
| Input images | The reference images that some tasks supply (the `referenceAssets` of each `scenario.json`) | Not in this repository; planned for release with the dataset |
| Results | Design Anything outputs and per-task evaluation records | Not in this repository; planned for release as a dataset |

The text materials that tasks supply are embedded in each `scenario.json`, so every task is complete except for its input images.

## Benchmark at a glance

- 19 domains × 12 tasks = 228 tasks, corresponding to 152 distinct projects.
- 38 project families appear at three scales, requesting 6, 14 and 24 artifacts (114 tasks). These families share background and inputs across scales.
- 57 reference-material tasks and 57 breadth tasks are independent projects requesting 6 or 14 artifacts each.
- The paper reports results for corpus `v0.6` and evaluator `v1.18`. The task-set digest of the scoring corpus is `sha256:3e7c05f57e269c2964da67774e095d72fe0be0e93b1878f961d75650ec0fb6b9`.

See `benchmark/README.md` for the file formats and `protocol/PROTOCOL.md` for how outputs are scored.

## What you can and cannot check with this release

What we verified before publishing, and what you can check yourself today:

- **Tasks.** We verified that the files in `benchmark/tasks/` are byte-identical to the task files bundled with the runs reported in the paper (`benchmark/README.md` says how strongly for each task). The run archives are not public, so today you can check this only through the digests in `index.csv`; the planned dataset release will let you check it against the runs.
- **Scoring corpus.** You can recompute the digest of `benchmark/scoring-corpus/v0.6-3e7c05f5/tasks/` and compare it with the `taskSetSha` that every official evaluation record names (`benchmark/README.md` shows how). We also verified each record's per-task `specSha` against these files; the records themselves will be released with the dataset.
- **Evaluator.** You can read the evaluator code and the exact prompts it sent to the judge. According to the scoring notes, 101 of the 456 official records were produced by exactly this code; for the rest, `evaluator/README.md` explains what is and is not known.
- You cannot yet re-run the evaluator from this repository: it imports a few modules of the platform it was developed in. `evaluator/README.md` lists them and what each does.
- The judge's replies and the per-task evaluation records are not part of this release, so the paper's numbers cannot be recomputed from this repository alone.

## Verifying the files

Every file except `CHECKSUMS.sha256` is listed in `CHECKSUMS.sha256`. From the repository root:

```bash
sha256sum -c CHECKSUMS.sha256
```

`.gitattributes` disables line-ending conversion (`* -text`), so the checksums hold on any operating system, including Windows clones with `core.autocrlf=true`. The JSON files are published byte for byte; do not reformat them before checking digests.

## License

- The evaluator source code in `evaluator/src/` is licensed under the Apache License 2.0 (`LICENSE`), except for the third-party code and text listed in `THIRD_PARTY_NOTICES`, which remain under their own licenses.
- Everything else (`benchmark/`, `protocol/`, and the documentation outside `evaluator/src/`, including `evaluator/README.md` and `evaluator/CHANGES.md`) is licensed under Creative Commons Attribution 4.0 International (`LICENSE-DATA`). Some task texts contain facts or excerpts from third-party sources; `LICENSE-DATA` lists them with their own terms and the attribution they require.

Copyright 2026 The Design Anything Authors.

## Citation

The paper is not yet publicly available. Until it is, please cite the project page:

```bibtex
@misc{designanything2026,
  title        = {Design Anything, Design at Scale},
  author       = {{The Design Anything Authors}},
  year         = {2026},
  howpublished = {\url{https://designanything.gemus.ai}}
}
```
