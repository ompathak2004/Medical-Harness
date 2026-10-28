import json

import pytest

from app.pipeline import AgentPipeline, CLARIFICATION_INTRO, ReviewUnavailable
from app.tools.education import VISUAL_IDS


class FakeLLM:


    def __init__(self, script: dict[str, str], stream_text: str = "streamed answer [1]."):
        self.script = script
        self.stream_text = stream_text
        self.prompts: list[str] = []
        self.calls: list[tuple[str, str]] = []

    async def generate(self, user: str, system: str | None = None, **kwargs) -> str:
        combined = f"{system or ''}\n{user}"
        self.prompts.append(combined)
        self.calls.append((user, system or ""))
        for key, response in self.script.items():
            if key in combined:
                return response.pop(0) if isinstance(response, list) else response
        return "{}"

    async def generate_stream(self, user: str, system: str | None = None):
        self.prompts.append(f"{system or ''}\n{user}")
        self.calls.append((user, system or ""))
        for word in self.stream_text.split(" "):
            yield word + " "


class FakeEvidence:
    def __init__(self, articles=None, response="Evidence summary.", followups=None):
        self.articles = articles if articles is not None else [
            {"title": "Study A", "year": 2023, "journal": "NEJM", "tldr": "T", "url": "http://x"}
        ]
        self.response = response
        self.followups = followups or ["What about X?"]

    def search(self, conversation, conversation_id):
        return {
            "response": self.response,
            "articles": self.articles,
            "followups": self.followups,
        }


TRIAGE_KEY = "medical triage assistant"
TOOLS_KEY = "clinical decision support"
ANATOMY_KEY = "anatomy detection assistant"
SAFETY_KEY = "medical safety reviewer"
EXTRACT_KEY = "extracting clinical variables"


def make_pipeline(triage: dict, tools: dict | None = None, safety: dict | None = None,
                  anatomy: dict | None = None, extract: dict | None = None) -> AgentPipeline:
    triage = {**triage, "anatomy": anatomy}
    script = {
        TRIAGE_KEY: json.dumps(triage),
        TOOLS_KEY: json.dumps(tools or {"selected_tools": []}),
        ANATOMY_KEY: json.dumps(anatomy or {"has_anatomy": False}),
        SAFETY_KEY: json.dumps(safety or {"is_safe": True, "issues": [], "revised_answer": ""}),
        EXTRACT_KEY: json.dumps(extract or {}),
    }
    if safety and safety.get("is_safe") is False and safety.get("revised_answer"):
        script[SAFETY_KEY] = [json.dumps(safety), json.dumps({"is_safe": True})]
    return AgentPipeline(llm=FakeLLM(script), evidence=FakeEvidence())


async def collect(pipeline, conversation):
    events = []
    async for ev in pipeline.run_streaming(conversation, "test-conv"):
        events.append(ev)
    return events


@pytest.mark.parametrize("visual,expected", [(item, item) for item in sorted(VISUAL_IDS)] + [
    ("unknown_visual", None), (None, None), ({"svg": "<script>"}, None), (["asthma"], None),
])
async def test_visual_uses_allowlist_after_review(visual, expected):
    pipeline = make_pipeline({"action": "answer", "visual": visual})
    events = await collect(pipeline, ["Explain eye pressure"])
    assert events[-1][1]["visual_context"] == expected
    assert any(SAFETY_KEY in prompt for prompt in pipeline.llm.prompts)


@pytest.mark.parametrize("visual", sorted(VISUAL_IDS))
async def test_emergency_suppresses_educational_visual(visual):
    pipeline = make_pipeline({"action": "emergency", "visual": visual})
    events = await collect(pipeline, ["Sudden severe eye pain and blurred vision"])
    assert events[-1][1].get("visual_context") is None
    assert events[-1][1]["type"] == "emergency"


@pytest.mark.parametrize("visual", sorted(VISUAL_IDS))
async def test_unavailable_evidence_suppresses_visual(visual):
    pipeline = make_pipeline({"action": "answer", "visual": visual})
    pipeline.evidence = FakeEvidence(articles=[])
    result = await pipeline.run(["Explain eye pressure"], "visual-failure")
    assert result.get("visual_context") is None


@pytest.mark.parametrize("visual", sorted(VISUAL_IDS))
async def test_clarification_suppresses_visual(visual):
    pipeline = make_pipeline({"action": "ask", "visual": visual, "follow_up_questions": ["When did this start?"]})
    result = await pipeline.run(["I have a health concern"], "visual-clarification")
    assert result["type"] == "follow_up"
    assert result.get("visual_context") is None


