STITCHLINE | Home sewing machine stitch settings touchscreen

Design six finished touchscreen views for our home sewing machine. The landscape interface has a logical size of 1024 × 600 and sits within the supplied panel geometry. The three stitches are S01 Straight, S02 Zigzag and S03 Long straight. Length and width use mm; speed is a limit selected from 300, 450 or 600 spm. Preserve the stitch paths in the identity attachment, with S03 visibly longer-spaced than S01 at their default lengths when using a common illustrative scale.

The central distinction is between a proposed draft, the complete configuration acknowledged by the controller, and the machine's current motion state. Touchscreen selection and preview update the draft; Apply commits settings after controller acknowledgement. Needle movement starts or resumes through the physical Start/Pause button, with the separate power switch also remaining physical. Apply is available in Standby or Paused when the needle is up, alerts are clear and values are valid. Pending edits are resolved before physical start or resume. Print "STITCHLINE" on A and C. Use the button wording "Review", "Apply", "Back", "Discard" and "Acknowledge" where those actions appear, and the alert message "Upper thread not detected" on F.

Audience: home sewing enthusiasts, with product and engineering teams using the six views to agree how stitch changes and machine status will be understood during making.

Inputs (attached): 01-client-facts.en.md contains the stitch catalogue, parameter ranges, controller rules and six snapshot records. 02-delivery-catalog.en.md lists the six deliverables with their proportions, formats and stages. panel-layout.png is the constraint image fixing the panel, screen opening and physical control positions. stitch-paths.png is the identity image fixing the three recognisable stitch paths. sewing-table-reference.png is an atmosphere reference for fabric, tools and lighting at a domestic sewing table.

Deliverables:
1. One stitch catalogue and preview screen, snapshot A: Standby, applied S01 Straight at 2.5 mm length, 0.0 mm width and 450 spm, with all three stitches available
2. One parameter editing screen, snapshot B: Standby, draft S02 Zigzag at 1.5 mm length, 5.0 mm width and 450 spm, alongside the applied S01 tuple, with Review and Discard
3. One pre-Apply review screen, snapshot C: the same draft and applied tuples as B, with Apply, Back and Discard and an Apply button shown during its pressed state before release
4. One running status screen, snapshot D: applied S02 Zigzag at 1.5 mm length, 5.0 mm width and 450 spm, Running, needle down and 126 recorded stitches
5. One paused editing screen, snapshot E: the applied D tuple beside draft S02 Zigzag at 2.0 mm length, 4.5 mm width and 300 spm, Paused, needle up and 126 recorded stitches, with Apply and Discard
6. One thread-alert screen, snapshot F: the applied D tuple, Inhibited, needle down, T01, 139 recorded stitches and disabled Acknowledge while upper thread remains missing

Acceptance:
- All six screens fit the 1024 × 600 landscape logical canvas. Body text reaches 4.5:1 contrast; large text and icons reach 3:1. State distinctions combine words with visual treatment. A and C display STITCHLINE.
- A presents S01 Straight, S02 Zigzag and S03 Long straight with their supplied path identities. B, C and E identify their previews as drafts and retain the complete applied tuple separately. Preview diagrams use one common illustrative scale or carry the supplied scale caption. B shows Review in its default enabled state; C shows Apply pressed while S01 remains applied.
- A–F preserve every stitch ID, length, width, speed limit and recorded count listed in their deliverables. B and E use 0.5 mm adjustment steps: S01 length 0.5–4.0 mm, S02 length 0.5–3.0 mm and width 1.0–6.0 mm, S03 length 4.0–5.0 mm. S01 and S03 width stays fixed at 0.0 mm; speed choices are 300, 450 and 600 spm.
- B, C and E visibly mark pending changes; Discard restores the entire applied tuple. C and E expose enabled Apply with Standby or Paused, needle up and alerts clear. D shows disabled editing and Apply with Running as the reason, while viewing and navigation remain available. E explains that Apply or Discard resolves the draft before physical resume.
- D identifies 450 spm as the speed limit and 126 as stitches recorded in the current run. E preserves that count. F is a separate branch from D, with 139 recorded stitches and the applied S02 tuple. D, E and F distinguish Running, Paused and Inhibited from the settings shown.
- F presents T01 and Upper thread not detected as an error state, with disabled Acknowledge and the missing-thread reason. Its recovery copy explains that Acknowledge becomes available when the controller reports clear and returns to Paused with the same applied tuple; physical Start/Pause resumes movement after acknowledgement.

Please clearly mark which version you consider the final deliverable. If nothing is marked, the last exported version counts.