# Working on OpenMed

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
- `app/tools/clinical.py`: deterministic calculators. `app/tools/anatomy.py`: body-region selection.
- `static/index.html`, `static/js/`, `static/css/`: browser UI. There is no Tailwind or frontend build step.
- `static/assets/anatomy/`: BodyParts3D-derived data; preserve attribution in `NOTICE.md` and the viewer.
- `tests/`: mocked API and pipeline tests.

## Invariants

- Emergency triage runs before retrieval and normal answering. Do not turn an emergency result into a normal answer.
- An answer with unavailable evidence must state that limitation; do not fabricate citations.
- The safety review must complete before the answer is sent to the browser. The authoritative response is the `result` event.
- Conversation arrays alternate user and assistant text and end with a user message.
- Keep source metadata and calculator results structured so the UI can display them.
- Keep `.env` and any real patient data out of commits, logs, screenshots, and tests.
- Preserve keyboard access, mobile layouts, light and dark themes, and reduced-motion behavior for UI edits.

## Change checklist

- For API changes: update `app/schemas.py`, [docs/API.md](docs/API.md), frontend parsing, and focused tests.
- For pipeline or prompt changes: add or update tests for emergency, clarification, evidence failure, and review failure where relevant.
- For configuration changes: update `.env.example` and [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- For visual changes: inspect desktop and narrow mobile widths in both themes and update the screenshots when the published UI changes.
- Run `uv run pytest -q` and `git diff --check` before committing.

The Vercel project is linked locally for CLI deployment. GitHub integration was not connected at the time of writing, so pushing `main` alone may not redeploy it. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
