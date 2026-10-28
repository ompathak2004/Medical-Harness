# Tools and reliability

Emergency triage precedes all tools. The planner selects at most two relevant tools. Missing facts are not normal findings. Medical answers require sources and completed review. These safeguards do not establish clinical accuracy.

| Tool | Input and result | Boundary |
| --- | --- | --- |
| MediSearch | Conversation → sources and excerpts | Missing evidence is explicit |
| DailyMed labels | Named medicine → up to three US label links/dates | Directory only, no interaction or dosing claim |
| FDA label sections | One named medicine → boxed warning, indications, contraindications, warnings, adverse reactions from the newest single-ingredient US label (openFDA) | Exact product only; combination products are flagged, not quoted; interactions section is reported as present, never quoted; no interaction or dosing claim |
| PubMed lookup | Topic → up to three indexed abstracts via Europe PMC | Explicit research requests, not systematic review |
| Adult BMI | Age, height, weight → BMI and CDC category | Age 20+, not pediatric/pregnancy classification |
| CKD-EPI 2021 eGFR | Adult age, equation sex, creatinine → eGFR | Stable creatinine; not AKI, pregnancy, CKD diagnosis or dosing |
| Estimated average glucose | HbA1c percent → estimated mg/dL and mmol/L | Not current glucose or insulin dosing |
| Non-HDL cholesterol | Total minus HDL, with explicit matching units → value and supplied units | Same panel only; no LDL estimate, risk category, target or medicine advice |
| Pack-years | Explicit packs per day and years smoked → pack-years | Arithmetic only; quotes USPSTF wording as a conversation starter, not an eligibility decision or cancer risk estimate |
| Waist-to-height ratio | Waist and height in cm → ratio | Adults; quotes NICE NG246 wording, not a diagnosis or category; waist must be below height |
| Measurement conversion | Value and conversion → value/units | Weight, height, temperature, glucose, creatinine; no drug doses |
| Two-level Wells DVT | All criteria explicitly supplied → score and likelihood | Requires examination; cannot rule out a clot |
| CHA2DS2-VASc | Confirmed AF and supplied factors → score | No treatment recommendation |
| MRC muscle strength | Examined integer grade → description | No grade inferred from symptoms |
| Anatomy | Spatially useful question → reference scene | No patient findings, diagnosis or inferred laterality |
| Imaging report guide | Report question → context, findings, and impression explanation | Text only; no image upload or scan interpretation |
| Blood pressure guide | Measurement question → systolic, diastolic, and repeat-reading explanation | Illustrative values, no personal category or treatment target |
| ECG guide | Test question → P/QRS/T signal explanation | Uncalibrated schematic, no waveform analysis or diagnostic reassurance |

Calculator results include source, scope, and the inputs as supplied. Tests cover nonnumeric, nonfinite, out-of-range, contradictory age-band and missing inputs. Approximate Framingham scoring is removed.

## Failure behavior

| Condition | Response |
| --- | --- |
| Emergency | Fixed urgent guidance, no normal tools |
| Greeting/unrelated request | Fixed nonclinical response after triage |
| Essential facts missing | Up to three questions, one round maximum |
| No medical evidence | Explicit limitation, no generated answer |
| Partial stream, review failure or invalid citations | Discard draft, return error |
| Reference endpoint fails | Explicit unavailable result, not a clinical negative |
| Label service rate limit (HTTP 429) | Tool reports `unavailable` with a try-again message and counts toward the circuit breaker; the answer continues from other sources |
| Only combination products match a medicine name | Label tool reports `empty` with `combination_only`; no label text is shown or cited and the handoff says why |
| Graphics/download failure | Keep searchable structures and text input |

## Handoff

Every `result`, and every 503 or stream `error` payload, carries a `handoff` object assembled by `app/handoff.py` without another model call. It holds the person's own messages, structured calculator inputs and results, reference lookups, the numbered sources with whether the reviewed answer cited each one, fixed limitation lines, three fixed questions to ask a clinician, and a trace of the five steps (triage, tools, evidence, draft, review) with statuses and milliseconds. It never contains the AI's answer prose, prompts, or provider text, and the server stores nothing; the browser offers Copy, Print, and a client-side download. "Emergency screen: not flagged" means only that the emergency screen did not fire; it is not a triage category. Claim support counts which retrieved sources the answer cited and does not verify any statement. Each way the pipeline can fail is exercised offline; see [failure modes](FAILURE_MODES.md).

Network work has deadlines, byte limits, pooled clients and circuit breakers. Session-scoped caches coalesce work and cancellation releases pending tasks. Limits remain per instance; see [configuration](CONFIGURATION.md).

Future tools should address observed gaps. Jurisdiction-appropriate patient education and medication-name normalization are reasonable candidates. A verified interaction service needs authoritative data and clinical evaluation. Clinician-reviewed cases are more useful than adding unvalidated risk scores.