@pytest.mark.parametrize("visual", sorted(VISUAL_IDS))
async def test_failed_review_cannot_publish_visual(visual):
    pipeline = make_pipeline({"action": "answer", "visual": visual}, safety={"is_safe": False})
    events = []
    with pytest.raises(ReviewUnavailable):
        async for event in pipeline.run_streaming(["Explain a health topic"], "visual-review"):
            events.append(event)
    assert not any(event[0] in {"result", "answer_chunk"} for event in events)


@pytest.mark.parametrize("visual,scene", [("eye_pressure", "head"), ("disc_nerve", "spine")])
async def test_guide_and_spatial_anatomy_have_separate_purposes(visual, scene):
    pipeline = make_pipeline({"action": "answer", "visual": visual}, anatomy={
        "scene_id": scene, "reason": "Explore the surrounding structures.",
    })
    result = await pipeline.run(["Explain the mechanism and surrounding anatomy"], "visual-atlas")
    assert result["visual_context"] == visual
    assert (result["anatomy_context"] is None) == (visual == "eye_pressure")


class TestAnswerPath:
    async def test_source_appendix_is_removed_before_review(self):
        p = make_pipeline({"action": "answer"})
        p.llm.stream_text = "A supported explanation [1].\n\nAvailable citations: [1] Study A. URL: https://example.org/source"
        result = await p.run(["Explain a health topic"], "citations")
        assert result["answer"] == "A supported explanation [1]."
        reviewed = [user.split("Available citations:\n")[0] for user, system in p.llm.calls if SAFETY_KEY in system]
        assert all("URL: https://example.org/source" not in user for user in reviewed)
        assert result["articles"][0]["title"] == "Study A"

    async def test_revised_source_appendix_is_removed_before_second_review(self):
        p = make_pipeline({"action": "answer"}, safety={
            "is_safe": False, "issues": ["Revise"],
            "revised_answer": "A revised explanation [1].\n\n**Available citations:** [1] Study A. URL: https://example.org/source",
        })
        result = await p.run(["Explain a health topic"], "revised-citations")
        assert result["answer"] == "A revised explanation [1]."
        reviews = [user for user, system in p.llm.calls if SAFETY_KEY in system]
        assert len(reviews) == 2
        assert "URL: https://example.org/source" not in reviews[-1]

    async def test_bibliography_alone_is_not_an_answer(self):
        p = make_pipeline({"action": "answer"})
        p.llm.stream_text = "Available citations: [1] Study A. URL: https://example.org/source"
        with pytest.raises(ReviewUnavailable):
            await p.run(["Explain a health topic"], "empty-citations")

    async def test_full_answer_flow(self):
        p = make_pipeline({"action": "answer", "follow_up_questions": []})
        events = await collect(p, ["What is hypertension?"])
        types = [e[0] for e in events]
        assert "step" in types
        assert "answer_chunk" in types
        result = events[-1][1]
        assert events[-1][0] == "result"
        assert result["type"] == "answer"
        assert result["answer"].startswith("streamed answer")
        assert result["articles"]
        assert result["followups"] == ["What about X?"]
        assert result["emergency"] is False

    async def test_safety_revision_replaces_answer(self):
        p = make_pipeline(
            {"action": "answer"},
            safety={"is_safe": False, "issues": ["overclaim"], "revised_answer": "revised safe answer [1]"},
        )
        events = await collect(p, ["Is coffee good for me?"])
        result = events[-1][1]
        assert result["answer"] == "revised safe answer [1]"

    async def test_run_returns_final_result(self):
        p = make_pipeline({"action": "answer"})
        result = await p.run(["What is diabetes?"], "cid")
        assert result["type"] == "answer"


class TestFollowUpPath:
    async def test_follow_up(self):
        p = make_pipeline(
            {
                "action": "ask",
                "follow_up_questions": ["How long?", "Any fever?"],
                "preliminary_info": "Headaches are common.",
            }
        )
        events = await collect(p, ["I have a headache"])
        result = events[-1][1]
        assert result["type"] == "follow_up"
        assert result["follow_up_questions"] == ["How long?", "Any fever?"]
        assert "not sure" in result["preliminary_info"]
        assert result["answer"] is None

    async def test_clarification_limit_forces_answer(self):
        p = make_pipeline(
            {"action": "ask", "follow_up_questions": ["More?"], "preliminary_info": "info"}
        )

        conversation = [
            "I have a headache",
            CLARIFICATION_INTRO + " How long has it lasted? Any fever?",
            "3 days, no fever",
        ]
        events = await collect(p, conversation)
        result = events[-1][1]
        assert result["type"] == "answer"


