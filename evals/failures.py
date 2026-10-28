"""Offline failure-injection runner for the answer pipeline.

Each case injects one synthetic fault with the doubles in `evals.doubles`, runs the real
`AgentPipeline`, and checks the route, the handoff reason, the trace, and that nothing
unreviewed reached the browser. These are behavior checks, not clinical validation.

    uv run python -m evals.failures --out docs/FAILURE_MODES.md [--json report.json]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.handoff import LIMITATION_COMBINATION, LIMITATION_UNREACHABLE, citation_indices
from app.pipeline import CLARIFICATION_INTRO, AgentPipeline, cache_scope
from app.schemas import Handoff
from app.tools.references import ReferenceTools
from evals.doubles import (
    EXTRACT_KEY, INJECTION_TEXT, SAFETY_KEY, TOOLS_KEY, TRIAGE_KEY,
    ScriptedEvidence, ScriptedLLM, default_script, mock_reference_client,
)

REGENERATE = "uv run python -m evals.failures --out docs/FAILURE_MODES.md"
LABEL_TOOL = "FDA label sections"
SET_ID = "0b1b0b1b-0000-4000-8000-000000000001"
EMERGENCY_STEPS = {"triage": "ok", "tools": "skipped", "evidence": "skipped", "draft": "skipped", "review": "skipped"}
ANSWER_STEPS = {"triage": "ok", "evidence": "ok", "draft": "ok", "review": "ok"}


@dataclass
class Scenario:
    pipeline: object
    conversation: list[str]
    llm: ScriptedLLM
    evidence: ScriptedEvidence
    checks: Callable[["Run"], dict[str, bool]]
    client: httpx.AsyncClient | None = None


@dataclass
class Run:
    scenario: Scenario
    events: list[tuple[str, dict]]
    result: dict | None
    error: Exception | None
    handoff: dict | None

    @property
    def route(self) -> str:
        if self.error is not None:
            return f"error:{type(self.error).__name__}"
        return self.result["type"] if self.result else "none"


# ---------------------------------------------------------------- scenario helpers

def _scenario(triage, conversation, *, tools=None, extract=None, faults=None, evidence=None, references=None,
              safety=None, stream_text="A supported explanation [1].", client=None, checks=None) -> Scenario:
    llm = ScriptedLLM(default_script(triage, tools, safety, extract), stream_text=stream_text, faults=faults)
    evidence = evidence or ScriptedEvidence()
    pipeline = AgentPipeline(llm=llm, evidence=evidence, references=references)
    return Scenario(pipeline, conversation, llm, evidence, checks or (lambda run: {}), client)


def _label_row(generic: str, brand: str, set_id: str = SET_ID) -> dict:
    return {
        "set_id": set_id, "effective_time": "20250314",
        "openfda": {"generic_name": [generic], "brand_name": [brand], "dosage_form": ["TABLET"]},
        "boxed_warning": ["Synthetic boxed warning text."],
        "indications_and_usage": ["Synthetic indications text."],
    }


def _label_scenario(responder, *, circuit_open=False, checks=None) -> Scenario:
    client = mock_reference_client(responder)
    references = ReferenceTools(client=client)
    if circuit_open:
        for _ in range(references.circuits["label_sections"].threshold):
            references.circuits["label_sections"].failure()
    return _scenario(
        {"action": "answer"}, ["What does the official US label for metformin list under warnings?"],
        tools={"selected_tools": ["label_sections"]}, extract={"query": "metformin"},
        client=client, references=references, checks=checks,
    )


def _label_tool(run: Run) -> dict:
    return next((r for r in (run.result or {}).get("tool_results", []) if r.get("tool") == LABEL_TOOL), {})


def _handoff_reference(run: Run) -> dict:
    return next((r for r in (run.handoff or {}).get("references", []) if r["tool"] == LABEL_TOOL), {})


def _no_answer_published(run: Run) -> dict[str, bool]:
    return {"no_answer_text_published": not run.result.get("articles") and not any(e == "answer_chunk" for e, _ in run.events)}


# ---------------------------------------------------------------- scenario builders

def build_evidence_timeout() -> Scenario:
    return _scenario({"action": "answer"}, ["Explain eye pressure"], evidence=ScriptedEvidence(fault="timeout"),
                     checks=lambda run: {**_no_answer_published(run), "status_unavailable": run.result["evidence_status"] == "unavailable"})


def build_evidence_empty() -> Scenario:
    return _scenario({"action": "answer"}, ["Explain eye pressure"], evidence=ScriptedEvidence(fault="empty"),
                     checks=lambda run: {**_no_answer_published(run), "status_unavailable": run.result["evidence_status"] == "unavailable"})


def build_triage_malformed_json() -> Scenario:
    return _scenario({"action": "answer"}, ["What is hypertension?"], faults={"triage": "malformed_json"},
                     checks=lambda run: {"no_downstream_work": run.scenario.evidence.calls == 0 and len(run.scenario.llm.calls) == 1})


def build_review_timeout() -> Scenario:
    return _scenario({"action": "answer"}, ["What is hypertension?"], faults={"review": "timeout"})


def build_review_unsafe_twice() -> Scenario:
    return _scenario({"action": "answer"}, ["What is hypertension?"], faults={"review": "unsafe_twice"},
                     checks=lambda run: {"two_reviews_only": sum(1 for _, s in run.scenario.llm.calls if SAFETY_KEY in s) == 2})


def build_answer_over_budget() -> Scenario:
    return _scenario({"action": "answer"}, ["What is hypertension?"], faults={"draft": "over_budget"},
                     checks=lambda run: {"review_never_ran": not any(SAFETY_KEY in s for _, s in run.scenario.llm.calls)})


def build_reference_5xx() -> Scenario:
    def checks(run: Run) -> dict[str, bool]:
        tool, reference = _label_tool(run), _handoff_reference(run)
        return {
            "tool_unavailable": tool.get("status") == "unavailable" and reference.get("status") == "unavailable",
            "not_a_clinical_negative": LIMITATION_UNREACHABLE.format(tool=LABEL_TOOL) in run.handoff["limitations"],
            "provider_was_called": len(run.scenario.client.requests) >= 1,
            "sources_still_present": bool(run.result["articles"]),
        }
    return _label_scenario(lambda request: httpx.Response(503, json={"error": "unavailable"}), checks=checks)


def build_reference_circuit_open() -> Scenario:
    def checks(run: Run) -> dict[str, bool]:
        return {
            "zero_http_requests": len(run.scenario.client.requests) == 0,
            "tool_unavailable": _label_tool(run).get("status") == "unavailable",
            "sources_still_present": bool(run.result["articles"]),
        }
    return _label_scenario(lambda request: httpx.Response(200, json={"results": []}), circuit_open=True, checks=checks)


def build_source_excerpt_injection() -> Scenario:
    def checks(run: Run) -> dict[str, bool]:
        llm = run.scenario.llm
        in_system = any(INJECTION_TEXT in system for _, system in llm.calls)
        user_blocks = [user for user, _ in llm.calls if INJECTION_TEXT in user]
        return {
            "delivered_to_user_block": bool(user_blocks),
            "never_in_system_prompt": not in_system,
            "never_in_answer": INJECTION_TEXT not in (run.result.get("answer") or ""),
            "never_in_handoff": "CANARY-7QX" not in json.dumps(run.handoff),
            "answer_cites_only_retrieved": all(1 <= n <= len(run.result["articles"]) for n in citation_indices(run.result["answer"])),
        }
    return _scenario({"action": "answer"}, ["What is hypertension?"], evidence=ScriptedEvidence(fault="injection"), checks=checks)


def build_clarification_limit() -> Scenario:
    conversation = ["I have a headache", f"{CLARIFICATION_INTRO} How long has it lasted?", "About three days"]
    return _scenario({"action": "ask", "follow_up_questions": ["Any other symptoms?"]}, conversation,
                     checks=lambda run: {"no_second_round": run.result["type"] != "follow_up" and not run.result["follow_up_questions"],
                                         "limitation_stated": any("one round of clarifying questions" in line for line in run.handoff["limitations"])})


def build_label_combination_only() -> Scenario:
    def responder(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [_label_row("SITAGLIPTIN AND METFORMIN HYDROCHLORIDE", "SYNTHETIC COMBO")]})

    def checks(run: Run) -> dict[str, bool]:
        tool = _label_tool(run)
        return {
            "tool_empty_combination_only": tool.get("status") == "empty" and tool.get("combination_only") is True and tool.get("items") == [],
            "limitation_stated": LIMITATION_COMBINATION in run.handoff["limitations"],
            "no_label_excerpts_as_sources": not any(s["kind"] == "label_section" for s in run.handoff["sources"]),
            "single_request": len(run.scenario.client.requests) == 1,
        }
    return _label_scenario(responder, checks=checks)


def build_tool_input_missing() -> Scenario:
    def checks(run: Run) -> dict[str, bool]:
        calc = (run.handoff["calculations"] or [{}])[0]
        return {
            "no_value_computed": bool(calc.get("error")) and calc.get("result") == "",
            "missing_input_named": calc.get("missing_inputs") == ["height_cm"],
            "limitation_stated": any("no value was computed" in line for line in run.handoff["limitations"]),
        }
    return _scenario({"action": "answer"}, ["Calculate my BMI. I am 35 and weigh 70 kg but am not sure of my height."],
                     tools={"selected_tools": ["bmi"]},
                     extract={"weight_kg": 70, "age_years": 35}, checks=checks)


def build_emergency() -> Scenario:
    def checks(run: Run) -> dict[str, bool]:
        prompts = run.scenario.llm.calls
        result = run.result
        return {
            "only_triage_called_model": len(prompts) == 1 and TRIAGE_KEY in prompts[0][1],
            "no_tool_selection_or_extraction": not any(TOOLS_KEY in s or EXTRACT_KEY in s for _, s in prompts),
            "no_evidence_call": run.scenario.evidence.calls == 0,
            "no_tools_sources_or_answer_stream": not result["tool_results"] and not result["articles"] and not run.scenario.llm.streams,
            "emergency_flag": result["emergency"] is True,
        }
    return _scenario({"action": "emergency"}, ["I have crushing chest pressure and trouble breathing right now."], checks=checks)


def _case(id, description, build, route, reason, urgency, trace, behavior) -> dict:
    return {"id": id, "description": description, "build": build,
            "expected": {"route": route, "reason": reason, "urgency": urgency, "leak": False, "trace": trace, "behavior": behavior}}


FAULT_CASES: list[dict] = [
    _case("evidence_timeout", "The evidence provider raises a timeout.", build_evidence_timeout,
          "answer", "evidence_unavailable", "routine",
          {**ANSWER_STEPS, "tools": "skipped", "evidence": "failed:error", "draft": "skipped", "review": "skipped"},
          "Fixed evidence-unavailable reply with status `unavailable`; no model-written answer, no sources."),
    _case("evidence_empty", "The evidence provider returns no articles.", build_evidence_empty,
          "answer", "evidence_unavailable", "routine",
          {**ANSWER_STEPS, "tools": "skipped", "evidence": "failed:empty", "draft": "skipped", "review": "skipped"},
          "Same fixed reply as a timeout; the absence of sources is stated, not hidden."),
    _case("triage_malformed_json", "The triage model returns text that is not JSON.", build_triage_malformed_json,
          "error:ReviewUnavailable", "review_unavailable", "unknown",
          {"triage": "failed:invalid_json", "tools": "skipped", "evidence": "skipped", "draft": "skipped", "review": "skipped"},
          "Fails closed with urgency `unknown`; no retrieval, tools, or answer after a failed emergency screen."),
    _case("review_timeout", "The safety review call times out.", build_review_timeout,
          "error:ReviewUnavailable", "review_unavailable", "routine",
          {**ANSWER_STEPS, "tools": "skipped", "review": "failed:attempts=2"},
          "The drafted answer is discarded; no `answer_chunk` or `result` event is sent."),
    _case("review_unsafe_twice", "The reviewer marks the draft unsafe, then marks its revision unsafe.", build_review_unsafe_twice,
          "error:ReviewUnavailable", "review_unavailable", "routine",
          {**ANSWER_STEPS, "tools": "skipped", "review": "failed:attempts=2"},
          "Exactly one revision is allowed; a second unsafe verdict discards the answer."),
    _case("answer_over_budget", "The drafting stream exceeds `max_answer_chars` by one character.", build_answer_over_budget,
          "error:ReviewUnavailable", "review_unavailable", "routine",
          {**ANSWER_STEPS, "tools": "skipped", "draft": "failed:over_budget", "review": "skipped"},
          "The stream is cut off and discarded before review; nothing is published."),
    _case("reference_5xx", "The openFDA label service returns HTTP 503.", build_reference_5xx,
          "answer", "answer_available", "routine",
          {**ANSWER_STEPS, "tools": "fallback:partial"},
          "The reviewed answer is still sent from the evidence provider; the tool is `unavailable` and the handoff says it is not a clinical negative."),
    _case("reference_circuit_open", "The label tool's circuit breaker is already open after three failures.", build_reference_circuit_open,
          "answer", "answer_available", "routine",
          {**ANSWER_STEPS, "tools": "fallback:partial"},
          "Zero HTTP requests are made; the tool is `unavailable` and the reviewed answer is still sent."),
    _case("source_excerpt_injection", "A source excerpt contains instruction-injection text.", build_source_excerpt_injection,
          "answer", "answer_available", "routine", ANSWER_STEPS,
          "The text reaches the model only inside a user-role evidence block; it is absent from every system prompt, the answer, and the handoff."),
    _case("clarification_limit", "The conversation already holds one clarification round and triage asks again.", build_clarification_limit,
          "answer", "clarification_limit", "routine", {**ANSWER_STEPS, "tools": "skipped"},
          "No second round of questions; the answer is produced and the handoff states the gap."),
    _case("label_combination_only", "openFDA returns only combination-product labels for the named medicine.", build_label_combination_only,
          "answer", "answer_available", "routine", {**ANSWER_STEPS, "tools": "fallback:partial"},
          "Label tool is `empty` with `combination_only`; no label excerpt becomes a source, and the handoff says why."),
    _case("tool_input_missing", "The BMI calculator is selected but the height was never supplied.", build_tool_input_missing,
          "answer", "tool_input_missing", "routine", {**ANSWER_STEPS, "tools": "fallback:partial"},
          "The calculator reports the missing input and no value; the handoff states that no value was computed."),
    _case("emergency", "Triage classifies the message as an emergency.", build_emergency,
          "emergency", "emergency", "emergency", EMERGENCY_STEPS,
          "Fixed urgent guidance; no tool selection, no evidence call, no drafting."),
]


# ---------------------------------------------------------------- runner

def _trace_matches(observed: list[dict], expected: dict[str, str]) -> bool:
    by_name = {step["name"]: step for step in observed}
    for name, want in expected.items():
        status, _, detail = want.partition(":")
        step = by_name.get(name)
        if step is None or step["status"] != status or (detail and step["detail"] != detail):
            return False
    return True


def _trace_text(steps: list[dict]) -> str:
    return " · ".join(f"{s['name']} {s['status']}" + (f" ({s['detail']})" if s["detail"] else "") for s in steps)


def _leaks(run: Run, expected_error: bool) -> bool:
    published = [event for event, _ in run.events if event in {"result", "answer_chunk"}]
    if expected_error and published:
        return True
    result = run.result
    if result and result.get("type") == "answer" and result.get("answer"):
        count = len(result.get("articles", []))
        return any(not 1 <= n <= count for n in citation_indices(result["answer"]))
    return False


async def _run_case(case: dict, timeout: float = 30.0) -> dict:
    cache_scope.set(str(uuid.uuid4()))
    scenario = case["build"]()
    events: list[tuple[str, dict]] = []
    result = error = None
    start = time.monotonic()

    async def drive():
        nonlocal result
        async for event, data in scenario.pipeline.run_streaming(scenario.conversation, str(uuid.uuid4())):
            events.append((event, data))
            if event == "result":
                result = data

    try:
        await asyncio.wait_for(drive(), timeout)
    except Exception as exc:  # the observed route is the exception name
        error = exc
    elapsed_ms = int((time.monotonic() - start) * 1000)
    try:
        handoff = getattr(error, "handoff", None) if error is not None else (result or {}).get("handoff")
        run = Run(scenario, events, result, error, handoff)
        expected = case["expected"]
        leak = _leaks(run, expected["route"].startswith("error:"))
        checks = {"route": run.route == expected["route"]}
        try:
            Handoff(**handoff)
            checks["handoff_valid"] = True
        except Exception:
            checks["handoff_valid"] = False
        if checks["handoff_valid"]:
            checks["reason"] = handoff["reason"] == expected["reason"]
            checks["urgency"] = handoff["urgency"] == expected["urgency"]
            checks["trace"] = _trace_matches(handoff["trace"]["steps"], expected["trace"])
            try:
                checks.update(scenario.checks(run))
            except Exception:
                checks["scenario_checks"] = False
        checks["no_leak"] = not leak
        return {
            "id": case["id"], "description": case["description"], "expected": expected,
            "route": run.route, "reason": handoff["reason"] if handoff else None,
            "urgency": handoff["urgency"] if handoff else None, "leak": leak,
            "trace": [{k: s[k] for k in ("name", "status", "detail")} for s in handoff["trace"]["steps"]] if handoff else [],
            "checks": checks, "passed": all(checks.values()), "elapsed_ms": elapsed_ms,
        }
    finally:
        await scenario.pipeline.aclose()
        if scenario.client is not None:
            await scenario.client.aclose()


def _forbid_live_http():
    """Make any request that is not served by a mock transport fail loudly."""
    async def blocked(self, request):
        raise AssertionError("Live network requests are forbidden in failure runs")

    original = httpx.AsyncHTTPTransport.handle_async_request
    httpx.AsyncHTTPTransport.handle_async_request = blocked
    return lambda: setattr(httpx.AsyncHTTPTransport, "handle_async_request", original)


async def run_all_async() -> list[dict]:
    # Settings validation needs non-empty keys; the doubles never use them.
    os.environ.setdefault("CEREBRAS_API_KEY", "offline-fault-run")
    os.environ.setdefault("MEDISEARCH_API_KEY", "offline-fault-run")
    restore = _forbid_live_http()
    try:
        return [await _run_case(case) for case in FAULT_CASES]
    finally:
        restore()


def run_all() -> list[dict]:
    return asyncio.run(run_all_async())


def render_markdown(records: list[dict]) -> str:
    passed = sum(1 for r in records if r["passed"])
    lines = [
        "# Failure modes",
        "",
        f"<!-- Generated by `{REGENERATE}`. Do not edit by hand; tests/test_failures.py fails if this file drifts. -->",
        "",
        "Each row injects one synthetic fault into the real pipeline with offline doubles (a scripted model, a scripted evidence provider,",
        "and a mock HTTP transport for the reference tools), then checks the route, the handoff reason, the trace, and that no unreviewed",
        "answer text reached the browser. These are behavior checks, not clinical validation, and they use no patient text.",
        f"Regenerate with `{REGENERATE}`. Timings are printed by the command and left out of this file so it stays byte-stable.",
        "",
        f"Result: {passed} of {len(records)} cases pass.",
        "",
        "| Case | Fault | Expected behavior | Observed route / reason / trace | Result |",
        "| --- | --- | --- | --- | --- |",
    ]
    for r in records:
        expected = r["expected"]
        want = f"`{expected['route']}` / `{expected['reason']}`. {expected['behavior']}"
        observed = f"`{r['route']}` / `{r['reason']}` / urgency `{r['urgency']}`; {_trace_text(r['trace'])}; leak: {'yes' if r['leak'] else 'no'}"
        lines.append(f"| `{r['id']}` | {r['description']} | {want} | {observed} | {'pass' if r['passed'] else 'FAIL'} |")
    failed = [f"`{r['id']}`: {', '.join(k for k, v in r['checks'].items() if not v)}" for r in records if not r["passed"]]
    if failed:
        lines += ["", "Failed checks: " + "; ".join(failed)]
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the offline failure-injection cases.")
    parser.add_argument("--out", type=Path, help="write the markdown report here, e.g. docs/FAILURE_MODES.md")
    parser.add_argument("--json", type=Path, help="write the full records, including timings, here")
    args = parser.parse_args()
    records = run_all()
    for r in records:
        print(f"{r['id']}: {'pass' if r['passed'] else 'fail'} ({r['route']}, {r['reason']}, {r['elapsed_ms']} ms)")
        for name, ok in r["checks"].items():
            if not ok:
                print(f"  failed check: {name}")
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(render_markdown(records), encoding="utf-8")
        print(args.out)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(records, indent=2), encoding="utf-8")
        print(args.json)
    if not all(r["passed"] for r in records):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
