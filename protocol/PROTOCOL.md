# Evaluation protocol

This document describes how DesignAnything-Bench tasks are given to a system and how the delivered files are scored. It follows the benchmark-protocol appendix of the paper *Design Anything, Design at Scale* and adds the file formats a reader needs to work with the released files. Where this document and the paper differ, the paper's definitions of the measures take precedence; the formats below are taken from the evaluator source in `evaluator/`.

Versions covered: corpus `v0.6`, evaluator `v1.18`, rubric `deterministic-2026-08-23.2`.

## 1. Tasks

The benchmark has 228 tasks in 19 design domains, 12 per domain:

| Task condition | Tasks per domain | 6 artifacts | 14 artifacts | 24 artifacts | Tasks | Projects |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Matched scales | 2 × 3 = 6 | 38 | 38 | 38 | 114 | 38 |
| Reference materials | 3 | 26 | 31 | 0 | 57 | 57 |
| Breadth | 3 | 19 | 38 | 0 | 57 | 57 |
| Total | 12 | 83 | 107 | 38 | 228 | 152 |

Each domain contributes two project families, each at three scales sharing background and inputs: one family asks the system to propose alternatives and select one, the other fixes the direction in the brief. Only the 14- and 24-artifact versions request process artifacts, such as alternative directions and specifications. Reference-material tasks test whether supplied objects are matched; breadth tasks add subjects and audiences. Only the base families support comparisons across scale.

The 19 domains are product design; vehicle styling; furniture and home products; architecture; interior design; exhibition design; landscape design; fashion and textiles; jewelry and accessories; brand identity; graphic design and advertising; books and illustration; packaging; UI/UX; information design and data visualization; animation and storyboarding; game art and worldbuilding; e-commerce product imagery; and advertising and fashion photography.

## 2. What a system receives

A system receives the English brief and the supplied materials, and nothing else:

- the brief: `steps[0].userMessage` of `scenario.json` (also `brief.md`);
- the text materials: each `text-prompt` node of `setup.initialCanvas.nodes` carries one document in full;
- the image materials: the files listed in `referenceAssets` (released as the Hugging Face dataset DesignAnything-Bench, https://huggingface.co/datasets/Gemus-AI/DesignAnything-Bench).

Systems never see the evaluation specification. In the paper, no system used skills written for a particular design domain, and none received task-specific hints. Each task contributes one final result per configuration.

### Runner-specific fields

`scenario.json` also configures the runner used for the paper's own system. These fields are published unchanged; other systems can ignore them:

- `budget`: per turn, at most 120 tool calls, 120 model steps and 90 minutes (`maxWallTimeMs` 5,400,000).
- `steps[1]` is a `nudge` step with `maxTotalTurns` 100 and `advanceIdleTimeoutMs` 180,000. After the brief, the runner keeps the session going: while the system has not finished, it sends a content-neutral follow-up message, at most up to 100 turns in total. The follow-up never restates any deliverable. The runner used two fixed messages, unchanged throughout the runs reported in the paper:
  - default: "Continue working until everything the original brief asks for is fully delivered. If everything is already delivered, say so briefly and make no canvas changes."
  - after turns that changed nothing on the canvas: "You have made no changes to the canvas. Stop asking questions and stop planning in prose: the brief already contains everything you need, and any remaining ambiguity is yours to resolve with your own judgement. Create the nodes and produce the deliverables now."
- `permissionMode`, `graphContract`, `targetFunctionalNodeRange`, `targetZoneRange`: settings of that runner.

The resource and controller limits of each configuration in the paper are listed in the paper's appendix on systems and results.

## 3. Output: the export pack

The evaluator never reads a system's internal representation. It reads an **export pack**: one directory per run, containing the delivered files and a manifest.

```text
<runKey>/
  manifest.json
  artifacts/<file>      every delivered file the manifest lists
```

`runKey` is `<taskId>--r<n>`. The Design Anything packs also contain `workflows/` (a canvas snapshot) and `inputs/` (copies of the supplied materials); the evaluator does not score either.

Packs for other systems are produced from their output directories by the importer `evaluator/src/benchmarks/design-anything/tools/importExternalRun.ts`, so that every system is scored through the same reader. The importer records supplied inputs as inputs, groups several formats of the same work so that a preview and its source count once, and does not read the other system's internal process records.

### `manifest.json`

The official runs used manifest versions 17 (DeepSeek-backed Design Anything runs) and 18 (GPT-backed runs). Version 18 only adds the optional diagnostic `llm.cellCostUsd`; the evaluator scores both versions identically. The fields the evaluator reads are:

| Field | Meaning |
| --- | --- |
| `manifestVersion` | Pack format version. The evaluator refuses packs older than version 5 |
| `scenarioId`, `benchTaskId`, `benchmarkVersion`, `runKey` | Which task the run belongs to, and the corpus version |
| `files[]` | The delivered files, in creation order (see below) |
| `runVerdict` | `{verdict, errorClass}`: how the run ended. A run that ended in an infrastructure failure is still scored, and the verdict is recorded so that it can be excluded from comparisons |
| `finalMessage` | The system's last reply. The evaluator reads it for files the system names as its final choice (see `finalSelectionPolicy` in the specification) and, as a diagnostic only, for the system's own claims about what it delivered |
| `generationJobs`, `llm` | Cost and usage records (diagnostic) |
| `mutations` | Edits injected by a person during the run; `null` for every task in this corpus |

Each entry of `files[]` has `file` (path under `artifacts/`), `contentType`, `bytes`, `source` (`blob`, `inline` text, or a `rendered` page), and `role`. **Only `role: "primary"` files are scored**; `derived` files (platform thumbnails, other formats of the same work) and `input` files (supplied materials copied into the output) are not. Optional fields: `pages` (page count of a multi-page document, when it is known structurally), `provenance` (how an image or video was produced: generated, uploaded or composed), `sourceNodes` and `artifactRefs` (where the file came from in the producing workflow; diagnostic only). When several files compete for the same category and the system has not named its final choice, the later file in `files[]` is taken as the category's representative.

## 4. Assigning files to requested categories

The evaluation specification lists the requested categories (`slots`) with their expected quantities. For every delivered image, a classifier scores each category and an "unassigned" option; the assignment then fills each category up to its expected quantity and uses each image at most once. Remaining images are recorded as overflow and cannot raise completion above the expected quantity. The assignment uses only the files and the specification, never node labels, group names or execution order of any system.

Multi-page documents keep their page and text information: HTML decks are rendered by their own page structure, and PDF and presentation files are read page by page. A file whose pages cannot be read makes a page minimum unmeasurable rather than failed. Rendered deck pages can be checked for consistency but do not count as separately requested artifacts.

## 5. Measures

All measures are computed per task and pooled as described under Aggregation. The field names refer to the evaluator's output, `evaluation.json` (section 7).

**Delivery completion.** For category *i* with expected quantity *e*ᵢ and delivered quantity *d*ᵢ, DC = Σ min(*d*ᵢ, *e*ᵢ) / Σ *e*ᵢ. Excess outputs in one category cannot offset a shortfall in another. Field: `score.deliverableCompletion` (`delivered`, `expected`, `rate`).

**Constraint satisfaction.** A factual constraint (for example, an exact name that must appear) is satisfied when it holds in every targeted artifact. Targets are the delivered files of the named categories, capped at the requested quantity, or only each category's final file when the specification says so. The task-level score is the share of applicable constraints that are satisfied. The check transcribes the artifact's text, removes whitespace and dash characters, normalises full-width forms, and then matches the required wording exactly and case-sensitively. Absent deliveries and unavailable evidence are distinguished:

- if none of the target categories contains a delivered file, the constraint counts as unsatisfied and stays in the denominator; if only some are empty, it is checked on the delivered files alone;
- files whose text transcription failed are removed from the target set, and the constraint is excluded if no target remains;
- the constraint is also excluded when its target categories are empty but a delivered file of an accepted type received no valid category from the classifier.

Field: `score.constraintPassRate` (`passed`, `applicable`, `rate`).

**Reference fidelity** and **identity consistency.** A single judge decides whether two images depict the same object, character, logo or space, within the `comparisonScope` the specification gives. Reference fidelity compares outputs with a supplied reference image; identity consistency compares outputs with a designated output of the same run. Both are the share of pairs judged "same". Pairs the judge cannot decide because of the system's own output stay in the denominator; those caused by an external reference are excluded. Field: `score.identityConsistency[]`, one entry per rule, with `band` `assets` (reference fidelity) or `run` (identity consistency) and a `pairTally`. The evaluator also knows a third band, `lineage`; none of the official Design Anything records uses it.

**Set consistency.** A judge scores a set of outputs against rubric items from the specification (`setVlmRubric`). Only items labelled `consistency` count; items labelled `compliance` are reported separately. Item scores 0, 1 and 2 map to 0, 60 and 100; inapplicable items are excluded and unmet items contribute zero. Within a task, rule-level consistency means are averaged equally. Field: `score.setVlmRubric[]`, with `byKind.consistency`.

**Design quality.** A checklist covering technical quality, aesthetics, text rendering and domain criteria is judged per delivered image of a core image category; the group scores are multiplied by pooled delivery completion. The checklist wording comes from Qwen-Image-Bench and AesEval-Bench (see `THIRD_PARTY_NOTICES`). The six corrected Book A evaluations contain this M3 pass; the other 450 released evaluations remain `not-run`. The paper's other design-quality results come from a separate pass that is not included in this release. The corrected M3 pass records judge `deepseek-flash`, configured through `BENCH_DQ_JUDGE_MODEL_ID`, which the published snapshot does not expose. Its default judge is `claude-opus-4.8`, so the snapshot as published cannot reproduce that pass (see `evaluator/README.md`).

**Aggregation.** Delivery completion, constraint satisfaction, reference fidelity and identity consistency pool their counting units over tasks (for example, the reported constraint-satisfaction rate is passed constraints over applicable constraints across all tasks). Set consistency averages rule-level scores within a task and weights tasks by their numbers of scored items.

The paper also reports a supplementary task-level outcome (`score.m1Success` and `score.m1FinalCore`): a task passes when every requested category is filled, every constraint marked critical holds, and the page minima of presentations and reports are met.

## 6. Judge

All judged steps in the official records (category assignment, text transcription, final-file selection, same-object pairs, set rubric) use the model alias `deepseek-flash` with reasoning disabled. Temperature is not set; the model's default sampling is used. In the judge switch published here, the judge is called through an OpenAI-compatible endpoint and the maximum output length is 4,096 tokens unless overridden; the second scoring machine's switch is not published (see `evaluator/README.md`). The prompt templates are part of the evaluator source (`evaluator/src/benchmarks/design-anything/tools/evaluator/prompts.ts` and the files it names), and the SHA-256 of each template is written into every evaluation record (`prompts.*`).

The judge was switched to this model by environment variables that a scoring-only patch adds to `evaluator/vlm.ts` (`BENCH_EVALUATOR_MODEL_ID`, `BENCH_JUDGE_VIA_OPENAI_COMPAT`, `BENCH_JUDGE_THINKING`, `BENCH_JUDGE_BASE_URL`, `BENCH_JUDGE_MAX_OUTPUT`, `BENCH_JUDGE_TELEMETRY`). The values used were not written into the evaluation records; `evaluator/README.md` states what is known about them.

**Calibration**, from the paper's appendix. Two professional designers labelled samples drawn from final benchmark artifacts; a judge qualifies when Cohen's κ ≥ 0.60 and raw agreement is at least 85%.

- Identity judge (same object): 103 of 108 sampled pairs analysed; human–human κ = 0.931 (96.1%); human–judge κ = 0.887 (93.9%) on 99 consensus pairs.
- Set-consistency judge: 112 of 117 sampled consistency items analysed; human–human κ = 0.893 (92.9%); human–judge κ = 0.885 (92.3%) on 104 consensus items.
- Category assignment: 120 tasks; human–human κ = 0.89; human–classifier κ = 0.83.
- Text transcription: human–human κ = 0.98; human–machine κ = 0.92.

## 7. The evaluation record (`evaluation.json`)

The evaluator writes one `evaluation.json` per run next to its `manifest.json`. Its identity fields let a reader tell which ruler produced it:

| Field | Value in the official records |
| --- | --- |
| `evaluatorVersion` | `v1.18` |
| `rubricVersion` | `deterministic-2026-08-23.2` |
| `classifierModel` | `deepseek-flash` |
| `sampling` | `model-managed (temperature unsupported by this model)` |
| `prompts.*` | SHA-256 of each prompt template |
| `pixelStrategy`, `paletteRuleVersion`, `styleRuleVersion` | Versions of the deterministic pixel, palette and style rules |
| `csdWeightsSha256` | SHA-256 of the style-encoder weights (empty when no style vectors were computed for the run) |
| `benchmarkVersion`, `taskId`, `specVersion` | The task |
| `taskSetSha` | Digest of the whole scoring corpus (see `benchmark/README.md`) |
| `requirements.specSha` | SHA-256 of the evaluation specification file that was scored |
| `manifestVersion`, `runKey`, `runVerdict` | Copied from the export pack |

The measurements are under `score` (section 5); `artifacts` lists each scored file with its assigned category; `diagnostics`, `generation`, `measurement` and `slotAssignment` record how the score was reached and whether it is valid.

These identity fields are fixed strings and digests. Matching them shows that two records used the same prompts and rule versions; it does not by itself prove that the evaluator code was identical in every other respect.

## 8. Designer evaluation

The designer study of the paper is described in its appendix. Twelve professional designers rated 185 tasks in pairwise, blinded comparisons of whole delivered sets, and preferences were estimated with a Bradley–Terry model. The study materials are not part of this release.