class TestConversationPath:
    @pytest.mark.parametrize("message", ["hi", "hii", "Hello!", "morning", "good evening"])
    async def test_first_turn_greeting_does_not_ask_for_symptoms(self, message):
        class NoEvidence(FakeEvidence):
            def search(self, conversation, conversation_id):
                raise AssertionError("Routine messages must not trigger medical retrieval")

        p = make_pipeline({
            "action": "ask",
            "follow_up_questions": ["What symptoms are you having?"],
        })
        p.evidence = NoEvidence()
        events = await collect(p, [message])
        result = events[-1][1]
        assert result["type"] == "conversation"
        assert result["answer"].startswith("Hi!")
        assert result["follow_up_questions"] == []
        assert result["articles"] == []
        assert result["evidence_status"] == "not_applicable"
        assert [e[1]["step"] for e in events if e[0] == "step"] == ["triage"]
        assert len(p.llm.calls) == 1
        assert p.outcome_stats()["conversation"] == 1

    @pytest.mark.parametrize("message,kind", [
        ("thanks", "courtesy"),
        ("bye", "farewell"),
        ("what can you do?", "capabilities"),
    ])
    async def test_other_routine_messages(self, message, kind):
        p = make_pipeline({"action": "conversation", "conversation_kind": kind})
        result = await p.run([message], "cid")
        assert result["type"] == "conversation"
        assert result["answer"]
        assert result["tool_results"] == []

    @pytest.mark.parametrize("kind", ["unclear", "off_topic"])
    async def test_model_routes_nonmedical_message_without_evidence(self, kind):
        p = make_pipeline({"action": "conversation", "conversation_kind": kind})
        result = await p.run(["xyzzy" if kind == "unclear" else "Tell me a joke"], "cid")
        assert result["type"] == "conversation"
        assert len(p.llm.calls) == 1

    async def test_mixed_greeting_keeps_emergency_priority(self):
        p = make_pipeline({"action": "emergency"})
        result = await p.run(["Hi, I have crushing chest pain and I'm sweating"], "cid")
        assert result["type"] == "emergency"

    async def test_short_reply_to_medical_followup_is_not_treated_as_greeting(self):
        p = make_pipeline({"action": "answer"})
        result = await p.run([
            "When does my headache happen?",
            "When does it usually occur?",
            "morning",
        ], "cid")
        assert result["type"] == "answer"
        assert result["articles"]

    async def test_greeting_reply_does_not_use_medical_clarification_allowance(self):
        p = make_pipeline({"action": "ask", "follow_up_questions": ["How long have you felt unwell?"]})
        result = await p.run([
            "hi",
            "Hi! What health question can I help you with?",
            "I feel unwell",
        ], "cid")
        assert result["type"] == "follow_up"

    async def test_triage_failure_still_blocks_routine_reply(self):
        p = make_pipeline({"action": "invalid"})
        with pytest.raises(ReviewUnavailable):
            await p.run(["hi"], "cid")

    async def test_first_turn_acknowledgment_requests_a_health_question(self):
        p = make_pipeline({"action": "ask", "follow_up_questions": ["What symptoms?"]})
        result = await p.run(["okay"], "cid")
        assert result["type"] == "conversation"
        assert "what health question" in result["answer"].lower()


class TestEmergencyPath:
    async def test_emergency_short_circuits(self):
        p = make_pipeline(
            {
                "action": "emergency",
                "emergency_message": "Call emergency services now.",
                "follow_up_questions": [],
            }
        )
        events = await collect(p, ["Crushing chest pain radiating to my left arm and sweating"])
        result = events[-1][1]
        assert result["type"] == "emergency"
        assert result["emergency"] is True
        assert "emergency" in result["emergency_message"].lower() or result["emergency_message"]

        step_names = [e[1]["step"] for e in events if e[0] == "step"]
        assert "tools" not in step_names
        assert "evidence" not in step_names

    async def test_emergency_default_message(self):
        p = make_pipeline({"action": "emergency", "emergency_message": ""})
        result = await p.run(["stroke symptoms"], "cid")
        assert result["emergency_message"]


