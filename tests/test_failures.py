from pathlib import Path

from evals.failures import FAULT_CASES, TOOL_CASES, render_markdown, run_all, run_tool_cases

REPORT = Path(__file__).resolve().parents[1] / "docs" / "FAILURE_MODES.md"
EXPECTED_IDS = [
    "evidence_timeout", "evidence_empty", "triage_malformed_json", "review_timeout", "review_unsafe_twice",
    "answer_over_budget", "reference_5xx", "reference_circuit_open", "rxnorm_timeout", "rxnorm_429", "rxnorm_malformed",
    "growth_table_missing", "dose_out_of_range", "source_excerpt_injection",
    "clarification_limit", "label_combination_only", "tool_input_missing", "emergency",
]
EXPECTED_TOOL_IDS = [
    "schedule_duplicate_brand_generic", "schedule_rxnorm_unavailable", "schedule_batch_timeout",
    "steadi_boundary", "bp_alert_first", "tools_endpoint_unknown_key",
]


def test_fault_cases_cover_the_documented_set():
    assert [case["id"] for case in FAULT_CASES] == EXPECTED_IDS
    for case in FAULT_CASES:
        assert callable(case["build"]) and case["description"]
        assert case["expected"]["leak"] is False and case["expected"]["reason"]


def test_tool_cases_cover_the_documented_set():
    assert [case["id"] for case in TOOL_CASES] == EXPECTED_TOOL_IDS
    for case in TOOL_CASES:
        assert callable(case["run"]) and case["description"] and case["expected"]


def test_every_fault_is_handled_without_leaking_and_the_report_is_current():
    records = run_all()
    tool_records = run_tool_cases()
    assert [r["id"] for r in records] == EXPECTED_IDS
    for record in records:
        assert record["passed"], (record["id"], [k for k, ok in record["checks"].items() if not ok])
        assert record["leak"] is False
        assert record["reason"] and record["route"] == record["expected"]["route"]
        assert [step["name"] for step in record["trace"]] == ["triage", "tools", "evidence", "draft", "review"]
    assert [r["id"] for r in tool_records] == EXPECTED_TOOL_IDS
    for record in tool_records:
        assert record["passed"], (record["id"], [k for k, ok in record["checks"].items() if not ok])
    # The checked-in report cannot drift; regenerate with
    # `uv run python -m evals.failures --out docs/FAILURE_MODES.md`.
    assert render_markdown(records, tool_records) == REPORT.read_text(encoding="utf-8")


def test_report_has_no_timings():
    assert " ms" not in render_markdown(run_all(), run_tool_cases())


def test_tool_case_run_leaves_global_state_as_it_found_it():
    from app.tools import forms, growth
    from app.tools.clinical import TOOL_REGISTRY

    functions = {key: info["function"] for key, info in TOOL_REGISTRY.items()}
    load_tables, budget = growth.load_tables, forms.LOOKUP_TIMEOUT_SECONDS
    run_all()
    run_tool_cases()
    assert growth.load_tables is load_tables and forms.LOOKUP_TIMEOUT_SECONDS == budget == 8
    assert {key: info["function"] for key, info in TOOL_REGISTRY.items()} == functions
