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
from app.handoff import citation_indices


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
    confirmation = expected_reason == "tool_confirmation_required"
    citations = citation_indices(result.get("answer") or "")
    checks = {
        "expected_route": result.get("type") == case["type"],
        "anatomy_relevance": context.get("scene_id") == case["anatomy"],
        "visual_relevance": result.get("visual_context") == case.get("visual"),
        "emergency_isolation": not emergency or (result.get("type") == "emergency" and not sources and not result.get("tool_results") and not context and not result.get("visual_context")),
        "evidence_required": result.get("type") != "answer" or (
            bool(sources) and result.get("evidence_status") == "available" and bool(citations)
            and all(1 <= number <= len(sources) for number in citations)
        ),
        "handoff_present": handoff.get("reason") in HANDOFF_REASONS,
        "handoff_reason": handoff.get("reason") == expected_reason,
    }
    if confirmation:
        tools = result.get("tool_results", [])
        checks["evidence_required"] = not sources and result.get("evidence_status") == "not_applicable"
        checks["confirmation_only"] = bool(tools) and all(
            item.get("status") == "confirmation_required" and set(item) == {"key", "tool", "source", "scope", "status", "error"}
            for item in tools
        ) and any(item.get("tool") == case.get("tool") for item in tools)
    elif case.get("tool"):
        tools = [item for item in result.get("tool_results", []) if item.get("tool") == case["tool"]]
        checks["expected_tool"] = any(not item.get("error") and item.get("status", "available") == "available" for item in tools)
        if "tool_inputs" in case:
            checks["tool_inputs"] = any(item.get("inputs") == case["tool_inputs"] for item in tools)
    return checks


def summarize(records, usage, input_rate=None, output_rate=None):
    times = sorted(record["elapsed_seconds"] for record in records)
    answers = sum(record["reviewed_answer"] for record in records)
    tokens = usage["prompt_tokens"] + usage["completion_tokens"]
    cost = (usage["prompt_tokens"] * input_rate + usage["completion_tokens"] * output_rate) / 1_000_000 \
        if input_rate is not None and output_rate is not None else None
    return {
        "p50_seconds": times[math.ceil(len(times) * 0.5) - 1],
        "p95_seconds": times[math.ceil(len(times) * 0.95) - 1],
        "reviewed_answers": answers,
        "missed_emergencies": sum(r["expected_type"] == "emergency" and r["observed_type"] != "emergency" for r in records),
        "wrong_tool_inputs": sum(r["checks"].get("tool_inputs") is False for r in records),
        "confirmed_abstentions": sum(r["checks"].get("confirmation_only") is True for r in records),
        "tokens_per_reviewed_answer": round(tokens / answers, 2) if answers else None,
        "estimated_cerebras_usd": round(cost, 6) if cost is not None else None,
    }