class TestDegradation:
    async def test_triage_failure_stops_generation(self):
        class BrokenTriageLLM(FakeLLM):
            async def generate(self, user, system=None, **kwargs):
                if TRIAGE_KEY in f"{system or ''}\n{user}":
                    raise RuntimeError("boom")
                return await super().generate(user, system, **kwargs)

        script = {
            TOOLS_KEY: json.dumps({"selected_tools": []}),
            ANATOMY_KEY: json.dumps({"has_anatomy": False}),
            SAFETY_KEY: json.dumps({"is_safe": True, "issues": [], "revised_answer": ""}),
        }
        p = AgentPipeline(llm=BrokenTriageLLM(script), evidence=FakeEvidence())
        with pytest.raises(ReviewUnavailable):
            await p.run(["What is asthma?"], "cid")

    async def test_stream_failure_never_publishes_unreviewed_fallback(self):
        class BrokenStreamLLM(FakeLLM):
            async def generate_stream(self, user, system=None):
                raise RuntimeError("stream down")
                yield

        script = {
            TRIAGE_KEY: json.dumps({"action": "answer"}),
            TOOLS_KEY: json.dumps({"selected_tools": []}),
            ANATOMY_KEY: json.dumps({"has_anatomy": False}),
            SAFETY_KEY: json.dumps({"is_safe": True, "issues": [], "revised_answer": ""}),
        }
        p = AgentPipeline(
            llm=BrokenStreamLLM(script),
            evidence=FakeEvidence(response="MediSearch fallback summary."),
        )
        with pytest.raises(ReviewUnavailable):
            await p.run(["What is flu?"], "cid")


class TestToolFlow:
    @pytest.mark.parametrize("tool,question,inputs,field,expected", [
        ("bmi", "I am 30, weigh 70 kg and am 175 cm tall. What is my BMI?",
         {"weight_kg": 70, "height_cm": 175, "age_years": 30}, "bmi", 22.9),
        ("non_hdl_cholesterol", "My total cholesterol is 200 mg/dL and HDL is 50 mg/dL on the same panel. What is non-HDL?",
         {"total_cholesterol": 200, "hdl_cholesterol": 50, "total_units": "mg/dL", "hdl_units": "mg/dL"}, "value", 150),
    ])
    async def test_tool_selection_and_execution(self, tool, question, inputs, field, expected):
        p = make_pipeline(
            {"action": "answer"},
            tools={"selected_tools": [tool]},
            extract=inputs,
        )
        result = await p.run([question], "cid")
        assert result["tool_results"][0][field] == expected
        assert result["tool_results"][0]["source"].startswith("https://")
        assert result["tool_results"][0]["scope"]


class TestPromptCacheLayout:
    async def test_system_messages_identical_across_conversations(self):


        p = make_pipeline({"action": "answer"})
        await p.run(["What is hypertension?"], "cid1")
        first_systems = [system for _, system in p.llm.calls]
        first_users = [user for user, _ in p.llm.calls]

        p.llm.calls.clear()
        p.step_cache = type(p.step_cache)()
        await p.run(["Why does my knee hurt after running?"], "cid2")
        second_systems = [system for _, system in p.llm.calls]
        second_users = [user for user, _ in p.llm.calls]


        assert sorted(first_systems) == sorted(second_systems)
        assert all(s for s in first_systems)
        assert sorted(first_users) != sorted(second_users)

    async def test_dynamic_content_never_in_system(self):
        p = make_pipeline({"action": "answer"})
        question = "What is hypertension?"
        await p.run([question], "cid")
        for _, system in p.llm.calls:
            assert question not in system


class TestStepCaching:
    async def test_repeat_conversation_skips_classification_calls(self):
        p = make_pipeline({"action": "answer"})
        await p.run(["What is flu?"], "cid1")
        calls_first = len(p.llm.calls)
        await p.run(["What is flu?"], "cid2")
        calls_second = len(p.llm.calls) - calls_first


        assert calls_second < calls_first
        assert p.step_cache.hits >= 2

    async def test_evidence_cache_reuses_search(self):
        class CountingEvidence(FakeEvidence):
            def __init__(self):
                super().__init__()
                self.searches = 0

            def search(self, conversation, conversation_id):
                self.searches += 1
                return super().search(conversation, conversation_id)

        evidence = CountingEvidence()
        script = {
            TRIAGE_KEY: json.dumps({"action": "answer"}),
            TOOLS_KEY: json.dumps({"selected_tools": []}),
            ANATOMY_KEY: json.dumps({"has_anatomy": False}),
            SAFETY_KEY: json.dumps({"is_safe": True, "issues": [], "revised_answer": ""}),
        }
        p = AgentPipeline(llm=FakeLLM(script), evidence=evidence)
        await p.run(["What is flu?"], "cid1")
        await p.run(["What is flu?"], "cid1")
        assert evidence.searches == 1
        await p.run(["What is flu?"], "cid2")
        assert evidence.searches == 2


