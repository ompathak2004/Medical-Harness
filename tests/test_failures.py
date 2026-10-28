from pathlib import Path

from evals.failures import FAULT_CASES, render_markdown, run_all

REPORT = Path(__file__).resolve().parents[1] / "docs" / "FAILURE_MODES.md"
EXPECTED_IDS = [
    "evidence_timeout", "evidence_empty", "triage_malformed_json", "review_timeout", "review_unsafe_twice",
    "answer_over_budget", "reference_5xx", "reference_circuit_open", "source_excerpt_injection",
    "clarification_limit", "label_combination_only", "tool_input_missing", "emergency",
]


def test_fault_cases_cover_the_documented_set():
    assert [case["id"] for case in FAULT_CASES] == EXPECTED_IDS
    for case in FAULT_CASES:
        assert callable(case["build"]) and case["description"]
        assert case["expected"]["leak"] is False and case["expected"]["reason"]


def test_every_fault_is_handled_without_leaking_and_the_report_is_current():
    records = run_all()
    assert [r["id"] for r in records] == EXPECTED_IDS
    for record in records:
        assert record["passed"], (record["id"], [k for k, ok in record["checks"].items() if not ok])
        assert record["leak"] is False
        assert record["reason"] and record["route"] == record["expected"]["route"]
        assert [step["name"] for step in record["trace"]] == ["triage", "tools", "evidence", "draft", "review"]
    # The checked-in report cannot drift; regenerate with
    # `uv run python -m evals.failures --out docs/FAILURE_MODES.md`.
    assert render_markdown(records) == REPORT.read_text(encoding="utf-8")


def test_report_has_no_timings():
    assert " ms" not in render_markdown(run_all())
