"""Offline failure-injection runner for the answer pipeline.

Each case injects one synthetic fault with the doubles in `evals.doubles`, runs the real
`AgentPipeline`, and checks the route, the handoff reason, the trace, and that nothing
unreviewed reached the browser. These are behavior checks, not clinical validation.

    uv run python -m evals.failures --out docs/FAILURE_MODES.md [--json report.json]
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.handoff import LIMITATION_COMBINATION, LIMITATION_EMPTY, LIMITATION_UNREACHABLE, citation_indices
from app.pipeline import CLARIFICATION_INTRO, AgentPipeline, cache_scope
from app.schemas import Handoff
from app.tools import forms, growth
from app.tools.clinical import STEADI_ITEMS, TOOL_REGISTRY
from app.tools.forms import run_form_tool
from app.tools.references import RXNORM_RATE_LIMIT_ERROR, ReferenceTools
from evals.doubles import (
    EXTRACT_KEY, INJECTION_TEXT, SAFETY_KEY, TOOLS_KEY, TRIAGE_KEY,
    ScriptedEvidence, ScriptedLLM, default_script, mock_reference_client,
)

REGENERATE = "uv run python -m evals.failures --out docs/FAILURE_MODES.md"
LABEL_TOOL = "FDA label sections"
RXNORM_TOOL = "RxNorm ingredients"
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
    cleanup: Callable[[], None] | None = None  # undoes a monkeypatch made by the builder


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
              safety=None, stream_text="A supported explanation [1].", client=None, checks=None,
              cleanup=None) -> Scenario:
    llm = ScriptedLLM(default_script(triage, tools, safety, extract), stream_text=stream_text, faults=faults)
    evidence = evidence or ScriptedEvidence()
    pipeline = AgentPipeline(llm=llm, evidence=evidence, references=references)
    return Scenario(pipeline, conversation, llm, evidence, checks or (lambda run: {}), client, cleanup)


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


def _rxnorm_scenario(responder, checks) -> Scenario:
    client = mock_reference_client(responder)
    return _scenario(
        {"action": "answer"}, ["What active ingredient is in Tylenol?"],
        tools={"selected_tools": ["rxnorm_ingredients"]}, extract={"query": "Tylenol"},
        client=client, references=ReferenceTools(client=client), checks=checks,
    )


def _rxnorm_tool(run: Run) -> dict:
    return next((r for r in (run.result or {}).get("tool_results", []) if r.get("tool") == RXNORM_TOOL), {})


def _rxnorm_unavailable_checks(run: Run) -> dict[str, bool]:
    tool = _rxnorm_tool(run)
    reference = next((r for r in run.handoff["references"] if r["tool"] == RXNORM_TOOL), {})
    return {
        "tool_unavailable": tool.get("status") == "unavailable" and tool.get("items") == [] and reference.get("status") == "unavailable",
        "not_a_clinical_negative": LIMITATION_UNREACHABLE.format(tool=RXNORM_TOOL) in run.handoff["limitations"],
        "ingredients_never_become_sources": not any(a.get("title") == "acetaminophen" for a in run.result["articles"]),
        "sources_still_present": bool(run.result["articles"]),
    }


def build_rxnorm_timeout() -> Scenario:
    def responder(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("synthetic read timeout", request=request)

    def checks(run: Run) -> dict[str, bool]:
        return {**_rxnorm_unavailable_checks(run), "match_lookup_only": [r.url.path for r in run.scenario.client.requests] == ["/REST/rxcui.json"]}
    return _rxnorm_scenario(responder, checks)


def build_rxnorm_429() -> Scenario:
    def checks(run: Run) -> dict[str, bool]:
        return {
            **_rxnorm_unavailable_checks(run),
            "rate_limit_message": _rxnorm_tool(run).get("error") == RXNORM_RATE_LIMIT_ERROR,
            "circuit_failure_counted": run.scenario.pipeline.references.circuits["rxnorm_ingredients"].failures == 1,
            "single_request": len(run.scenario.client.requests) == 1,
        }
    return _rxnorm_scenario(lambda request: httpx.Response(429, json={}), checks)


def build_rxnorm_malformed() -> Scenario:
    def responder(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/rxcui.json"):
            return httpx.Response(200, json={"idGroup": {"rxnormId": ["abc"]}})
        return httpx.Response(500, json={})

    def checks(run: Run) -> dict[str, bool]:
        tool = _rxnorm_tool(run)
        return {
            "tool_empty": tool.get("status") == "empty" and tool.get("items") == [],
            "limitation_stated": LIMITATION_EMPTY.format(tool=RXNORM_TOOL) in run.handoff["limitations"],
            "invalid_rxcui_makes_no_second_request": len(run.scenario.client.requests) == 1,
            "circuit_not_charged": run.scenario.pipeline.references.circuits["rxnorm_ingredients"].failures == 0,
            "sources_still_present": bool(run.result["articles"]),
        }
    return _rxnorm_scenario(responder, checks)


def _calc_without_values(run: Run, forbidden: tuple[str, ...]) -> dict[str, bool]:
    tool = next((r for r in run.result["tool_results"] if "items" not in r), {})
    calc = (run.handoff["calculations"] or [{}])[0]
    return {
        "error_and_no_value_fields": bool(tool.get("error")) and not any(field in tool for field in forbidden),
        "handoff_calculation_has_no_result": bool(calc.get("error")) and calc.get("result") == "",
        "limitation_stated": any("no value was computed" in line for line in run.handoff["limitations"]),
    }


def build_growth_table_missing() -> Scenario:
    original = growth.load_tables

    def missing():
        raise growth.GrowthTablesError("synthetic missing table")

    growth.load_tables = missing

    def checks(run: Run) -> dict[str, bool]:
        tool = next((r for r in run.result["tool_results"] if "items" not in r), {})
        return {
            **_calc_without_values(run, ("value", "z", "percentile", "percentile_text", "curve", "point")),
            "unavailable_message": tool.get("error") == growth.UNAVAILABLE,
        }
    return _scenario({"action": "answer"}, ["What percentile is my 6 month old son's weight of 7.5 kg?"],
                     tools={"selected_tools": ["growth_percentile"]},
                     extract={"sex": "male", "age_months": 6, "measure": "weight", "value": 7.5}, checks=checks,
                     cleanup=lambda: setattr(growth, "load_tables", original))


def build_dose_out_of_range() -> Scenario:
    def checks(run: Run) -> dict[str, bool]:
        tool = next((r for r in run.result["tool_results"] if "items" not in r), {})
        return {
            **_calc_without_values(run, ("amount_ml", "amount_mg", "summary", "syringe", "band_low_lb", "interval_hours_low")),
            "under_three_months_stop": tool.get("hard_stop", {}).get("title") == "Baby under 3 months" and tool.get("hard_stop", {}).get("urgent") is True,
            "same_day_call_wording": "same-day call" in (tool.get("error") or ""),
        }
    return _scenario({"action": "answer"}, ["How much children's acetaminophen can my 2 month old have? She weighs 5 kg and the bottle says 160 mg/5 mL."],
                     tools={"selected_tools": ["child_dose_check"]},
                     extract={"medicine": "acetaminophen", "concentration": "160mg/5mL", "weight": 5, "weight_units": "kg", "age_months": 2},
                     checks=checks)


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
    _case("rxnorm_timeout", "The RxNorm match request raises a read timeout.", build_rxnorm_timeout,
          "answer", "answer_available", "routine", {**ANSWER_STEPS, "tools": "fallback:partial"},
          "The reviewed answer is still sent from the evidence provider; the tool is `unavailable` and the handoff says it is not a clinical negative."),
    _case("rxnorm_429", "The RxNorm service answers HTTP 429 (rate limit).", build_rxnorm_429,
          "answer", "answer_available", "routine", {**ANSWER_STEPS, "tools": "fallback:partial"},
          "Same as a timeout with the rate-limit message; the failure is counted by the circuit breaker and no retry is made."),
    _case("rxnorm_malformed", "The RxNorm match response holds an invalid RxCUI.", build_rxnorm_malformed,
          "answer", "answer_available", "routine", {**ANSWER_STEPS, "tools": "ok:selected=1"},
          "The identifier is rejected before any second request; the tool is `empty` and the handoff says that is not evidence of safety."),
    _case("growth_table_missing", "The bundled growth reference tables cannot be loaded.", build_growth_table_missing,
          "answer", "tool_input_missing", "routine", {**ANSWER_STEPS, "tools": "fallback:partial"},
          "The percentile tool returns its unavailable message and no number or curve; the handoff states that no value was computed."),
    _case("dose_out_of_range", "The dose checker receives a 2-month-old for acetaminophen.", build_dose_out_of_range,
          "answer", "tool_input_missing", "routine", {**ANSWER_STEPS, "tools": "fallback:partial"},
          "The tool returns the under-3-months hard stop (same-day call) and no mL, mg, or band fields; the handoff states that no value was computed."),
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


# ---------------------------------------------------------------- tool failure modes

RXNORM_IDS = {"tylenol": ("202433", "acetaminophen", "161"), "acetaminophen": ("161", "acetaminophen", "161"),
              "lisinopril": ("29046", "lisinopril", "29046"), "metformin": ("6809", "metformin", "6809")}
RXNORM_TIMEOUT_MEDICINE = "Slowmed"


def _rxnorm_responder(request: httpx.Request) -> httpx.Response:
    """A synthetic RxNorm: names resolve to an RxCUI, then to one ingredient concept."""
    if request.url.path.endswith("/rxcui.json"):
        known = RXNORM_IDS.get(request.url.params.get("name", "").casefold())
        return httpx.Response(200, json={"idGroup": {"rxnormId": [known[0]] if known else []}})
    rxcui = request.url.path.split("/")[-2]
    for identifier, name, ingredient in RXNORM_IDS.values():
        if identifier == rxcui:
            return httpx.Response(200, json={"relatedGroup": {"conceptGroup": [
                {"tty": "IN", "conceptProperties": [{"rxcui": ingredient, "name": name, "tty": "IN"}]}]}})
    return httpx.Response(200, json={"relatedGroup": {"conceptGroup": []}})


def _entry(name, directions, strength=""):
    return {"name": name, "strength": strength, "directions": directions}


async def _with_references(client, inputs):
    references = ReferenceTools(client=client)
    try:
        return await run_form_tool("medication_schedule", inputs, references)
    finally:
        await client.aclose()


async def run_schedule_duplicate_brand_generic() -> tuple[dict[str, bool], str]:
    client = mock_reference_client(_rxnorm_responder)
    result = await _with_references(client, {"medicines": [
        _entry("Tylenol", "twice_daily"), _entry("acetaminophen", "as_needed", "500 mg"), _entry("Lisinopril", "once_daily_morning")]})
    duplicates = result.get("duplicates", [])
    checks = {
        "one_duplicate_naming_both": len(duplicates) == 1 and duplicates[0]["ingredient"] == "acetaminophen"
        and duplicates[0]["medicines"] == ["Tylenol", "acetaminophen"],
        "not_an_interaction_check_line": result.get("duplicates_note") == forms.DUPLICATES_NOTE and "not an interaction check" in result.get("duplicates_note", ""),
        "limitation_says_no_interaction_check": forms.NOT_INTERACTION_CHECK in result.get("limitations", []),
        "every_row_normalised": result.get("status") == "available" and all(r["normalisation"]["status"] == "matched" for r in result.get("grid", [])),
        "three_rows": len(result.get("grid", [])) == 3,
    }
    return checks, f"status `{result.get('status')}`; duplicates {[(d['ingredient'], d['medicines']) for d in duplicates]}; {len(client.requests)} RxNorm requests"


async def run_schedule_rxnorm_unavailable() -> tuple[dict[str, bool], str]:
    client = mock_reference_client(lambda request: httpx.Response(503, json={"error": "unavailable"}))
    result = await _with_references(client, {"medicines": [
        _entry("Tylenol", "twice_daily"), _entry("tylenol", "as_needed"), _entry("acetaminophen", "as_needed"), _entry("Metformin", "with_meals")]})
    grid, duplicates = result.get("grid", []), result.get("duplicates", [])
    checks = {
        "status_unavailable": result.get("status") == "unavailable",
        "every_row_still_listed": [r["name"] for r in grid] == ["Tylenol", "tylenol", "acetaminophen", "Metformin"]
        and all(r["wording"] and r["normalisation"]["status"] == "unavailable" for r in grid),
        "duplicates_from_exact_names_only": [(d["ingredient"], d["medicines"]) for d in duplicates] == [("Tylenol", ["Tylenol", "tylenol"])],
        "brand_and_generic_not_linked_without_rxnorm": not any("acetaminophen" in d["medicines"] for d in duplicates),
        "each_name_listed_as_not_normalised": all(forms.LIMITATION_NOT_NORMALISED.format(name=n) in result.get("limitations", [])
                                                    for n in ("Tylenol", "tylenol", "acetaminophen", "Metformin")),
        "provider_was_called": len(client.requests) >= 1,
    }
    return checks, f"status `{result.get('status')}`; {len(grid)} rows kept; duplicates {[(d['ingredient'], d['medicines']) for d in duplicates]}"


async def run_schedule_batch_timeout() -> tuple[dict[str, bool], str]:
    declared_budget = forms.LOOKUP_TIMEOUT_SECONDS
    patched_budget = 0.2  # keeps the suite fast; the production budget is asserted below

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("name") == RXNORM_TIMEOUT_MEDICINE:
            await asyncio.sleep(declared_budget * 4)  # far past the budget; cancelled by the batch timeout
        return _rxnorm_responder(request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=8, follow_redirects=False)
    forms.LOOKUP_TIMEOUT_SECONDS = patched_budget
    start = time.monotonic()
    try:
        result = await _with_references(client, {"medicines": [_entry("Tylenol", "twice_daily"), _entry(RXNORM_TIMEOUT_MEDICINE, "once_daily_morning")]})
    finally:
        forms.LOOKUP_TIMEOUT_SECONDS = declared_budget
    elapsed = time.monotonic() - start
    statuses = {r["name"]: r["normalisation"]["status"] for r in result.get("grid", [])}
    checks = {
        "production_budget_is_eight_seconds": declared_budget == 8,
        "elapsed_under_nine_seconds": elapsed < 9,
        "elapsed_near_patched_budget": elapsed < patched_budget + 1,
        "partial_status": result.get("status") == "partial",
        "finished_lookup_kept": statuses.get("Tylenol") == "matched",
        "timed_out_lookup_unavailable": statuses.get(RXNORM_TIMEOUT_MEDICINE) == "unavailable",
        "every_row_still_listed": len(result.get("grid", [])) == 2,
    }
    return checks, f"status `{result.get('status')}`; lookups {statuses}; batch budget patched down from {declared_budget} s for speed"


STEADI_KEYS = [key for key, _, _ in STEADI_ITEMS]
STEADI_ONE_POINT = ["steadies_on_furniture", "pushes_with_hands_to_stand", "rushes_to_toilet", "lost_feeling_in_feet"]


def _steadi(yes: list[str], omit: str | None = None) -> dict:
    return TOOL_REGISTRY["steadi_fall_risk"]["function"]({key: key in yes for key in STEADI_KEYS if key != omit})


async def run_steadi_boundary() -> tuple[dict[str, bool], str]:
    three = _steadi(STEADI_ONE_POINT[:3])
    fall_cane = _steadi(["fallen_past_year", "uses_or_advised_cane_walker"])
    four = _steadi(STEADI_ONE_POINT)
    missing = _steadi(STEADI_ONE_POINT, omit="rushes_to_toilet")
    checks = {
        "three_one_point_items_not_at_risk": three.get("score") == 3 and three.get("at_risk") is False,
        "fall_plus_cane_at_risk": fall_cane.get("score") == 4 and fall_cane.get("at_risk") is True,
        "four_one_point_items_at_risk": four.get("score") == 4 and four.get("at_risk") is True,
        "one_missing_item_named": missing.get("missing_inputs") == ["rushes_to_toilet"],
        "no_score_without_every_item": not any(field in missing for field in ("score", "at_risk", "items", "recommendation")),
    }
    return checks, f"3 points: at_risk {three.get('at_risk')}; fall + cane: {fall_cane.get('score')} at_risk {fall_cane.get('at_risk')}; one item missing: missing_inputs {missing.get('missing_inputs')}"


def _bp_readings(extra=()):
    days = [f"2026-10-{day:02d}" for day in range(12, 19)]
    normal = [{"date": day, "time": time_, "systolic": 118, "diastolic": 76, "pulse": 64, "position": "sitting"}
              for day in days for time_ in ("07:30", "19:30")]
    return normal + list(extra)


async def run_bp_alert_first() -> tuple[dict[str, bool], str]:
    spike = {"date": "2026-10-18", "time": "08:00", "systolic": 185, "diastolic": 95, "pulse": 80, "position": "sitting"}
    result = await run_form_tool("bp_log_summary", {"readings": _bp_readings([spike])})
    keys = list(result)
    standing_only = await run_form_tool("bp_log_summary", {"readings": [{**spike, "systolic": 190, "diastolic": 100, "position": "standing"}]})
    alerts = result.get("alerts", [])
    checks = {
        "alert_is_the_fixed_aha_line": bool(alerts) and alerts[0] == {"level": "emergency", "text": forms.BP_ALERT},
        "alert_precedes_averages": "alerts" in keys and "averages" in keys and keys.index("alerts") < keys.index("averages") < keys.index("summary"),
        "averages_still_computed": result.get("reading_count") == 15 and result.get("averages", {}).get("all") is not None,
        "no_alert_without_a_high_reading": (await run_form_tool("bp_log_summary", {"readings": _bp_readings()})).get("alerts") == [],
        "alert_survives_a_no_average_error": bool(standing_only.get("error")) and standing_only.get("alerts", [{}])[0].get("text") == forms.BP_ALERT
        and "averages" not in standing_only,
    }
    return checks, f"alerts {len(alerts)} listed before averages; {result.get('reading_count')} seated readings; summary `{result.get('summary')}`"


class _CountingReferences:
    """Stands in for the pipeline's reference client; any call means a tool ran."""
    def __init__(self):
        self.calls = 0

    async def run(self, key, variables):
        self.calls += 1
        return {"status": "empty", "items": []}


