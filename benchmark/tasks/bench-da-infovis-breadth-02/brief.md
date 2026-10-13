RELAY CARGO | City cargo-bike shifts and parcel connections

We need an information graphics series explaining how our cargo-bike operation connects Canal Depot, North Gate, Market Lane and Library Steps. The attached service window contains 12 parcels, 6 trips and 9 handoff events across 4 stations. Follow the parcels through these connections, comparing the timetable with recorded operation and making the difference between a parcel, a trip and a handoff immediately readable.

Build from our existing blue cargo box, black bicycle frame and circular badge. The identity color is #0072B2. Planned operation uses #0072B2 with dashed lines and open markers; actual operation uses #D55E00 with solid lines and filled markers. Arrival delay means actual arrival minus planned arrival; station waiting means departure minus arrival at the transfer station, both in minutes. P05 changes from planned T05 to actual T03 after T04. T06 has an empty actual-arrival field, affecting the destination-arrival account for P07 and P08. Print "RELAY CARGO" and "Source: Relay Cargo, 2026" on every chart and publication page. Use "Arrival not recorded" for the T06 arrival gap.

Audience: operations staff deciding which connections deserve attention, and public readers learning how last-mile delivery is organized.

Inputs (attached): 01-client-facts.en.md contains the identity, reporting scope and fixed wording. 02-delivery-catalog.en.md lists each deliverable's proportion, format and stage. stations.md supplies station names and local coordinates. trips.md supplies planned and actual departure and arrival records. parcels.md supplies anonymous parcel identifiers and their planned and actual trip sequences. handoffs.md supplies the nine transfer-event records. data-definitions.en.md contains definitions, calculated values and missing-data coverage. report-surfaces.png fixes the physical publication surfaces. cargo-bike-identity.png supplies the existing bicycle, cargo-box color and badge. microhub-handoff-reference.png supplies the atmosphere of a working transfer point.

Deliverables:
1. A two-page data summary and chart inventory stating counting units, waiting formulas, source credit, visual encodings and each chart's data columns, chart type, carrier and printed labels
2. One station network map locating all four stations and six directed trip connections in local coordinates
3. Two parcel-flow maps, one planned and one actual, with parcel counts on each trip connection
4. One timetable comparing planned and actual departure and arrival for all six trips
5. One handoff timeline covering H01–H09, separating arrival-to-ready time from ready-to-departure time
6. One waiting-distribution chart comparing planned and actual station waiting for the nine handoffs
7. Two exception case sheets: P05's changed connection and T06's missing arrival with P07 and P08
8. One A3 landscape operations overview combining the network, timetable and principal findings
9. One portrait public explainer connecting parcel flow, waiting and the two exception cases
10. One A4 summary page with the headline counts, waiting distribution and arrival-record coverage
11. One 12-second explanatory video following P05 through T04 and T03, alongside its planned T04 and T05 connection
12. One presentation document of at least eight pages reusing the specification, charts, case sheets and publication layouts

Acceptance:
- The data summary, landscape overview, portrait explainer, A4 summary and presentation repeat 4 stations, 12 distinct parcels, 6 distinct trips and 9 handoff events as separate measures; the presentation also repeats the summary's waiting formulas and source credit.
- The network and parcel-flow maps retain the station coordinates and directed endpoints in stations.md and trips.md. Flow labels show planned/actual counts of T01 4/4, T02 5/5, T03 4/5, T04 3/3, T05 3/2 and T06 2/2, with 21 parcel boardings in each scenario distinguished from 12 unique parcels.
- The timetable, handoff timeline, waiting distribution, case sheets and video trace their displayed times to trip or handoff IDs. The waiting distribution shows planned waiting of 6 minutes for all 9 events and actual waiting of 4 minutes for 4 events, 6 minutes for 4 events and 11 minutes for H08; the P05 case and video show readiness at 09:37, T05 departure at 09:35 and T03 departure at 09:40.
- The timetable, T06 case sheet, publication layouts and presentation display "Arrival not recorded" for T06 and distinguish 5 recorded trip arrivals from 6 trips, and 10 parcels with recorded destination arrival from 12 parcels.
- Every chart, case sheet, publication layout and the video follows the summary's planned/actual colors, line styles and marker shapes, with direct labels that remain distinguishable in grayscale. Every chart and publication page carries its title, units, source credit, RELAY CARGO name and one reading annotation; displayed numerical values match the attached tables, and numerical axes begin at zero or label their starting value.
- The landscape overview, portrait explainer, A4 summary and presentation reuse the earlier charts with matching values and encodings. Their printed surfaces follow report-surfaces.png; the presentation has at least eight pages, and the video runs for 12 seconds.

Please clearly mark which version you consider the final deliverable. If nothing is marked, the last exported version counts.