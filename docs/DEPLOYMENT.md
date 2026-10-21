# Deployment

medical-harness serves the frontend and API from the same FastAPI application. Every deployment needs `CEREBRAS_API_KEY` and `MEDISEARCH_API_KEY` set on the host. Keep `.env` local; it is excluded from Git and Vercel uploads.

## Vercel

The public production application is [medical-harness.vercel.app](https://medical-harness.vercel.app). The refactor has been merged to `main`, the Vercel production branch. The home page, health endpoint, and logo assets were checked without cookies or deployment-bypass headers. Use this stable production address when sharing; unique preview URLs may require Vercel sign-in.

Vercel recognizes `app.main:app` through `pyproject.toml`. `vercel.json` gives the Function 180 seconds, longer than the app's default 150-second request timeout. The Python runtime serves the UI and API together.

1. In Vercel, create a project from this GitHub repository. Leave the root directory at the repository root and use the detected FastAPI settings.
2. Add both provider keys under **Project Settings → Environment Variables** for Production. Add Preview only if preview deployments should call the providers.
3. Keep the committed `static/dist/`, `static/build.json`, and regional atlas files. These are built locally/CI; production does not run npm. Scratch artifacts, tests, evaluations, and `.env` are excluded from uploads.
4. Deploy a preview. Check `/api/health`, the home page, `/docs`, and a synthetic question. Confirm no 3D assets download until opening a relevant scene.

You can also deploy a linked local checkout with:

```bash
vercel link --project medical-harness
vercel deploy --target preview
```

The refactor links a project named `medical-harness` and connects the GitHub repository. Preview and Production provider variables are configured as sensitive values. Verify Git integration and the production branch in Vercel settings before relying on automatic deployments. Merge the reviewed PR when ready; use `vercel deploy --prod` only for an intentional production deployment. A preview may require the owner's Vercel session because of deployment protection.

Vercel Functions scale independently. In-memory caches, concurrency slots, and rate limits are per instance. Use external shared infrastructure if you need global quotas or durable state. The application has no user authentication or database.

Preview has `VERCEL_PREVIEW_FEEDBACK_ENABLED=0` to prevent Vercel's feedback toolbar from injecting `vercel.live` scripts that conflict with the application's CSP. This takes effect on new deployments. Keep the app's script policy limited to its own assets. See [Vercel's toolbar settings](https://vercel.com/docs/vercel-toolbar/managing-toolbar).

## Visitor analytics

Vercel Web Analytics is enabled for the linked project. The official `@vercel/analytics` SDK is bundled in a separate entry point. FastAPI includes it only when Vercel supplies both `VERCEL=1` and `VERCEL_ENV=production`; local and preview visits do not load it. The script and collection endpoints are served from the same origin, so the application CSP does not need an external analytics host.

Open the [project Analytics dashboard](https://vercel.com/pathakom890/medical-harness/analytics) to view anonymous visitor counts, page views, countries, device types, and browsers. Choose Production and the desired date range. Collection starts with the deployment containing the SDK; earlier visits are not backfilled. Content blockers and dashboard processing delays can affect the counts.

The app sends page views only. Its `beforeSend` filter reports the root URL without query parameters or fragments and rejects custom events. Chat questions, answers, calculator inputs, selected medical topics, and conversation IDs are not sent as analytics properties. The analytics service does not identify visitors by name. See [Vercel's setup](https://vercel.com/docs/analytics/quickstart) and [privacy documentation](https://vercel.com/docs/analytics/privacy-policy).

## Deployment from GitHub Actions

The `Deploy` workflow is manually dispatched and defaults to Preview. It calls the same CI workflow against the selected commit and deploys only after both check jobs pass. CI retains the original `test` check name as an aggregate gate for existing branch-protection rules. Production is restricted to `main`. Deployments to the same environment are serialized. The CLI is pinned, builds once, and uploads that build with `--prebuilt`; the checked-in frontend bundles have already been verified by CI.

Create GitHub environments named `preview` and `production`. In each environment, set `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` as secrets. Get the IDs from the existing local `.vercel/project.json` link and confirm they match the intended project. Provider keys remain in Vercel environment settings. Configure required reviewers and a `main` branch restriction on the production environment before using it.

After the workflow is on the default branch, select **Actions → Deploy → Run workflow**, choose the branch and target, and review the deployment URL in the run summary. Check the deployed home page and `/api/health`; protected previews may need your Vercel session. The workflow does not make live medical-provider calls as a smoke test.

This workflow does not disable Vercel's existing Git integration. Verify that integration before relying on these checks as the only deployment gate. If Git auto-deploy is enabled, a push can still deploy independently of this workflow; choose one deployment owner in project settings to avoid duplicate deployments. No remote secrets or hosting settings are changed by adding these files.

See [Vercel's GitHub Actions guidance](https://vercel.com/docs/git/vercel-for-github#using-github-actions).

## Docker

```bash
docker build -t medical-harness .
docker run --env-file .env -p 8080:8080 medical-harness
```

`Dockerfile` installs runtime dependencies with uv and runs Uvicorn as a non-root user. The health endpoint is `/api/health`. `docker run --env-file` passes keys at runtime; they are not baked into the image.

## DigitalOcean App Platform

The example `deploy/app-spec.yaml` uses a container image in DigitalOcean Container Registry. Build and push a `medical-harness` image to your registry, update the repository/tag fields, and provide provider values as secrets in the console. The Docker and DigitalOcean paths are documented but were not deployed during this refactor.

## Before sharing a public URL

Check that the home page, `/api/health`, and an ordinary answer work. Review provider costs, request limits, deployment protection, and privacy expectations for your audience. See [SECURITY.md](../SECURITY.md).
