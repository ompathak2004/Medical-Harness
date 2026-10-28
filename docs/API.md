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

`conversation` is a nonempty list of strings: user, assistant, user, and so on. It must end with the user's message. The server limits the conversation to 39 messages and each message to 8,000 characters by default. Reuse the returned `conversation_id` for follow-up requests.

`POST /api/chat` waits for a JSON response. For example:

```bash
curl -X POST http://localhost:8080/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"conversation":["What does BMI mean?"]}'
```

The response has `type` (`answer`, `follow_up`, `emergency`, or `conversation`), `conversation_id`, `answer`, `articles`, `tool_results`, `followups`, `anatomy_context`, and emergency or clarification fields. A `conversation` result handles greetings, thanks, help requests, unclear messages, and unrelated requests with a short reply in `answer`. It has no articles or calculator results and uses `evidence_status: "not_applicable"`. See `app/schemas.py` for exact optional fields and defaults.

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

PubMed abstracts and official label sections (any reference item with a `tldr` excerpt) may join the numbered article list or supply evidence when the primary provider is unavailable or fails. Label sections come first (at most 5), then abstracts, then the primary sources fill the rest; when they change the numbering the primary retrieval summary is dropped. The combined list remains bounded by `MAX_EVIDENCE_ARTICLES`, and all claims still pass answer review. Directory-only label results cannot replace medical evidence. Failed lookups return an explicit limitation; they never mean a medicine is safe or that no research exists.
