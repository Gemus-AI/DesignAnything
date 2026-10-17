# Tasks

This directory holds the 228 tasks of DesignAnything-Bench (corpus `v0.6`) as a run corpus, a corrected scoring corpus and a historical Book A overlay:

- `tasks/<taskId>/` — the **run corpus**: the files the two Design Anything configurations received. Use these to run a new system.
- `scoring-corpus/v0.6-c21d5896/` — the **corrected scoring corpus**: all 228 tasks, including the astronomical-prints Book A specifications used for the six corrected evaluations. Use these to audit or check those scores.

The run and corrected scoring corpora have the same task ids. Three tasks are byte-identical, 196 differ only in formatting, and 29 differ after parsing. `scoring-corpus/v0.6-3e7c05f5-book-a/` retains the three earlier photography-book specs and scenarios and explains how to reconstruct the earlier complete corpus. `KNOWN_ISSUES.md` lists every difference.

## Files per task

```text
tasks/<taskId>/
  brief.md        the brief as plain text (UTF-8, no byte-order mark)
  scenario.json   the task as the agent received it, byte for byte
  spec.json       the evaluation specification, byte for byte
scoring-corpus/v0.6-c21d5896/
  tasks/<taskId>.json       corrected evaluation specification
  scenarios/<taskId>.json   corrected scoring scenario
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

The input images themselves are not in this repository. They are released as the Hugging Face dataset DesignAnything-Bench (https://huggingface.co/datasets/Gemus-AI/DesignAnything-Bench), where each image is stored under its SHA-256 digest, so the digests in `referenceAssets` let you check them.

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

- **The run corpus is what the two Design Anything configurations received.** Before publishing, we verified that the files in `tasks/` are byte-identical to the corpus bundled with the DeepSeek-backed runs, and to the authoring layer each task came from. For the GPT-backed runs, `gptArmCheck` says how strong the check is for each task. The run archives are not public, so these checks cannot be repeated against them; the Results dataset publishes each run's outputs and evaluation, not the task files the run received.
- **Each evaluation names the corpus it was scored against.** Six corrected Book A records name `sha256:c21d5896cb922e2bbc4bb00dac0b8597bbb903c3cdfa784f606aa09a6b0902ed`; the other 450 retain `sha256:3e7c05f57e269c2964da67774e095d72fe0be0e93b1878f961d75650ec0fb6b9`. Each record's `requirements.specSha` matches the specification in the corpus named by its own `taskSetSha`. The 225 unchanged specifications are identical in both scoring corpora. The historical Book A overlay explains reconstruction of the earlier complete corpus; the generator recomputes both full digests.

The task-set digest is computed over the `.json` files of the `tasks/` directory, sorted by file name: for each file, feed `<file name>:<hex SHA-256 of the file>;` into a running SHA-256, and prefix the result with `sha256:`.

```python
import hashlib, os
d = "benchmark/scoring-corpus/v0.6-c21d5896/tasks"
h = hashlib.sha256()
for name in sorted(n for n in os.listdir(d) if n.endswith(".json")):
    with open(os.path.join(d, name), "rb") as f:
        h.update(f"{name}:{hashlib.sha256(f.read()).hexdigest()};".encode())
print("sha256:" + h.hexdigest())
```
