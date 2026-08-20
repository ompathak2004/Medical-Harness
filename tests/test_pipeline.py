"""Pipeline flow tests with mocked LLM and evidence clients."""

import json

import pytest

from app.pipeline import AgentPipeline


class FakeLLM:
    """Scripted LLM: returns responses keyed by prompt substring."""

    def __init__(self, script: dict[str, str], stream_text: str = "streamed answer [1]."):
        self.script = script
        self.stream_text = stream_text
        self.prompts: list[str] = []

    async def generate(self, prompt: str) -> str:
        self.prompts.append(prompt)
        for key, response in self.script.items():
            if key in prompt:
                return response
        return "{}"

    async def generate_stream(self, prompt: str):
        self.prompts.append(prompt)
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
        assert result["preliminary_info"] == "Headaches are common."
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
    async def test_triage_failure_defaults_to_answer(self):
        class BrokenTriageLLM(FakeLLM):
            async def generate(self, prompt):
                if TRIAGE_KEY in prompt:
                    raise RuntimeError("boom")
                return await super().generate(prompt)

        script = {
            TOOLS_KEY: json.dumps({"selected_tools": []}),
            ANATOMY_KEY: json.dumps({"has_anatomy": False}),
            SAFETY_KEY: json.dumps({"is_safe": True, "issues": [], "revised_answer": ""}),
        }
        p = AgentPipeline(llm=BrokenTriageLLM(script), evidence=FakeEvidence())
        result = await p.run(["What is asthma?"], "cid")
        assert result["type"] == "answer"

    async def test_stream_failure_falls_back_to_evidence_summary(self):
        class BrokenStreamLLM(FakeLLM):
            async def generate_stream(self, prompt):
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
        result = await p.run(["What is flu?"], "cid")
        assert "MediSearch fallback summary." in result["answer"]


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
