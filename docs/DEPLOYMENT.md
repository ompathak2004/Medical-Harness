# Deployment

OpenMed serves the frontend and API from the same FastAPI application. Every deployment needs `CEREBRAS_API_KEY` and `MEDISEARCH_API_KEY` set on the host. Keep `.env` local; it is excluded from Git and Vercel uploads.

## Vercel

Vercel recognizes `app.main:app` through `pyproject.toml`. `vercel.json` gives the Function 180 seconds, longer than the app's default 150-second request timeout. The Python runtime serves the UI and API together.

1. In Vercel, create a project from this GitHub repository. Leave the root directory at the repository root and use the detected FastAPI settings.
2. Add both provider keys under **Project Settings → Environment Variables** for Production. Add Preview only if preview deployments should call the providers.
3. Deploy. Open `/api/health`, the home page, and `/docs`. Test a harmless question to confirm both providers can be reached.

You can also deploy a linked local checkout with:

```bash
vercel link
vercel deploy --prod
```

The current production project was initially deployed by CLI. At the time this guide was written, the Vercel account lacked a GitHub login connection, so **pushing to GitHub alone did not trigger Vercel**. If that remains true, run the CLI deployment after pushing. To enable automatic builds, connect GitHub in Vercel account settings and link the repository to the project.

Vercel Functions scale independently. In-memory caches, concurrency slots, and rate limits are per instance. Use external shared infrastructure if you need global quotas or durable state. The application has no user authentication or database.

## Docker

```bash
docker build -t openmed .
docker run --env-file .env -p 8080:8080 openmed
```

`Dockerfile` installs runtime dependencies with uv and runs Uvicorn as a non-root user. The health endpoint is `/api/health`. `docker run --env-file` passes keys at runtime; they are not baked into the image.

## DigitalOcean App Platform

The example `deploy/app-spec.yaml` uses a container image in DigitalOcean Container Registry. Build and push an `openmed` image to your registry, update the repository/tag fields in the spec, and provide the two required environment values as secrets in the DigitalOcean console. Review instance size, region, and health check before creating an app. Do not commit filled secret values to the spec.

## Before sharing a public URL

Check that the home page, `/api/health`, and an ordinary answer work. Review provider costs, request limits, deployment protection, and privacy expectations for your audience. See [SECURITY.md](../SECURITY.md).
