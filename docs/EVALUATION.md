# Evaluation

The normal unit tests are offline and use fake keys. Run them before every change:

```bash
uv run pytest -q
```

`eval_healthbench.py` is an optional manual benchmark script. It reads the included `healtbench/hard_2025-05-08-21-00-10.jsonl` file, sends selected examples through the real agent pipeline, and asks the configured Cerebras model to grade rubric items. It makes live Cerebras and MediSearch requests, so it can use provider quota or incur charges. It is not part of CI.

```bash
uv run python eval_healthbench.py --limit 5
```

Use `--file PATH` for another compatible JSONL input. Start with a small `--limit`. The script and historical `healtbench/eval_results.json` are research aids, not clinical validation or a performance guarantee. Do not add private patient questions or API keys to benchmark files or checked-in results.
