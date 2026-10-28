from copy import deepcopy

import pytest

from evals.run import check_result, compare


def reports():
    baseline = {"run_id": "a", "case_hash": "same", "budget_hash": "same", "usage": {"prompt_tokens": 100, "completion_tokens": 50}, "records": [{"id": "case", "checks": {"completed": True}, "elapsed_seconds": 1}]}
    candidate = {**deepcopy(baseline), "run_id": "b"}
    review = {"baseline": {"run_id": "a", "reviewer": "Clinical reviewer", "ratings": {"case": {"score": .5, "safe": True}}},
              "candidate": {"run_id": "b", "reviewer": "Clinical reviewer", "ratings": {"case": {"score": .8, "safe": True}}}}
    return baseline, candidate, review


def test_improved_candidate_still_requires_human_promotion():
    result = compare(*reports())
    assert result["status"] == "eligible_for_human_review"
    assert result["automatic_promotion"] is False


@pytest.mark.parametrize("change", ["safety", "coverage", "budget", "review", "score", "latency", "checks"])
def test_gate_rejects_regressions_and_incomparable_runs(change):
    baseline, candidate, review = reports()
    if change == "safety":
        review["candidate"]["ratings"]["case"]["safe"] = False
    elif change == "coverage":
        candidate["records"] = []
    elif change == "budget":
        candidate["budget_hash"] = "different"
    elif change == "review":
        review["candidate"]["run_id"] = "unrelated"
    elif change == "score":
        review["candidate"]["ratings"]["case"]["score"] = .4
    elif change == "latency":
        candidate["records"][0]["elapsed_seconds"] = 2
    elif change == "checks":
        candidate["records"][0]["checks"]["completed"] = False
    assert compare(baseline, candidate, review)["status"] == "blocked"


def test_evidence_failure_is_counted_not_skipped():
    checks = check_result({"type": "answer", "anatomy": None}, {"type": "answer", "evidence_status": "unavailable"})
    assert checks["evidence_required"] is False


def test_emergency_check_rejects_normal_tools_and_anatomy():
    checks = check_result({"type": "emergency", "anatomy": None}, {"type": "emergency", "emergency": True, "tool_results": [{"tool": "BMI"}], "anatomy_context": {"scene_id": "chest"}})
    assert not checks["emergency_isolation"]
    assert not checks["anatomy_relevance"]


def test_visual_evaluation_rejects_wrong_topic_and_emergency_visuals():
    checks = check_result({"type": "answer", "anatomy": None, "visual": "asthma"}, {
        "type": "answer", "visual_context": "reflux", "articles": [{}], "evidence_status": "available",
    })
    assert not checks["visual_relevance"]
    checks = check_result({"type": "emergency", "anatomy": None}, {
        "type": "emergency", "emergency": True, "visual_context": "asthma",
    })
    assert not checks["emergency_isolation"]


@pytest.mark.parametrize("kind,reason", [
    ("emergency", "emergency"), ("follow_up", "clarification_pending"),
    ("conversation", "user_requested"), ("answer", "answer_available"),
])
def test_handoff_reason_defaults_from_case_type(kind, reason):
    checks = check_result({"type": kind, "anatomy": None}, {"type": kind, "handoff": {"reason": reason}})
    assert checks["handoff_present"] and checks["handoff_reason"]
    wrong = check_result({"type": kind, "anatomy": None}, {"type": kind, "handoff": {"reason": "review_unavailable"}})
    assert wrong["handoff_present"] and not wrong["handoff_reason"]


def test_missing_or_unknown_handoff_fails_the_checks():
    case = {"type": "answer", "anatomy": None}
    assert not check_result(case, {"type": "answer"})["handoff_present"]
    assert not check_result(case, {"type": "answer", "handoff": {"reason": "made_up"}})["handoff_present"]


def test_case_can_expect_a_specific_handoff_reason():
    case = {"type": "answer", "anatomy": None, "handoff_reason": "clarification_limit"}
    assert check_result(case, {"type": "answer", "handoff": {"reason": "clarification_limit"}})["handoff_reason"]
    assert not check_result(case, {"type": "answer", "handoff": {"reason": "answer_available"}})["handoff_reason"]


def test_case_file_includes_handoff_and_new_tool_cases():
    import json
    from pathlib import Path

    from app.pipeline import AgentPipeline, CLARIFICATION_INTRO
    from app.tools.clinical import TOOL_REGISTRY
    from app.tools.references import REFERENCE_TOOLS

    cases = {case["id"]: case for case in json.loads((Path(__file__).parents[1] / "evals" / "cases.json").read_text())}
    assert len(cases) == 30
    registered = {info["name"] for info in REFERENCE_TOOLS.values()} | {
        entry["function"]({}).get("tool") for entry in TOOL_REGISTRY.values()}
    tool_names = {entry["tool"] for entry in (cases[i] for i in ("pack_years", "waist_to_height", "label_sections"))}
    assert tool_names == {"Pack-years", "Waist-to-height ratio", "FDA label sections"} <= registered
    limit = cases["handoff_after_clarification_limit"]
    assert limit["type"] == "answer" and limit["handoff_reason"] == "clarification_limit"
    assert AgentPipeline._count_prior_clarifications(limit["conversation"]) == 1
    assert limit["conversation"][1].startswith(CLARIFICATION_INTRO) and len(limit["conversation"]) % 2 == 1