class TestTokenBudgets:
    async def test_generation_and_each_review_receive_identical_bounded_evidence(self):
        p = make_pipeline({"action": "answer"})
        evidence = {
            "articles": [{"title": "Reference", "year": "2025", "journal": "Journal",
                          "url": "https://example.org/reference", "tldr": "x" * 2000}],
            "response": "summary " * 1000,
        }
        expected = p._build_answer_user("q?", [], evidence).split("Retrieved medical source excerpts:\n", 1)[1]
        reviews = []

        async def review(user, **kwargs):
            reviews.append(user.split("Available citations:\n", 1)[1])
            if len(reviews) == 1:
                return json.dumps({"is_safe": False, "issues": ["Revise"], "revised_answer": "Revised [1]."})
            return json.dumps({"is_safe": True, "issues": [], "revised_answer": ""})

        p.llm.generate = review
        assert await p._safety_check("q?", "Draft [1].", evidence) == "Revised [1]."
        assert reviews == [expected, expected]
        assert "https://example.org/reference" in expected
        assert "not an independent source" in expected
        assert "x" * (p.max_tldr_chars + 1) not in expected
        assert "summary " * 1000 not in expected

    async def test_answer_prompt_caps_articles_and_tldr(self):
        many_articles = [
            {
                "title": f"Study {i}",
                "year": 2020 + i,
                "journal": "J",
                "tldr": "x" * 2000,
                "url": f"http://x/{i}",
            }
            for i in range(20)
        ]
        script = {
            TRIAGE_KEY: json.dumps({"action": "answer"}),
            TOOLS_KEY: json.dumps({"selected_tools": []}),
            ANATOMY_KEY: json.dumps({"has_anatomy": False}),
            SAFETY_KEY: json.dumps({"is_safe": True, "issues": [], "revised_answer": ""}),
        }
        p = AgentPipeline(
            llm=FakeLLM(script),
            evidence=FakeEvidence(articles=many_articles, response="y" * 5000),
        )
        user = p._build_answer_user("q?", [], {"articles": many_articles, "response": "y" * 5000})
        assert f"[{p.max_evidence_articles}]" in user
        assert f"[{p.max_evidence_articles + 1}]" not in user
        assert "x" * (p.max_tldr_chars + 10) not in user
        assert "y" * (p.max_summary_chars + 10) not in user


def label_item(section, text="Official label text."):
    return {"title": f"METFORMIN label: {section}", "section": section, "url": "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=x",
            "year": "2025", "journal": "US FDA label (openFDA)", "tldr": text, "evidence_kind": "label_section"}


def reference_pipeline(tool_results, articles=None, response="Primary summary."):
    p = make_pipeline({"action": "answer"})
    p.evidence = FakeEvidence(articles=articles, response=response)

    async def run_tools(conv_text, info=None):
        if info is not None:
            info["selected"] = len(tool_results)
        return tool_results

    p._run_tools = run_tools
    return p


