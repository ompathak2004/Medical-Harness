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
| `error` | Safe error detail when streaming work fails |

The server may send SSE comment keep-alives while work is pending. Consumers should ignore comments and use `result` as the final answer. It has the same validated shape as the buffered response, including `conversation_id`. The app emits the reviewed answer as one `answer_chunk`, after safety review; the browser waits for `result`.

Numbered citations in `answer` refer to the structured `articles` array. Recognized duplicate bibliography sections are removed before safety review, including from a proposed revision before its second review. An empty result is rejected. The browser renders article titles as direct external links and exposes summaries through a separate Details control; it does not reconstruct references from prose.

## Metrics

`GET /api/metrics` is available only when `METRICS_TOKEN` is set. Send `Authorization: Bearer <token>`. Without a matching token, the route returns 404. It reports numeric usage, cache counters, and completed outcome counts (`conversation`, `follow_up`, `answer`, `emergency`, and `evidence_unavailable`), not question text. Counts are per process or Vercel Function instance.

## Limits and errors

Validation errors use normal FastAPI HTTP statuses. The app may return 429 for the per-instance chat rate limit or 503 when busy, timed out, or unable to complete a safe answer. Do not present a 503 as a medical answer. See [configuration](CONFIGURATION.md) for limit settings.

## Anatomy and calculators

`anatomy_context` is `null` unless triage determines a spatial explanation is useful. Otherwise it is a validated object such as:

```json
{"scene_id":"knee","label":"Knee","reason":"See the bones around the knee."}
```

Supported scene IDs are `head`, `neck`, `shoulder`, `chest`, `abdomen`, `pelvis`, `spine`, `elbow`, `hand`, `knee`, `lower_leg`, and `foot`. This replaces the old `has_anatomy`/region-array contract. Emergency, routine conversation and evidence failure paths suppress anatomy. The browser downloads the model only after the user opens it.

Calculator results include `tool`, `source`, `scope`, and a numeric score or value with units where applicable. Invalid supplied inputs yield an `error`; missing inputs never become assumed normal values. The approximate Framingham calculator has been removed. The new tools are adult CKD-EPI 2021 eGFR, estimated average glucose from HbA1c, and explicit measurement conversion.

`non_hdl_cholesterol` accepts `total_cholesterol`, `hdl_cholesterol`, `total_units`, and `hdl_units` from the same lipid panel. Units must match and be `mg/dL` or `mmol/L`. The result contains `value` and `units` alongside source/scope metadata. It does not classify cardiovascular risk or supply a treatment target. HDL above total, mixed/unknown units, nonfinite or negative inputs, and total above 1,000 mg/dL or 30 mmol/L are rejected. Values are rounded to two decimal places.

The default aggregate conversation limit is 32,000 characters and request body limit is 262,144 bytes. A request above either limit returns 413. The `result` event is authoritative. Incomplete provider streams, failed re-review, or missing/out-of-range citation indices produce an error instead of an answer. An unsafe draft can be revised once and must pass a separate second review. Protected metrics include the LLM `circuit_open` flag.

## Reference tools

`tool_results` may contain a reference result with `tool`, `source`, `scope`, `status` (`available`, `empty`, `unavailable`), and `items`. Each item has `title` and a validated source `url`. DailyMed items optionally include `published`; they contain label directory metadata, not label contents or interaction checks. Europe PMC items include an abstract excerpt in `tldr`, `year`, `journal`, and `evidence_kind: "abstract"`.

PubMed abstracts may join the numbered article list or supply evidence when the primary provider is unavailable. The combined list remains bounded by `MAX_EVIDENCE_ARTICLES`, and all claims still pass answer review. Directory-only label results cannot replace medical evidence. Failed lookups return an explicit limitation; they never mean a medicine is safe or that no research exists.
