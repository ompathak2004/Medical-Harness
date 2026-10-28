# Configuration

Copy `.env.example` to `.env` and fill in `CEREBRAS_API_KEY` and `MEDISEARCH_API_KEY`. The local `.env` is ignored by Git, Docker, and Vercel. Provider names in these keys are intentional; the product is medical-harness.

Settings are validated at startup. Invalid budgets, retry counts, or concurrency values prevent startup rather than creating unbounded behavior. Runtime environment values override `.env`.

| Variable | Default |
| --- | --- |
| `CEREBRAS_API_KEY` | `` |
| `CEREBRAS_MODEL` | `gpt-oss-120b` |
| `CEREBRAS_BASE_URL` | `https://api.cerebras.ai/v1` |
| `LLM_TEMPERATURE` | `0.3` |
| `LLM_MAX_TOKENS` | `4096` |
| `LLM_TIMEOUT_SECONDS` | `45` |
| `LLM_MAX_RETRIES` | `2` |
| `CEREBRAS_PROMPT_CACHE_KEY` | `` |
| `MEDISEARCH_API_KEY` | `` |
| `OPENFDA_API_KEY` | `` |
| `MAX_EVIDENCE_ARTICLES` | `8` |
| `MAX_TLDR_CHARS` | `400` |
| `MAX_SUMMARY_CHARS` | `1500` |
| `MAX_ANSWER_CHARS` | `24000` |
| `EVIDENCE_CACHE_ENTRIES` | `128` |
| `EVIDENCE_CACHE_TTL_SECONDS` | `600` |
| `STEP_CACHE_ENTRIES` | `256` |
| `STEP_CACHE_TTL_SECONDS` | `120` |
| `PORT` | `8080` |
| `LOG_LEVEL` | `INFO` |
| `CORS_ORIGINS` | `` |
| `REQUEST_TIMEOUT_SECONDS` | `150` |
| `MAX_CONCURRENT_REQUESTS` | `8` |
| `METRICS_TOKEN` | `` |
| `MAX_CONVERSATION_MESSAGES` | `39` |
| `MAX_MESSAGE_CHARS` | `8000` |
| `MAX_CONVERSATION_CHARS` | `32000` |
| `MAX_REQUEST_BYTES` | `262144` |
| `RATE_LIMIT_REQUESTS` | `20` |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` |
| `TOOL_RATE_LIMIT_REQUESTS` | `60` |

The total request deadline covers all steps. Providers have shorter timeouts, connection pooling, and circuit breakers that open after three failures for 30 seconds. Only one recovery probe is allowed after cooldown. LLM and primary evidence retry transient failures within fixed attempt limits; reference tools make one bounded attempt. LLM authentication failures are not retried. DailyMed and Europe PMC need no key. openFDA label lookups also work without one, limited per IP address to 40 requests per minute and 1,000 per day; a free `OPENFDA_API_KEY` raises that to 240 per minute and 120,000 per day. The key is optional and never logged. A rate-limited lookup counts toward the circuit breaker and is reported as unavailable. Each lookup is limited to eight seconds; DailyMed and Europe PMC are capped at 256 KiB and return three records. openFDA returns full labels of 100 to 300 KiB each, so that lookup fetches at most five labels under its own 2 MiB cap and returns one selected single-ingredient label (rows whose metadata does not establish exactly one active substance are rejected). Buffered JSON and evidence SSE are capped at 256 KiB; LLM SSE has a 2 MiB total and 64 KiB line cap.

A zero cache capacity or TTL disables storage. Cached classifications and evidence contain sensitive derived text in process memory, are scoped to a random HTTP-only browser session, and expire. They are never written to disk. All-waiter cancellation also cancels the shared provider task; one cancelled waiter does not interrupt another. Completed answers are not cached. Cache and quota limits are per process, not global across Vercel instances.

Set `METRICS_TOKEN` to expose aggregate token, cache, circuit and outcome metrics through authenticated `/api/metrics`. No patient text or API keys are included. Set `CORS_ORIGINS` only when a separate trusted frontend needs access. An empty value is suitable for the same-origin UI.

`VERCEL_PREVIEW_FEEDBACK_ENABLED=0` is a Vercel platform setting for previews, not a Python application setting. It suppresses toolbar injection. Vercel sets `VERCEL=1` itself; do not set it on other hosts, where forwarded geographic headers are not trusted. The pinned `tzdata` dependency supplies IANA time-zone rules on Windows and minimal containers. Request context is documented in [API.md](API.md).

Vercel also sets `VERCEL_ENV`. The visitor analytics bootstrap is included only when it is `production` and `VERCEL=1`. No analytics key belongs in `.env`; enable Web Analytics on the Vercel project and redeploy to provision its same-origin endpoints.
