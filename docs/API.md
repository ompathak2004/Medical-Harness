# HTTP API

The app serves its API and frontend from the same origin. Run it locally, then open `/docs` for FastAPI's interactive schema. The examples below use `http://localhost:8080`.

## Health

`GET /api/health` returns a small status object and version. It does not call the external providers.

```bash
curl http://localhost:8080/api/health
```

## Chat request

Both chat endpoints accept JSON with `conversation` and an optional `conversation_id`:

```json
{
  "conversation": ["What does BMI mean?"],
  "conversation_id": "optional-stable-id"
}
```

`conversation` is a nonempty list of strings: user, assistant, user, and so on (omitted only for a [sheet request](#when-to-call-sheet-request)). It must end with the user's message. The server limits the conversation to 39 messages and each message to 8,000 characters by default. Reuse the returned `conversation_id` for follow-up requests.

### When-to-call sheet request

Both chat endpoints also accept a `sheet` field in place of a conversation:

```json
{
  "sheet": {"kind": "when_to_call", "condition": "heart failure"}
}
```

`kind` is always `"when_to_call"`. `condition` is 3 to 200 characters of letters, digits, spaces, and basic punctuation (`, . ' ( ) / & + -`) with no run of four digits, so dates, phone numbers, and identifiers are rejected with 422; unknown fields are rejected too. When `sheet` is present `conversation` must be omitted or empty and `user_turn_times` must be empty, otherwise the route returns 400 `{"detail": "A sheet request must not include a conversation."}`; without `sheet`, an empty conversation is still a 422. The server builds the single user turn itself from a fixed template ("Make a when-to-call sheet for someone recently discharged after: {condition}. List warning signs that mean they should call their care team the same day."). Names, phone numbers, and a person's own thresholds are never part of a request; the browser adds them to the printed sheet.

The request runs the normal pipeline in sheet mode: emergency triage first (an emergency, a clarification, or a conversation result is returned exactly as in chat and carries no `sheet`), no tool planning (the `tools` trace step is `skipped`), source retrieval for the templated turn, a dedicated drafting prompt for the middle tier only, then the unchanged safety review. `visual_context` and `anatomy_context` are `null`.

`POST /api/chat` waits for a JSON response. For example:

```bash
curl -X POST http://localhost:8080/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"conversation":["What does BMI mean?"]}'
```

The response has `type` (`answer`, `follow_up`, `emergency`, or `conversation`), `conversation_id`, `answer`, `articles`, `tool_results`, `followups`, `anatomy_context`, and emergency or clarification fields. A `conversation` result handles greetings, thanks, help requests, unclear messages, and unrelated requests with a short reply in `answer`. It has no articles or calculator results and uses `evidence_status: "not_applicable"`. See `app/schemas.py` for exact optional fields and defaults.

In sheet mode the `answer` result also carries `sheet`, which is `null` or absent on every other result (including emergency, clarification, and evidence-unavailable results):

```json
{
  "sheet": {
    "kind": "when_to_call",
    "emergency_signs": ["Chest pain or pressure, ...", "..."],
    "emergency_line": "Call your local emergency number now; do not wait for an online answer.",
    "routine_lines": ["Keep your follow-up appointment.", "..."],
    "middle_tier_source": "answer"
  }
}
```

`emergency_signs`, `emergency_line`, and `routine_lines` are fixed server constants (`app/tools/sheets.py`; the signs restate the triage red flags in patient wording). The reviewed, cited middle tier ("Call your care team today if") is `answer`, with its sources in `articles`; `middle_tier_source` names that field. When evidence is unavailable the result still carries the fixed tiers with `middle_tier_source: "unavailable"` and no `answer` text; the browser prints blank ruled lines for the middle tier. The handoff's `limitations` adds a line stating that the middle tier was written from retrieved sources and reviewed, that the other tiers are fixed, and that names, numbers, and personal thresholds were added in the browser and never sent.

### Time and country context

Clients can optionally send `context: {"time_zone":"Asia/Kolkata","locale":"en-IN","country_code":"IN"}`. The zone must be a valid IANA identifier; locale is a bounded language tag; country is an optional two-letter uppercase code. Omit unknown fields. Browser settings describe the user's clock and language, not their physical location.

Both responses and SSE `meta` include `request_context`: server `received_at` with local UTC offset, `local_date`, `time_zone`, `time_zone_source`, `locale`, `country_code`, and `country_source`. The server clock is authoritative. Browser time zone takes precedence; Vercel's approximate network zone is a fallback, followed by explicitly labeled UTC. A supplied country takes precedence over Vercel's approximate network country. Network hints are accepted only in the Vercel runtime (`VERCEL=1`). No precise coordinates are collected.

For follow-ups, send `user_turn_times`, containing each earlier user turn's returned `received_at`, in order. Use `null` for unknown times, or omit the array entirely for legacy clients. A nonempty array must have exactly one entry per earlier user turn. Offsets must be present. These are client-supplied history annotations, not authenticated clinical observations. The current turn always uses the server clock. This preserves the date of an earlier “this morning” when a conversation crosses midnight or the user changes time zones. Exact onset and location are clarified when clinically relevant; neither is inferred from an approximate phrase or network country.

`visual_context` is `null` or one of `eye_pressure`, `asthma`, `reflux`, `kidney_stones`, `gallstones`, `osteoarthritis`, `disc_nerve`, `atherosclerosis`, `radiology_report`, `blood_pressure`, and `ecg`. It offers a fixed, sourced educational guide after a reviewed answer. Emergency, clarification, routine, evidence failure, and failed review paths do not publish a guide. The triage policy selects a guide for a relevant explanation, not as a diagnosis inferred from an unexplained symptom. Unknown and malformed IDs are discarded.

`radiology_report` explains written imaging report sections. Requests remain text-only; no image upload, scan interpretation, OCR, or ECG waveform analysis is supported. Report explanations must preserve uncertainty and stated follow-up recommendations.

Guides do not provide a diagnosis, personalized simulation, or procedural guidance. Eye-pressure education suppresses the less relevant head atlas. Other guides may accompany an independently selected `anatomy_context` when the question also asks about location or spatial relationships; reference geometry does not show the condition. Clients must only render known visual IDs, never model-supplied SVG or HTML. The browser loads the guide renderer and original diagrams only when opened.

## Streaming chat

`POST /api/chat/stream` accepts the same request and replies with `text/event-stream`:

```bash
curl -N -X POST http://localhost:8080/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"conversation":["What does BMI mean?"]}'
```

| Event | Meaning |
| --- | --- |
| `meta` | Generated or reused `conversation_id` and server `request_context` |
| `step` | Current pipeline stage and human-readable message |
| `answer_chunk` | Reviewed answer text after the safety pass |
| `result` | Complete authoritative response; the UI renders this |
| `error` | `{"detail": "...", "handoff": {...}}` when streaming work fails; no answer text |

The server may send SSE comment keep-alives while work is pending. Consumers should ignore comments and use `result` as the final answer. It has the same validated shape as the buffered response, including `conversation_id`. The app emits the reviewed answer as one `answer_chunk`, after safety review; the browser waits for `result`.

Numbered citations in `answer` refer to the structured `articles` array. Recognized duplicate bibliography sections are removed before safety review, including from a proposed revision before its second review. An empty result is rejected. The browser renders article titles as direct external links and exposes summaries through a separate Details control; it does not reconstruct references from prose.

## Metrics

`GET /api/metrics` is available only when `METRICS_TOKEN` is set. Send `Authorization: Bearer <token>`. Without a matching token, the route returns 404. It reports numeric usage, cache counters, and completed outcome counts (`conversation`, `follow_up`, `answer`, `emergency`, and `evidence_unavailable`), not question text. Counts are per process or Vercel Function instance.

## Limits and errors

Validation errors use normal FastAPI HTTP statuses. The app may return 429 for the per-instance chat rate limit or 503 when busy, timed out, or unable to complete a safe answer. Do not present a 503 as a medical answer. A 503 caused by a failed review or a timeout has the body `{"detail": "Unable to complete the answer review. Please try again.", "handoff": {...}}`; `detail` is always a string. See [Clinician handoff](#clinician-handoff). See [configuration](CONFIGURATION.md) for limit settings.

## Clinician handoff

Every `result` (`answer`, `follow_up`, `emergency`, `conversation`, and evidence-unavailable answers) carries a `handoff` object, and so do the 503 body and the SSE `error` event. It is a deterministic summary assembled from data the pipeline already holds: no extra model call, no storage, and no answer prose. `result` remains the only authoritative answer; `handoff` summarizes that same result, and an error payload's handoff contains no answer text. The handoff never adds a conversation message. `ChatResponse.handoff` is `null` only for legacy callers and test doubles.

```json
{
  "version": 1,
  "reason": "answer_available",
  "urgency": "routine",
  "questions": ["I am 30, weigh 70 kg and am 175 cm tall. What is my BMI?"],
  "calculations": [{"tool": "BMI", "inputs": {"weight_kg": 70, "height_cm": 175}, "result": "22.9", "units": "", "source": "https://...", "scope": "...", "error": "", "missing_inputs": []}],
  "references": [{"tool": "DailyMed", "status": "available", "items": [{"title": "...", "url": "https://..."}], "note": ""}],
  "sources": [{"index": 1, "title": "...", "year": "2023", "journal": "NEJM", "url": "https://...", "kind": "research", "cited": true}],
  "limitations": ["This is general information from an automated tool, not a diagnosis or a treatment plan.", "..."],
  "clinician_questions": [{"heading": "What is my main problem?", "text": "..."}, {"heading": "What do I need to do?", "text": "..."}, {"heading": "Why is it important?", "text": "..."}],
  "trace": {
    "steps": [{"name": "triage", "status": "ok", "elapsed_ms": 820, "detail": ""}, "... tools, evidence, draft, review"],
    "claim_support": {"citation_markers": 3, "sources_retrieved": 4, "sources_cited": 2, "uncited_sources": [3, 4]}
  }
}
```

- `questions` are the user's own turns, verbatim and in order. Assistant turns and the answer text are excluded.
- `calculations` list calculator results with the inputs as supplied (when the tool echoes them), the headline value, units, source, and scope, or the `error` and `missing_inputs`.
- `references` list directory and reference lookups (title and URL, plus `product` and `set_id` for label sections) with `status` and the tool's `error` as `note`.
- `sources` are the numbered `articles` sent in the result. `kind` is `research`, `abstract`, or `label_section`; `cited` says whether the reviewed answer cites that index.
- `limitations` are fixed strings chosen by condition, always starting with the general-information and emergency-screen lines and ending with the citation-check line. "Routine" urgency only means the emergency screen did not fire.
- `clinician_questions` are fixed templates under the Ask Me 3 headings. Only calculator results and the source count are substituted; message text never is.
- `trace.steps` always has five rows in the order `triage`, `tools`, `evidence`, `draft`, `review`. Status is `ok`, `skipped`, `failed`, or `fallback`; `detail` comes from a fixed vocabulary (`invalid_json`, `unavailable`, `selected=N`, `partial`, `selection_failed`, `empty`, `error`, `reference_sources`, `over_budget`, `interrupted`, `attempts=2`, `revised_once`) and never contains provider or user text. `elapsed_ms` is the step's duration; `tools` and `evidence` run concurrently and are timed separately.
- `trace.claim_support` is `null` when no answer was produced. It is coverage, not verification: it shows which retrieved sources the reviewed answer pointed at, not whether a statement is true.

| `reason` | `urgency` | When |
| --- | --- | --- |
| `emergency` | `emergency` | The emergency screen fired. Nothing else ran. |
| `user_requested` | `routine` | A routine conversation reply (greeting, thanks, off-topic). |
| `clarification_pending` | `routine` | Clarifying questions were returned (`follow_up`). |
| `evidence_unavailable` | `routine` | No sources were retrieved, including a provider failure. |
| `clarification_limit` | `routine` | An answer was produced after the one clarification round while triage still wanted more detail. |
| `tool_input_missing` | `routine` | An answer was produced but a calculator reported `missing_inputs` or an input `error`. |
| `answer_available` | `routine` | A reviewed answer with sources. |
| `review_unavailable` | `unknown` if triage never completed, otherwise `routine` | `ReviewUnavailable` or a request timeout. Only in the 503 body and `error` event. |

On the answer path precedence is `clarification_limit`, then `tool_input_missing`, then `answer_available`. A timeout has no pipeline trace, so its handoff is built by the route with all five steps `skipped`.

## Anatomy and calculators

`anatomy_context` is `null` unless triage determines a spatial explanation is useful. Otherwise it is a validated object such as:

```json
{"scene_id":"knee","label":"Knee","reason":"See the bones around the knee."}
```

Supported scene IDs are `head`, `neck`, `shoulder`, `chest`, `abdomen`, `pelvis`, `spine`, `elbow`, `hand`, `knee`, `lower_leg`, and `foot`. This replaces the old `has_anatomy`/region-array contract. Emergency, routine conversation and evidence failure paths suppress anatomy. The browser downloads the model only after the user opens it.

Calculator results include `tool`, `source`, `scope`, and a numeric score or value with units where applicable. Invalid supplied inputs yield an `error`; missing inputs never become assumed normal values. The approximate Framingham calculator has been removed. The new tools are adult CKD-EPI 2021 eGFR, estimated average glucose from HbA1c, and explicit measurement conversion.

`non_hdl_cholesterol` accepts `total_cholesterol`, `hdl_cholesterol`, `total_units`, and `hdl_units` from the same lipid panel. Units must match and be `mg/dL` or `mmol/L`. The result contains `value` and `units` alongside source/scope metadata. It does not classify cardiovascular risk or supply a treatment target. HDL above total, mixed/unknown units, nonfinite or negative inputs, and total above 1,000 mg/dL or 30 mmol/L are rejected. Values are rounded to two decimal places.

Every successful calculator result also echoes the validated `inputs` object (field name to value) so the handoff and the tool card can show exactly what was used.

`pack_years` accepts `packs_per_day` (0.05 to 10) and `years_smoked` (0 to 100) and returns `value` (their product rounded to one decimal), `units: "pack-years"`, and a `recommendation` quoting the USPSTF lung cancer screening wording as a conversation starter; it does not decide eligibility. `waist_to_height` accepts `waist_cm` (40 to 250) and `height_cm` (100 to 250) and returns `value` (rounded to two decimals), `units: "ratio"`, and a `recommendation` quoting NICE NG246's wording; a waist at or above height is rejected as an input error. Both require explicit numbers and never estimate a missing one.

The default aggregate conversation limit is 32,000 characters and request body limit is 262,144 bytes. A request above either limit returns 413. The `result` event is authoritative. Incomplete provider streams, failed re-review, or missing/out-of-range citation indices produce an error instead of an answer. An unsafe draft can be revised once and must pass a separate second review. Protected metrics include the LLM `circuit_open` flag.

## Reference tools

`tool_results` may contain a reference result with `tool`, `source`, `scope`, `status` (`available`, `empty`, `unavailable`), and `items`. Each item has `title` and a validated source `url`. DailyMed items optionally include `published`; they contain label directory metadata, not label contents or interaction checks. Europe PMC items include an abstract excerpt in `tldr`, `year`, `journal`, and `evidence_kind: "abstract"`. Label-section items use `evidence_kind: "label_section"` with the same `tldr`, `title`, `url`, `year`, and `journal` fields.

The `FDA label sections` tool (`label_sections`, openFDA) returns, for one named medicine, a result with `status`, `product`, `generic_name`, `effective_time`, `set_id`, a DailyMed `url` built from the set ID, `has_interactions_section` (presence only; the interactions text is never quoted), and `items`. Each item is one section in fixed order (`boxed_warning`, `indications_and_usage`, `contraindications`, `warnings_and_precautions` or `warnings`, `adverse_reactions`) with `title`, `section`, `url`, `year`, `journal`, `source`, `tldr` (HTML stripped, at most 1,000 characters), and `evidence_kind: "label_section"`. If only combination products match the name, the result has `status: "empty"`, `combination_only: true`, an `error` explaining why, and no items. If rows match but none can be confirmed as a single-ingredient product (missing or ambiguous ingredient metadata), the result is `status: "empty"` with an `error` and no `combination_only` flag. A rate limit (HTTP 429) gives `status: "unavailable"` with a try-again message.

The `RxNorm ingredients` tool (`rxnorm_ingredients`, RxNav at `rxnav.nlm.nih.gov`, no key) resolves one explicitly named medicine to its active ingredients; it is not an interaction check, dosing, or a product confirmation. The query is 1 to 60 characters of letters, digits, spaces, and hyphens, starting with a letter and with no run of four digits. It makes at most two requests inside the 8-second budget: an exact-then-normalised name match (`rxcui.json?name=...&search=2`, no approximate matching, so a misspelling is `empty` rather than a guess), then `rxcui/<id>/related.json?tty=IN+MIN` for the first match. Identifiers must be 1 to 8 digits; an invalid one gives `status: "empty"` without a second request. The result has `status`, `rxcui` (the matched concept), `combination`, and `items`, each `{"title": <ingredient name>, "url": <RxNav page for that RxCUI>, "rxcui", "tty": "IN"}`. `combination` is `true` when the match has two or more ingredients; the combination concepts (`tty: "MIN"`) are then added to `items`. A single ingredient is never flagged just because RxNorm lists combinations that contain it. Items carry no `tldr`, so they never become numbered evidence. A rate limit (HTTP 429) gives `status: "unavailable"` with a try-again message and counts toward the circuit breaker.

PubMed abstracts and official label sections (any reference item with a `tldr` excerpt) may join the numbered article list or supply evidence when the primary provider is unavailable or fails. Label sections come first (at most 5), then abstracts, then the primary sources fill the rest; when they change the numbering the primary retrieval summary is dropped. The combined list remains bounded by `MAX_EVIDENCE_ARTICLES`, and all claims still pass answer review. Directory-only label results cannot replace medical evidence. Failed lookups return an explicit limitation; they never mean a medicine is safe or that no research exists.

## Tools endpoint

The patient tools run without a language model. `GET /api/tools` lists them and `POST /api/tools/{key}` runs one. The `POST` requests count toward the `/api/tools` rate limit (`TOOL_RATE_LIMIT_REQUESTS` per client per window, counted separately from `/api/chat`); the listing is not counted. Reference tools (`drug_labels`, `pubmed_search`, `label_sections`, `rxnorm_ingredients`) are not exposed here; they return 404 like any unknown key. The server logs the tool key and one of `ok`, `error`, `unavailable`, never the inputs.

`GET /api/tools` returns `{"tools": [{"key", "name", "description", "variables", "source", "scope", "kind"}]}`, where `kind` is `calculator` (the 18 tools in `app/tools/clinical.py` and `growth.py`) or `form` (`bp_log_summary`, `glucose_log_pattern`, `medication_schedule`). `variables` lists the input field names.

```json
POST /api/tools/child_dose_check
{"inputs": {"medicine": "acetaminophen", "concentration": "160mg/5mL", "weight": 14, "weight_units": "kg", "age_months": 36}}

200 {"tool_key": "child_dose_check", "result": {"tool": "...", "key": "child_dose_check", "source": "https://...", "scope": "...", "inputs": {}, "amount_ml": 5}}
```

The body is `{"inputs": {...}}` and nothing else (extra fields give 422). A tool that cannot compute still returns 200 with `result.error` (a fixed sentence) and, for absent fields, `result.missing_inputs`. An error result never carries a computed value next to `error`. Every result has `tool`, `key` (the tool key), `source`, and `scope`; a successful one also echoes the validated `inputs`.

Common rules: text inputs are 1 to N characters starting with a letter or digit (`%`, `µ`, `μ` also allowed), with no run of four or more digits; weights and ages are checked for range; strings are never accepted for numbers; booleans never count as numbers.

### Calculators (`kind: "calculator"`)

| Key | Result fields on success |
| --- | --- |
| `child_dose_check` (inputs `medicine`, `concentration`, `weight`, `weight_units`, `age_months`) | `medicine`, `concentration`, `weight_kg`, `weight_lb`, `band_low_lb`, `band_high_lb`, `band_low_kg`, `band_high_kg`, `amount_ml`, `amount_mg`, `interval_hours_low`, `interval_hours_high`, `max_doses_24h`, `near_band_edge`, `notes[]`, `summary`, `syringe {capacity_ml, amount_ml}`, `combination_warning`, `recommendation`, `source` |
| `ors_planner` (inputs `weight`, `weight_units`, `age_months`) | `weight_kg`, `per_stool_ml`, `per_stool_rule`, `cdc_per_episode_ml {low, high}`, `cdc_per_episode_rule`, `teaspoon_timer {ml_per_sip, seconds_between_low, seconds_between_high}`, `summary`, `red_flags[]`, `recommendation`, `risk_note` (only under 6 months) |
| `lab_result_reader` (inputs `test_name`, `analyte`, `value`, `units`, `range_kind`, `range_low`, `range_high`, `flag_on_report`) | `analyte`, `status` (`below`, `within`, `above`), `position {low, high, value, fraction}`, `converted {value, units}` and `converted_range {low, high, units}` (only for known analyte and unit pairs), `word_help {term, text}` or `null`, `questions[3]`, `summary` |
| `peak_flow_zone` (inputs `personal_best_l_min`, `reading_l_min`) | `value` (percent of best, rounded down), `units`, `zone` (`green`, `yellow`, `red`), `zones[{label, low_pct, high_pct, low_l_min, high_l_min}]`, `recommendation`, `alerts[]` (red only) |
| `hf_weight_zone` (inputs `weight_now`, `weight_before`, `weight_units`, `interval`) | `value` (signed change in the supplied units), `units`, `change_kg`, `change_lb`, `direction` (`gain`, `loss`, `none`), `threshold {lb, kg, interval}`, `zone` (`within`, `call_team`), `recommendation`, `alerts[]` (`call_team` only). Weights more than 20 % apart give an `error` with no result fields; the `call_team` alert is kept when the gain still crosses the threshold |
| `growth_percentile` (inputs `sex`, `age_months`, `measure`, `value`) | `value`, `units`, `z`, `percentile`, `percentile_text`, `reference` (`WHO 2006` under 24 months, `CDC 2000` from 24), `z_method` (`who_lms`, `who_modified`, `cdc_lms`), `flag`, `flag_text`, `curve[{age_months, p3, p15, p50, p85, p97}]` (25 points for WHO, 217 for CDC), `point {age_months, value}`, `measure`, `source`, `summary` |
| `child_bmi_percentile` (inputs `sex`, `age_months`, `weight_kg`, `height_cm`) | as `growth_percentile` without `measure`, plus `reference_lines {p5, p85, p95}` and `recommendation` |
| `estimated_glucose` (input `a1c_percent`) | unchanged `value`, `units`, `mmol_l`, plus `line[{a1c, eag}]` (A1c 5 to 12 in steps of 0.5) and `point {a1c, eag}` |
| `steadi_fall_risk` (12 booleans) | `score`, `max_score` (14), `at_risk` (score of 4 or more), `talk_anyway`, `talk_anyway_text`, `items[{key, text, answer, points}]`, `recommendation`, `home_hazards[]` |

Details a client needs:

- `child_dose_check` returns the amount printed in the American Academy of Pediatrics weight-band tables; it is never calculated from a weight. A hard stop (baby too young, concentration mismatch, weight outside the table, age 12 or over) is an `error` plus `hard_stop {title, text, urgent}`; no amount fields are present. `urgent: true` is used under 3 months (same-day call) whatever the medicine. The age stops run before input validation, so a missing or unknown concentration never hides them. The syringe `capacity_ml` is 5, 10, or 15. Weight is range-checked per unit (2 to 60 kg, 4 to 132 lb). The 50 mg/1.25 mL drops table ends at 59 lb.
- `ors_planner` refuses ages under one month. `seconds_between_low` and `seconds_between_high` bound the teaspoon timer (60 and 120 seconds).
- `lab_result_reader`: `flag_on_report` may be an empty string. For a one-sided range (`range_kind` of `below` or `above`) send the limit in both `range_low` and `range_high`; differing values are an error. The result then has a `null` bound on the unused side and `fraction: null`. For `between`, `range_low` must be below `range_high`. `fraction` is clipped to -0.5 to 1.5. `word_help` is `null` unless the flag matches the glossary.
- `peak_flow_zone` refuses a reading more than 30 % above the personal best. `hf_weight_zone` refuses weights more than 20 % apart.
- `growth_percentile` refuses head circumference from 24 months. Percentile text is capped as "fewer than 1 of 1,000" and "more than 999 of 1,000". If the bundled tables fail their SHA-256 or size check, both growth tools return the error `Growth reference tables are unavailable; no percentile was computed.` and no number. `child_bmi_percentile` refuses a BMI outside 6 to 80.
- `steadi_fall_risk` needs all 12 booleans (`fallen_past_year`, `uses_or_advised_cane_walker`, `unsteady_walking`, `steadies_on_furniture`, `worried_about_falling`, `pushes_with_hands_to_stand`, `trouble_stepping_up_curb`, `rushes_to_toilet`, `lost_feeling_in_feet`, `medicine_causes_lightheaded_or_tired`, `medicine_for_sleep_or_mood`, `often_sad_or_depressed`); a missing one gives `missing_inputs`.

### Form tools (`kind: "form"`)

Form inputs are lists, so they are only accepted through this endpoint. A bad field gives `error: "Invalid or out-of-range input: <field path>."` and no other result fields. Missing top-level fields give `missing_inputs`.

`bp_log_summary`: inputs `readings` (1 to 120 of `{date, time, systolic 50-300, diastolic 30-200, pulse 20-250 or omitted, position sitting|standing|lying}`, systolic above diastolic) and optional `window_end` (ISO date, default the latest reading date). Result: `alerts[{level, text}]` (computed first; a reading above 180 or 120 gives `level: "emergency"` with the AHA wording), `window {start, end}`, `averages {morning, evening, all}` (each `{systolic, diastolic, count}` or `null`; seated readings only, 7 days ending at `window_end`), `reading_count`, `days_covered`, `excluded_non_seated`, `outside_window`, `coverage` (`complete`, `partial`), `coverage_note`, `band {label, note}`, `bands[{label, sbp_low, sbp_high, dbp_low, dbp_high}]`, `orthostatic_drops[{date, time, sbp_drop, dbp_drop}]`, `orthostatic_note`, `series[{date, time, systolic, diastolic, pulse, position, session}]`, `summary`. With no seated reading in the window the result is an `error` (plus `alerts` if any reading is above 180/120). A validation `error` also keeps `alerts` computed from the readings that validate on their own, so an invalid companion row never hides the emergency line. `time` values are local clock times; a timezone suffix is rejected.

`glucose_log_pattern`: inputs `readings` (1 to 200 of `{date, time, value, units mg/dL|mmol/L, tag fasting|before_meal|after_meal|bedtime|other}`) and optional `a1c_percent` (4 to 12). Result: `alerts[{level, text}]` (below 54 mg/dL `emergency`; 54 to 69 and above 250 `call_today`), `grid[{slot, count, mean, min, max, in_target_fraction}]` in mg/dL (`null` when a slot is empty or has no target), `target_bands[{slot, low_mg_dl, high_mg_dl, low_mmol_l, high_mmol_l}]`, `target_note`, `points[{date, time, value_mg_dl, value_mmol_l, tag}]`, `pattern_note`, `reading_count`, `summary`, and with an A1c `adag {eag_mg_dl, eag_mmol_l, line[{a1c, eag}], mean_of_readings_mg_dl, note}`. As for the blood-pressure log, a validation `error` keeps the hypoglycaemia `alerts` from the readings that validate on their own, and `time` must be a local clock time.

`medication_schedule`: input `medicines` (1 to 12 of `{name, strength or "", directions, directions_text or ""}`; `directions` is one of `once_daily_morning`, `once_daily_evening`, `once_daily_bedtime`, `twice_daily`, `three_times_daily`, `four_times_daily`, `every_morning_and_bedtime`, `with_meals`, `weekly`, `as_needed`, `other`, and `other` needs `directions_text`). Result: `status` (`available`, `partial`, `unavailable`, how many RxNorm lookups worked), `grid[{name, strength, ingredients[], slots {morning, noon, evening, bedtime}, wording, placed, normalisation {status matched|unmatched|unavailable, matched_name, rxcui, ingredients[{name, rxcui}]}}]`, `ums_note`, `duplicates[{ingredient, medicines[]}]`, `duplicates_note`, `limitations[]`, `summary`. Twice daily is placed in the morning and the evening, as in the AHRQ Universal Medication Schedule. Duplicates are grouped by RxNorm ingredient code and, as a fallback, by a case-insensitive match of the typed name; this is not an interaction check. The handoff treats a result as a reference lookup only when it has both `status` and `items`; every form tool and checklist (including `steadi_fall_risk`, whose `items` are the answered questions) is listed as a calculation.

### Frontend notes

- Every result carries `key`, `tool`, `source`, `scope`, and `inputs` (the validated inputs on success), so the browser can show the source and scope next to any number.
- When a chat answer includes a calculator result whose `key` is in the browser catalogue (`static/js/tools-catalog.js`), the answer shows an "open the tool" launch button. It opens that tool with the result's `inputs`. If the result has an `error` or `missing_inputs` and no `hard_stop`, the button reads "Open the tool to complete it". Results for keys outside the catalogue show no button.
- Deep links: `#tools` opens the catalogue and `#tool=<key>` opens one tool. An unknown key is ignored.
- Education guides can carry a "Try the tool" button (`tool: { key, label }` in `static/js/education-guides.js`): blood pressure opens `bp_log_summary` and asthma opens `peak_flow_zone`.
