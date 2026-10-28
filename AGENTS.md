# Working on medical-harness

This file is the short starting point for coding agents. Follow the user's current request first; use these notes to find the right files and preserve the application's safety behavior.

## Start here

1. Read [README.md](README.md) for setup and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the actual request flow.
2. Read [docs/API.md](docs/API.md) before changing request, response, or SSE shapes.
3. Run `uv sync --locked` and `uv run pytest -q`. Tests use fake keys; do not use live provider keys for routine tests.

## Map of the code

- `app/main.py`: FastAPI construction, middleware, lifecycle, frontend mount.
- `app/api/routes.py` and `app/schemas.py`: HTTP surface and validation.
- `app/pipeline.py`: triage, clarification, clinical tools, evidence, answer, safety review.
- `app/llm.py` and `app/evidence.py`: external provider calls. Do not log prompts, patient text, or keys.
- `app/prompts.py`: model instructions. Changes here can affect safety and citations.
- `app/tools/clinical.py`: deterministic calculators, including the patient tools (`child_dose_check`, `ors_planner`, `lab_result_reader`, `steadi_fall_risk`, zone calculators). `app/tools/anatomy.py`: body-region selection.
- `app/tools/growth.py`: growth percentiles from the bundled CDC/WHO LMS tables in `app/tools/data/` (hash-checked against its manifest; on any mismatch the tools return no number). `scripts/build_growth_tables.py` rebuilds the data; do not edit the JSON by hand.
- `app/tools/forms.py`: form-only tools whose inputs are lists (`bp_log_summary`, `glucose_log_pattern`, `medication_schedule`), run through `run_form_tool`. `app/tools/sheets.py`: the fixed tiers of the when-to-call sheet.
- `GET /api/tools` and `POST /api/tools/{key}` (in `app/api/routes.py`) run calculators and form tools with no model call; reference tools are not exposed there. `TOOL_RATE_LIMIT_REQUESTS` is that endpoint's own per-minute limit.
- `static/index.html`, `static/js/`, `static/css/`: browser sources; `npm run build` updates checked-in hashed bundles in `static/dist/` The build also updates `static/build.json`; commit it with the generated bundles.
- `static/js/tools*.js` (the Tools panel, `tools-catalog.js`, and the child, form, log, and sheet group modules), `charts.js` (SVG charts drawn from result numbers), `local-log.js` (opt-in browser-local logs), `print.js` (printable sheets): the patient-tool frontend. Tool keys are the backend keys; do not rename them.
- `static/assets/atlas/`: focused BodyParts3D-derived scenes; preserve attribution in `NOTICE.md` and the viewer. Validate with `npm run check:anatomy`.
- `app/tools/references.py`: bounded DailyMed and Europe PMC lookups.
- `app/tools/education.py` and `static/js/education-catalog.js`: allowed educational guide IDs and browser titles.
- `evals/`: synthetic evaluations and the offline comparison gate; never enable live calls in routine tests. `evals/failures.py` holds the pipeline and tool failure-injection cases; regenerate `docs/FAILURE_MODES.md` with `uv run python -m evals.failures --out docs/FAILURE_MODES.md`.
- `tests/`: mocked API and pipeline tests.

## Invariants

- Emergency triage runs before retrieval and normal answering. Do not turn an emergency result into a normal answer.
- An answer with unavailable evidence must state that limitation; do not fabricate citations.
- The safety review must complete before the answer is sent to the browser. The authoritative response is the `result` event.
- Conversation arrays alternate user and assistant text and end with a user message.
- Keep source metadata and calculator results structured so the UI can display them.
- Patient tools are deterministic and fail closed: no value next to an error, fixed wording from the cited source, danger-threshold alerts listed first, and no model-written dose, diagnosis, or category. Child dosing is a label lookup, never mg/kg. Logs stay in the browser; the server must not store or log tool inputs.
- Keep `.env` and any real patient data out of commits, logs, screenshots, and tests.
- Preserve keyboard access, mobile layouts, light and dark themes, and reduced-motion behavior for UI edits.

## Change checklist

- For API changes: update `app/schemas.py`, [docs/API.md](docs/API.md), frontend parsing, and focused tests.
- For pipeline or prompt changes: add or update tests for emergency, clarification, evidence failure, and review failure where relevant.
- For configuration changes: update `.env.example` and [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- For visual changes: inspect desktop and narrow mobile widths in both themes and update the screenshots when the published UI changes.
- For a new patient tool: add a `tools-catalog.js` entry, a definition in a group file (`tools-child.js`, `tools-logs.js`, or `tools-sheets.js`), a browser spec, and a desktop-light and mobile-dark screenshot pair under `docs/media/`. Keep the tool key equal to the backend key.
- Run `uv run pytest -q` and `git diff --check` before committing.
- For browser changes, run `npm run build`, `npm run check:anatomy`, and `npm run test:browser`. Keep generated bundles in the same commit as their source.

Use the local Vercel project link for preview deployment. Do not assume a Git push triggers deployment; verify the project's Git integration. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
