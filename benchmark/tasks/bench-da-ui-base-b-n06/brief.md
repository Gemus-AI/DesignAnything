PAGEWIND | Offline reading and listening, with a deliberate handover

PAGEWIND serves readers who move between a few minutes of reading and listening during their commute. The product direction is fixed: quiet, content-led screens with #1F4E5F as the brand accent. Print PAGEWIND on Library and Downloads. The catalog contains The Small Lantern and The Empty Bench, both by PAGEWIND Studio. Use the supplied lantern artwork to identify The Small Lantern wherever its cover appears. Main-area navigation reads Library, Downloads, Settings, in that order; Reader, Player, their overlays and continuation choices have a return action.

Reading position belongs to a sentence, while listening position belongs to a chapter-relative media time. In The Small Lantern, L1-S03 spans 00:30–00:45: switching from reading previews 00:30 and starts after confirmation; switching from playback at 00:37 returns to that sentence. Use the exact action labels "Listen", "Read" and "Confirm" for this handover. Each narrated chapter lasts 01:30. L2 audio at 6 of 10 MB, or 60%, becomes available offline at 10 of 10 MB, or 100%. The continuation choice compares Phone A's L2-S02 / 00:22 saved at 08:40 with the received Tablet B record L2-S04 / 00:50 synced at 08:35, on 24 August 2027. Apply a record after an explicit choice. Standard screens use a 390 × 844 logical viewport with top/bottom safe areas of 47/34 logical units; reader-wide uses 430 × 932 with 59/34. These are platform-neutral layouts. Centre each complete artwork frame proportionally within its delivery canvas. Body text needs contrast of at least 4.5:1, large text and meaningful icons 3:1; pair status colours with words or symbols. Night uses #18252B as its background. Reader sizes are 18, 22 and 26 logical units, initially 18 and Day; Player starts at 1.0x with its timer Off, and offers 1.5x, 15 minutes and 30 minutes.

Audience: product and interface engineering teams deciding how reading, listening, offline access and explicit cross-device continuation should behave in the first release.

Inputs (attached): 01-client-facts.en.md contains the fixed product behaviour, dimensions and control values. 02-delivery-catalog.en.md lists each deliverable's proportion, format and stage. 03-books.md contains the two book records. 04-chapter-text-and-timeline.md contains the complete chapter text and sentence-to-audio intervals. 05-state-snapshots.md supplies each named screen's connection, position, availability and save status. viewport-constraints.png defines the two screen envelopes and safe areas. lantern-cover-art.png supplies the existing catalog artwork for The Small Lantern. commute-reference.png supplies the reading-to-listening atmosphere.

Deliverables:
1. One finished Library screen identifying both books and the paused L1 position at 00:37
2. One finished Reader screen at L1-S03, with the complete six-sentence chapter available in its reading flow, size 18, Day and the Listen action
3. One finished Player screen playing L1 at 00:37 of 01:30, with Read, speed 1.0x and timer Off
4. One finished Downloads screen showing both books, separate text and narration availability, and L2 audio at 6 of 10 MB (60%)
5. One finished offline-unavailable screen for the blocked L2-S02 listening attempt, with its proposed 00:15 start, retained 00:22 position and an Open saved text action
6. One finished sync-choice screen comparing Phone A and the received Tablet B record, with explicit selection and cancellation

Acceptance:
- Compose all six screens in the 390 × 844 logical viewport with 47/34 top/bottom safe areas; keep complete controls inside those areas and meet the 4.5:1 body-text and 3:1 large-text/icon contrast thresholds.
- Print PAGEWIND, The Small Lantern and The Empty Bench on Library and Downloads; use the lantern artwork for The Small Lantern and repeat Library, Downloads, Settings in that order on both screens.
- Keep Reader anchored at L1-S03 and Player at L1 00:37 of 01:30; use the supplied chapter wording and the exact Listen and Read labels, with Reader at 18/Day and Player at 1.0x/Off.
- Distinguish file progress from playback on Downloads and offline-unavailable: 6 of 10 MB equals 60%; offline-unavailable pairs its disabled Listen action with a written incomplete-download explanation, offers Open saved text, and retains L2-S02 / 00:22 while identifying 00:15 as the proposed start.
- Label both devices and record statuses on sync-choice: Phone A, L2-S02 / 00:22, local save 08:40; Tablet B, L2-S04 / 00:50, synced 08:35; date 24 August 2027. Give each record an explicit selection action and explain that cancellation retains Phone A's position.

Please clearly mark which version you consider the final deliverable. If nothing is marked, the last exported version counts.