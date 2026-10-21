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

Every state of all seven additional guides is checked at desktop and 320 px mobile widths in both themes. Titles, source links, diagram labels, overflow, focus restoration, older-answer topics, unknown IDs, and delayed imports after reset are covered. The following screenshots use synthetic answers; they show conceptual diagrams, not clinical scans.

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
