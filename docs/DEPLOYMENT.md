# Deployment

medical-harness serves the frontend and API from the same FastAPI application. Every deployment needs `CEREBRAS_API_KEY` and `MEDISEARCH_API_KEY` set on the host. Keep `.env` local; it is excluded from Git and Vercel uploads.

## Vercel

The stable production address is [medical-harness.ompathak.dev](https://medical-harness.ompathak.dev). The project is hosted in the `shinchan21` Vercel team. Use the GitHub Actions workflow below for preview and production releases. The Vercel configuration disables automatic Git deployments.

Vercel recognizes `app.main:app` through `pyproject.toml`. `vercel.json` gives the Function 180 seconds, longer than the app's default 150-second request timeout. The Python runtime serves the UI and API together.

Use the existing linked `medical-harness` Vercel project with the FastAPI preset. Add the required provider variables to each environment you intend to deploy. Keep the committed bundles, build manifest, and atlas files. Vercel excludes local scratch files, tests, eval outputs, and `.env` from uploads.

Vercel Functions scale independently. For a public demo, configure one [Vercel WAF rate-limit rule](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting) on POST requests to the paid chat endpoints, keyed by IP. Check the allowance on your plan before enabling it. Keep provider quotas separate from the app's per-instance rate limits, and use preview access protection for private evaluation.

Preview has `VERCEL_PREVIEW_FEEDBACK_ENABLED=0` to prevent Vercel's feedback toolbar from injecting `vercel.live` scripts that conflict with the application's CSP. This takes effect on new deployments. Keep the app's script policy limited to its own assets. See [Vercel's toolbar settings](https://vercel.com/docs/vercel-toolbar/managing-toolbar).

## Visitor analytics

Vercel Web Analytics is enabled for the linked project. The official `@vercel/analytics` SDK is bundled in a separate entry point. FastAPI includes it only when Vercel supplies both `VERCEL=1` and `VERCEL_ENV=production`; local and preview visits do not load it. The script and collection endpoints are served from the same origin, so the application CSP does not need an external analytics host.

Open the [project Analytics dashboard](https://vercel.com/shinchan21/medical-harness/analytics) to view anonymous visitor counts, page views, countries, device types, and browsers. Choose Production and the desired date range. Collection starts with the deployment containing the SDK; earlier visits are not backfilled. Content blockers and dashboard processing delays can affect the counts.

The app sends page views only. Its `beforeSend` filter reports the root URL without query parameters or fragments and rejects custom events. Chat questions, answers, calculator inputs, selected medical topics, and conversation IDs are not sent as analytics properties. The analytics service does not identify visitors by name. See [Vercel's setup](https://vercel.com/docs/analytics/quickstart) and [privacy documentation](https://vercel.com/docs/analytics/privacy-policy).

## Deployment from GitHub Actions

The `Deploy` workflow defaults to Preview. It runs CI on the selected commit, uploads the allowed source files for one build on Vercel, and stamps the deployment with that SHA. Remote builds apply `.vercelignore` before packaging the Python function, avoiding prebuilt symlinks to excluded files. Only root-level `/data/` is excluded; `app/tools/data/` contains required, hash-verified growth tables. The smoke check verifies the revision reported by `/api/health`, the home page and its main bundles, and synthetic BMI and growth calculator results. For Production, the workflow stages the build without assigning the public domains, checks that it is still the head of `main`, and promotes it after the smoke check passes.

The custom domain uses a Name.com CNAME record with host `medical-harness`, answer `5e7bff2d5d58bd92.vercel-dns-017.com`, and TTL 300. Other root, wildcard, and email records do not need changes.

In the GitHub Preview and Production environments, set `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, and `VERCEL_AUTOMATION_BYPASS_SECRET`. Get the IDs from the local Vercel project link and generate the smoke-test secret in [Vercel Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation). Keep the provider keys in Vercel. Restrict the Production environment to `main` and review access before dispatching the workflow.

After the workflow lands on the default branch, select **Actions → Deploy → Run workflow** and choose the branch and environment. The run summary records the revision and deployment URL. Confirm the public health endpoint reports the intended revision after a production promotion.

Apply the [main branch ruleset](../.github/rulesets/main.json) after reviewing the PR. It requires pull requests, resolved review threads, and the GitHub Actions `test` check, and prevents deletion and force pushes. The template allows a solo maintainer to merge a reviewed PR.

```bash
gh api --method POST repos/ompathak2004/Medical-Harness/rulesets --input .github/rulesets/main.json
```

Verify the rule appears in **Settings → Rules → Rulesets** and that pushes no longer start automatic Vercel releases. If a promoted release fails, use the previous verified deployment in [Vercel Instant Rollback](https://vercel.com/docs/instant-rollback), then confirm the public health revision. Use [operator traces](OBSERVABILITY.md) to check whether reviewed answers and provider outcomes recovered.

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
