# Evaluator v1.18 (source snapshot)

This directory contains the source code of the DesignAnything-Bench evaluator as it was when the official scores of the paper were computed (evaluator `v1.18`, rubric `deterministic-2026-08-23.2`). It is published so that the scoring rules and the exact prompts sent to the judge can be read and audited.

**It is a snapshot, not a runnable package.** The evaluator was developed inside the monorepo of the Gemus platform and imports a few platform modules that are not published here (listed below). There is no `package.json` or build configuration. Making a standalone, runnable evaluator is planned as separate work.

## Layout

`src/` mirrors the original repository from its root, so relative imports between published files resolve as written:

- `src/benchmarks/design-anything/tools/evaluate.ts` — the evaluator entry point: reads an export pack and its task specification, writes `evaluation.json`.
- `src/benchmarks/design-anything/tools/evaluator/` — the scoring modules: category assignment, constraint checks, identity and set judgments, the judge client (`vlm.ts`) and the prompt templates (`prompts.ts`).
- `src/benchmarks/design-anything/tools/importExternalRun.ts` — builds an export pack from another system's output directory, so that every system is scored through the same reader.
- `src/benchmarks/design-anything/tools/reviewRequirements.ts`, `requirementCoverage.ts` — requirement review and coverage tools.
- `src/benchmarks/design-anything/tools/verify-evaluation.mjs` — post-scoring sanity checks on a directory of evaluation records.
- `src/benchmarks/design-anything/tools/sidecar/` — two Python sidecars: CSD style vectors (`csd/`) and Grounding DINO subject boxes (`dino/`), with their requirements, weight locks and golden tests. Model weights are not included; each sidecar's README and `weights.lock.json` say where they come from.
- `src/src/lib/agent/eval/` — two small platform modules the evaluator depends on that are published because they contain no platform logic (corpus paths and the asset contract).

The set of published files was computed, not chosen by hand: starting from the entry points above, every imported file (value or type import) was followed until one of the platform modules in the next section was reached.

Comments in the source are mostly in Chinese and are kept verbatim. References such as `#3443` are issue numbers of the original, private repository; they are kept so that the code is exactly what was run, but they do not resolve publicly.

## Where this code comes from

The official evaluation records were produced on two machines, each with the same evaluator code plus a small scoring-only patch that switches the judge model:

1. **101 of the 228 GPT-backed tasks** (the 6-, 14- and 24-artifact base tasks, except 13 tasks at 14 artifacts that were re-run elsewhere) were scored with the original repository at commit `a64a40530` plus the judge-switch patch included here. According to that machine's scoring notes, this is the combination published in `src/`; the script that generated this repository checked that each published file is the corresponding file of that commit, and applied the patch by a clean merge.
2. **The other 355 records** (all 228 DeepSeek-backed tasks, and the remaining 127 GPT-backed tasks) were scored on a second machine with the original repository at commit `dc880f0d9` plus that machine's own judge switch. Between `dc880f0d9` and `a64a40530`, every file published here is byte-identical (so is the earlier commit `2fae2ef39`). The second machine's judge switch is not published and has not been compared byte for byte with the patch here; the scoring notes of that machine describe it only as a switch to the same DeepSeek judge, and its records carry the same identity fields (next section).

The judge-switch patch is the block marked `[JUDGE-SWITCH 探针，未入库]` near the top of `src/benchmarks/design-anything/tools/evaluator/vlm.ts`, plus the uses of `resolveJudgeModel`, `BENCH_JUDGE_MAX_OUTPUT` and `BENCH_JUDGE_TELEMETRY` further down. It reads these environment variables:

| Variable | Effect |
| --- | --- |
| `BENCH_EVALUATOR_MODEL_ID` | The judge model id (the code's default is a different model). The official records name `deepseek-flash` |
| `BENCH_JUDGE_VIA_OPENAI_COMPAT` | When set, calls the judge through an OpenAI-compatible client instead of the platform's model layer |
| `BENCH_JUDGE_BASE_URL` | Base URL of that client (default `https://api.deepseek.com/v1`) |
| `BENCH_JUDGE_THINKING` | `off` disables the model's reasoning; the official scoring ran with reasoning disabled |
| `BENCH_JUDGE_MAX_OUTPUT` | Maximum output tokens (default 4,096) |
| `BENCH_JUDGE_TELEMETRY` | Optional file to append per-call timing and usage to |

The exact values of these variables were not written into the evaluation records.

The two machines also used separate judge caches, so the same output scored on both machines can differ by judge sampling. The paper reports that independent scorings of the same outputs differ by about three points on judged measures.

## What the identity fields prove

Every evaluation record carries identity fields: `evaluatorVersion`, `rubricVersion`, the SHA-256 of every prompt template (`prompts.*`), the pixel, palette and style rule versions, the style-encoder weights digest, the judge model name, and the digest of the scoring corpus (`taskSetSha`). For all 456 official records of the two Design Anything configurations, each of these fields equals the value computed from the code in this directory (and `classifierModel` reads `deepseek-flash`). A few records have an empty `csdWeightsSha256` because no style vectors were computed for them; for those the field is not compared.

These fields show that every official record used the same prompts, rule versions and scoring corpus as this code. They do **not** distinguish between different commits that share the version string `v1.18`, and they cannot tell the two judge switches apart. The code identity rests on the scoring notes summarised above.

## Changes from the original files

`CHANGES.md` lists every change made to the original files: the judge-switch patch in `vlm.ts`, and absolute paths on the authors' machines replaced by placeholders. Nothing else was changed.

## Platform modules that are not published

These modules belong to the platform the evaluator was developed in. The evaluator imports them, so the code here does not run without substitutes.

| Module (path in the original repository) | Imported by | Imports | What it does | How to substitute |
| --- | --- | --- | --- | --- |
| `src/lib/ai/llm.ts` | `benchmarks/design-anything/tools/evaluator/vlm.ts` | `resolveModel` | Model-call layer: maps a model id to a provider client (used for every judge call). | Return an AI SDK `LanguageModel` for the judge you use; the scoring-only judge switch in `vlm.ts` already bypasses it when `BENCH_JUDGE_VIA_OPENAI_COMPAT` is set. |
| `src/lib/agent/eval/scenarioSchema.ts` | `benchmarks/design-anything/tools/requirementCoverage.ts`<br>`benchmarks/design-anything/tools/evaluator/assetBindings.ts` | `EvalScenario (type)`, `parseScenario` | Zod schema of the scenario (brief) files; loads the platform node registry. | Parse `benchmark/tasks/<taskId>/scenario.json` as plain JSON; the evaluator reads `referenceAssets` and the embedded materials only. |
| `src/lib/agent/eval/scenario/materializeReferenceAssets.ts` | `benchmarks/design-anything/tools/evaluator/assetBindings.ts` | `assertInsideAssetRoot` | Copies reference images out of object storage; the evaluator imports only its path-fence helper. | A function that rejects paths escaping the corpus asset directory. |
| `src/lib/nodes/registry/core.ts` | `benchmarks/design-anything/tools/deliveryTier.ts` | `tryGetNodeConfig` | Platform node registry; the delivery-tier rules ask it which node types generate media. | A static table from node type to "generates media / uploads / transforms". |
| `src/lib/nodes/nodeRegistry.ts` | `benchmarks/design-anything/tools/deliveryTier.ts` | `(side effects)` | Imported for its side effect: registers every platform node definition, so that the registry above can answer. | Not needed once the registry is replaced by a static table. |
| `src/types/node.ts` | `benchmarks/design-anything/tools/deliveryTier.ts` | `NodeCategory` | Platform node type definitions; the delivery-tier rules compare against its `NodeCategory` enum (`INPUT`, `GENERATION`). | Two string constants, or the static table above. |
| `benchmarks/design-anything/tools/exportRunArtifacts.ts` | `benchmarks/design-anything/tools/evaluator/designQuality.ts`<br>`benchmarks/design-anything/tools/evaluator/stratum.ts`<br>`benchmarks/design-anything/tools/evaluator/deckPages.ts`<br>`benchmarks/design-anything/tools/importExternalRun.ts`<br>`benchmarks/design-anything/tools/evaluate.ts` | `ExportedFile (type)`, `FileRole (type)`, `MANIFEST_VERSION`, `RunExportManifest (type)`, `RunVerdict (type)` | The platform exporter that writes export packs from the database and object storage. The evaluator uses its `RunExportManifest` / `ExportedFile` types and the `MANIFEST_VERSION` constant. | The export-pack layout and manifest fields are documented in `protocol/PROTOCOL.md`. |
| `benchmarks/design-anything/tools/assembleRunCorpus.ts` | `benchmarks/design-anything/tools/importExternalRun.ts` | `readRetiredTaskIds` | The corpus assembler; the external-run importer reads from it the map of task ids retired in v0.6 to their replacements, to accept an old id on the command line. | An empty map, as long as you pass current v0.6 task ids. |

npm packages imported by the published code: `@ai-sdk/openai`, `@napi-rs/canvas`, `ai`, `dotenv`, `jszip`, `mammoth`, `pdfjs-dist`, `playwright-core`, `sharp`, `unpdf`, `zod`.

## License

Apache License 2.0 (see `LICENSE` at the repository root), except for the third-party portions listed in `THIRD_PARTY_NOTICES`.
