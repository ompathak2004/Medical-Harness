# Reliability harness

OpenMed is an educational health assistant. Its control flow treats medical emergencies, ordinary conversation, and evidence-backed medical questions as different tasks. This document records the expected behavior and the next tool choices.

## Why the routes are separate

The [World Health Organization](https://www.who.int/news/item/18-01-2024-who-releases-ai-ethics-and-governance-guidance-for-large-multi-modal-models) recommends well-defined health AI tasks with measured accuracy and reliability. [AHRQ's review of symptom-checker research](https://www.ahrq.gov/diagnostic-safety/research/stroke-support.html) shows that triage mistakes can be unsafe. [Agent-building guidance](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/) recommends guardrails tied to observed failures and repeatable evaluations. These sources motivate a narrow route for messages such as “hi,” while preserving emergency triage and the reviewed medical answer path.

1. Classify the latest turn in conversation context. Emergency takes priority.
2. Return a fixed, nonclinical response to a greeting, courtesy message, capabilities question, unclear message, or unrelated request. Exact first-turn routine phrases also recover from an unnecessary medical clarification. These responses do not retrieve evidence, select calculators, or claim citations.
3. For a medical request, ask for details only when they materially change advice. Otherwise retrieve sources and calculate applicable scores from supplied inputs. If sources are unavailable, state that limitation.
4. Review the complete medical answer before the browser receives it. Record only numeric outcome counts in protected, per-instance metrics.

## Regression cases

| Input | Required path |
| --- | --- |
| `hi`, `hii`, `morning` | Short greeting, no symptom form or medical retrieval |
| `thanks`, `bye`, `what can you do?` | Appropriate bounded reply |
| Unclear text or a clearly unrelated request | Ask for a health concern or explain the app's scope |
| `Hi, I have crushing chest pain and I'm sweating` | Emergency triage, never greeting |
| A short answer such as `morning` to an earlier medical follow-up | Continue the medical conversation |
| Clear health question | Evidence-backed answer and completed safety review |
| Evidence or review failure | Explicit limitation or safe error; no invented sources or unreviewed answer |

Automated tests use scripted provider responses to check these paths without live keys or patient data. They do not establish clinical accuracy. Before expanding clinical scope, add clinician-reviewed cases for red flags, ambiguous symptoms, medication questions, missing data, mixed-language inputs, and possible under-triage. Review false negatives as well as false positives.

## Tool review

The current tools are MediSearch retrieval, anatomy selection, and deterministic calculators. The next useful addition is a **patient education source**, especially for broad questions whose best explanation is not a single paper. The [National Library of Medicine's MedlinePlus Web Service](https://medlineplus.gov/about/developers/webservices/) supports ranked health-topic searches with summaries and source links. It requires attribution, limits clients to 85 requests per minute per IP address, and recommends caching. Any integration should send a short topic query rather than a full patient conversation, keep its source type distinct from research articles, and fail explicitly if it cannot retrieve material.

For medication names, [RxNorm's API](https://lhncbc.nlm.nih.gov/RxNav/APIs/RxNormAPIs.html) could normalize a name before retrieval. A normalized name is not a verified interaction or dosing recommendation. Medication safety advice needs its own source, validation, and evaluation cases. Additional scoring calculators should follow the same standard: validated scope, required inputs, unit checks, source attribution, and refusal to score when data are missing.
