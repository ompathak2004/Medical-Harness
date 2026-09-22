"""Pipeline flow tests with mocked LLM and evidence clients."""

import json

import pytest

from app.pipeline import AgentPipeline, ReviewUnavailable


class FakeLLM:
    """Scripted LLM: returns responses keyed by system-prompt substring."""

    def __init__(self, script: dict[str, str], stream_text: str = "streamed answer [1]."):
        self.script = script
        self.stream_text = stream_text
        self.prompts: list[str] = []  # combined system + user text per call
        self.calls: list[tuple[str, str]] = []  # (user, system) per call

    async def generate(self, user: str, system: str | None = None) -> str:
        combined = f"{system or ''}\n{user}"
        self.prompts.append(combined)
        self.calls.append((user, system or ""))
        for key, response in self.script.items():
            if key in combined:
                return response
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
    script = {
        TRIAGE_KEY: json.dumps(triage),
        TOOLS_KEY: json.dumps(tools or {"selected_tools": []}),
        ANATOMY_KEY: json.dumps(anatomy or {"has_anatomy": False}),
        SAFETY_KEY: json.dumps(safety or {"is_safe": True, "issues": [], "revised_answer": ""}),
        EXTRACT_KEY: json.dumps(extract or {}),
    }
    return AgentPipeline(llm=FakeLLM(script), evidence=FakeEvidence())


async def collect(pipeline, conversation):
    events = []
    async for ev in pipeline.run_streaming(conversation, "test-conv"):
        events.append(ev)
    return events


class TestAnswerPath:
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
            safety={"is_safe": False, "issues": ["overclaim"], "revised_answer": "revised safe answer"},
        )
        events = await collect(p, ["Is coffee good for me?"])
        result = events[-1][1]
        assert result["answer"] == "revised safe answer"

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
        # Two prior assistant clarification turns (short, question-bearing).
        conversation = [
            "I have a headache",
            "How long has it lasted? Any fever?",
            "3 days, no fever",
            "Is the pain one-sided? Any visual changes?",
            "It is one-sided, no visual changes",
        ]
        events = await collect(p, conversation)
        result = events[-1][1]
        assert result["type"] == "answer"


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
        # No tools/evidence steps should have run.
        step_names = [e[1]["step"] for e in events if e[0] == "step"]
        assert "tools" not in step_names
        assert "evidence" not in step_names

    async def test_emergency_default_message(self):
        p = make_pipeline({"action": "emergency", "emergency_message": ""})
        result = await p.run(["stroke symptoms"], "cid")
        assert result["emergency_message"]  # default applied


class TestDegradation:
    async def test_triage_failure_stops_generation(self):
        class BrokenTriageLLM(FakeLLM):
            async def generate(self, user, system=None):
                if TRIAGE_KEY in f"{system or ''}\n{user}":
                    raise RuntimeError("boom")
                return await super().generate(user, system)

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
                yield  # pragma: no cover

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
    async def test_tool_selection_and_execution(self):
        p = make_pipeline(
            {"action": "answer"},
            tools={"selected_tools": ["bmi"]},
            extract={"weight_kg": 70, "height_cm": 175},
        )
        result = await p.run(["My weight is 70kg and height 175cm, what's my BMI?"], "cid")
        assert result["tool_results"]
        assert result["tool_results"][0]["tool"].lower().startswith("b")


class TestPromptCacheLayout:
    async def test_system_messages_identical_across_conversations(self):
        """Each pipeline step must send a byte-identical system message for
        different conversations, or Cerebras prefix caching cannot reuse it."""
        p = make_pipeline({"action": "answer"})
        await p.run(["What is hypertension?"], "cid1")
        first_systems = [system for _, system in p.llm.calls]
        first_users = [user for user, _ in p.llm.calls]

        p.llm.calls.clear()
        p.step_cache = type(p.step_cache)()  # fresh cache so LLM is re-hit
        await p.run(["Why does my knee hurt after running?"], "cid2")
        second_systems = [system for _, system in p.llm.calls]
        second_users = [user for user, _ in p.llm.calls]

        # Compare as multisets: byte-identity is the invariant, not call order
        # (asyncio scheduling could reorder concurrent steps).
        assert sorted(first_systems) == sorted(second_systems)
        assert all(s for s in first_systems)  # every call has a system message
        assert sorted(first_users) != sorted(second_users)  # dynamic content lives in user msg

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
        # Triage, tool selection, anatomy are cached; only the streamed
        # answer + safety check hit the LLM on the repeat run.
        assert calls_second < calls_first
        assert p.step_cache.hits >= 3

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
