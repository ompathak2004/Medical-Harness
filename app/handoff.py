"""Deterministic clinician-handoff assembler.

Builds a plain-dict summary from data the pipeline already holds: the user's own
turns, structured tool results, retrieved sources, the reviewed answer's citation
markers, and a per-run trace. It makes no model call, reads no prompts, logs nothing,
and never copies the AI answer text or any message text into fixed strings.
"""
from __future__ import annotations

import re
from collections.abc import Sequence

TRACE_STEPS = ("triage", "tools", "evidence", "draft", "review")

# Fixed vocabulary for TraceStep.detail. Never provider or user text.
TRACE_DETAILS = frozenset({
    "", "invalid_json", "unavailable", "selected=1", "selected=2", "partial", "selection_failed",
    "empty", "error", "reference_sources", "over_budget", "interrupted", "attempts=2", "revised_once",
})

ASK_ME_3 = ("What is my main problem?", "What do I need to do?", "Why is it important?")

# Ask Me 3 / AHRQ Question Builder headings; fixed strings per reason, never generated.
HANDOFF_TEMPLATES: dict[str, tuple[str, str, str]] = {
    "emergency": (
        "The app stopped and told me to contact emergency services now because my message described symptoms that may need immediate care.",
        "The app did not give me an answer and told me not to wait for an online one. What should I do about these symptoms right now?",
        "Which of these symptoms makes it urgent, and what signs mean I need help straight away?",
    ),
    "user_requested": (
        "I used an online information tool; it did not assess anything about my health.",
        "I want to discuss a health question with you. Where should we start?",
        "What information would you need from me to answer it properly?",
    ),
    "clarification_pending": (
        "The app asked me for more details and has not answered yet. Which of those details matter most for my situation?",
        "Can you help me answer the questions the app asked, and tell me what else you need to know?",
        "Why do these details change what I should do?",
    ),
    "evidence_unavailable": (
        "The app could not retrieve medical sources for my question and wrote no answer. Can you help me with it?",
        "What should I do next, given that I have no sourced information yet?",
        "What would change if I waited, and what signs mean I should not wait?",
    ),
    "review_unavailable": (
        "The app could not finish its safety review, so it showed me no answer. Can you help me with my question?",
        "What should I do next, given that I have no reviewed information yet?",
        "What would change if I waited, and what signs mean I should not wait?",
    ),
    "clarification_limit": (
        "The app asked its clarifying questions once and still has gaps in what I told it. Is the explanation I read relevant to me?",
        "Which details are missing, and what should I do next?",
        "What would change if I waited, and what signs mean I should not wait?",
    ),
    "tool_input_missing": (
        "A calculator needed measurements the app did not have, so it computed no value. Can we take or confirm them?",
        "Which measurements or tests do I need, and what should I do next?",
        "Why do these numbers matter for my situation?",
    ),
    "answer_available": (
        "I read a sourced explanation about my question; is it relevant to me?",
        "Which of the listed sources applies to my situation, and what should I do next?",
        "What would change if I waited, and what signs mean I should not wait?",
    ),
}
# Appended only when structured values exist; only these fields are ever substituted.
CALCULATION_SUFFIX = " The tool calculated {calculation}; what does that mean for me?"
SOURCES_SUFFIX = " The tool listed {sources} source(s)."
SOURCES_REASONS = frozenset({"answer_available", "clarification_limit", "tool_input_missing"})

