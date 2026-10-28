import json

import pytest

from app.handoff import (
    HANDOFF_TEMPLATES, LIMITATION_CITATIONS, LIMITATION_GENERAL, LIMITATION_SCREEN, TRACE_DETAILS,
    build_handoff, citation_indices, claim_support, skipped_steps,
)
from app.pipeline import AgentPipeline, CLARIFICATION_INTRO, ReviewUnavailable
from app.schemas import Handoff
from tests.test_pipeline import EXTRACT_KEY, FakeEvidence, FakeLLM, SAFETY_KEY, TRIAGE_KEY, TOOLS_KEY, ANATOMY_KEY, make_pipeline

STEP_NAMES = ["triage", "tools", "evidence", "draft", "review"]
SECRET = "my private sentence about zorblax"


def validated(result) -> dict:
    assert result["handoff"] is not None
    Handoff(**result["handoff"])
    return result["handoff"]


def assert_trace(handoff, **statuses):
    steps = handoff["trace"]["steps"]
    assert [s["name"] for s in steps] == STEP_NAMES
    for step in steps:
        assert step["status"] in {"ok", "skipped", "failed", "fallback"}
        assert step["elapsed_ms"] >= 0
        assert step["detail"] in TRACE_DETAILS
    for name, status in statuses.items():
        assert next(s for s in steps if s["name"] == name)["status"] == status


