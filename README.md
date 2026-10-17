# DesignAnything-Bench

DesignAnything-Bench is the benchmark introduced in the paper *Design Anything, Design at Scale*. It contains 228 design tasks across 19 design domains. Each task gives a system an English client brief, supplied materials and a list of requested deliverables, and the evaluator scores the files the system delivers.

Project page: <https://designanything.gemus.ai>

Datasets: input images <https://huggingface.co/datasets/Gemus-AI/DesignAnything-Bench> and Design Anything results <https://huggingface.co/datasets/Gemus-AI/DesignAnything-Results>

## What this repository contains

| Path | Contents | Status |
| --- | --- | --- |
| `benchmark/` | The 228 tasks received by the two Design Anything configurations (`brief.md`, `scenario.json`, `spec.json` per task), the scoring corpus the official scores were computed against, and an index | Released |
| `benchmark/KNOWN_ISSUES.md` | Where the scoring corpus differs from the tasks the agents received, and other caveats | Released |
| `protocol/PROTOCOL.md` | The evaluation protocol: task format, export-pack format, measures, judge configuration | Released |
| `evaluator/` | Source snapshot of evaluator v1.18 as used for the official scores, with notes on its provenance and on the internal modules it depends on | Released as readable source; it does not run on its own |
| Input images | The reference images that some tasks supply (the `referenceAssets` of each `scenario.json`) | Not in this repository; released as the Hugging Face dataset [DesignAnything-Bench](https://huggingface.co/datasets/Gemus-AI/DesignAnything-Bench) |
| Results | Design Anything outputs and per-task evaluation records | Not in this repository; released as the Hugging Face dataset [DesignAnything-Results](https://huggingface.co/datasets/Gemus-AI/DesignAnything-Results) |

The text materials that tasks supply are embedded in each `scenario.json`, so every task is complete except for its input images.

## Benchmark at a glance

- 19 domains × 12 tasks = 228 tasks, corresponding to 152 distinct projects.
- 38 project families appear at three scales, requesting 6, 14 and 24 artifacts (114 tasks). These families share background and inputs across scales.
- 57 reference-material tasks and 57 breadth tasks are independent projects requesting 6 or 14 artifacts each.
- The paper reports results for corpus `v0.6` and evaluator `v1.18`. The corrected scoring corpus has digest `sha256:c21d5896cb922e2bbc4bb00dac0b8597bbb903c3cdfa784f606aa09a6b0902ed`. Six corrected Book A evaluations name this corpus; the remaining 450 retain the earlier `3e7c05f5` identity.

See `benchmark/README.md` for the file formats and `protocol/PROTOCOL.md` for how outputs are scored.

## What you can and cannot check with this release

What we verified before publishing, and what you can check yourself today:

- **Tasks.** We verified that the files in `benchmark/tasks/` are byte-identical to the task files bundled with the runs reported in the paper (`benchmark/README.md` says how strongly for each task). The run archives are not public, so you can check this only through the digests in `index.csv`; the Results dataset publishes each run's outputs and evaluation, not the task files the run received.
- **Scoring corpus.** Recompute the digest of `benchmark/scoring-corpus/v0.6-c21d5896/tasks/` and reconstruct the earlier corpus with the historical Book A overlay (`benchmark/README.md` shows how). Each evaluation's per-task `specSha` was checked against the corpus named by its own `taskSetSha`.
- **Evaluator.** You can read the evaluator code and the exact prompts it sent to the judge. According to the scoring notes, 101 of the original 456 records were produced by exactly this code; for the other original records and the six corrected evaluations, `evaluator/README.md` explains what is and is not known.
- You cannot yet re-run the evaluator from this repository: it imports a few modules of the platform it was developed in. `evaluator/README.md` lists them and what each does.
- The judge's replies and the per-task evaluation records are not in this repository, so the paper's numbers cannot be recomputed from it alone. The evaluation records are published with the outputs in the Results dataset.

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
