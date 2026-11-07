# Operator traces

The API returns a server-generated `X-Request-ID`. Search for that ID in the application logs or in a sampled trace. Each request spans its full lifetime, including streaming. A stream can have HTTP status 200 and end in `review_blocked`, `triage_unavailable`, `timeout`, or another application outcome.

Trace spans record fixed route and stage names, release, model, durations, retry numbers, statuses, cache behavior, source counts, and reported tokens. The exporter excludes conversation and session IDs, URLs with query strings, prompt and answer text, source excerpts, tool values, headers, and exceptions. Keep access to the trace store restricted. The app uses a bounded queue and makes a short best-effort flush at the end of sampled Vercel requests. Use application logs as the fallback when a trace is unsampled or export is unavailable.

## Local setup without an account

Run [Jaeger](https://www.jaegertracing.io/docs/2.23/getting-started/) on loopback:

```powershell
docker run --rm --name medical-harness-jaeger -p 127.0.0.1:4318:4318 -p 127.0.0.1:16686:16686 cr.jaegertracing.io/jaegertracing/jaeger:2.23.0
```

Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` and `OTEL_TRACES_SAMPLER_ARG=1` in the local `.env`. Restart the app, run a calculator with synthetic inputs, and open [Jaeger](http://localhost:16686). Select the `medical-harness` service. Jaeger's local store is in memory.

## Grafana Cloud Free

Create a [Grafana Cloud Free stack](https://grafana.com/pricing/). In its [OTLP connection setup](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/), generate a token scoped to writing traces. Set the following variables in Vercel Preview or the local secret environment:

- `OTEL_EXPORTER_OTLP_ENDPOINT` is the HTTPS base endpoint from Grafana, without `/v1/traces`.
- `OTEL_EXPORTER_OTLP_HEADERS` is the authorization header from the same setup. Preserve the `Basic%20` encoding for Python.
- `OTEL_TRACES_SAMPLER_ARG` is a fraction between 0 and 1. Use 1 for a small synthetic demo. The default 0.1 samples one tenth of requests on average.

Import [the dashboard](../deploy/grafana-dashboard.json) and select the stack's Tempo data source. Filter the request list by `span.medical_harness.request_id` to inspect one run. The panels show sampled p95 request duration for completed answers, application outcomes, and input and output token volume. Use a one-minute minimum interval when setting up an outcome-rate alert. Review `review_blocked`, `evidence_unavailable`, and `timeout` counts against a recent baseline before choosing alert thresholds. For a synthetic preview at full sampling, a single unexpected outcome is a useful alert. Use a separate uptime check against `GET /api/health` for availability.

Set both `CEREBRAS_INPUT_USD_PER_MILLION` and `CEREBRAS_OUTPUT_USD_PER_MILLION` to enable the estimated spend panel. Its estimates apply the entered rates to provider-reported token counts. Billing can differ due to cached rates, unreported usage, and evidence provider charges. Use your providers' dashboards for spend limits and billing totals.

Provider conversations and the app's cache are separate from telemetry. Review provider retention, allowed users and regions, and clinical oversight before accepting identifiable patient data.
