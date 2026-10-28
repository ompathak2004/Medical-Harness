# Architecture

medical-harness serves a FastAPI backend and plain HTML/CSS/JavaScript frontend. esbuild produces checked-in, self-hosted bundles. Node is a development dependency; production needs Python 3.12+ and the static files. There is no account system, database, or durable conversation store.

## Request flow

1. Routes validate alternating messages, body size, aggregate text size, rate and concurrency limits. They attach a random browser-session cache scope and enforce a total deadline. SSE sends keep-alives and cancels pending work on disconnect. Buffered and streamed results share ChatResponse validation.
2. Triage runs first. Emergencies stop normal work and return fixed urgent guidance. Routine messages receive fixed nonclinical replies. Clarification asks up to three essential questions and is limited to one round. Anatomy intent is part of triage, eliminating a separate model call; only twelve validated scene IDs are accepted.
3. Tool planning and MediSearch retrieval run concurrently. At most two relevant tools execute, with concurrent input extraction and reference requests. Calculators require supplied values and validate types, finite numbers, ranges and enums. Reference requests use fixed endpoints, eight-second total timeouts, at most three records, and a 256 KiB decoded response cap (openFDA labels: at most five rows under a 2 MiB cap).
4. Supplemental PubMed abstracts may join the bounded source list or supply evidence when the primary provider is unavailable. Directory-only medicine labels cannot. When abstracts alter source numbering, the primary summary is dropped to avoid stale citation indices. No sources means a fixed evidence-unavailable response.
5. Generation is buffered. Generation and both review attempts share the same bounded evidence text, including source metadata and excerpts. The retrieval summary is labeled context, never an independent source. Review also sees tool outputs. A revision is allowed once and must pass another review. Empty, interrupted, oversized or invalidly cited answers fail closed. The browser renders only the authoritative result.

These checks validate control flow and citation indices, not clinical truth.

## Lifecycle and caches

HTTP clients are pooled and closed on shutdown. Provider calls have bounded retries and circuit breakers with one recovery probe after cooldown. Session-scoped TTL/LRU caches coalesce identical work. One cancelled waiter cannot disrupt others; the final waiter's cancellation stops the shared operation. Failed evidence/reference retrieval is not cached. Zero capacity or TTL disables storage.

Cache values contain sensitive derived data in memory; expired entries are removed during cache operations. No prompts, patient text or keys belong in logs. Protected metrics expose numeric counters only. Caches, concurrency and quotas are per instance; global limits require platform infrastructure.

## Visitor analytics

Production on Vercel adds a separate bundled analytics bootstrap using `@vercel/analytics`. It loads Vercel's same-origin collection script and records anonymous page views. The filter strips query strings and fragments and rejects custom events; it never receives chat text or clinical tool results. Local and preview HTML omit the bootstrap. Country, browser, and device breakdowns are available in the project's Vercel dashboard. See [deployment](DEPLOYMENT.md).

## Browser and anatomy

The initial response already contains the home screen and home layout. A small synchronous theme script runs before CSS; startup does not replace the hero. HTML/manifests revalidate, while hashed bundles and GLBs use immutable caching. Instrument Sans is a self-hosted 30 KB variable font with a system fallback and swap behavior. Selected Lucide icons are bundled locally. There are no CDN runtime requests. FastAPI developer documentation has a separate CSP for its Swagger/ReDoc assets.

The mobile-first interface keeps a stable reading column. Numbered citations open a native modal source sheet without changing the conversation width. Dialogs preserve keyboard focus and restore the invoking control. Long answers open at their beginning. Native accordions, 44 px primary controls, consistent scrollbars, two themes, and reduced-motion styles work without a component framework.

Request-local ContextVars carry validated timezone/country hints and server-clock timestamps through triage, planning, generation and review. Earlier user turns retain offset-aware timestamps supplied by the client. Temporal context contributes to cache keys at minute precision, preventing stale relative dates at midnight. Location hints never select emergency numbers. No additional model call is used for the clock.

Eleven allowlisted educational guides cover eye pressure, asthma, reflux, kidney stones, gallstones, osteoarthritis, disc/nerve relationships, arterial plaque, written imaging reports, blood pressure, and ECG signals. Triage selects a relevant explanation and the pipeline publishes its ID only with a reviewed answer. `app/tools/education.py` supplies the server allowlist and response type; `education-catalog.js` supplies browser titles. Fixed, cited content and original conceptual SVG live in a separate lazy module. No model-generated graphics execute. State buttons update diagrams and accessible descriptions; the optional eye-flow animation starts only on request, pauses on close, and is disabled under reduced motion. These guides are separate from the twelve reference-anatomy mesh scenes. Only spatial questions can additionally receive an atlas; the atlas cannot display a patient's disease.

Anatomy context belongs to each answer. Opening its native dialog imports the viewer and downloads one region. Closing aborts loads and disposes geometry, materials, observers, listeners and WebGL resources. Rendering occurs on interaction or resize, not continuously. Keyboard controls and a searchable structure list remain usable after graphics failure.

| Module | Responsibility |
| --- | --- |
| app/main.py | Startup/shutdown, headers, static shell |
| app/api/routes.py, app/schemas.py | HTTP/SSE contract and validation |
| app/context.py | Server clock, validated local context and per-turn time annotations |
| app/pipeline.py, app/prompts.py | Bounded orchestration and reviewed answer policy |
| app/handoff.py | Deterministic clinician handoff: reason, urgency, user questions, calculations, sources, limitations, fixed questions to ask, step trace |
| app/cache.py, app/transport.py | TTL/LRU, single-flight and circuit breakers |
| app/tools/clinical.py | Ten sourced calculators/converters |
| app/tools/references.py | DailyMed, openFDA label sections, and Europe PMC lookups |
| static/js/anatomy-panel.js, atlas-viewer.js | Dialog and on-demand Three.js viewer |
| static/js/education.js, context.js, dialog.js | Sourced visual guide, local settings and dialog keyboard behavior |
| scripts/build_atlas.mjs, check_atlas.mjs | Reproducible packs and decoded geometry validation |
| static/js/handoff.js | Lazy clinician-handoff dialog with Copy, Print, and Download |
| evals/ | Synthetic evaluations and an offline review gate |
| evals/failures.py, evals/doubles.py | Offline fault injection with doubles; generates docs/FAILURE_MODES.md |

See [research decisions](RESEARCH.md), [tool boundaries](RELIABILITY.md), and [performance checks](PERFORMANCE.md).
