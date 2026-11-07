# Contributing to medical-harness

Thanks for helping improve medical-harness. Issues and pull requests are welcome for bugs, accessibility, documentation, reliability, and carefully scoped features.

Please follow the [community code of conduct](CODE_OF_CONDUCT.md).

## Before you change code

1. Read the [README](README.md) for local setup and [architecture guide](docs/ARCHITECTURE.md) for the request flow.
2. For medical behavior, read the safety rules in [AGENTS.md](AGENTS.md). Preserve emergency triage, citations, and the post-answer review.
3. Open an issue for large changes so maintainers can discuss the shape of the work first.

## Local workflow

```bash
uv sync --locked
uv run pytest -q
npm ci --ignore-scripts
npm run build
npm run check:anatomy
npm run test:browser
```

Tests do not require real API keys. To try the full app, copy `.env.example` to `.env` and set your own provider keys. Never include `.env`, patient information, or real API responses containing private information in a commit or issue.

For UI changes, check light and dark themes at desktop and narrow mobile widths. Keep keyboard navigation and reduced-motion support working. For pipeline changes, add a focused test that covers the changed behavior or safety boundary.

Commit rebuilt `static/dist/` and `static/build.json` with browser source changes. Anatomy pack generation uses the full source revision recorded in `scripts/build_atlas.mjs`; fetch that revision if your checkout is shallow. Run `npm run build:anatomy` only when changing scene selection or conversion. Keep explanations in documentation rather than inline code comments.

## Pull requests

- Keep each pull request focused and explain what changed, why, and how you checked it.
- Include screenshots for visible UI changes. Use synthetic example questions and redact personal information.
- To update the published screenshots, set `UPDATE_DOC_SCREENSHOTS=1` and use Playwright's `--grep` to capture the changed views.
- Update relevant documentation when behavior, configuration, or API contracts change.
- Run `uv run pytest -q` before opening the request.

## Reporting problems

Use GitHub issues for ordinary bugs. For a security vulnerability or accidental key exposure, follow [SECURITY.md](SECURITY.md) instead of posting details publicly.
