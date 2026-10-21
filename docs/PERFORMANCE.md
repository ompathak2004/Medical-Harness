# Performance audit

Measured locally during the refactor. These are asset sizes and control-flow checks, not a production load test or clinical benchmark.

| Area | Change and evidence |
| --- | --- |
| Initial rendering | Home markup/layout arrives in HTML. Browser tests delay the module and verify the correct first screen and theme. |
| Initial browser assets | App plus shared JS: about 34 KiB raw / 13 KiB gzip; CSS: about 26 / 6.5 KiB; theme bootstrap: 265 bytes. One self-hosted 29.4 KiB Instrument Sans WOFF2 adds consistent typography, down from the former 36.1 KiB font. No external font or 3D requests at startup. |
| Eleven educational guides | About 28.5 KiB raw / 10.8 KiB gzip for the renderer, content, and original SVG, imported only when opened. No WebGL, videos, or continuously running animation on page load. Small title metadata is shared with the app; the illustrated content remains lazy. |
| Local time context | Deterministic server-clock and timezone conversion, no added model call. Minute-level temporal cache keys prevent stale relative dates but reduce cross-minute cache hits. |
| 3D JavaScript | About 595 KiB raw / 153 KiB gzip, dynamically imported only when opening anatomy. |
| Anatomy | One of twelve regional packs is fetched. Knee: 71 KiB, elbow: 139 KiB, hand: 232 KiB. Largest is chest, about 5 MiB; regional storage duplicates some structures and is not uniformly smaller than the former total. |
| GPU work | All twelve scenes rendered in Chrome smoke checks. A 250 ms idle observation added zero render frames per scene. Closing releases the context and model resources. |
| Asset validity | Every GLB is hash-checked, decoded, checked for nondegenerate positions, and matched to catalog structure IDs. |
| Provider calls | Anatomy intent now shares triage. Tool planning overlaps retrieval; extraction/reference work is concurrent and bounded. |
| Answer buffering | Incremental character counting replaces repeated summing of every previous chunk. |
| Caching | Bounded session-scoped TTL/LRU, in-flight coalescing, cancellation-aware cleanup, and immutable hashed static assets. |
| Runtime dependencies | Unused MediSearch SDK removed; direct async HTTP clients are used. Python 3.12 removes compatibility-only dependency branches. |
| Dead frontend | Retired full-body viewer, six cascading stylesheet files, full-body packs, unused controls/helpers and outdated recording removed. |

A single live synthetic BMI-definition smoke test completed with reviewed, cited evidence, four LLM requests, no anatomy, and approximately 10 seconds including two separate public reference checks. This confirms connectivity, not a latency percentile or quality guarantee.

## Reproduce

Run `npm ci --ignore-scripts`, `npm run build`, `npm run check:anatomy`, `uv run pytest -q`, and `npm run test:browser`. Browser fixtures use fake keys and intercepted synthetic responses. Generated screenshots are in `docs/media/`.

For live latency/token measurements, use the explicit synthetic evaluation runner described in [EVALUATION.md](EVALUATION.md). Keep model, budgets, cases and cache state comparable. To measure cold/warm Vercel behavior and traffic capacity, collect repeated runs on the intended deployment tier; local results cannot establish those limits.

The largest remaining costs are external inference/retrieval and dense chest/head anatomy. Further mesh simplification must preserve anatomy and receive visual review. Shared rate limits would be needed across horizontally scaled instances. No claim is made that per-process limits provide a global quota.
