# Known issues

## The scoring corpus is not the run corpus

The official scores of the paper (corpus `v0.6`, evaluator `v1.18`) were computed against `scoring-corpus/v0.6-3e7c05f5/`. Every official evaluation record of the two Design Anything configurations names this corpus: its `taskSetSha` is `sha256:3e7c05f57e269c2964da67774e095d72fe0be0e93b1878f961d75650ec0fb6b9`, and its per-task `specSha` matches the corresponding file in `scoring-corpus/v0.6-3e7c05f5/tasks/`.

The agents received the files in `tasks/`. The scoring corpus is a separately frozen copy of the same tasks. The paper's appendix states that execution and scoring use the same frozen task specifications for all systems; for the tasks listed below that is not exactly the case, and we report the differences here. We verified which corpus was scored only for the records of the two Design Anything configurations; the other systems' records are not part of this release.

All 228 files of the scoring corpus were re-serialised, so none of them is byte-identical to the run corpus. After parsing the JSON, three groups of tasks still differ:

- **Book A family (three tasks).** The scoring corpus holds an earlier version of this project family: an archival photography book. The agents received a later version on a different subject, astronomical prints. The scenario file, the reference images and the evaluation specification all differ. These three tasks were therefore scored against a brief the agents did not receive.
- **Comparison scope.** In a group of tasks, the identity-consistency rules of the run corpus carry a `comparisonScope` field (which properties of the anchor must be preserved) that the scoring-corpus version lacks.
- **One requirement check.** In one task, one requirement check is worded and typed differently.

The generated list below gives every task that differs and the JSON paths that differ. `index.csv` carries the same information per task (`scoringDiffers`, `scoringDiffFields`). To compare a task yourself, parse both files and compare the resulting objects; comparing the raw bytes will report every task as different.

**28 tasks** — differing fields: `spec:identityConsistency[].comparisonScope`

`bench-da-architecture-base-a-n06`, `bench-da-architecture-base-a-n14`, `bench-da-architecture-base-a-n24`, `bench-da-brand-base-b-n06`, `bench-da-brand-base-b-n14`, `bench-da-brand-base-b-n24`, `bench-da-brand-breadth-01`, `bench-da-brand-breadth-02`, `bench-da-brand-breadth-03`, `bench-da-interior-base-a-n06`, `bench-da-interior-base-a-n14`, `bench-da-interior-base-a-n24`, `bench-da-interior-base-b-n06`, `bench-da-interior-base-b-n14`, `bench-da-interior-base-b-n24`, `bench-da-interior-breadth-01`, `bench-da-interior-material-03`, `bench-da-landscape-base-a-n06`, `bench-da-landscape-base-a-n14`, `bench-da-landscape-base-a-n24`, `bench-da-packaging-base-a-n06`, `bench-da-packaging-base-a-n14`, `bench-da-packaging-base-a-n24`, `bench-da-packaging-base-b-n06`, `bench-da-packaging-base-b-n14`, `bench-da-packaging-base-b-n24`, `bench-da-packaging-breadth-02`, `bench-da-packaging-material-02`

**1 task** — differing fields: `spec:constraints[]`, `spec:dqRubric.naRules`, `spec:dqRubric.slots[]`, `spec:requirementChecks[]`, `spec:scoringCoverage.brandToken`, `spec:scoringCoverage.identityAnchors.none`, `spec:setConsistency[].token`, `spec:setVlmRubric[]`, `spec:slots[].description`, `spec:slots[].id`, `spec:slots[].label`, `scenario:referenceAssets[]`, `scenario:setup.initialCanvas.nodes[]`, `scenario:steps[].userMessage`, `scenario:title`

`bench-da-book-base-a-n06`

**1 task** — differing fields: `spec:carryThrough[]`, `spec:constraints[]`, `spec:dqRubric.naRules`, `spec:dqRubric.slots[]`, `spec:identityConsistency`, `spec:requirementChecks[]`, `spec:scoringCoverage.brandToken`, `spec:scoringCoverage.identityAnchors`, `spec:setConsistency[].token`, `spec:setVlmRubric[]`, `spec:slots[].description`, `spec:slots[].id`, `spec:slots[].label`, `scenario:referenceAssets[]`, `scenario:setup.initialCanvas.nodes[]`, `scenario:steps[].userMessage`, `scenario:title`

`bench-da-book-base-a-n14`

**1 task** — differing fields: `spec:carryThrough[]`, `spec:constraints[]`, `spec:dqRubric.naRules`, `spec:dqRubric.slots[]`, `spec:identityConsistency`, `spec:requirementChecks[]`, `spec:scoringCoverage.brandToken`, `spec:scoringCoverage.identityAnchors`, `spec:setConsistency[].token`, `spec:setVlmRubric[].id`, `spec:setVlmRubric[].items[]`, `spec:setVlmRubric[].slots[]`, `spec:setVlmRubric[].sourceSlots[]`, `spec:setVlmRubric[].items[].item`, `spec:slots[].description`, `spec:slots[].id`, `spec:slots[].label`, `scenario:referenceAssets[]`, `scenario:setup.initialCanvas.nodes[]`, `scenario:steps[].userMessage`, `scenario:title`

`bench-da-book-base-a-n24`

**1 task** — differing fields: `spec:requirementChecks[].criteria`, `spec:requirementChecks[].manualReason`, `spec:requirementChecks[].method`, `spec:requirementChecks[].properties`

`bench-da-brand-base-a-n14`

The remaining 196 tasks differ only in JSON formatting (the parsed content is identical).

The evaluator does not check that the scoring corpus and the run corpus are the same version; it only records the digest of the corpus it read.

## Outdated authoring notes

Every evaluation specification has a `notes` field written while the tasks were being authored, for example "Independent review, actual model runs and judge calibration pending." These notes are out of date. Judge calibration is described in `protocol/PROTOCOL.md` and in the paper's appendix.

## Input images are not included

The tasks' input images are not in this repository. Each `scenario.json` lists them in `referenceAssets` with their SHA-256 digests. They are planned for release with the dataset, after a separate review of their redistribution licenses.

## Licence lines inside scenario files

Some scenario files contain credit or licence lines for their reference images. Those lines describe the images, not the JSON file. The license of the files in this directory is set out in `LICENSE-DATA` at the repository root.