def _tools_endpoint_probe() -> tuple[dict[str, bool], str]:
    from fastapi.testclient import TestClient

    import app.api.routes as routes
    from app.main import create_app

    executed: list[str] = []
    originals = {key: info["function"] for key, info in TOOL_REGISTRY.items()}
    form_original = routes.run_form_tool
    references = _CountingReferences()
    try:
        for key, info in TOOL_REGISTRY.items():
            info["function"] = (lambda data, _key=key: (executed.append(_key), originals[_key](data))[1])

        async def counted_form(key, inputs, refs=None):
            executed.append(key)
            return await form_original(key, inputs, refs)
        routes.run_form_tool = counted_form
        with TestClient(create_app()) as client:
            client.app.state.pipeline.references = references
            unknown = {key: client.post(f"/api/tools/{key}", json={"inputs": {"query": "aspirin"}})
                       for key in ("label_sections", "drug_labels", "pubmed_search", "rxnorm_ingredients", "no_such_tool")}
            listed = {tool["key"] for tool in client.get("/api/tools").json()["tools"]}
            before = len(executed)
            control = client.post("/api/tools/bmi", json={"inputs": {"weight_kg": 70, "height_cm": 175, "age_years": 30}})
    finally:
        routes.run_form_tool = form_original
        for key, function in originals.items():
            TOOL_REGISTRY[key]["function"] = function
    checks = {
        "every_reference_key_is_404": all(r.status_code == 404 and r.json() == {"detail": "Unknown tool."} for r in unknown.values()),
        "no_tool_executed_for_them": before == 0 and references.calls == 0,
        "reference_keys_not_listed": not listed & {"label_sections", "drug_labels", "pubmed_search", "rxnorm_ingredients"},
        "control_call_is_counted": control.status_code == 200 and executed == ["bmi"],
    }
    return checks, f"statuses {sorted({r.status_code for r in unknown.values()})} for 5 unknown or reference-only keys; {before} executions; control `bmi` ran once"


