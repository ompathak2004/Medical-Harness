# MediSearch Agent — Design Blueprint

Evidence-based medical QA agent for patients: ask a health question, get a
cited, safety-reviewed answer grounded in peer-reviewed literature, with
clinical calculators and an interactive 3D anatomy viewer.

## 1. Product principles (patient-first)

| Principle | How it shows up |
|---|---|
| Safety before speed | Emergency red-flag triage runs first; unmissable emergency banner tells the patient to call local emergency services before anything else. |
| Evidence, not opinion | Every medical claim in an answer must cite a peer-reviewed source retrieved via MediSearch; the safety reviewer rejects unsupported claims. |
| Never a diagnosis | The system explains, scores risk, and points to care — it does not diagnose. A persistent disclaimer reinforces this. |
| Meet patients where they are | Plain language answers, example question chips for the blank-page problem, follow-up questions as tappable chips, 3D body model so patients can *point* at where it hurts instead of naming anatomy. |
| Useful even when incomplete | If the agent needs clarification, it still gives preliminary guidance ("While you answer…") so no turn is wasted. |
| Graceful degradation | If evidence retrieval or the LLM fails mid-flow, the patient gets a partial answer with a notice — never a blank error page. |

## 2. System architecture

```
Browser (vanilla JS + three.js)
  │  POST /api/chat/stream  (SSE)
  ▼
FastAPI (app/main.py — factory, middleware: rate-limit, CORS, gzip)
  │
  ▼
AgentPipeline (app/pipeline.py — async orchestrator)
  ├─ 1. Triage (emergency / ask / answer)  ┐ run concurrently
  ├─ 1b. Anatomy detection                 ┘ (asyncio tasks)
  ├─ 2. Clinical tools (select → extract → execute) ┐ run concurrently
  ├─ 2b. Evidence retrieval (MediSearch, thread)    ┘ (asyncio.gather)
  ├─ 3. Answer generation — token-streamed to client
  └─ 4. Safety review — may revise the streamed answer
  │
  ├── CerebrasClient (app/llm.py)   → api.cerebras.ai (gpt-oss-120b, OpenAI-compatible)
  └── EvidenceRetriever (app/evidence.py) → MediSearch API (articles + summary)
```

### Why Cerebras `gpt-oss-120b`
- Open-source-weights model served at ~3,000 tokens/s — the pipeline makes
  4–6 LLM calls per answer, so per-call latency dominates UX.
- OpenAI-compatible API keeps the client thin (httpx, no vendor SDK).
- Streaming supported, enabling token-by-token answer rendering.

### Latency design
The original pipeline was fully sequential (7 serial LLM/API calls). The
refactor runs triage ∥ anatomy detection, then clinical tools ∥ MediSearch
retrieval, and streams the final answer as it generates. MediSearch's
synchronous SDK is isolated in a worker thread (`asyncio.to_thread`) so it
never blocks the event loop.

### SSE contract
```
event: meta          {"conversation_id": str}
event: step          {"step": triage|tools|evidence|generating|safety, "message": str}
event: answer_chunk  {"text": str}                  ← streamed tokens
event: result        {type, follow_up_questions, preliminary_info, answer,
                      articles, tool_results, followups, anatomy_context,
                      emergency, emergency_message}
event: error         {"detail": str}
```
The `result.answer` is authoritative: the safety reviewer runs after
streaming and may revise the text, in which case the frontend replaces the
streamed content.

## 3. Safety architecture

1. **Emergency triage (pre-answer):** the first LLM call classifies
   red-flag presentations (MI, stroke/FAST, anaphylaxis, severe bleeding,
   suicidal ideation, sepsis/meningitis signs). On `emergency`, the pipeline
   short-circuits: no tools, no literature search — an emergency banner plus
   short while-you-wait guidance is returned immediately.
2. **Evidence-only answering:** the answer prompt forbids claims not
   supported by retrieved articles or computed tool results.
3. **Post-answer safety review:** a second LLM pass checks for unsupported
   claims, missing emergency warnings, diagnostic over-promising, and a
   missing professional-advice disclaimer; it rewrites the answer if needed.
4. **Clarification cap:** at most 2 follow-up rounds before the agent must
   answer with what it has (prevents interrogation loops).
5. **Privacy-conscious logging:** conversation content and prompts are never
   logged at INFO — only IDs, sizes, and timings.

## 4. Clinical tools

Deterministic, validated calculators (LLM selects + extracts variables; the
math is pure Python — the LLM never computes scores):

- Wells score (DVT) — Wells et al., Lancet 1997
- CHA₂DS₂-VASc (AF stroke risk) — Lip et al., Chest 2010
- Framingham 10-year CVD risk
- MRC muscle strength grade
- BMI

Adding a tool = one function + one `TOOL_REGISTRY` entry (description,
variables, callable). Missing variables degrade gracefully via defaults.

## 5. 3D anatomy viewer

- three.js procedural human body (skin / muscles / skeleton / vascular
  layers) with per-region hitboxes; no heavyweight GLTF download on load.
- The anatomy LLM step maps conversation → body-region IDs
  (`app/tools/anatomy.py: ANATOMY_REGIONS`), and the viewer auto-highlights
  the primary region with a camera transition + pulse.
- Region sub-parts render as tappable chips that insert precise location
  text ("The issue is in my inner calf") back into the chat — patients
  point, the agent gets clinical precision.
- WebGL-unavailable environments fall back to text.

## 6. API surface

| Route | Purpose |
|---|---|
| `POST /api/chat/stream` | SSE streaming chat (primary) |
| `POST /api/chat` | Buffered chat (back-compat, evals) |
| `GET /api/health` | Health/version probe |
| `GET /` + `/static/*` | Frontend |

Request limits: ≤40 messages, ≤8,000 chars/message, 20 req/min per client
(in-memory sliding window; swap for Redis when scaling horizontally).

## 7. Configuration

All via environment (pydantic-settings, `.env` supported) — see
`.env.example`. Required: `CEREBRAS_API_KEY`, `MEDISEARCH_API_KEY`.
No secrets are ever committed.

## 8. Deployment (DigitalOcean App Platform)

- Multi-stage `Dockerfile` (uv-installed deps → slim runtime, non-root
  user, honors `$PORT`; App Platform sets `PORT=8080`).
- Image pushed to DO Container Registry; App Platform runs it with
  `CEREBRAS_API_KEY` / `MEDISEARCH_API_KEY` as encrypted app-level env vars.
- Health check: `GET /api/health`.
- `deploy/app-spec.yaml` is the source of truth for the app spec.

## 9. Quality gates

- `uv run pytest` — 38 unit/API tests: calculators against known scores,
  JSON-parse fuzz cases, pipeline paths (answer / follow-up / emergency /
  clarification-cap / degradation) with mocked clients, API validation and
  SSE contract tests.
- `eval_healthbench.py` — HealthBench Hard rubric evaluation, migrated to
  the Cerebras stack (`uv run python eval_healthbench.py --limit 5`).

## 10. Future work

- Redis-backed rate limiting + horizontal scaling.
- Conversation persistence and shareable answer links.
- Multilingual answers (MediSearch supports language settings).
- Wearable/vitals import for richer calculator inputs.
- Clinician handoff export (structured summary PDF).
