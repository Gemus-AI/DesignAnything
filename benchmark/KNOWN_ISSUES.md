# Known issues

## Scoring corpus versions

This release uses the corrected scoring corpus in `scoring-corpus/v0.6-c21d5896/`. It contains all 228 tasks: 225 are unchanged from `v0.6-3e7c05f5`, and three Book A tasks use the later astronomical-prints brief.

The released evaluations retain their recorded corpus identities. The six corrected Book A evaluations name `c21d5896`; the other 450 evaluations name `3e7c05f5`. The latter evaluations' per-task `specSha` values also match the corrected corpus because their specifications did not change. Earlier Book A specifications and scenarios are kept in `scoring-corpus/v0.6-3e7c05f5-book-a/`, with instructions for reconstructing the earlier complete corpus and checking both digests.

### Book A family

The tasks `bench-da-book-base-a-n06`, `bench-da-book-base-a-n14` and `bench-da-book-base-a-n24` exist in two versions: an earlier archival photography book and a later book of astronomical prints.

Both Design Anything configurations received the astronomical-prints brief. Their original evaluations used the earlier photography-book specifications. This release replaces those six evaluations with the 25 September 2026 rescoring, using evaluator v1.18 and the specifications for the brief they received. The paper's reported numbers are computed from these rescored evaluations.

The paper's OpenDesign and JarvisHub baselines received the earlier photography-book brief and were scored against that version; their scores are unchanged. Codex received the later astronomical-prints brief and was also rescored. Baseline evaluation records and baseline input sets are not included in this release. The shared task ids therefore do not imply that all systems received the same Book A brief.

### Remaining differences from the Design Anything run corpus

The files in `tasks/` are the run corpus of the two Design Anything configurations. The corrected scoring corpus remains a separately frozen copy. Three tasks are byte-identical to the run corpus and 196 differ only in JSON formatting. After parsing the JSON, 28 tasks still differ in identity-consistency comparison scope, and one task (`bench-da-brand-base-a-n14`) differs in a requirement check.

The generated list below gives every remaining task that differs and the JSON paths that differ. `index.csv` carries the same information per task (`scoringDiffers`, `scoringDiffFields`). Compare parsed JSON objects to distinguish content changes from formatting changes.

**28 tasks** — differing fields: `spec:identityConsistency[].comparisonScope`

`bench-da-architecture-base-a-n06`, `bench-da-architecture-base-a-n14`, `bench-da-architecture-base-a-n24`, `bench-da-brand-base-b-n06`, `bench-da-brand-base-b-n14`, `bench-da-brand-base-b-n24`, `bench-da-brand-breadth-01`, `bench-da-brand-breadth-02`, `bench-da-brand-breadth-03`, `bench-da-interior-base-a-n06`, `bench-da-interior-base-a-n14`, `bench-da-interior-base-a-n24`, `bench-da-interior-base-b-n06`, `bench-da-interior-base-b-n14`, `bench-da-interior-base-b-n24`, `bench-da-interior-breadth-01`, `bench-da-interior-material-03`, `bench-da-landscape-base-a-n06`, `bench-da-landscape-base-a-n14`, `bench-da-landscape-base-a-n24`, `bench-da-packaging-base-a-n06`, `bench-da-packaging-base-a-n14`, `bench-da-packaging-base-a-n24`, `bench-da-packaging-base-b-n06`, `bench-da-packaging-base-b-n14`, `bench-da-packaging-base-b-n24`, `bench-da-packaging-breadth-02`, `bench-da-packaging-material-02`

**1 task** — differing fields: `spec:requirementChecks[].criteria`, `spec:requirementChecks[].manualReason`, `spec:requirementChecks[].method`, `spec:requirementChecks[].properties`

`bench-da-brand-base-a-n14`

The remaining 199 tasks are identical after parsing the JSON.

The evaluator records the digest of the corpus it read; this does not by itself prove that the system received that corpus version.

## Outdated authoring notes

Every evaluation specification has a `notes` field written while the tasks were being authored, for example "Independent review, actual model runs and judge calibration pending." These notes are out of date. Judge calibration is described in `protocol/PROTOCOL.md` and in the paper's appendix.

## Input images are not included

The tasks' input images are not in this repository. Each `scenario.json` lists them in `referenceAssets` with their SHA-256 digests. They are planned for release with the dataset, after a separate review of their redistribution licenses.

## Licence lines inside scenario files

Some scenario files contain credit or licence lines for their reference images. Those lines describe the images, not the JSON file. The license of the files in this directory is set out in `LICENSE-DATA` at the repository root.
