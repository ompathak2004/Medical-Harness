from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
from pathlib import Path


CASES_PATH = Path(__file__).with_name("cases_holdout.json")


async def run_heldout():
    from app.pipeline import AgentPipeline, ReviewUnavailable
    from evals.doubles import DEFAULT_ARTICLE, ScriptedEvidence, ScriptedLLM, default_script

    records = []
    for case in json.loads(CASES_PATH.read_text(encoding="utf-8")):
        script = case["script"]
        selected = [script["tool"]] if "tool" in script else []
        llm = ScriptedLLM(default_script(script.get("triage", {"action": "answer"}),
                                        {"selected_tools": selected}, script.get("safety"), script.get("extract")))
        articles = [{**DEFAULT_ARTICLE, "tldr": ""}] if script.get("metadata_only") else None
        pipeline = AgentPipeline(llm, ScriptedEvidence(articles=articles, response=""))
        try:
            result = await pipeline.run(case["conversation"], case["id"])
            route = result["type"]
        except ReviewUnavailable:
            result, route = {}, "blocked"
        finally:
            await pipeline.aclose()

        reason = (result.get("handoff") or {}).get("reason")
        expected_reason = case.get("handoff_reason")
        tools = result.get("tool_results", [])
        computed = any(tool.get("inputs") and not tool.get("error") for tool in tools)
        passed = route == case["type"] and (not expected_reason or reason == expected_reason)
        if case["slice"] == "tool_confirmation":
            passed = passed and not computed and any(tool.get("status") == "confirmation_required" for tool in tools)
        if case.get("tool_inputs"):
            passed = passed and any(tool.get("inputs") == case["tool_inputs"] for tool in tools)
        records.append({
            "id": case["id"], "slice": case["slice"], "route": route, "reason": reason, "passed": passed,
            "unconfirmed_calculation": case["slice"] == "tool_confirmation" and computed,
            "missed_emergency": case["type"] == "emergency" and route != "emergency",
        })
    return {
        "mode": "scripted_offline",
        "case_hash": hashlib.sha256(CASES_PATH.read_bytes()).hexdigest(),
        "passed": sum(record["passed"] for record in records),
        "cases": len(records),
        "unconfirmed_calculations": sum(record["unconfirmed_calculation"] for record in records),
        "missed_emergencies": sum(record["missed_emergency"] for record in records),
        "records": records,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkout", type=Path, default=CASES_PATH.parent.parent)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    checkout = args.checkout.resolve()
    if not (checkout / "app" / "pipeline.py").is_file():
        parser.error("--checkout must be a Medical Harness checkout")
    os.environ.update(CEREBRAS_API_KEY="test-key", MEDISEARCH_API_KEY="test-key", OTEL_EXPORTER_OTLP_ENDPOINT="")
    sys.path.insert(0, str(checkout))
    report = asyncio.run(run_heldout())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"{report['passed']}/{report['cases']} policy checks passed")


if __name__ == "__main__":
    main()
