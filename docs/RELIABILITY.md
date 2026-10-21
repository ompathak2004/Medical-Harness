# Tools and reliability

Emergency triage precedes all tools. The planner selects at most two relevant tools. Missing facts are not normal findings. Medical answers require sources and completed review. These safeguards do not establish clinical accuracy.

| Tool | Input and result | Boundary |
| --- | --- | --- |
| MediSearch | Conversation → sources and excerpts | Missing evidence is explicit |
| DailyMed labels | Named medicine → up to three US label links/dates | Directory only, no interaction or dosing claim |
| PubMed lookup | Topic → up to three indexed abstracts via Europe PMC | Explicit research requests, not systematic review |
| Adult BMI | Age, height, weight → BMI and CDC category | Age 20+, not pediatric/pregnancy classification |
| CKD-EPI 2021 eGFR | Adult age, equation sex, creatinine → eGFR | Stable creatinine; not AKI, pregnancy, CKD diagnosis or dosing |
| Estimated average glucose | HbA1c percent → estimated mg/dL and mmol/L | Not current glucose or insulin dosing |
| Measurement conversion | Value and conversion → value/units | Weight, height, temperature, glucose, creatinine; no drug doses |
| Two-level Wells DVT | All criteria explicitly supplied → score and likelihood | Requires examination; cannot rule out a clot |
| CHA2DS2-VASc | Confirmed AF and supplied factors → score | No treatment recommendation |
| MRC muscle strength | Examined integer grade → description | No grade inferred from symptoms |
| Anatomy | Spatially useful question → reference scene | No patient findings, diagnosis or inferred laterality |
| Imaging report guide | Report question → context, findings, and impression explanation | Text only; no image upload or scan interpretation |
| Blood pressure guide | Measurement question → systolic, diastolic, and repeat-reading explanation | Illustrative values, no personal category or treatment target |
| ECG guide | Test question → P/QRS/T signal explanation | Uncalibrated schematic, no waveform analysis or diagnostic reassurance |

Calculator results include source and scope. Tests cover nonnumeric, nonfinite, out-of-range, contradictory age-band and missing inputs. Approximate Framingham scoring is removed.

## Failure behavior

| Condition | Response |
| --- | --- |
| Emergency | Fixed urgent guidance, no normal tools |
| Greeting/unrelated request | Fixed nonclinical response after triage |
| Essential facts missing | Up to three questions, one round maximum |
| No medical evidence | Explicit limitation, no generated answer |
| Partial stream, review failure or invalid citations | Discard draft, return error |
| Reference endpoint fails | Explicit unavailable result, not a clinical negative |
| Graphics/download failure | Keep searchable structures and text input |

Network work has deadlines, byte limits, pooled clients and circuit breakers. Session-scoped caches coalesce work and cancellation releases pending tasks. Limits remain per instance; see [configuration](CONFIGURATION.md).

Future tools should address observed gaps. Jurisdiction-appropriate patient education and medication-name normalization are reasonable candidates. A verified interaction service needs authoritative data and clinical evaluation. Clinician-reviewed cases are more useful than adding unvalidated risk scores.