async def run_tools_endpoint_unknown_key() -> tuple[dict[str, bool], str]:
    return await asyncio.to_thread(_tools_endpoint_probe)


def _tool_case(id, description, run, expected) -> dict:
    return {"id": id, "description": description, "run": run, "expected": expected}


TOOL_CASES: list[dict] = [
    _tool_case("schedule_duplicate_brand_generic", "RxNorm maps \"Tylenol\" and \"acetaminophen\" to the same ingredient RxCUI.",
               run_schedule_duplicate_brand_generic,
               "`duplicates` holds one entry naming both medicines, the not-an-interaction-check line is present, and the unrelated medicine is not flagged."),
    _tool_case("schedule_rxnorm_unavailable", "The RxNorm service answers HTTP 503 to every request.", run_schedule_rxnorm_unavailable,
               "Status `unavailable`; every grid row is still returned; duplicates come from exact typed names only, so a brand and its generic are not linked."),
    _tool_case("schedule_batch_timeout", "One RxNorm lookup sleeps past the batch budget.", run_schedule_batch_timeout,
               "Status `partial` with no exception; the finished lookup is kept, the slow one is `unavailable`, and the batch ends inside the 8 s production budget (patched down here to keep the suite fast)."),
    _tool_case("steadi_boundary", "STEADI answers sit on either side of the score-4 line, and one item is missing.", run_steadi_boundary,
               "Three 1-point items score 3 and are not at risk; fall plus cane scores 4 and is at risk; one missing item returns `missing_inputs` and no score."),
    _tool_case("bp_alert_first", "One home reading of 185/95 sits among normal readings.", run_bp_alert_first,
               "`alerts[0]` is the fixed AHA line and precedes the averages in the result; it also survives an error result."),
    _tool_case("tools_endpoint_unknown_key", "`POST /api/tools/label_sections` and the other reference-only keys.", run_tools_endpoint_unknown_key,
               "HTTP 404 `Unknown tool.` with no calculator, form tool, or reference lookup executed; reference keys are absent from `GET /api/tools`."),
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
        if scenario.cleanup is not None:
            scenario.cleanup()
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


async def _run_tool_case(case: dict, timeout: float = 30.0) -> dict:
    start = time.monotonic()
    try:
        checks, observed = await asyncio.wait_for(case["run"](), timeout)
    except Exception as exc:  # an unexpected exception is a failed case, named by type only
        checks, observed = {"completed": False}, f"raised {type(exc).__name__}"
    return {"id": case["id"], "description": case["description"], "expected": case["expected"], "observed": observed,
            "checks": checks, "passed": all(checks.values()), "elapsed_ms": int((time.monotonic() - start) * 1000)}


@contextlib.contextmanager
def _offline():
    # Settings validation needs non-empty keys; the doubles never use them.
    os.environ.setdefault("CEREBRAS_API_KEY", "offline-fault-run")
    os.environ.setdefault("MEDISEARCH_API_KEY", "offline-fault-run")
    restore = _forbid_live_http()
    try:
        yield
    finally:
        restore()


async def run_all_async() -> list[dict]:
    with _offline():
        return [await _run_case(case) for case in FAULT_CASES]


async def run_tool_cases_async() -> list[dict]:
    with _offline():
        return [await _run_tool_case(case) for case in TOOL_CASES]


def run_all() -> list[dict]:
    return asyncio.run(run_all_async())


def run_tool_cases() -> list[dict]:
    return asyncio.run(run_tool_cases_async())


def render_markdown(records: list[dict], tool_records: list[dict] | None = None) -> str:
    tool_records = tool_records or []
    passed = sum(1 for r in records if r["passed"])
    lines = [
        "# Failure modes",
        "",
        f"<!-- Generated by `{REGENERATE}`. Do not edit by hand; tests/test_failures.py fails if this file drifts. -->",
        "",
        "Each pipeline row injects one synthetic fault into the real pipeline with offline doubles (a scripted model, a scripted evidence provider,",
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
    if tool_records:
        tool_passed = sum(1 for r in tool_records if r["passed"])
        lines += [
            "",
            "## Tool failure modes",
            "",
            "These rows run the patient tools directly, with no model: the form tools through `run_form_tool` with a mock RxNorm transport,",
            "the calculators through the registry, and the HTTP surface through the FastAPI test client. Each checks the fixed wording, the",
            "result shape, and that a failed lookup or a missing input never turns into a value.",
            "",
            f"Result: {tool_passed} of {len(tool_records)} cases pass.",
            "",
            "| Case | Fault | Expected behavior | Observed | Result |",
            "| --- | --- | --- | --- | --- |",
        ]
        for r in tool_records:
            lines.append(f"| `{r['id']}` | {r['description']} | {r['expected']} | {r['observed']} | {'pass' if r['passed'] else 'FAIL'} |")
        tool_failed = [f"`{r['id']}`: {', '.join(k for k, v in r['checks'].items() if not v)}" for r in tool_records if not r["passed"]]
        if tool_failed:
            lines += ["", "Failed tool checks: " + "; ".join(tool_failed)]
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the offline failure-injection cases.")
    parser.add_argument("--out", type=Path, help="write the markdown report here, e.g. docs/FAILURE_MODES.md")
    parser.add_argument("--json", type=Path, help="write the full records, including timings, here")
    args = parser.parse_args()
    records, tool_records = run_all(), run_tool_cases()
    for r in records + tool_records:
        detail = f"{r['route']}, {r['reason']}" if "route" in r else "tool"
        print(f"{r['id']}: {'pass' if r['passed'] else 'fail'} ({detail}, {r['elapsed_ms']} ms)")
        for name, ok in r["checks"].items():
            if not ok:
                print(f"  failed check: {name}")
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(render_markdown(records, tool_records), encoding="utf-8")
        print(args.out)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps({"pipeline": records, "tools": tool_records}, indent=2), encoding="utf-8")
        print(args.json)
    if not all(r["passed"] for r in records + tool_records):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