class TestReasons:
    async def test_emergency(self):
        p = make_pipeline({"action": "emergency"})
        result = await p.run([SECRET], "c")
        h = validated(result)
        assert (h["reason"], h["urgency"]) == ("emergency", "emergency")
        assert_trace(h, triage="ok", tools="skipped", evidence="skipped", draft="skipped", review="skipped")
        assert h["trace"]["claim_support"] is None

    async def test_conversation(self):
        p = make_pipeline({"action": "conversation", "conversation_kind": "courtesy"})
        h = validated(await p.run(["thanks"], "c"))
        assert (h["reason"], h["urgency"]) == ("user_requested", "routine")
        assert_trace(h, triage="ok", evidence="skipped")

    async def test_follow_up(self):
        p = make_pipeline({"action": "ask", "follow_up_questions": ["How long?", "Any fever?"]})
        h = validated(await p.run(["I have a headache"], "c"))
        assert (h["reason"], h["urgency"]) == ("clarification_pending", "routine")
        assert any("How long? Any fever?" in line for line in h["limitations"])
        assert_trace(h, triage="ok", tools="skipped", evidence="skipped")

    async def test_evidence_unavailable(self):
        p = make_pipeline({"action": "answer"})
        p.evidence = FakeEvidence(articles=[])
        h = validated(await p.run(["Explain eye pressure"], "c"))
        assert (h["reason"], h["urgency"]) == ("evidence_unavailable", "routine")
        assert "No medical sources were retrieved, so no answer was written." in h["limitations"]
        assert_trace(h, triage="ok", evidence="failed", draft="skipped", review="skipped")
        assert h["sources"] == []

    async def test_clarification_limit(self):
        p = make_pipeline({"action": "ask", "follow_up_questions": ["More?"]})
        conversation = ["I have a headache", CLARIFICATION_INTRO + " How long?", "3 days"]
        h = validated(await p.run(conversation, "c"))
        assert h["reason"] == "clarification_limit"
        assert h["questions"] == ["I have a headache", "3 days"]
        assert "The app asked its one round of clarifying questions; remaining gaps were not resolved." in h["limitations"]

    async def test_tool_input_invalid_gives_tool_input_missing(self):
        p = make_pipeline({"action": "answer"}, tools={"selected_tools": ["bmi"]},
                          extract={"weight_kg": 70, "height_cm": 175, "age_years": 3000})
        result = await p.run(["I weigh 70 kg and am 175 cm. What is my BMI?"], "c")
        h = validated(result)
        assert h["reason"] == "tool_input_missing"
        assert h["calculations"][0]["error"]
        assert any("no value was computed" in line for line in h["limitations"])

    async def test_missing_calculator_input_gives_tool_input_missing(self):
        p = make_pipeline({"action": "answer"}, tools={"selected_tools": ["bmi"]},
                          extract={"weight_kg": 70, "age_years": 30})
        result = await p.run(["I weigh 70 kg. What is my BMI?"], "c")
        h = validated(result)
        assert h["reason"] == "tool_input_missing"
        assert h["calculations"][0]["missing_inputs"] == ["height_cm"]
        assert result["tool_results"][0]["missing_inputs"] == ["height_cm"]

    async def test_missing_reference_input_drops_the_tool_and_marks_tools_partial(self):
        p = make_pipeline({"action": "answer"}, tools={"selected_tools": ["pubmed_search"]}, extract={})
        result = await p.run(["Any research on migraine?"], "c")
        assert result["tool_results"] == []
        h = result["handoff"]
        assert h["reason"] == "answer_available"
        assert (h["trace"]["steps"][1]["status"], h["trace"]["steps"][1]["detail"]) == ("fallback", "partial")

    async def test_failed_variable_extraction_marks_tools_partial(self):
        p = make_pipeline({"action": "answer"}, tools={"selected_tools": ["bmi"]})
        p.llm.script[EXTRACT_KEY] = "not json"
        result = await p.run(["What is my BMI?"], "c")
        assert result["tool_results"] == []
        step = result["handoff"]["trace"]["steps"][1]
        assert (step["status"], step["detail"]) == ("fallback", "partial")

    async def test_clarification_limit_beats_tool_input_missing(self):
        p = make_pipeline({"action": "ask", "follow_up_questions": ["More?"]},
                          tools={"selected_tools": ["bmi"]},
                          extract={"weight_kg": 70, "height_cm": 175, "age_years": 3000})
        conversation = ["q", CLARIFICATION_INTRO, "BMI please"]
        assert (await p.run(conversation, "c"))["handoff"]["reason"] == "clarification_limit"

    async def test_answer_available(self):
        p = make_pipeline({"action": "answer"}, tools={"selected_tools": ["bmi"]},
                          extract={"weight_kg": 70, "height_cm": 175, "age_years": 30})
        result = await p.run(["I am 30, weigh 70 kg and am 175 cm tall. What is my BMI?"], "c")
        h = validated(result)
        assert (h["reason"], h["urgency"]) == ("answer_available", "routine")
        assert_trace(h, triage="ok", tools="ok", evidence="ok", draft="ok", review="ok")
        assert h["trace"]["steps"][1]["detail"] == "selected=1"
        calc = h["calculations"][0]
        assert calc["tool"]
        assert calc["source"].startswith("https://") and calc["scope"]
        assert h["sources"][0]["cited"] is True
        assert h["limitations"][:2] == [LIMITATION_GENERAL, LIMITATION_SCREEN]
        assert h["limitations"][-1] == LIMITATION_CITATIONS
        assert h["trace"]["claim_support"]["uncited_sources"] == []

    async def test_revised_once_is_fallback_review(self):
        p = make_pipeline({"action": "answer"}, safety={"is_safe": False, "issues": ["x"], "revised_answer": "Revised [1]."})
        h = validated(await p.run(["Is coffee good for me?"], "c"))
        assert_trace(h, review="fallback")
        assert h["trace"]["steps"][4]["detail"] == "revised_once"

    async def test_review_failure_exposes_handoff(self):
        p = make_pipeline({"action": "answer"}, safety={"is_safe": False})
        with pytest.raises(ReviewUnavailable) as caught:
            await p.run([SECRET], "c")
        h = caught.value.handoff
        Handoff(**h)
        assert (h["reason"], h["urgency"]) == ("review_unavailable", "routine")
        assert_trace(h, triage="ok", evidence="ok", draft="ok", review="failed")
        assert h["trace"]["steps"][4]["detail"] == "attempts=2"
        assert h["trace"]["claim_support"] is None
        assert all(not s["cited"] for s in h["sources"])

    async def test_triage_failure_has_unknown_urgency(self):
        p = make_pipeline({"action": "invalid"})
        with pytest.raises(ReviewUnavailable) as caught:
            await p.run(["hello there"], "c")
        h = caught.value.handoff
        Handoff(**h)
        assert h["urgency"] == "unknown"
        assert_trace(h, triage="failed", tools="skipped", review="skipped")
        assert h["trace"]["steps"][0]["detail"] == "invalid_json"

    async def test_triage_llm_unavailable_detail(self):
        class Down(FakeLLM):
            async def generate(self, user, system=None, **kwargs):
                raise RuntimeError("down")
        p = AgentPipeline(llm=Down({}), evidence=FakeEvidence())
        with pytest.raises(ReviewUnavailable) as caught:
            await p.run(["What is asthma?"], "c")
        assert caught.value.handoff["trace"]["steps"][0]["detail"] == "unavailable"

    @pytest.mark.parametrize("over,detail", [(True, "over_budget"), (False, "interrupted")])
    async def test_draft_failure_details(self, over, detail):
        p = make_pipeline({"action": "answer"})
        limit = p.max_answer_chars

        class Stream(FakeLLM):
            async def generate_stream(self, user, system=None):
                if not over:
                    raise RuntimeError("stream down")
                yield "x" * (limit + 1)
        p.llm = Stream({TRIAGE_KEY: json.dumps({"action": "answer"}), TOOLS_KEY: json.dumps({"selected_tools": []}),
                        ANATOMY_KEY: "{}", SAFETY_KEY: "{}"})
        with pytest.raises(ReviewUnavailable) as caught:
            await p.run(["What is flu?"], "c")
        assert_trace(caught.value.handoff, draft="failed")
        assert caught.value.handoff["trace"]["steps"][3]["detail"] == detail

    async def test_evidence_failure_trace_detail(self):
        class Boom:
            def search(self, conversation, conversation_id):
                raise RuntimeError("provider down")
        p = make_pipeline({"action": "answer"})
        p.evidence = Boom()
        result = await p.run(["Explain eye pressure"], "c")
        assert result["evidence_status"] == "unavailable"
        h = validated(result)
        assert h["trace"]["steps"][2] == {**h["trace"]["steps"][2], "status": "failed", "detail": "error"}


