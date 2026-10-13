SWITCHYARD | An industrial tactical map built from an existing asset library

We need one industrial battlefield for SWITCHYARD, a desktop tactical game in which players choose routes and cover while contesting a central relay. The playable boundary is 64 × 64 cells, each 2 m square. Grid coordinates start at the southwest corner. West Spawn is at (4, 32), East Spawn at (60, 32), and Relay at (32, 32). Develop three west-to-east routes named North, Middle and South, each connected to Relay, with at least 4 m of clear width along every traversable connection.

The existing kit fixes the visual direction: four T01 storage tanks, six C01 conveyors and two G01 gantry cranes. Their respective length × width × height envelopes are 8000 × 8000 × 10000 mm, 12000 × 4000 × 1200 mm and 16000 × 8000 × 12000 mm. Arrange all 12 instances on one level; G01-01 is centred on Relay. Preserve the tank's twin cream bands, the conveyor's three cream side panels and the crane's chamfered upper corners. Tank bodies and crane legs provide full cover; conveyor sides provide low cover. The spaces beneath crane beams remain traversable. The three named areas are Tank Yard, Belt Lane and Crane Court.

Faction recognition combines colour and shape: Amber Union uses #FFB547 with a square, and Blue Assembly uses #67C5FF with a triangle. The desktop interface uses a 2560 × 1440 logical canvas, a 64-unit inset on every edge and an 18-unit minimum character height. Print the game name as "SWITCHYARD" and the two action prompts as "Activate crane" and "Inspect cover". The interface records supply the remaining display labels and starting values.

Audience: players who need to judge routes and cover quickly, and the environment and gameplay teams choosing the map layout for implementation.

Inputs (attached): 01-client-facts.en.md contains the fixed gameplay, art and interface facts. 02-delivery-catalog.en.md contains the delivery proportions, formats and stages. 03-asset-records.md contains asset dimensions, instance IDs, cover behaviour and visible features. 04-interface-records.md contains display copy, starting values and input mappings. map-boundary.png supplies the measured grid and fixed gameplay anchors. asset-footprints.png supplies the asset envelopes at a shared scale. industrial-kit.png supplies the existing appearance of the three asset types. factory-atmosphere.png supplies daylight, surface wear and industrial atmosphere.

Deliverables:
1. One two-page tactical specification covering the asset inventory, cover rules, faction colours and shapes, surface palette, lighting direction and asset states
2. One interface information architecture table covering the tactical overview, crane interaction and cover inspection, with their labels, values, states and input mappings
3. Two map drawings: a master plan with all 12 instance IDs, centre coordinates and orientations, and a matching route-and-cover overlay with North, Middle, South, clear widths and cover classifications
4. Three key-area views: Tank Yard from the southwest, Belt Lane from the northwest and Crane Court from the southeast, each with its camera position marked on the master plan
5. One asset continuity sheet covering T01, C01 and G01 in front, side, rear and top views, with Idle and Active details and paired close-up and map-scale depictions
6. One faction and interaction signage sheet containing both faction emblems, the three area labels, the two action prompts and the Ready and Locked treatments
7. Two matched interaction screens at G01-01, one for controller input and one for touch input, each containing the crane action and a cover-inspection inset
8. One tactical overview hero showing the complete battlefield, both spawn labels, Relay, the three area labels and SWITCHYARD
9. One 10-second map flythrough travelling from West Spawn through Relay to East Spawn
10. One presentation document of at least 10 pages, reusing the specification, information architecture, map drawings, area views, continuity sheet, signage, interaction screens and hero

Acceptance:
- The specification, master plan and route-and-cover overlay use the 64 × 64 grid, 2 m cells, three fixed anchor coordinates and all 12 asset instances. The overlay identifies three connected routes and dimensions their narrowest traversable connections at 4 m or greater; its full-cover and low-cover markings follow the specification.
- The three key-area views, hero and flythrough follow the master plan's instance positions and orientations. The continuity sheet repeats all three asset IDs and their dimensions from the specification, shows four views per type and both Idle and Active states, and carries the same identifying features into its map-scale depictions.
- The signage sheet, interaction screens and hero repeat the specification's Amber Union square in #FFB547 and Blue Assembly triangle in #67C5FF. The signage sheet includes Tank Yard, Belt Lane and Crane Court; both interaction screens print SWITCHYARD, Activate crane, Inspect cover, Relay 50% and 03:00 exactly.
- The information architecture table and both interaction screens use the same Ready and Locked states. Controller A and X correspond respectively to the two touch actions in matching screen positions. Both screens show the Ready crane action and a separate Locked treatment with a padlock; their text stays within the 64-unit inset at a minimum character height of 18 logical units. Text contrast reaches 4.5:1, and icons and disabled controls reach 3:1 against their backgrounds.
- The key-area views, continuity sheet, hero and flythrough preserve T01's two cream bands, C01's three cream side panels and G01's chamfered upper corners. The specification and these images use #596368 painted steel, #D9D2BD cream detailing and light from the northwest; Idle and Active change beacon treatment while retaining each asset's silhouette.
- The flythrough runs for 10 seconds and shows West Spawn, Relay and East Spawn in that order. The presentation has at least 10 pages, prints SWITCHYARD on its opening page and repeats the specification's asset dimensions, both faction colour codes and shapes, and Idle and Active state names alongside the reused work.

Please clearly mark which version you consider the final deliverable. If nothing is marked, the last exported version counts.