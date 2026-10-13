# Tasks

This directory holds the 228 tasks of DesignAnything-Bench (corpus `v0.6`) in two versions:

- `tasks/<taskId>/` — the **run corpus**: the files the evaluated agents actually received. Use these to run a new system.
- `scoring-corpus/v0.6-3e7c05f5/` — the **scoring corpus**: the files the evaluator read when it produced the official scores reported in the paper. Use these to audit or check those scores.

The two versions are the same tasks but are not byte-identical. Most differences are JSON formatting only; a few tasks differ in content. `KNOWN_ISSUES.md` lists every difference.

## Files per task

```text
tasks/<taskId>/
  brief.md        the brief as plain text (UTF-8, no byte-order mark)
  scenario.json   the task as the agent received it, byte for byte
  spec.json       the evaluation specification, byte for byte
scoring-corpus/v0.6-3e7c05f5/
  tasks/<taskId>.json       evaluation specification the official scoring read
  scenarios/<taskId>.json   scenario file the official scoring read
index.csv                   one row per task (see below)
```

`brief.md` is exactly the `userMessage` of the first step of `scenario.json`; it is there for reading convenience.

## `scenario.json`

The scenario file is what the harness sends to the system under test. The fields that matter to any system are:

| Field | Meaning |
| --- | --- |
| `id`, `title`, `domain` | Task id, a one-line title, and a coarse domain group (`index.csv` gives the 19 benchmark domains) |
| `steps[0]` | `{"kind": "send", "userMessage": …}` — the brief, sent as the first user message |
| `setup.initialCanvas.nodes` | The supplied materials. A node of type `text-prompt` carries one text document (Markdown or CSV) in full in `data.config.text`; its `data.label` reads `Provided: <file name>`. A node of type `image-upload` stands for one supplied image |
| `referenceAssets` | One entry per supplied image: `path` (where the image lives in the corpus), `nodeId` (the `image-upload` node it belongs to), `role`, `mimeType` and `sha256` |
| `tags` | Includes the scale tag `n6`, `n14` or `n24` |

The remaining fields configure the runner used for the paper's own system and are published unchanged so that the file digests stay checkable: `budget` (per-turn limits on tool calls, model steps and wall time), `permissionMode`, `graphContract`, `targetFunctionalNodeRange`, `targetZoneRange`, and `steps[1]`, a `nudge` step. The nudge step is described in `protocol/PROTOCOL.md`. Other systems should receive the brief and the materials and nothing else.

The input images themselves are not in this repository. Their SHA-256 digests in `referenceAssets` will let you check them once they are released with the dataset.

## `spec.json`

The evaluation specification turns the brief into scoring criteria. Systems never see it. Its main parts:

| Field | Meaning |
| --- | --- |
| `slots` | The requested deliverable categories: id, label, description, expected quantity, accepted media kinds, `stage` (process or final) and whether the category is `core` |
| `constraints` | Factual constraints, such as an exact name that must appear in every targeted artifact, with their target categories and whether they are `critical` |
| `identityConsistency` | Pairs to compare for "same object": a supplied anchor image or a designated output, the categories to compare it with, and the `comparisonScope` that says which properties must be preserved |
| `setVlmRubric` | Rubric items for a set of outputs; each item is labelled `consistency` or `compliance` |
| `setConsistency` | Deterministic set checks, such as brand-token spelling |
| `requirementChecks` | Requirement-level checks used for diagnostics and review |
| `dqRubric` | Settings for the design-quality checklist |
| `notes` | An authoring note; see `KNOWN_ISSUES.md` |

`protocol/PROTOCOL.md` explains how the evaluator uses each part.

## `index.csv`

| Column | Meaning |
| --- | --- |
| `taskId` | Task id |
| `domain` | Design domain, from the task id: one of the 19 domains, 12 tasks each. (The `domain` field inside `scenario.json` is a coarser grouping and is not used here) |
| `kind` | `base` (one of the 38 project families at three scales), `material` (reference-material task) or `breadth` |
| `familyId` | For `base` tasks, the family shared by the three scales; empty otherwise |
| `scale` | Number of requested artifacts: 6, 14 or 24 |
| `variant` | `a` or `b` for base families; the task's number within its domain for independent tasks |
| `scenarioSha256`, `specSha256` | SHA-256 of `tasks/<taskId>/scenario.json` and `spec.json` |
| `scoringSpecSha256`, `scoringScenarioSha256` | SHA-256 of the two scoring-corpus files |
| `scoringDiffers` | `true` when the two versions still differ after parsing the JSON (formatting ignored) |
| `scoringDiffFields` | The JSON paths that differ, `;`-separated, prefixed `spec:` or `scenario:`; array indices are written as `[]` |
| `sourcePackage`, `receiptSha256` | The authoring layer the task was assembled from, and the SHA-256 of that layer's authoring receipt. Tasks with the same pair came from the same frozen authoring package |
| `gptArmCheck` | How the task the GPT-backed runs received was checked against these files: `bytes` means the run's own copy of the files was compared byte for byte; `receipt-layer` means that run kept only its assembly receipt, and the check is that it names the same authoring layer and receipt digest |

## Checking the files yourself

- **The run corpus is what the agents received.** Before publishing, we verified that the files in `tasks/` are byte-identical to the corpus bundled with the DeepSeek-backed runs, and to the authoring layer each task came from. For the GPT-backed runs, `gptArmCheck` says how strong the check is for each task. The run archives are not public yet; once the dataset is released, these checks can be repeated against it.
- **The scoring corpus is what the scorer read.** Recompute the task-set digest with the procedure below; it must equal the `taskSetSha` recorded in every official evaluation record, `sha256:3e7c05f57e269c2964da67774e095d72fe0be0e93b1878f961d75650ec0fb6b9`. Each evaluation record also stores `requirements.specSha`, the SHA-256 of the one specification file it scored against. We verified that it matches the corresponding file in `scoring-corpus/v0.6-3e7c05f5/tasks/` for all 456 official records; the records will be released with the dataset.

The task-set digest is computed over the `.json` files of the `tasks/` directory, sorted by file name: for each file, feed `<file name>:<hex SHA-256 of the file>;` into a running SHA-256, and prefix the result with `sha256:`.

```python
import hashlib, os
d = "benchmark/scoring-corpus/v0.6-3e7c05f5/tasks"
h = hashlib.sha256()
for name in sorted(n for n in os.listdir(d) if n.endswith(".json")):
    with open(os.path.join(d, name), "rb") as f:
        h.update(f"{name}:{hashlib.sha256(f.read()).hexdigest()};".encode())
print("sha256:" + h.hexdigest())
```
