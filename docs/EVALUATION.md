# Evaluation

The normal unit tests are offline and use fake keys. Run them before every change:

```bash
uv run pytest -q
```

`eval_healthbench.py` is an optional manual benchmark script. It sends selected examples through the real agent pipeline and asks the configured Cerebras model to grade rubric items. It makes live Cerebras and MediSearch requests, so it can use provider quota or incur charges. It is not part of CI or local setup.

## Obtain the benchmark

Download OpenAI's [HealthBench Hard dataset](https://huggingface.co/datasets/openai/healthbench) into `data/healthbench-hard.jsonl`. The `data/` directory is Git-ignored. OpenAI asks users not to reproduce benchmark examples in plain text or images online; keep examples out of screenshots, issues, and model training material.

On macOS or Linux:

```bash
mkdir -p data
curl -L https://huggingface.co/datasets/openai/healthbench/resolve/main/hard_2025-05-08-21-00-10.jsonl -o data/healthbench-hard.jsonl
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force data
Invoke-WebRequest -Uri 'https://huggingface.co/datasets/openai/healthbench/resolve/main/hard_2025-05-08-21-00-10.jsonl' -OutFile 'data/healthbench-hard.jsonl'
```

Then run a small sample:

```bash
uv run python eval_healthbench.py --limit 5
```

Use `--file PATH` for another compatible JSONL input. The script writes results to ignored `data/healthbench-results.json`. This is a research aid, not clinical validation or a performance guarantee. Do not add private patient questions, keys, or raw benchmark examples to checked-in results.
