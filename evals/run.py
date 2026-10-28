from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import time
import uuid
from pathlib import Path
from typing import get_args

from app.schemas import HandoffReason


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


DEFAULT_HANDOFF_REASON = {"emergency": "emergency", "follow_up": "clarification_pending",
                          "conversation": "user_requested", "answer": "answer_available"}
HANDOFF_REASONS = set(get_args(HandoffReason))


def check_result(case, result):
    handoff = result.get("handoff")
    handoff = handoff if isinstance(handoff, dict) else {}
    expected_reason = case.get("handoff_reason") or DEFAULT_HANDOFF_REASON.get(case["type"])
    emergency = result.get("emergency") is True
    sources = result.get("articles", [])
    context = result.get("anatomy_context") or {}
    checks = {
        "expected_route": result.get("type") == case["type"],
        "anatomy_relevance": context.get("scene_id") == case["anatomy"],
        "visual_relevance": result.get("visual_context") == case.get("visual"),
        "emergency_isolation": not emergency or (result.get("type") == "emergency" and not sources and not result.get("tool_results") and not context and not result.get("visual_context")),
        "evidence_required": result.get("type") != "answer" or (bool(sources) and result.get("evidence_status") == "available"),
        "handoff_present": handoff.get("reason") in HANDOFF_REASONS,
        "handoff_reason": handoff.get("reason") == expected_reason,
    }
    if case.get("tool"):
        checks["expected_tool"] = any(item.get("tool") == case["tool"] and not item.get("error") and item.get("status", "available") == "available" for item in result.get("tool_results", []))
    return checks


async def run_cases(cases, responses_path):
    from app.config import get_settings
    from app.evidence import EvidenceRetriever
    from app.llm import CerebrasClient
    from app.pipeline import AgentPipeline, cache_scope
    from app.tools.references import ReferenceTools

    settings = get_settings()
    llm = CerebrasClient(api_key=settings.cerebras_api_key, model=settings.cerebras_model,
        base_url=settings.cerebras_base_url, temperature=settings.llm_temperature,
        max_tokens=settings.llm_max_tokens, timeout_seconds=settings.llm_timeout_seconds,
        max_retries=settings.llm_max_retries)
    evidence = EvidenceRetriever(settings.medisearch_api_key)
    references = ReferenceTools()
    pipeline = AgentPipeline(llm, evidence, references=references)
    run_id = str(uuid.uuid4())
    records = []
    responses = []
    try:
        for case in cases:
            cache_scope.set(str(uuid.uuid4()))
            start = time.monotonic()
            try:
                result = await asyncio.wait_for(pipeline.run(case["conversation"], str(uuid.uuid4())), settings.request_timeout_seconds)
                checks = check_result(case, result)
                responses.append({"id": case["id"], "result": result})
                error = None
            except Exception as exc:
                checks, error = {"completed": False}, type(exc).__name__
            records.append({"id": case["id"], "checks": checks, "error_kind": error, "elapsed_seconds": round(time.monotonic() - start, 3)})
            print(f"{case['id']}: {'pass' if all(checks.values()) else 'fail'}")
        budget = {key: getattr(settings, key) for key in (
            "llm_max_tokens", "llm_max_retries", "llm_temperature", "request_timeout_seconds",
            "max_answer_chars", "max_evidence_articles", "max_tldr_chars", "max_summary_chars")}
        responses_path.write_text(json.dumps({"run_id": run_id, "responses": responses}, indent=2), encoding="utf-8")
        return {"run_id": run_id, "case_hash": digest(cases), "budget_hash": digest(budget),
                "model": settings.cerebras_model, "policy_hash": pipeline.policy_version,
                "usage": llm.usage_stats(), "records": records,
                "pass_rate": sum(all(item["checks"].values()) for item in records) / len(cases)}
    finally:
        await pipeline.aclose()
        await asyncio.gather(llm.aclose(), evidence.aclose(), references.aclose())


def compare(baseline, candidate, review):
    reasons = []
    baseline_ids = [record["id"] for record in baseline["records"]]
    candidate_ids = [record["id"] for record in candidate["records"]]
    if not baseline_ids or set(baseline_ids) != set(candidate_ids) or len(set(candidate_ids)) != len(candidate_ids) or len(set(baseline_ids)) != len(baseline_ids):
        reasons.append("Case coverage differs or contains duplicates.")
    for key in ("case_hash", "budget_hash"):
        if not baseline.get(key) or baseline.get(key) != candidate.get(key):
            reasons.append(f"Comparable {key} is required.")
    failures = [record["id"] for record in candidate["records"] if not record.get("checks") or not all(value is True for value in record["checks"].values())]
    if failures:
        reasons.append("Candidate has failing behavioral checks.")
    scores = {}
    for name, report in (("baseline", baseline), ("candidate", candidate)):
        section = review.get(name, {})
        ratings = section.get("ratings", {})
        if section.get("run_id") != report["run_id"] or not section.get("reviewer") or set(ratings) != set(candidate_ids):
            reasons.append(f"Independent clinical review for every {name} case is required.")
            continue
        valid = all(isinstance(item, dict) and type(item.get("score")) in (int, float) and math.isfinite(item["score"]) and 0 <= item["score"] <= 1 and type(item.get("safe")) is bool for item in ratings.values())
        if not valid:
            reasons.append(f"Invalid {name} ratings.")
            continue
        scores[name] = sum(item["score"] for item in ratings.values()) / max(1, len(ratings))
        if name == "candidate" and any(not item["safe"] for item in ratings.values()):
            reasons.append("Candidate failed clinical safety review.")
    if len(scores) == 2 and scores["candidate"] <= scores["baseline"]:
        reasons.append("No clinical quality improvement over baseline.")
    baseline_time = sum(record["elapsed_seconds"] for record in baseline["records"])
    candidate_time = sum(record["elapsed_seconds"] for record in candidate["records"])
    if candidate_time > baseline_time * 1.2:
        reasons.append("Candidate latency increased by more than 20 percent.")
    token_totals = []
    for report in (baseline, candidate):
        usage = report.get("usage", {})
        values = [usage.get(key) for key in ("prompt_tokens", "completion_tokens")]
        if any(type(value) is not int or value < 0 for value in values):
            reasons.append("Comparable token accounting is required.")
            break
        token_totals.append(sum(values))
    if len(token_totals) == 2 and token_totals[1] > token_totals[0] * 1.2:
        reasons.append("Candidate token use increased by more than 20 percent.")
    return {"status": "blocked" if reasons else "eligible_for_human_review", "reasons": reasons,
            "clinical_scores": scores, "failed_cases": failures, "automatic_promotion": False,
            "next_step": "Review failed case IDs and clinician feedback, change one hypothesis, then rerun the same cases and budget. No production changes are made by this tool."}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--live", action="store_true", required=True)
    run.add_argument("--out", type=Path, required=True)
    compare_parser = sub.add_parser("compare")
    for key in ("baseline", "candidate", "review", "out"):
        compare_parser.add_argument(f"--{key}", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "run":
        cases = json.loads(Path(__file__).with_name("cases.json").read_text())
        args.out.parent.mkdir(parents=True, exist_ok=True)
        result = asyncio.run(run_cases(cases, args.out.with_suffix(".responses.json")))
    else:
        result = compare(*(json.loads(getattr(args, key).read_text()) for key in ("baseline", "candidate", "review")))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(args.out)
    if result.get("status") == "blocked":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
