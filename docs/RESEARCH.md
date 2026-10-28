# Research decisions

Sources were reviewed with Firecrawl during the October 2026 refactor. These are engineering judgments, not clinical validation.

## Anatomy

[OpenAI's Astra architectural visualization example](https://developers.openai.com/blog/architectural-visualization-with-astra) shows an agent operating Blender and producing editable geometry. This supports using an agent to author a 3D workflow; it does not establish the medical accuracy of generated anatomy. Generating a mesh from patient symptoms would add unsupported detail.

[Z-Anatomy](https://github.com/Z-Anatomy/Models-of-human-anatomy) provides an open Blender/Unity atlas with CC BY-SA licensing obligations. It is a candidate for richer coverage, but adopting its whole authoring stack would increase scope and distribution cost.

The chosen implementation rebuilds the viewer using the repository's attributed [BodyParts3D](https://lifesciencedb.jp/bp3d/) geometry, converted through [anatomy-lab](https://github.com/MrH0v0/anatomy-lab). The old runtime assets and full-body viewer are removed. Twelve regional packs preserve structure identifiers/labels and record hashes plus source revision. Conversion dequantizes source positions before recompression; a decoded-geometry test prevents collapsed meshes.

These are adult reference structures, including male-specific anatomy in the source atlas. Coverage is incomplete: selected bones, muscles and organs, not a comprehensive vascular, nerve or ligament atlas. Both sides are labeled; neither laterality nor disease is inferred. A view is not a scan or diagnosis. Future assets need independent anatomical review and appropriate licensing.

## Tools chosen

[DailyMed's directory API](https://dailymed.nlm.nih.gov/dailymed/webservices-help/v2/spls_api.cfm) supplies official US label titles and links. It does not provide an interaction check, approval confirmation, or dosing decision. The [Europe PMC articles API](https://europepmc.org/RestfulWebService), restricted here to PubMed-indexed records with abstracts, adds research lookup without another paid key. Abstracts are not a systematic review or a guarantee of study quality.

New calculations use [NIDDK's CKD-EPI 2021 adult eGFR equation](https://www.niddk.nih.gov/research-funding/research-programs/kidney-clinical-research-epidemiology/laboratory/glomerular-filtration-rate-equations/adults), the [ADAG estimated average glucose equation](https://doi.org/10.2337/dc08-0545), and explicit measurement conversions. BMI uses [CDC adult categories](https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html); two-level Wells references [NICE NG158](https://www.nice.org.uk/guidance/ng158/chapter/recommendations). Inputs, scope and source links accompany results. Approximate Framingham scoring was removed.

Personalized dosing, interaction checking and diagnostic image interpretation require suitable authoritative data and clinical evaluation before implementation. General search results do not satisfy those needs.

## Self-improvement

| Paper | Relevant finding | Engineering consequence |
| --- | --- | --- |
| [Reflexion](https://arxiv.org/abs/2303.11366) | Uses feedback and episodic reflection to improve later attempts on benchmark tasks; not a medical safety validation. | Record failures and external reviewer feedback; test the next candidate under a fixed budget. |
| [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) | Intrinsic correction can fail or degrade reasoning without reliable external feedback. | Do not let the answering model approve permanent changes or count another attempt as proof of improvement. |

The resulting design is an offline, externally reviewed loop with regression gates. The evals package implements comparable synthetic runs and comparison reports; clinical review and PR review remain necessary. Runtime answer review is a bounded check on one answer, not online learning. The application does not train on conversations or store answers as permanent medical memory.

## Mobile reading, local time, and explanatory visuals

Research checked on 2026-10-12 through Firecrawl, using generic product and medical-topic queries rather than patient text.

- [MDN: Intl.DateTimeFormat.resolvedOptions](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/resolvedOptions) documents the browser's IANA time-zone and locale settings. We send these hints, use the server clock, retain per-turn offsets, and calculate today/yesterday deterministically. Approximate phrases remain approximate. This avoids an extra model call and prevents treating the model's training cutoff as today's date.
- [Vercel request headers](https://vercel.com/docs/headers/request-headers) provides approximate network country and time-zone hints. They are only read in the Vercel runtime and never treated as GPS or confirmed location. Explicit user context takes precedence. Locale does not imply country. Exact location is unnecessary for normal explanations.
- [NEI: Glaucoma and Eye Pressure](https://www.nei.nih.gov/eye-health-information/eye-conditions-and-diseases/glaucoma/glaucoma-and-eye-pressure) informs the front-chamber/drainage schematic. The guide explains slow drainage and distinguishes raised pressure from a diagnosis. It does not map personal measurements onto a simulated eye.
- [NEI: Laser Treatment](https://www.nei.nih.gov/eye-health-information/eye-conditions-and-diseases/glaucoma/treatment) and [NEI: Glaucoma Surgery](https://www.nei.nih.gov/eye-health-information/eye-conditions-and-diseases/glaucoma/glaucoma-surgery) support fixed explanations of treatment goals and limitations. A user chooses a topic; the app does not recommend a procedure. Links stay next to the explanation. No third-party surgical video, tracking embed, or unlicensed GIF is loaded.
- [NEI: Glaucoma](https://www.nei.nih.gov/eye-health-information/eye-conditions-and-diseases/glaucoma) supplies warning signs and the treatment overview. Emergency routing still precedes visuals and retrieval.
- [Adobe Express logo generator](https://www.adobe.com/express/create/ai/logo) was researched and tried with a generic project brief. Generation required sign-in. An interim SVG book mark was later replaced by the approved generated m monogram described below. The mascot exploration was rejected and is not shipped.
- [Vercel toolbar management](https://vercel.com/docs/vercel-toolbar/managing-toolbar) documents the preview feedback environment flag. Preview toolbar injection is disabled instead of broadening the application's script policy.

Native HTML dialogs and accordions fit this small JavaScript application without adding React solely for Radix. Explicit keyboard loops, focus restoration, touch targets and reduced-motion behavior are tested. Lucide provides a consistent icon vocabulary; a single local variable font replaces platform-dependent typography. Guides are fixed educational assets, not proof of anatomical or clinical accuracy. Independent clinical review remains outstanding for the illustrations and content.

## Monochrome and typography refinement

The October 12 follow-up uses black and neutral charcoal in dark mode, warm off-white in light mode, and a 44 px icon-only new-question control with an accessible name. Instrument Sans supplies restrained headings and a lighter wordmark; mobile answer text is 16 px and desktop answer text is 17 px. The owner subsequently approved the generated m monogram, now adapted as a small SVG for the header, assistant avatar, and favicon. These are design decisions, not claims of clinical benefit.

- [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) informed text and muted-text contrast in both themes. Color is not the only indicator of an error or selected state.
- [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) informed pointer spacing; principal header and composer controls remain at least 44 px. Inline citations retain their text context and keyboard labels.
- [Rello, Pielot and Marcos, CHI 2016](https://www.pielot.org/pubs/Rello2016-Fontsize.pdf) studied font size and spacing with 104 participants. Larger text improved their reading measures, while extreme spacing was less helpful. Their desktop Arial experiment does not establish an optimum for this mobile UI; we use the finding to avoid shrinking answer text and retain browser zoom.
- [Instrument's typeface background](https://www.instrument.com/latest/from-old-to-bold-instrument-rebrand-signals-energetic-shift) describes the family collaboration. The locally bundled font is OFL licensed; selecting it is an aesthetic choice, not a universal readability claim.

Adobe Express was retried after sign-in with Gemini 3 and Firefly Image 4. Both attempts showed a service error. The approved [monochrome concept](brand/README.md) was therefore generated with the built-in image tool. Its original raster and prompt are preserved as provenance; the application loads the SVG adaptation.

## Broader visual coverage

Firecrawl searches and source-page reads on 2026-10-12 used generic condition queries. No search-volume dataset or patient traffic analysis was available: these are common-condition candidates chosen for a clear visual mechanism, not a ranking of popular searches. The catalog now includes the existing eye-pressure guide and seven additional topics.

| Example question | Why a diagram helps | Primary content source |
| --- | --- | --- |
| How does asthma narrow an airway? | Compare the opening with swelling and tightening. | [NHLBI asthma](https://www.nhlbi.nih.gov/health/asthma), [asthma attacks](https://www.nhlbi.nih.gov/health/asthma/attacks) |
| Why do stomach contents come back up in reflux? | Show flow direction at the sphincter. | [NIDDK reflux symptoms and causes](https://www.niddk.nih.gov/health-information/digestive-diseases/acid-reflux-ger-gerd-adults/symptoms-causes) |
| How can a kidney stone block urine? | Trace kidney → ureter → bladder, then a possible obstruction. | [NIDDK urinary tract](https://www.niddk.nih.gov/health-information/urologic-diseases/urinary-tract-how-it-works), [stone definitions](https://www.niddk.nih.gov/health-information/urologic-diseases/kidney-stones/definition-facts), [warning signs](https://www.niddk.nih.gov/health-information/urologic-diseases/kidney-stones/symptoms-causes) |
| How do gallstones interrupt bile flow? | Separate the liver, storage organ, ducts, and intestine. | [NIDDK gallstone definitions](https://www.niddk.nih.gov/health-information/digestive-diseases/gallstones/definition-facts), [symptoms](https://www.niddk.nih.gov/health-information/digestive-diseases/gallstones/symptoms-causes) |
| What changes in a knee with osteoarthritis? | Compare cartilage while stating that the whole joint is involved. | [NIAMS osteoarthritis](https://www.niams.nih.gov/health-topics/osteoarthritis) |
| How can a herniated disc affect a nerve? | Show proximity and possible compression without diagnosing pain. | [NIAMS back pain](https://www.niams.nih.gov/health-topics/back-pain) |
| How does arterial plaque reduce blood flow? | Compare open space, plaque, and a possible clot. | [NHLBI atherosclerosis](https://www.nhlbi.nih.gov/health/atherosclerosis) |

The original schematics intentionally omit detail and measurements. No anatomy illustrations, surgical videos, or GIFs were copied. State changes are manual and the text describes their meaning for screen readers. They do not represent inevitable stages, personal scans, blood-flow calculations, pressure estimates, or procedural training. Each state links directly to the source supporting its explanation.

The twelve attributed 3D reference scenes continue to serve location/spatial questions. A schematic explains flow or blockage more directly than an unaffected reference mesh; a model is not automatically loaded because a condition is named. The triage policy does not map unexplained chest, abdominal, or back pain to a disease guide. Emergency routing and evidence/review gates precede any guide publication. The synthetic evaluation pack now checks all eight IDs plus irrelevant and emergency cases; offline tests verify the gates, not medical validity or live routing accuracy.

## Imaging report education

Firecrawl research on 2026-10-22 used generic topics and official source pages, without patient text. [RadiologyInfo's report guide](https://www.radiologyinfo.org/en/info/all-about-your-radiology-report), maintained by ACR, RSNA, and ASRT, separates exam context, findings, and impression. The new guide illustrates that structure with an original document diagram. It shows no invented patient findings.

The application accepts text only. Generation and review instructions now explicitly prohibit claims to have inspected scans or ECG waveforms, require preserving report uncertainty and follow-up recommendations, and prevent reassuring report wording from overriding current emergency symptoms. These are prompt requirements, not validated diagnostic capabilities. Existing offline tests exercise the emergency, clarification, evidence-failure, and review-failure gates for every allowed guide ID. Synthetic evaluation cases cover report routing and emergency override; live routing and independent clinical review remain separate checks.

## Blood pressure and heart-test understanding

On 2026-10-22, Firecrawl retrieved [NHS England's 2025 website demand report](https://www.england.nhs.uk/2026/02/people-searching-nhs-advice-on-high-blood-pressure-skyrocketed-last-year/). Blood pressure was the second most viewed condition page with about two million visits. High cholesterol and iron deficiency anaemia were also in the top ten. This measures NHS page visits, not global search volume or this application's users. It supports prioritizing blood pressure and cardiovascular education; it does not justify diagnosing the most searched conditions from symptoms.

The [NHS blood pressure test guide](https://www.nhs.uk/tests-and-treatments/blood-pressure-test/) supports the two-number explanation. [NHS hypertension guidance](https://www.nhs.uk/conditions/high-blood-pressure/) supports repeated measurement and urgent-symptom advice. The diagram uses fixed illustrative values and does not assign categories, targets, or treatment. This avoids hiding the differences between office and home thresholds and between clinical guidelines.

[MedlinePlus ECG education](https://medlineplus.gov/lab-tests/electrocardiogram/) supports the signal overview and the limitations of a brief recording. The original ECG drawing has no diagnostic calibration and cannot be compared with a patient's tracing. The written-report policy applies to ECG results too. No upload service, new provider, or extra model call was added.

The new non-HDL tool implements total cholesterol minus HDL, as defined by [MedlinePlus](https://medlineplus.gov/cholesterollevelswhatyouneedtoknow.html). Subtraction works directly in either supported unit, so there is no unit conversion or estimated LDL formula. Inputs must come from the same panel with matching explicit units. The tool rejects contradictions and implausibly large values as input errors, not as clinical categories. Treatment targets depend on patient context and are not computed here.

## Clinician handoff, provenance, and failure testing (2026-10-25)

Collected with web search and Firecrawl using generic queries. No patient text was used. These are engineering judgments about what to build, not clinical validation. Numbers are quoted from the cited papers and describe their samples, not this application's users.

### Demand: what people ask health chatbots

- [Nature Health 2026](https://www.nature.com/articles/s44360-026-00117-x) analyzed 617,827 de-identified consumer AI health conversations. About 41% sought health information or education; personal symptom assessment was nearly one in five conversations; one in seven personal queries concerned someone else; personal queries peaked at night, when care is hardest to reach.
- [Ayre, Cvejic and McCaffery, MJA 2025](https://www.mja.com.au/journal/2025/222/4/use-chatgpt-obtain-health-information-australia-2024-insights-nationally) surveyed 2,034 Australian adults. Among ChatGPT health users, 48% asked about a specific condition, 37% about symptoms, 36% what action to take, 35% to explain medical terms, and 8.6% to interpret test results. Many of these questions end with a clinician, not with the chatbot.
- [Yun and Bickmore, JMIR 2025;27:e68560](https://www.jmir.org/2025/1/e68560/): 90.2% of 297 surveyed users searched online for information about conditions or symptoms.

### Pain points

- [JAMA Network Open 2023](https://jamanetwork.com/journals/jamanetworkopen/fullarticle/2802672) (8,139 patients at four US academic centers): 96% preferred immediate online release of results, yet 7.5% said viewing results before hearing from a clinician increased worry, and a related national analysis found only about two thirds understood what released results meant. Patients want plain-language explanation, context, and a next step.
- Symptom-checker user studies ([PMC8075525](https://pmc.ncbi.nlm.nih.gov/articles/PMC8075525/), [PMC10874001](https://pmc.ncbi.nlm.nih.gov/articles/PMC10874001/), [PMC10148318](https://pmc.ncbi.nlm.nih.gov/articles/PMC10148318/), and JMIR Human Factors 2020 e19713) report questionnaire fatigue, badly sequenced questions, vague outputs, a generic "see a doctor" with no actionable next step, no follow-up guidance, and anxiety from alarming results.
- Press and forum accounts describe confidently wrong answers, fabricated or unverifiable citations, false reassurance, and clinicians dismissing AI-written patient notes. Patients report chatbots as most useful for translating terms, preparing questions, and organizing what to tell a doctor. These are anecdotes, not measured rates; they shaped two choices: the handoff contains the person's own words plus structured data and never the AI's answer prose, and it ends in questions to ask, not advice.

### What the evidence supports

- Question prompt lists are low-risk. A [systematic review of 51 randomized trials](https://academic.oup.com/book/26485/chapter/194937904) of pre-consultation interventions found small but significant increases in questions asked and patient participation, without longer consultations and without consistent effects on anxiety or knowledge. A 2025 meta-analysis of 14 cancer studies reached a similar conclusion. The handoff's "Questions to ask" section follows this structure.
- [AHRQ Question Builder](https://www.ahrq.gov/questions/question-builder/index.html) and [IHI Ask Me 3](https://www.ihi.org/library/tools/ask-me-3-good-questions-your-good-health) (What is my main problem? What do I need to do? Why is it important?) provide the heading structure. The questions are fixed strings in `app/handoff.py`; only the calculator name and value and the source count are substituted, so message text can never leak into them.
- [SourceCheckup, Nature Communications 2025](https://www.nature.com/articles/s41467-025-58551-6) (800 questions, about 58,000 statement-source pairs) found that for GPT-4o with retrieval, source URLs were valid 100% of the time but only 75.7% of statements were supported. A valid link is not claim support. The "How this answer was made" panel therefore reports claim support as citation coverage (which retrieved sources the reviewed answer cited) and says it is coverage, not verification.
- [HealthBench](https://openai.com/index/healthbench/) reports context seeking and emergency referral among the weakest axes for current models, which supports keeping the emergency screen first and the one-round clarification fixed.
- Abstention and deferral work ([UncertaiNLP 2025, "Do LLMs know when not to answer in medical QA"](https://aclanthology.org/2025.uncertainlp-main.4/); [NeurIPS 2025 cascaded human-AI decision making](https://neurips.cc/virtual/2025/loc/san-diego/poster/119942); [PMC12484644](https://pmc.ncbi.nlm.nih.gov/articles/PMC12484644/), an implementation review of conversational AI) mostly studies when a model should stop. Little of it specifies the operational handoff: context, sources, uncertainty, and urgency passed to a person. The implementation review recommends explicit escalation pathways and structured handoff information. The handoff object is that artifact, assembled deterministically with no extra model call and no storage.

### openFDA label sections

The [openFDA drug label API](https://open.fda.gov/apis/drug/label/) needs no key (40 requests per minute and 1,000 per day per IP; 240 per minute and 120,000 per day with a free key). Labels arrive as arrays of section strings. A probe on 2026-10-25 for `generic_name:"metformin"` returned a sitagliptin plus metformin combination product first among 355 labels. A combination product is not the same medicine, so quoting it as "the metformin label" would mislead.

Selection rule, implemented in `app/tools/references.py`: request labels by generic name sorted by effective date (brand name only after a 404); keep single-ingredient rows whose name matches the query as a whole word; prefer an exact match, then the newest row; discard rows without a valid set ID. If rows exist but only combinations match, return an empty result flagged `combination_only`, show nothing from the label, and say so in the handoff. The exact product name and its DailyMed link are always shown. The interactions section is reported as present or absent and never quoted, so the tool cannot be read as an interaction check. A 429 counts as a failure toward the circuit breaker, and an optional `OPENFDA_API_KEY` raises the limit.

### MediSearch tier

MediSearch's [terms of use](https://medisearch.io/terms) are informational-use terms with no clause restricting API embedding. Its [developer pricing](https://medisearch.io/developers/docs) lists a Free tier described as for testing and development, a Production tier described as for production applications, and an Enterprise tier with compliance and service-level commitments. The conclusion: use the Production tier for real users and keep the free tier for development. Get written confirmation of terms before handling real patient data at scale. The terms disclaim accuracy, which is one more reason the application keeps its own review gate.

### Tools considered and excluded

| Candidate | Why it is not included |
| --- | --- |
| PHQ-9 and GAD-7 self-scoring | A scored severity band needs clinician interpretation and a crisis pathway. The application has only its emergency screen; a score in a chat can do harm without that pathway. |
| Drug interaction checking | Needs an authoritative interaction dataset and clinical evaluation. Label text is not an interaction check; the label tool deliberately does not quote the interactions section. |
| Dosing calculators | Patient-specific and high consequence, with no authoritative, validated data source in this application. |
| Lab reference ranges | Ranges depend on the laboratory and population; a generic table would misclassify results. |
| Email delivery of the summary | Would send patient text through a third party or require storing it. Copy, Print, and Download keep the text on the device. |
| Voice agents | A different product surface with new safety and latency risks; no patient-information need in the research pointed to it. |
| A lab-report visual guide | Lab reports vary by laboratory, and the value is in the handoff and the existing written-report guide, not another diagram. |

Pack-years and waist-to-height were added instead: both are arithmetic on explicitly supplied numbers, cite a public source, and return the guideline's wording as a conversation starter for a clinician, not a category or an eligibility decision. Sources: [USPSTF lung cancer screening](https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/lung-cancer-screening) and [NICE NG246](https://www.nice.org.uk/guidance/ng246).

### Market context and naming rule

A business-to-business pharma engagement product was also reviewed for transferable ideas: a structured handoff to a human, escalation pathways, auditability of each answer, and benchmark-driven evaluation. Its voice agents, pharma CRM integration, and market-simulation features are out of scope for a patient-information application. No third-party startup or company that was reviewed only as market context is named anywhere in this repository (code, docs, tests, or commit messages). Only standards bodies, journals, government sources, and the application's existing providers are named.

## Patient tools across ages (2026-10-25)

The question for this version was which deterministic tools patients and caregivers of any age would use in real life. The evidence came from forum and portal studies (r/AskDocs and related communities, patient-portal studies), discharge-instruction research, and public guidance from CDC, FDA, NICE, AHRQ, AAP, ADA, and AHA. The pain points below are the recurring ones in that material, not measured rates for this application. Every tool is arithmetic or a fixed public table, cites one public source in its result, echoes its inputs, and fails closed on missing or out-of-range input. Tools with a danger threshold show a fixed alert from the cited source first; the application's emergency screen is unchanged and still runs before any chat-selected tool.

| Tool | Problem it answers | Evidence | Source in the result |
| --- | --- | --- | --- |
| Child fever-medicine dose check (`child_dose_check`) | Caregivers dose by age or temperature instead of weight, mix infant drops with children's liquid, use kitchen spoons, and give two products with the same ingredient. | [AAP HealthyChildren](https://www.healthychildren.org/English/safety-prevention/at-home/medication-safety/Pages/Acetaminophen-for-Fever-and-Pain.aspx) dosing tables; FDA acetaminophen safety page; MedlinePlus 000319; a pharmacist review of caregiver dosing errors | AAP acetaminophen and [ibuprofen](https://www.healthychildren.org/English/safety-prevention/at-home/medication-safety/Pages/Ibuprofen-for-Fever-and-Pain.aspx) pages |
| Growth percentiles (`growth_percentile`, `child_bmi_percentile`) | A percentile read as a grade ("is the 10th percentile bad?"); one reading read as a trend. | CDC guidance on the WHO growth charts; AAP "Growth charts by the numbers" | [CDC growth chart data files](https://www.cdc.gov/growthcharts/cdc-data-files.htm) |
| Oral rehydration planner (`ors_planner`) | How much oral rehydration solution, how often, and when to seek care after vomiting or diarrhoea. | [NICE CG84](https://www.nice.org.uk/guidance/cg84); AAFP 2019; CDC MMWR 2003 (RR-16) | NICE CG84 |
| Lab result reader (`lab_result_reader`) | "What does this number mean" in a patient portal; a flag such as "reactive" read as good news. About three quarters of online posts about results ask to understand the values. | PMC7752528; PMC6857529; JAMIA Open 2025; the JAMA Network Open 2023 survey cited above | [NIST SP 811](https://www.nist.gov/pml/special-publication-811) for unit factors; the report's own range for position |
| Home blood-pressure log (`bp_log_summary`) | Order of the numbers, posture, averaging, and home against clinic thresholds. | AHA and ACC home-monitoring guidance | [2017 ACC/AHA guideline](https://doi.org/10.1161/HYP.0000000000000065); CDC STEADI orthostatic measurement |
| Glucose log pattern (`glucose_log_pattern`) and the A1c line on `estimated_glucose` | "My reading is 110, so my A1c must be fine." | ADA Standards of Care; Diabetes Journals, "If the numbers don't fit" | [ADA Standards of Care, section 6](https://doi.org/10.2337/dc26-S006); [ADAG](https://doi.org/10.2337/dc08-0545) |
| Medication schedule sheet (`medication_schedule`, `rxnorm_ingredients`) | "Twice daily" misread (35% correct in a low-literacy group against 76% with concrete times); the same ingredient under a brand and a generic name. | [AHRQ Health Literacy Toolkit, tool 16](https://www.ahrq.gov/health-literacy/improve/precautions/tool16.html); Davis 2006 label study; caregiver.org | AHRQ tool 16; [NLM RxNorm](https://rxnav.nlm.nih.gov/) |
| STEADI fall-risk checklist (`steadi_fall_risk`) | Older adults are not screened for fall risk. | CDC STEADI "Stay Independent" 12-item questionnaire | [CDC STEADI](https://www.cdc.gov/steadi/patient.html) |
| When-to-call sheet (`sheet: when_to_call`) | Discharged patients do not know who to call or which symptom is a warning sign. | BMJ Open 2017 e014842; AHRQ RED toolkit; an advice-line study (15% readmission among callers) | Retrieved sources with citations; fixed emergency and routine tiers |
| Peak-flow zone (`peak_flow_zone`), heart-failure weight check (`hf_weight_zone`) | Action-plan zones from a personal best or a weight change. | NHLBI asthma action plan; AHA heart-failure action plans | [NHLBI Asthma Action Plan](https://www.nhlbi.nih.gov/resources/asthma-action-plan); [AHA](https://www.heart.org/en/health-topics/heart-failure/warning-signs-of-heart-failure/managing-heart-failure-symptoms) |

### Growth data: CDC and WHO tables, and the licence

Percentiles use the LMS parameters (L skewness, M median, S coefficient of variation) that CDC publishes for the [WHO Child Growth Standards](https://www.cdc.gov/growthcharts/who-data-files.htm) (weight, length, and head circumference for age, whole months 0 to 24) and the [CDC 2000 growth charts](https://www.cdc.gov/growthcharts/cdc-data-files.htm) (weight, stature, and BMI for age, 2 to 20 years). The switch happens at 24 months, as CDC recommends: WHO standards below it, CDC charts from it. CDC publications are works of the US government and in the public domain, and the WHO tables are redistributed by CDC in that form, so the data is bundled unchanged (only combined into one JSON file). Attribution and retrieval date are in `NOTICE.md`. The bundle is `app/tools/data/growth_lms.json`, built by `scripts/build_growth_tables.py`. A manifest records its SHA-256, size, and row counts; `app/tools/growth.py` verifies all three on first use and, on any mismatch or a missing file, returns a fixed unavailable message and never a number (the `growth_table_missing` failure case). The z-score is ((X/M)^L − 1)/(L·S), or ln(X/M)/S when L is 0, with L, M, and S interpolated linearly between table ages; the percentile is the normal cumulative distribution at z. Below 24 months, when |z| is above 3, the WHO modified z-score is used. The tool does not name a weight category: it flags a value only outside the WHO ±2 SD or the CDC 5th to 95th percentile and says to discuss it with a clinician.

### Child dosing: a label lookup, not a calculation

Dosing calculators stay on the exclusion list above for prescription and patient-specific dosing. This version adds one narrow exception: the over-the-counter label amounts that AAP and FDA publish for parents. The AAP HealthyChildren pages print one amount per weight band (for example 24 to 35 lb, 5 mL of 160 mg/5 mL acetaminophen), mirroring the FDA Drug Facts tables. The tool therefore returns the amount printed for the child's band, with the band shown, and never computes milligrams per kilogram. The band tables are constants in `app/tools/clinical.py` (`CHILD_DOSE_BANDS`), copied from the two AAP pages on 2026-10-25 rather than from a third-party chart, because sources differ by small amounts (ibuprofen 100 mg/5 mL at 18 to 23 lb is 4 mL on the AAP page; some charts print 3.75 mL). Tests pin every row, and a sanity test checks that each row's amount stays inside 10 to 15 mg/kg (acetaminophen) or 5 to 10 mg/kg (ibuprofen) at the band midpoint, which catches a mistyped row without using mg/kg to produce a dose. Age and weight hard stops return no amount: acetaminophen under 3 months (a same-day call), ibuprofen under 6 months, weights below the smallest band, and weights or ages past the end of the table (95 lb or 11 years for the children's tables; the infant-drops table ends sooner). A concentration that does not belong to the medicine is refused. The chat description says the concentration must be copied from the user's words and never assumed, and the answer prompt requires the result to be presented as the label amount for that band.

### Medication schedule: AHRQ time periods and RxNorm

The sheet uses the time periods of the AHRQ Universal Medication Schedule (morning, noon, evening, bedtime), as implemented in `DIRECTION_SLOTS` in `app/tools/forms.py`: once daily goes to the named period; twice daily goes to morning and evening; three times daily and "with meals" go to morning, noon, and evening; four times daily uses all four periods; "every morning and bedtime" is a separate choice for a medicine that is meant to sit at those two times; weekly, as-needed, and "other" take no slot and show the label wording (for "other", with a note to ask the pharmacist to place it). The sheet says the times are suggestions to confirm with the pharmacist and that medicines needing exact intervals keep the label's spacing.

RxNorm (NLM, no key) is used for one purpose: to resolve each typed medicine name to its active ingredient(s) so the same ingredient listed twice, such as a brand and its generic, is flagged. It follows the DailyMed rules: fixed endpoints, an exact-then-normalised name match with no approximate matching (so a misspelling returns nothing rather than a guess), a 256 KiB response cap, an eight-second budget, a circuit breaker, and no logging of names. The limits are stated in every result: this is ingredient grouping, not an interaction check and not a dose check. A name RxNorm cannot match, or a lookup that fails or times out, leaves that row un-normalised with the typed name, and the fallback duplicate check compares typed names only (case-insensitive), so a brand and its generic are not linked without RxNorm. A failed lookup never blocks the sheet and never produces a conclusion. The `schedule_*` cases in `docs/FAILURE_MODES.md` exercise a shared ingredient, a 503 from every call, and a batch timeout.

### Left out, and why

| Candidate | Decision |
| --- | --- |
| Pregnancy dating and kick counts | Removed at the user's request; out of scope for this version. |
| SpO2 checklist | Removed by judgement. The application cannot measure oxygen saturation, and a typed home reading needs education about baseline and limits, which the existing guide pattern covers better than a calculator. |
| Symptom diary with a body map | Deferred. It needs local-only storage, a timeline export, and handoff integration that this version does not have room for; the handoff already carries the person's own words. |
| Immunisation schedule | Deferred. Schedules vary by country and change yearly. |
| Wong-Baker faces scale | Not used; it is licensed artwork. A 0 to 10 numeric scale with plain anchors is public. |

Logs (blood pressure, glucose, weight, medicines) stay in the browser: they are saved only when the person turns the log on, a Clear button deletes them, and the server sees entries only as explicit inputs when the person presses Run. They reach the clinician handoff only through an explicit action.