class TestContent:
    async def test_questions_are_user_turns_and_answer_prose_is_absent(self):
        p = make_pipeline({"action": "ask", "follow_up_questions": ["More?"]})
        conversation = [SECRET, CLARIFICATION_INTRO + " How long?", "second user turn"]
        result = await p.run(conversation, "c")
        h = result["handoff"]
        assert h["questions"] == [SECRET, "second user turn"]
        assert result["answer"] not in json.dumps(h)

    @pytest.mark.parametrize("reason", sorted(HANDOFF_TEMPLATES))
    def test_templates_never_contain_message_text(self, reason):
        h = build_handoff([SECRET, "assistant reply", "another"], reason, None, triage_done=True)
        texts = [q["text"] for q in h["clinician_questions"]]
        assert len(texts) == 3 and all(texts)
        assert [q["heading"] for q in h["clinician_questions"]] == [
            "What is my main problem?", "What do I need to do?", "Why is it important?"]
        assert "zorblax" not in " ".join(texts + h["limitations"])
        assert "assistant reply" not in json.dumps({k: v for k, v in h.items() if k != "questions"})
        Handoff(**h)

    def test_calculation_value_is_the_only_substitution(self):
        tool = {"tool": "Pack-years", "inputs": {"packs_per_day": 1, "years_smoked": 30}, "value": 30.0,
                "units": "pack-years", "source": "https://example.org", "scope": "s"}
        h = build_handoff(["q"], "answer_available", None, triage_done=True, tool_results=[tool],
                          articles=[{"title": "A", "url": "https://x", "year": 2020}], answer="ok [1]")
        assert "Pack-years: 30.0 pack-years" in h["clinician_questions"][0]["text"]
        assert "1 source(s)" in h["clinician_questions"][1]["text"]
        assert h["calculations"][0]["inputs"] == {"packs_per_day": 1, "years_smoked": 30}
        assert h["calculations"][0]["result"] == "30.0" and h["calculations"][0]["units"] == "pack-years"

    def test_steadi_checklist_is_a_calculation_not_a_reference(self):
        from app.tools.clinical import TOOL_REGISTRY
        keys = TOOL_REGISTRY["steadi_fall_risk"]["variables"]
        tool = TOOL_REGISTRY["steadi_fall_risk"]["function"]({key: key == "fallen_past_year" for key in keys})
        h = build_handoff(["q"], "answer_available", None, triage_done=True, tool_results=[tool], articles=[], answer="ok")
        assert h["references"] == [] and len(h["calculations"]) == 1
        assert h["calculations"][0]["result"] == "2" and h["calculations"][0]["inputs"]["fallen_past_year"] is True

    def test_reference_limitations_and_label_note(self):
        tools = [
            {"tool": "DailyMed", "status": "unavailable", "items": [], "error": "down"},
            {"tool": "PubMed", "status": "empty", "items": []},
            {"tool": "FDA label sections", "status": "empty", "items": [], "combination_only": True, "error": "Only combination"},
            {"tool": "Label ok", "status": "available", "product": "P", "set_id": "S",
             "items": [{"title": "T", "url": "https://u", "tldr": "long text"}]},
        ]
        articles = [{"title": "L", "url": "https://u", "evidence_kind": "label_section"}]
        h = build_handoff(["q"], "answer_available", None, triage_done=True, tool_results=tools, articles=articles, answer="[1]")
        lines = h["limitations"]
        assert "DailyMed could not be reached; this says nothing about the medicine." in lines
        assert "PubMed returned nothing; this is not evidence of safety." in lines
        assert "Only combination products matched the medicine name; label sections were not shown." in lines
        assert any(line.startswith("Label excerpts are from the US label") for line in lines)
        assert h["references"][3]["items"] == [{"title": "T", "url": "https://u", "product": "P", "set_id": "S"}]
        assert "tldr" not in json.dumps(h["references"])
        assert h["references"][0]["note"] == "down"
        assert h["sources"][0]["kind"] == "label_section"

    def test_uncited_sources_limitation(self):
        arts = [{"title": "A", "url": "https://a"}, {"title": "B", "url": "https://b"}]
        h = build_handoff(["q"], "answer_available", None, triage_done=True, articles=arts, answer="Claim [1].")
        assert h["trace"]["claim_support"]["uncited_sources"] == [2]
        assert [s["cited"] for s in h["sources"]] == [True, False]
        assert "Sources 2 were retrieved but not cited." in h["limitations"]


