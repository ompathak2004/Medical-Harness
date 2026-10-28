# Evaluation and improvement loop

Routine checks are offline and use fake keys: run `uv run pytest -q`, `npm run check:anatomy`, and `npm run test:browser`.

The old HealthBench script was removed. It reused asynchronous clients across separate event loops, graded with the answering model, excluded failed examples from scores, and printed question excerpts. Those properties made its scores unsuitable as a promotion signal. This repository claims no clinical benchmark score.

## Synthetic live runs

The thirty built-in cases in evals/cases.json probe emergency routing, anatomy relevance, all eight guide IDs, visual suppression, missing inputs, reference lookup, official label sections, pack-years and waist-to-height calculators, the clarification limit, and instruction injection. Every case also checks that the result carries a clinician handoff (`handoff_present`) with the expected reason (`handoff_reason`). The expected reason defaults from the case type (emergency, clarification_pending for follow_up, user_requested for conversation, answer_available for answer); a case can override it with a `handoff_reason` field, as `handoff_after_clarification_limit` does. These are behavior checks, not clinical validation. The visual-routing cases are prospective evaluations; passing mocked regression tests does not mean the live model has passed these cases. Explicit opt-in is required:

```bash
uv run python -m evals.run run --live --out data/evals/baseline.json
uv run python -m evals.run run --live --out data/evals/candidate.json
```

Run the baseline on its revision, make one reviewable change, then run the candidate. Keep the case file and provider settings fixed. Each case has a fresh cache scope. Reports contain run IDs, case/budget/prompt hashes, usage, elapsed time, and check outcomes. Failures remain in the denominator. Adjacent *.responses.json files contain synthetic outputs for clinical review. The data directory is ignored by Git and deployment. Do not substitute patient records for these fixtures.

Changing `evals/cases.json` changes `case_hash`, and `compare` refuses reports with different hashes. The cases added with the clinician handoff (`pack_years`, `waist_to_height`, `label_sections`, `handoff_after_clarification_limit`) and the new handoff checks therefore need a new live baseline, run on the same revision as the candidate; older reports are not comparable.

Repeat runs before interpreting small improvements. Equal token budgets are not equal dollar costs across models; provider pricing and retry costs need separate review.

## Failure modes

The offline runner injects thirteen synthetic faults into the real pipeline and checks how each one ends. Doubles stand in for the model (`ScriptedLLM`), the evidence provider (`ScriptedEvidence`), and the reference services (an `httpx.MockTransport` under the real `ReferenceTools`, so parsing, byte limits, and the circuit breaker are the production code). No network, no keys, no patient text.

```bash
uv run python -m evals.failures --out docs/FAILURE_MODES.md
uv run python -m evals.failures --json data/evals/failures.json   # adds per-case timings
```

The cases are an evidence timeout, no evidence, malformed triage JSON, a review timeout, two unsafe review verdicts, an over-budget draft, a label-service 5xx, an open circuit breaker, instruction injection inside a source excerpt, the clarification limit, combination-only label matches, an invalid calculator input, and an emergency. Each case states its expected route, handoff reason, urgency, and trace statuses. A case also fails if a `result` or `answer_chunk` event is sent when an error was expected, or if a published answer cites a source index that was not retrieved. The command exits nonzero on any failure.

`docs/FAILURE_MODES.md` is generated and contains no timings, so it is identical across runs. `tests/test_failures.py` runs every case in the normal `uv run pytest -q` and compares the checked-in file with the regenerated one, so CI fails when a fault case regresses or the report drifts. After changing a case or pipeline behavior, rerun the command and commit the new file.

These are behavior checks with doubles. They show that the pipeline fails closed and says what happened; they do not measure clinical accuracy, and a passing run does not mean a live provider behaves the same way.

## Independent review

A qualified independent reviewer should inspect both sets of responses against a predetermined rubric: factual correctness, citation support, applicability, uncertainty, red flags and harmful omissions. Model self-grading does not meet this requirement. A local review JSON file must use exact run IDs and contain every case:

```json
{
  "baseline": {
    "run_id": "baseline-report-run-id",
    "reviewer": "Reviewer identifier",
    "ratings": {"greeting": {"score": 1.0, "safe": true}}
  },
  "candidate": {
    "run_id": "candidate-report-run-id",
    "reviewer": "Reviewer identifier",
    "ratings": {"greeting": {"score": 1.0, "safe": true}}
  }
}
```

This example shows one entry; include every case ID in each ratings map. Scores must be finite numbers from 0 to 1, and safe must be boolean. Store it in ignored data/evals/review.json.

```bash
uv run python -m evals.run compare --baseline data/evals/baseline.json --candidate data/evals/candidate.json --review data/evals/review.json --out data/evals/comparison.json
```

The gate exits nonzero for missing/duplicate cases, different case or budget hashes, failed candidate checks, incomplete review, any candidate safety failure, no average clinical-score improvement, or more than 20% growth in elapsed time or reported tokens. Passing produces eligible_for_human_review. It never edits code, promotes prompts, deploys or merges. Reports are operator-supplied evidence, not cryptographically attested results.

## Bounded improvement process

1. Reproduce a failure with a synthetic or approved, properly deidentified case.
2. Obtain external feedback and record one specific hypothesis.
3. Change a prompt, tool or route on a branch and add a regression test.
4. Rerun the same cases and budgets with independent clinical review.
5. Compare safety, quality, source support, latency and tokens; review the PR before promotion.

Useful contributions are clinician-reviewed cases/rubrics, intended countries and populations, acceptable cost/latency, and adversarial cases. Keep a held-out set that is not used to tune prompts. The small bundled pack is scaffolding, not clinical validation. [Research notes](RESEARCH.md) explain why online learning from chat history and self-approved promotion are not enabled.
