# Earlier Book A scoring files

This directory contains only the three earlier photography-book specifications and scenarios for `bench-da-book-base-a-n06`, `bench-da-book-base-a-n14` and `bench-da-book-base-a-n24`. They are historical scoring evidence; the released Design Anything Book A evaluations use the later astronomy versions.

The complete corrected corpus is in `../v0.6-c21d5896/` and has task-set digest `sha256:c21d5896cb922e2bbc4bb00dac0b8597bbb903c3cdfa784f606aa09a6b0902ed`. To reconstruct the complete earlier corpus, copy that directory and replace the three files in each of `tasks/` and `scenarios/` with the files here. The reconstructed task-set digest must be `sha256:3e7c05f57e269c2964da67774e095d72fe0be0e93b1878f961d75650ec0fb6b9`. The other 225 tasks are unchanged. The release generator verifies both full digests before publication and again from the written files.

The six corrected evaluations are the 25 September 2026 rescoring of the two Design Anything configurations. They preserve their recorded `c21d5896` identity; the remaining 450 evaluations preserve their original bytes and `3e7c05f5` identity. See `../../KNOWN_ISSUES.md` for the different Book A briefs received by the paper's baselines.
