# Browser verification

Screenshots are generated from synthetic responses by `npm run test:browser`. Desktop is 1440 × 1000; mobile is 390 × 844. Both themes use reduced-motion mode. Startup tests delay the app module to verify the home screen is present before initialization and no anatomy code/assets are requested.

| View | Light | Dark |
| --- | --- | --- |
| Desktop home | ![Desktop light](media/desktop-light.png) | ![Desktop dark](media/desktop-dark.png) |
| Mobile home | ![Mobile light](media/mobile-light.png) | ![Mobile dark](media/mobile-dark.png) |
| Desktop anatomy | ![Desktop anatomy light](media/anatomy-desktop-light.png) | ![Desktop anatomy dark](media/anatomy-desktop-dark.png) |
| Mobile anatomy | ![Mobile anatomy light](media/anatomy-mobile-light.png) | ![Mobile anatomy dark](media/anatomy-mobile-dark.png) |
| Desktop answer | ![Desktop answer light](media/answer-desktop-light.png) | ![Desktop answer dark](media/answer-desktop-dark.png) |
| Mobile answer | ![Mobile answer light](media/answer-mobile-light.png) | ![Mobile answer dark](media/answer-mobile-dark.png) |
| Desktop source sheet | ![Desktop source light](media/source-desktop-light.png) | ![Desktop source dark](media/source-desktop-dark.png) |
| Mobile source sheet | ![Mobile source light](media/source-mobile-light.png) | ![Mobile source dark](media/source-mobile-dark.png) |
| Desktop eye-pressure guide | ![Desktop guide light](media/education-desktop-light.png) | ![Desktop guide dark](media/education-desktop-dark.png) |
| Mobile eye-pressure guide | ![Mobile guide light](media/education-mobile-light.png) | ![Mobile guide dark](media/education-mobile-dark.png) |

Tests also cover graphics failure with searchable fallback, older-answer context, new-question reset, and discarded unreviewed chunks. The outdated walkthrough recording was removed.

The redesign also verifies direct citation opening, unchanged conversation width, keyboard focus looping and restoration, lazy visual-guide loading, sourced treatment limitations, reduced motion, 320 px layouts, reading the beginning of long answers, and preserving turn timestamps through clarification and reset. The mobile clarification screenshot uses a synthetic ankle question. No real patient conversation is used for fixtures or screenshots.

## Mechanism guides

Every state of all ten additional guides is checked at desktop and 320 px mobile widths in both themes. Titles, source links, diagram labels, overflow, focus restoration, older-answer topics, unknown IDs, and delayed imports after reset are covered. The following screenshots use synthetic answers; they show conceptual diagrams, not clinical scans.

The visual-guide button appears above the reviewed answer so it remains discoverable before long text and source lists. Selecting it opens the interactive illustration. The ECG launch state is captured on [desktop light](media/visual-launch-desktop-light.png), [desktop dark](media/visual-launch-desktop-dark.png), [mobile light](media/visual-launch-mobile-light.png), and [mobile dark](media/visual-launch-mobile-dark.png).

| Topic | Desktop light | Narrow mobile dark |
| --- | --- | --- |
| Asthma | [View](media/guide-asthma-desktop-light.png) | [View](media/guide-asthma-mobile-dark.png) |
| Reflux | [View](media/guide-reflux-desktop-light.png) | [View](media/guide-reflux-mobile-dark.png) |
| Kidney stones | [View](media/guide-kidney_stones-desktop-light.png) | [View](media/guide-kidney_stones-mobile-dark.png) |
| Gallstones | [View](media/guide-gallstones-desktop-light.png) | [View](media/guide-gallstones-mobile-dark.png) |
| Osteoarthritis | [View](media/guide-osteoarthritis-desktop-light.png) | [View](media/guide-osteoarthritis-mobile-dark.png) |
| Disc and nerve | [View](media/guide-disc_nerve-desktop-light.png) | [View](media/guide-disc_nerve-mobile-dark.png) |
| Arterial plaque | [View](media/guide-atherosclerosis-desktop-light.png) | [View](media/guide-atherosclerosis-mobile-dark.png) |
| Imaging reports | [View](media/guide-radiology_report-desktop-light.png) | [View](media/guide-radiology_report-mobile-dark.png) |
| Blood pressure | [View](media/guide-blood_pressure-desktop-light.png) | [View](media/guide-blood_pressure-mobile-dark.png) |
| ECG signals | [View](media/guide-ecg-desktop-light.png) | [View](media/guide-ecg-mobile-dark.png) |

## Patient tools