LIMITATION_GENERAL = "This is general information from an automated tool, not a diagnosis or a treatment plan."
LIMITATION_SCREEN = "Emergency screen only: 'not flagged' is not a triage category."
LIMITATION_BY_REASON = {
    "evidence_unavailable": "No medical sources were retrieved, so no answer was written.",
    "review_unavailable": "The answer did not pass the safety review or the review did not complete; nothing was shown.",
    "clarification_limit": "The app asked its one round of clarifying questions; remaining gaps were not resolved.",
}
LIMITATION_PENDING = "The app asked these questions and has not answered yet: {questions}"
LIMITATION_UNREACHABLE = "{tool} could not be reached; this says nothing about the medicine."
LIMITATION_EMPTY = "{tool} returned nothing; this is not evidence of safety."
LIMITATION_COMBINATION = "Only combination products matched the medicine name; label sections were not shown."
LIMITATION_CALC_INPUTS = "{tool}: inputs missing or invalid; no value was computed."
LIMITATION_UNCITED = "Sources {sources} were retrieved but not cited."
LIMITATION_LABELS = (
    "Label excerpts are from the US label for the exact product named; "
    "they are not an interaction check or dosing advice."
)
LIMITATION_RXNORM = "RxNorm matched medicine names to ingredients; it did not check interactions or doses."
LIMITATION_CITATIONS = "Citations were checked to point at retrieved sources; each claim's truth was not verified."
LIMITATION_SHEET = (
    "When-to-call sheet: the middle tier was written from retrieved sources and reviewed; the emergency and routine tiers "
    "are fixed; names, numbers, and personal thresholds were added in the browser and never sent."
)

_CITATION_MARKER = re.compile(r"[\[【〔](\d+(?:\s*[,，]\s*\d+)*)[\]】〕]")


def citation_indices(answer: str) -> list[int]:
    """Every cited source index in `answer`, in order of appearance (repeats kept)."""
    markers = _CITATION_MARKER.findall(answer or "")
    return [int(n.strip()) for marker in markers for n in re.split("[,，]", marker)]


def claim_support(answer: str, article_count: int) -> dict:
    """Coverage of retrieved sources by citation markers. Not verification of any claim."""
    indices = citation_indices(answer)
    cited = {n for n in indices if 1 <= n <= article_count}
    return {
        "citation_markers": len(indices),
        "sources_retrieved": article_count,
        "sources_cited": len(cited),
        "uncited_sources": [n for n in range(1, article_count + 1) if n not in cited],
    }


def skipped_step(name: str) -> dict:
    return {"name": name, "status": "skipped", "elapsed_ms": 0, "detail": ""}


def skipped_steps() -> list[dict]:
    return [skipped_step(name) for name in TRACE_STEPS]


def _text(value) -> str:
    return "" if value is None else str(value)


def _headline(result: dict) -> tuple[str, str]:
    """Mirror of toolHeadline in static/js/dom-utils.js: value, score, bmi, grade, then the summary line."""
    for field in ("value", "score", "bmi", "grade"):
        number = result.get(field)
        if isinstance(number, (int, float)) and not isinstance(number, bool):
            return str(number), _text(result.get("units")) if field == "value" else ""
    summary = result.get("summary")
    if isinstance(summary, str) and summary:
        return summary, ""
    return "", ""


def is_reference(result):
    """Reference lookups carry `status` and `items`; a checklist calculator (STEADI) has `items` but no `status`."""
    return "items" in result and "status" in result


def _calculation(result: dict) -> dict:
    inputs = result.get("inputs")
    inputs = inputs if isinstance(inputs, dict) else {}
    value, units = _headline(result)
    missing = result.get("missing_inputs")
    return {
        "tool": _text(result.get("tool")),
        "inputs": {str(k): v for k, v in inputs.items() if isinstance(v, (int, float, bool, str))},
        "result": value,
        "units": units,
        "source": _text(result.get("source")),
        "scope": _text(result.get("scope")),
        "error": _text(result.get("error")),
        "missing_inputs": [str(m) for m in missing] if isinstance(missing, list) else [],
    }


def _reference(result: dict) -> dict:
    extra = {key: _text(result[key]) for key in ("product", "set_id") if result.get(key)}
    items = [
        {"title": _text(item.get("title")), "url": _text(item.get("url")), **extra}
        for item in result.get("items", []) if isinstance(item, dict)
    ]
    return {
        "tool": _text(result.get("tool")),
        "status": _text(result.get("status")) or "available",
        "items": items,
        "note": _text(result.get("error")),
    }


def _source(index: int, article: dict, cited: bool) -> dict:
    return {
        "index": index,
        "title": _text(article.get("title")),
        "year": _text(article.get("year")),
        "journal": _text(article.get("journal")),
        "url": _text(article.get("url")),
        "kind": _text(article.get("evidence_kind")) or "research",
        "cited": cited,
    }


