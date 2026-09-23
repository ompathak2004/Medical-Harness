# Security

OpenMed handles health questions. Avoid entering identifiable patient information in public demos, issues, screenshots, or test fixtures. This project is educational software and has not been certified as a medical device or healthcare record system.

## Report a vulnerability

Use GitHub's **Report a vulnerability** option on this repository's Security tab when available. If it is unavailable, contact the repository owner privately through their GitHub profile. Do not publish exploit details or secrets in a public issue.

Include the affected version or commit, reproduction steps with synthetic data, and the expected impact. The maintainers will acknowledge the report and coordinate a fix and disclosure.

## Secrets and deployments

- Keep `CEREBRAS_API_KEY` and `MEDISEARCH_API_KEY` in `.env` locally or your host's environment variable store. `.env` is Git-ignored.
- Rotate a key immediately if it appears in a commit, issue, screenshot, build log, or chat transcript. Remove it from the provider account after the replacement is deployed.
- The in-process rate limiter is not a distributed abuse-control layer. Public deployments should add platform-level controls appropriate for their traffic.
- The application does not provide user authentication or a persistent patient record. Review provider privacy terms before accepting sensitive data.