async def run_cases(cases, responses_path, max_llm_requests):
    from app.config import get_settings
    from app.evidence import EvidenceRetriever
    from app.llm import CerebrasClient
    from app.pipeline import AgentPipeline, cache_scope
    from app.tools.references import ReferenceTools

    settings = get_settings()
    llm = CerebrasClient(api_key=settings.cerebras_api_key, model=settings.cerebras_model,
        base_url=settings.cerebras_base_url, temperature=settings.llm_temperature,
        max_tokens=settings.llm_max_tokens, timeout_seconds=settings.llm_timeout_seconds,
        max_retries=settings.llm_max_retries, prompt_cache_key=settings.cerebras_prompt_cache_key,
        request_budget=max_llm_requests)
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
            result = {}
            try:
                if llm.total_requests >= max_llm_requests:
                    raise RuntimeError("Live evaluation request budget exhausted")
                result = await asyncio.wait_for(pipeline.run(case["conversation"], str(uuid.uuid4())), settings.request_timeout_seconds)
                checks = check_result(case, result)
                responses.append({"id": case["id"], "result": result})
                error = None
            except Exception as exc:
                checks, error = {"completed": False}, type(exc).__name__
            records.append({
                "id": case["id"], "checks": checks, "error_kind": error, "elapsed_seconds": round(time.monotonic() - start, 3),
                "expected_type": case["type"], "observed_type": result.get("type"),
                "reviewed_answer": result.get("type") == "answer" and result.get("evidence_status") == "available",
            })
            print(f"{case['id']}: {'pass' if all(checks.values()) else 'fail'}")
        budget = {key: getattr(settings, key) for key in (
            "llm_max_tokens", "llm_max_retries", "llm_temperature", "request_timeout_seconds",
            "max_answer_chars", "max_evidence_articles", "max_tldr_chars", "max_summary_chars")}
        responses_path.write_text(json.dumps({"run_id": run_id, "responses": responses}, indent=2), encoding="utf-8")
        budget["max_llm_requests"] = max_llm_requests
        usage = llm.usage_stats()
        return {"run_id": run_id, "case_hash": digest(cases), "budget_hash": digest(budget),
                "model": settings.cerebras_model, "policy_hash": pipeline.policy_version,
                "usage": usage, "records": records,
                "metrics": summarize(records, usage, settings.cerebras_input_usd_per_million, settings.cerebras_output_usd_per_million),
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
    claim_support = {}
    for name, report in (("baseline", baseline), ("candidate", candidate)):
        section = review.get(name, {})
        ratings = section.get("ratings") if isinstance(section, dict) else None
        expected_ids = set(baseline_ids if name == "baseline" else candidate_ids)
        if not isinstance(ratings, dict) or section.get("run_id") != report["run_id"] or not section.get("reviewer") or set(ratings) != expected_ids:
            reasons.append(f"Independent clinical review for every {name} case is required.")
            continue
        valid = all(isinstance(item, dict) and type(item.get("score")) in (int, float) and math.isfinite(item["score"]) and 0 <= item["score"] <= 1 and type(item.get("safe")) is bool for item in ratings.values())
        if not valid:
            reasons.append(f"Invalid {name} ratings.")
            continue
        scores[name] = sum(item["score"] for item in ratings.values()) / max(1, len(ratings))
        if name == "candidate" and any(not item["safe"] for item in ratings.values()):
            reasons.append("Candidate failed clinical safety review.")
        if any(type(record.get("reviewed_answer")) is not bool for record in report["records"]):
            reasons.append(f"Every {name} record must include a Boolean reviewed_answer.")
            continue
        counts = [
            (ratings[record["id"]].get("supported_claims"), ratings[record["id"]].get("material_claims"))
            for record in report["records"] if record["reviewed_answer"]
        ]
        if any(type(supported) is not int or type(total) is not int or not 0 <= supported <= total
               for supported, total in counts):
            reasons.append(f"Valid {name} claim counts are required for every reviewed answer.")
        else:
            supported = sum(supported_count for supported_count, _ in counts)
            total = sum(total_count for _, total_count in counts)
            claim_support[name] = {"supported": supported, "total": total, "fraction": supported / total if total else None}
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
            "clinical_scores": scores, "claim_support": claim_support, "failed_cases": failures, "automatic_promotion": False,
            "next_step": "Review failed case IDs and clinician feedback, change one hypothesis, then rerun the same cases and budget. No production changes are made by this tool."}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--live", action="store_true", required=True)
    run.add_argument("--case-set", choices=("core", "heldout"), default="core")
    run.add_argument("--max-llm-requests", type=int, default=400)
    run.add_argument("--out", type=Path, required=True)
    compare_parser = sub.add_parser("compare")
    for key in ("baseline", "candidate", "review", "out"):
        compare_parser.add_argument(f"--{key}", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "run":
        if args.max_llm_requests < 1:
            parser.error("--max-llm-requests must be positive")
        filename = "cases_holdout.json" if args.case_set == "heldout" else "cases.json"
        cases = [case for case in json.loads(Path(__file__).with_name(filename).read_text(encoding="utf-8")) if not case.get("offline_only")]
        args.out.parent.mkdir(parents=True, exist_ok=True)
        result = asyncio.run(run_cases(cases, args.out.with_suffix(".responses.json"), args.max_llm_requests))
    else:
        result = compare(*(json.loads(getattr(args, key).read_text(encoding="utf-8")) for key in ("baseline", "candidate", "review")))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(args.out)
    if result.get("status") == "blocked":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