def _clinician_questions(reason: str, calculations: list[dict], source_count: int) -> list[dict]:
    texts = list(HANDOFF_TEMPLATES[reason])
    done = [c for c in calculations if c["result"]]
    if done and reason in SOURCES_REASONS:
        summary = "; ".join(f"{c['tool']}: {c['result']} {c['units']}".strip() for c in done)
        texts[0] += CALCULATION_SUFFIX.format(calculation=summary)
    if source_count and reason in SOURCES_REASONS:
        texts[1] += SOURCES_SUFFIX.format(sources=source_count)
    return [{"heading": heading, "text": text} for heading, text in zip(ASK_ME_3, texts)]


def build_handoff(
    conversation: Sequence[str],
    reason: str,
    trace: Sequence[dict] | None,
    *,
    triage_done: bool,
    tool_results: Sequence[dict] = (),
    articles: Sequence[dict] = (),
    answer: str | None = None,
    follow_up_questions: Sequence[str] = (),
    sheet: bool = False,
) -> dict:
    """Assemble the clinician handoff as a plain dict (validated by `schemas.Handoff`).

    `trace` is the ordered list of step dicts from the run recorder, or None for a
    route-built handoff where nothing ran (all five steps `skipped`). The AI answer
    prose is used only to count citation markers and is never copied into the result.
    """
    tool_results = [r for r in tool_results if isinstance(r, dict)]
    articles = [a for a in articles if isinstance(a, dict)]
    calculations = [_calculation(r) for r in tool_results if not is_reference(r)]
    references = [_reference(r) for r in tool_results if is_reference(r)]
    support = claim_support(answer, len(articles)) if answer is not None else None
    uncited = set(support["uncited_sources"]) if support else set()
    sources = [_source(i, a, support is not None and i not in uncited) for i, a in enumerate(articles, 1)]

    limitations = [LIMITATION_GENERAL, LIMITATION_SCREEN]
    if reason == "clarification_pending":
        limitations.append(LIMITATION_PENDING.format(questions=" ".join(follow_up_questions)))
    elif reason in LIMITATION_BY_REASON:
        limitations.append(LIMITATION_BY_REASON[reason])
    for result in tool_results:
        if "items" not in result:
            continue
        if result.get("combination_only"):
            limitations.append(LIMITATION_COMBINATION)
        elif result.get("status") == "unavailable":
            limitations.append(LIMITATION_UNREACHABLE.format(tool=_text(result.get("tool"))))
        elif result.get("status") == "empty":
            limitations.append(LIMITATION_EMPTY.format(tool=_text(result.get("tool"))))
        if result.get("tool") == "RxNorm ingredients" and result.get("status") != "unavailable" and LIMITATION_RXNORM not in limitations:
            limitations.append(LIMITATION_RXNORM)
    for calc in calculations:
        if calc["error"] or calc["missing_inputs"]:
            limitations.append(LIMITATION_CALC_INPUTS.format(tool=calc["tool"]))
    if support and support["uncited_sources"]:
        limitations.append(LIMITATION_UNCITED.format(sources=", ".join(map(str, support["uncited_sources"]))))
    if any(s["kind"] == "label_section" for s in sources):
        limitations.append(LIMITATION_LABELS)
    if sheet:
        limitations.append(LIMITATION_SHEET)
    limitations.append(LIMITATION_CITATIONS)

    if reason == "emergency":
        urgency = "emergency"
    elif reason == "review_unavailable" and not triage_done:
        urgency = "unknown"
    else:
        urgency = "routine"

    return {
        "version": 1,
        "reason": reason,
        "urgency": urgency,
        "questions": [str(m) for m in conversation[0::2]],
        "calculations": calculations,
        "references": references,
        "sources": sources,
        "limitations": limitations,
        "clinician_questions": _clinician_questions(reason, calculations, len(sources)),
        "trace": {
            "steps": [dict(step) for step in trace] if trace else skipped_steps(),
            "claim_support": support,
        },
    }
