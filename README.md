# OpenMed

Evidence-based medical QA agent for patients. Ask a health question and get a
cited, safety-reviewed answer grounded in peer-reviewed literature — with
clinical risk calculators and an interactive 3D anatomy viewer.

> Informational only — not a substitute for professional medical advice.

## Features

- **Evidence-first answers** — every claim cites peer-reviewed articles
  retrieved via [MediSearch](https://medisearch.io); a safety-review pass
  rejects unsupported or unsafe content.
- **Emergency triage** — red-flag presentations (heart attack, stroke,
  anaphylaxis, …) short-circuit to an immediate "call emergency services"
  response with while-you-wait guidance.
- **Clinical calculators** — Wells (DVT), CHA₂DS₂-VASc, Framingham, MRC
  grade, BMI — deterministic Python, selected and populated by the LLM.
- **Interactive 3D anatomy** — a three.js body model auto-highlights the
  region under discussion; patients tap sub-parts to describe exactly where
  it hurts.
- **Fast** — Cerebras `gpt-oss-120b` (~3,000 tok/s) + parallelized pipeline
  stages + token-streamed answers over SSE.

## Quick start

```bash
cp .env.example .env      # fill in CEREBRAS_API_KEY and MEDISEARCH_API_KEY
uv sync
uv run medisearch-agent   # serves http://localhost:8080
```

## Tests

```bash
uv run pytest
```

## HealthBench evaluation

```bash
uv run python eval_healthbench.py --limit 5
```

## Docker

```bash
docker build -t medisearch-agent .
docker run -p 8080:8080 --env-file .env medisearch-agent
```

## Deploy (DigitalOcean App Platform)

```bash
doctl registry login
docker tag medisearch-agent registry.digitalocean.com/<registry>/medisearch-agent:latest
docker push registry.digitalocean.com/<registry>/medisearch-agent:latest
doctl apps create --spec deploy/app-spec.yaml   # set secret env values in the DO console
```

## Deploy (Vercel)

1. In Vercel, select **Add New → Project**, import this GitHub repository,
   and select the account or team that should own it. Keep the root directory
   as the repository root and leave the build and output settings at their
   defaults. Vercel uses the FastAPI app exported from `app/main.py`.
2. Before deploying, add `CEREBRAS_API_KEY` and `MEDISEARCH_API_KEY` under
   **Project Settings → Environment Variables** for Production. Add them for
   Preview too if you plan to use preview deployments. Get these keys from
   Cerebras Cloud and MediSearch, respectively; Vercel does not issue them.
3. Deploy, then check `/api/health` and load the home page. The chat endpoint
   needs both provider keys to answer questions. After changing environment
   variables, redeploy for the new values to take effect.

`vercel.json` allows the app's 150-second request timeout to finish within a
180-second Vercel Function invocation. The in-memory caches and rate limiter
are per Function instance, so they are not shared across scaled instances.
No Vercel access token is needed for a Git-connected dashboard deployment.

## 3D anatomy model

The interactive body map renders real anatomical geometry derived from
[BodyParts3D](https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/README_e.html)
(© The Database Center for Life Science, licensed under
[CC Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)).
Per-layer GLBs (skin, skeleton, muscles, organs, vascular, nerves) live in
`static/assets/anatomy/` together with `structures.json`, which maps every
mesh to its FMA concept name, body region, and organ group.

Assets are reproducible with the pipeline script:

```bash
python scripts/build_anatomy_assets.py \
  --assets-dir <dir-with-source-glbs> \
  --metadata <parsed_metadata.json|asset-pack.zip> \
  --obj-zip isa_BP3D_4.0_obj_99.zip \
  --out static/assets/anatomy
```

The source GLBs come from the
[anatomy-lab](https://github.com/MrH0v0/anatomy-lab) (MIT) BodyParts3D
conversion pipeline; `--obj-zip` additionally converts major superficial
muscles (gastrocnemius, biceps, deltoid, trapezius, quadriceps, ...) straight
from the official BodyParts3D OBJ archive. Everything is simplified and
meshopt-compressed with `gltfpack`.

## Architecture

See [docs/BLUEPRINT.md](docs/BLUEPRINT.md) for the full design blueprint
(pipeline, safety architecture, SSE contract, latency design, deployment).