The Tools button in the header (or the `#tools` deep link) opens a catalogue of eleven patient tools in six groups. A single tool opens from the catalogue, from the `#tool=<key>` deep link, from the launch button under a chat answer that used it, or from the "Try the tool" link in a visual guide. Each tool runs without a language model and shows its source and scope. Screenshots below use synthetic inputs; `tests/browser/tools*.spec.js`, `logs.spec.js`, and `sheets.spec.js` generate them.

| Catalogue | Light | Dark |
| --- | --- | --- |
| Desktop | ![Desktop catalogue light](media/tools-catalogue-desktop-light.png) | ![Desktop catalogue dark](media/tools-catalogue-desktop-dark.png) |
| Mobile | ![Mobile catalogue light](media/tools-catalogue-mobile-light.png) | ![Mobile catalogue dark](media/tools-catalogue-mobile-dark.png) |

| Tool (key) | Group | What it does | Desktop light | Narrow mobile dark |
| --- | --- | --- | --- | --- |
| Child fever-medicine amount (`child_dose_check`) | Babies and children | Fever-medicine amount for a weight band, shown on a syringe picture. | [View](media/tool-child_dose_check-desktop-light.png) | [View](media/tool-child_dose_check-mobile-dark.png) |
| Growth percentiles (`growth_percentile`) | Babies and children | Weight, length or head size placed on WHO and CDC growth curves. | [View](media/tool-growth_percentile-desktop-light.png) | [View](media/tool-growth_percentile-mobile-dark.png) |
| Oral rehydration planner (`ors_planner`) | Babies and children | Oral rehydration amounts with a teaspoon timer. | [View](media/tool-ors_planner-desktop-light.png) | [View](media/tool-ors_planner-mobile-dark.png) |
| Home blood pressure log (`bp_log_summary`) | Heart, blood pressure and sugar | Home blood pressure log with morning and evening averages and the pressure bands. | [View](media/tool-bp_log_summary-desktop-light.png) | [View](media/tool-bp_log_summary-mobile-dark.png) |
| Glucose pattern view and A1c (`glucose_log_pattern`) | Heart, blood pressure and sugar | Glucose readings by time of day, plus an A1c conversion. | [View](media/tool-glucose_log_pattern-desktop-light.png) | [View](media/tool-glucose_log_pattern-mobile-dark.png) |
| Peak-flow zone (`peak_flow_zone`) | Breathing and heart failure | A peak-flow reading placed in the green, yellow or red zone. | [View](media/tool-peak_flow_zone-desktop-light.png) | [View](media/tool-peak_flow_zone-mobile-dark.png) |
| Daily weight check (`hf_weight_zone`) | Breathing and heart failure | Daily weight compared with yesterday and last week. | [View](media/tool-hf_weight_zone-desktop-light.png) | [View](media/tool-hf_weight_zone-mobile-dark.png) |
| Read a lab result (`lab_result_reader`) | Test results | A lab value placed against the range printed on the report. | [View](media/tool-lab_result_reader-desktop-light.png) | [View](media/tool-lab_result_reader-mobile-dark.png) |
| Medication schedule sheet (`medication_schedule`) | Medicines and staying safe at home | Printable medication grid of what each label says and when. | [View](media/tool-medication_schedule-desktop-light.png) | [View](media/tool-medication_schedule-mobile-dark.png) |
| Fall-risk checklist (CDC STEADI) (`steadi_fall_risk`) | Medicines and staying safe at home | The twelve-question CDC STEADI fall-risk checklist. | [View](media/tool-steadi_fall_risk-desktop-light.png) | [View](media/tool-steadi_fall_risk-mobile-dark.png) |
| When-to-call sheet (`when_to_call`) | After a hospital visit | Printable when-to-call sheet of warning signs and who to call. | [View](media/tool-when_to_call-desktop-light.png) | [View](media/tool-when_to_call-mobile-dark.png) |

Printable sheets are captured in print layout: [medication sheet](media/sheet-medication-print.png) and [when-to-call sheet](media/sheet-when-to-call-print.png).

### Links from the visual guides

Two visual guides end with a "Try the tool" button that reuses the `open-tool` action: Understanding blood pressure opens `bp_log_summary`, and How asthma affects an airway opens `peak_flow_zone`. A guide declares this with an optional `tool: { key, label }` field in `static/js/education-guides.js`; guides without the field show no button. `tests/browser/education.spec.js` covers the link, opening with Enter, a 320 px dark layout, and the guides that have no link. The updated [blood pressure](media/guide-blood_pressure-mobile-dark.png) and [asthma](media/guide-asthma-desktop-light.png) guide screenshots show the button.