class TestLabelSourceMerge:
    async def test_label_sections_precede_abstracts_and_drop_primary_summary(self):
        from app.tools.references import REFERENCE_TOOLS
        pubmed_name = REFERENCE_TOOLS["pubmed_search"]["name"]
        tools = [
            {"tool": pubmed_name, "status": "available", "items": [
                {"title": "Abstract", "url": "https://pubmed.example/1", "tldr": "abstract", "evidence_kind": "abstract"}]},
            {"tool": "FDA label sections", "status": "available", "items": [label_item("boxed_warning"), label_item("indications_and_usage")]},
        ]
        p = reference_pipeline(tools)
        events = await collect(p, ["What does the metformin label say?"])
        result = events[-1][1]
        titles = [a["title"] for a in result["articles"]]
        assert titles == ["Study A", "METFORMIN label: boxed_warning", "METFORMIN label: indications_and_usage", "Abstract"]
        user = next(user for user, system in p.llm.calls if "Retrieved medical source excerpts" in user)
        assert "Primary summary." not in user
        assert [s["kind"] for s in result["handoff"]["sources"]] == ["research", "label_section", "label_section", "abstract"]
        assert "Label excerpts are from the US label" in " ".join(result["handoff"]["limitations"])

    async def test_primary_summary_kept_without_extras(self):
        p = reference_pipeline([])
        result = await p.run(["Explain"], "c")
        user = next(user for user, system in p.llm.calls if "Retrieved medical source excerpts" in user)
        assert "Primary summary." in user
        assert [a["title"] for a in result["articles"]] == ["Study A"]

    async def test_labels_capped_at_five_and_total_bounded(self):
        sections = [label_item(f"s{i}") for i in range(8)]
        tools = [{"tool": "FDA label sections", "status": "available", "items": sections}]
        primary = [{"title": f"P{i}", "year": 2023, "journal": "J", "tldr": "t", "url": f"https://p/{i}"} for i in range(8)]
        p = reference_pipeline(tools, articles=primary)
        result = await p.run(["Explain"], "c")
        articles = result["articles"]
        assert len(articles) == p.max_evidence_articles
        labels = [a for a in articles if a.get("evidence_kind") == "label_section"]
        assert len(labels) == 5
        assert [a["title"] for a in articles[:p.max_evidence_articles - 5]] == [f"P{i}" for i in range(p.max_evidence_articles - 5)]

    async def test_label_sections_supply_evidence_when_primary_empty(self):
        tools = [{"tool": "FDA label sections", "status": "available", "items": [label_item("boxed_warning")]}]
        p = reference_pipeline(tools, articles=[])
        result = await p.run(["What does the label say?"], "c")
        assert result["type"] == "answer" and result["evidence_status"] == "available"
        assert [a["evidence_kind"] for a in result["articles"]] == ["label_section"]
        h = result["handoff"]
        assert h["trace"]["steps"][2]["status"] == "fallback"
        assert h["trace"]["steps"][2]["detail"] == "reference_sources"

    async def test_items_without_excerpts_do_not_supply_evidence(self):
        tools = [{"tool": "FDA label sections", "status": "available", "items": [{"title": "Directory", "url": "https://x"}]}]
        p = reference_pipeline(tools, articles=[])
        result = await p.run(["Explain"], "c")
        assert result["evidence_status"] == "unavailable"

    async def test_primary_duplicates_of_label_urls_yield_to_the_excerpt(self):
        label = label_item("boxed_warning")
        primary = [{"title": "Same", "year": 2024, "journal": "J", "tldr": "t", "url": label["url"]},
                   {"title": "Other", "year": 2024, "journal": "J", "tldr": "t", "url": "https://p/other"}]
        p = reference_pipeline([{"tool": "FDA label sections", "status": "available", "items": [label]}], articles=primary)
        result = await p.run(["Explain"], "c")
        assert [a["title"] for a in result["articles"]] == ["Other", label["title"]]

    async def test_full_capacity_overlap_keeps_every_label_section_and_fills_with_primary(self):
        sections = [label_item(f"s{i}") for i in range(5)]
        shared = sections[0]["url"]
        primary = [{"title": f"P{i}", "year": 2023, "journal": "J", "tldr": "t", "url": shared if i < 3 else f"https://p/{i}"}
                   for i in range(8)]
        p = reference_pipeline([{"tool": "FDA label sections", "status": "available", "items": sections}], articles=primary)
        result = await p.run(["Explain"], "c")
        titles = [a["title"] for a in result["articles"]]
        assert len(titles) == p.max_evidence_articles
        assert titles[p.max_evidence_articles - 5:] == [s["title"] for s in sections]
        assert titles[:p.max_evidence_articles - 5] == [f"P{i}" for i in range(3, 3 + p.max_evidence_articles - 5)]


class TestEvidenceFailure:
    async def test_raising_evidence_double_yields_unavailable_result(self):
        class Boom:
            def search(self, conversation, conversation_id):
                raise RuntimeError("provider exploded")

        p = make_pipeline({"action": "answer"})
        p.evidence = Boom()
        result = await p.run(["What is flu?"], "cid")
        assert result["type"] == "answer"
        assert result["evidence_status"] == "unavailable"
        assert result["articles"] == []
        assert p.outcome_stats()["evidence_unavailable"] == 1

    async def test_raising_async_evidence_is_not_cached(self):
        class Boom:
            async def search(self, conversation, conversation_id):
                raise TimeoutError

        p = make_pipeline({"action": "answer"})
        p.evidence = Boom()
        assert (await p.run(["What is flu?"], "cid"))["evidence_status"] == "unavailable"
        p.evidence = FakeEvidence()
        assert (await p.run(["What is flu?"], "cid"))["evidence_status"] == "available"
