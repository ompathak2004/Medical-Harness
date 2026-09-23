# Configuration

`app/config.py` is the source of truth. Settings come from environment variables, with `.env` loaded for local runs. Start from [`.env.example`](../.env.example); never commit populated values.

## Required

| Variable | Purpose |
| --- | --- |
| `CEREBRAS_API_KEY` | Authenticates model calls to Cerebras Cloud |
| `MEDISEARCH_API_KEY` | Authenticates evidence retrieval from MediSearch |

The app validates both at startup. Tests supply placeholder keys and mock provider behavior.

## Common optional settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `CEREBRAS_MODEL` | `gpt-oss-120b` | Cerebras model name |
| `CEREBRAS_BASE_URL` | `https://api.cerebras.ai/v1` | Provider endpoint |
| `CEREBRAS_PROMPT_CACHE_KEY` | empty | Optional cache routing key if enabled on your account |
| `PORT` | `8080` | Local/container listening port |
| `LOG_LEVEL` | `INFO` | Application log level |
| `CORS_ORIGINS` | empty | Comma-separated cross-origin browser origins; same-origin UI needs none |
| `REQUEST_TIMEOUT_SECONDS` | `150` | Maximum pipeline time per buffered or streamed request |
| `MAX_CONCURRENT_REQUESTS` | `8` | Concurrent chat slots per process |
| `RATE_LIMIT_REQUESTS` | `20` | Chat requests per client per window, per process |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Rate-limit window length |
| `METRICS_TOKEN` | empty | Bearer token for `/api/metrics`; empty disables access |

Other model, cache, message, and evidence-budget settings are listed in `app/config.py`. Values such as `LLM_TIMEOUT_SECONDS` and `LLM_MAX_RETRIES` affect provider behavior. The in-memory cache and limiter do not coordinate across Vercel Function instances or multiple containers.

## Production notes

Set secrets in your hosting platform's environment variable UI. Do not copy `.env` into a container image or publish it in a deployment bundle. If you change a Vercel environment variable, redeploy so the new value reaches the Function. Review [SECURITY.md](../SECURITY.md) before accepting real patient information.