class TestClaimSupport:
    def test_counts(self):
        assert claim_support("One [1]. Two [1, 3]. Three【2】.", 4) == {
            "citation_markers": 4, "sources_retrieved": 4, "sources_cited": 3, "uncited_sources": [4]}

    def test_answer_citing_one_of_two(self):
        support = claim_support("A claim [1].", 2)
        assert support["uncited_sources"] == [2] and support["sources_cited"] == 1

    def test_citation_indices(self):
        assert citation_indices("a [1] b [2，3] c 〔4〕 d [x]") == [1, 2, 3, 4]
        assert citation_indices("no markers") == []

    def test_skipped_steps_shape(self):
        assert [s["name"] for s in skipped_steps()] == STEP_NAMES
        assert {s["status"] for s in skipped_steps()} == {"skipped"}


class TestPatientToolHandoff:
    def test_headline_falls_back_to_summary(self):
        from app.handoff import _headline
        assert _headline({"summary": "5 mL every 4 h"}) == ("5 mL every 4 h", "")
        assert _headline({"value": 12, "units": "kg", "summary": "ignored"}) == ("12", "kg")
        assert _headline({"summary": ""}) == ("", "")
        assert _headline({"summary": 7}) == ("", "")

    def test_summary_tool_is_a_calculation_and_form_lists_are_dropped(self):
        result = {"tool": "Home blood-pressure log", "key": "bp_log_summary", "source": "https://s", "scope": "adults",
                  "inputs": {"readings": [{"systolic": 120}], "window_end": "2026-10-07"},
                  "summary": "7-day average 128/82 from 14 readings"}
        h = build_handoff(["q"], "answer_available", None, triage_done=True, tool_results=[result])
        Handoff(**h)
        calc = h["calculations"][0]
        assert calc["result"] == "7-day average 128/82 from 14 readings" and calc["units"] == ""
        assert calc["inputs"] == {"window_end": "2026-10-07"} and h["references"] == []

    def test_rxnorm_limitation_only_when_lookup_worked(self):
        from app.handoff import LIMITATION_RXNORM
        base = {"tool": "RxNorm ingredients", "source": "https://rxnav.nlm.nih.gov/", "scope": "s"}
        for status, expected in [("available", True), ("empty", True), ("unavailable", False)]:
            result = {**base, "status": status, "items": [{"title": "acetaminophen", "url": "https://u"}] if status == "available" else []}
            h = build_handoff(["q"], "answer_available", None, triage_done=True, tool_results=[result, dict(result)])
            assert h["limitations"].count(LIMITATION_RXNORM) == (1 if expected else 0)
        assert LIMITATION_RXNORM == "RxNorm matched medicine names to ingredients; it did not check interactions or doses."


# ---------------------------------------------------------------- when-to-call sheet limitation

def test_sheet_limitation_is_added_only_when_a_sheet_is_present_and_stays_before_the_citation_line():
    from app.handoff import LIMITATION_SHEET
    article = {"title": "Study", "url": "https://example.org/s"}
    plain = build_handoff(["q"], "answer_available", None, triage_done=True, articles=[article], answer="Sign [1].")
    sheet = build_handoff(["q"], "answer_available", None, triage_done=True, articles=[article], answer="Sign [1].", sheet=True)
    assert LIMITATION_SHEET not in plain["limitations"]
    assert sheet["limitations"].count(LIMITATION_SHEET) == 1
    assert sheet["limitations"][-1] == LIMITATION_CITATIONS
    assert [x for x in sheet["limitations"] if x != LIMITATION_SHEET] == plain["limitations"]
    assert sheet["reason"] == plain["reason"] == "answer_available"
    Handoff(**sheet)


def test_sheet_limitation_text_and_sensitivity():
    from app.handoff import LIMITATION_SHEET
    assert LIMITATION_SHEET == (
        "When-to-call sheet: the middle tier was written from retrieved sources and reviewed; the emergency and routine tiers "
        "are fixed; names, numbers, and personal thresholds were added in the browser and never sent."
    )
    handoff = build_handoff([SECRET], "answer_available", None, triage_done=True, answer=f"{SECRET} [1]", sheet=True)
    assert SECRET not in json.dumps(handoff["limitations"])
