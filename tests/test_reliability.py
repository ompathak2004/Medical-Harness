import asyncio
import json

import httpx
import pytest

from app.cache import TTLCache
from app.evidence import EvidenceRetriever
from app.pipeline import ReviewUnavailable, cache_scope
from tests.test_pipeline import make_pipeline, collect, FakeEvidence, SAFETY_KEY


async def test_only_reviewed_revision_reaches_stream():
    pipeline = make_pipeline({"action": "answer"}, safety={
        "is_safe": False, "issues": ["Missing context"], "revised_answer": "Reviewed answer [1].",
    })
    events = await collect(pipeline, ["What is flu?"])
    chunks = [data["text"] for kind, data in events if kind == "answer_chunk"]
    assert chunks == ["Reviewed answer [1]."]
    assert events[-1][1]["answer"] == "Reviewed answer [1]."


@pytest.mark.parametrize("review", [
    {},
    {"is_safe": True},
    {"is_safe": "true", "issues": [], "revised_answer": ""},
    {"is_safe": True, "issues": None, "revised_answer": ""},
    {"is_safe": True, "issues": [], "revised_answer": "Unexpected revision [1]."},
    {"is_safe": False, "issues": [], "revised_answer": "Unexpected approval [1]."},
])
async def test_invalid_review_fails_closed(review):
    pipeline = make_pipeline({"action": "answer"})
    pipeline.llm.script[SAFETY_KEY] = json.dumps(review)
    emitted = []
    with pytest.raises(ReviewUnavailable):
        async for kind, data in pipeline.run_streaming(["What is flu?"], "c"):
            emitted.append(kind)
    assert "answer_chunk" not in emitted
    assert "result" not in emitted


async def test_answer_and_review_include_original_context():
    pipeline = make_pipeline({"action": "answer"})
    await pipeline.run(["I am allergic to penicillin", "Which medicine?", "Amoxicillin"], "c")
    for user, system in pipeline.llm.calls:
        if "Generate a clear" in system or SAFETY_KEY in system:
            assert "allergic to penicillin" in user
            assert "Amoxicillin" in user


async def test_emergency_uses_one_call_and_no_evidence_or_anatomy():
    pipeline = make_pipeline({"action": "emergency", "follow_up_questions": None, "conversation_kind": []})
    result = await pipeline.run(["I cannot breathe"], "c")
    assert result["emergency"]
    assert len(pipeline.llm.calls) == 1
    assert result["anatomy_context"] is None


@pytest.mark.parametrize("articles", [[], [{"title": "Metadata only", "url": "https://example.org", "tldr": "  "}]])
async def test_missing_evidence_is_explicit_and_skips_answer_generation(articles):
    pipeline = make_pipeline({"action": "answer"})
    pipeline.evidence = FakeEvidence(articles=articles, response="Unverified summary")
    result = await pipeline.run(["Question"], "c")
    assert result["evidence_status"] == "unavailable"
    assert "Unverified summary" not in result["answer"]
    assert not any(SAFETY_KEY in system for _, system in pipeline.llm.calls)


async def test_metadata_only_sources_are_excluded_before_citation_numbering():
    pipeline = make_pipeline({"action": "answer"})
    pipeline.evidence = FakeEvidence(articles=[
        {"title": "Metadata only", "url": "https://example.org/metadata"},
        {"title": "Study with an excerpt", "url": "https://example.org/study", "tldr": "Synthetic supporting excerpt."},
    ], response="Old summary [2]")
    result = await pipeline.run(["Explain a health topic"], "c")
    assert [article["title"] for article in result["articles"]] == ["Study with an excerpt"]
    assert result["handoff"]["sources"][0]["cited"] is True
    assert all("Old summary" not in user for user, _ in pipeline.llm.calls)


async def test_missing_calculator_inputs_never_become_zero():
    pipeline = make_pipeline({"action": "answer"}, tools={"selected_tools": ["bmi"]}, extract={"weight_kg": 70})
    result = await pipeline.run(["I weigh 70kg"], "c")
    (tool_result,) = result["tool_results"]
    assert tool_result["missing_inputs"] == ["height_cm", "age_years"]
    assert "bmi" not in tool_result and "value" not in tool_result
    assert result["handoff"]["reason"] == "tool_input_missing"


@pytest.mark.parametrize("key", ["child_dose_check", "ors_planner", "peak_flow_zone", "hf_weight_zone"])
async def test_high_risk_tools_require_form_inputs_without_waiting_for_evidence(key):
    class WaitingEvidence:
        async def search(self, conversation, conversation_id):
            await asyncio.Future()

    pipeline = make_pipeline({"action": "answer"}, tools={"selected_tools": [key]}, extract={
        "medicine": "acetaminophen", "concentration": "160mg/5mL", "weight": 14, "weight_units": "kg", "age_months": 36,
    })
    pipeline.evidence = WaitingEvidence()
    events = await asyncio.wait_for(collect(pipeline, ["I do not know all the values. Can you calculate this?"]), timeout=2)
    result = events[-1][1]
    (tool,) = result["tool_results"]
    assert tool["key"] == key and tool["status"] == "confirmation_required"
    assert set(tool) == {"key", "tool", "source", "scope", "status", "error"}
    assert result["handoff"]["reason"] == "tool_confirmation_required"
    assert not result["articles"]
    assert not any(event == "answer_chunk" for event, _ in events)


async def test_browser_sessions_do_not_share_patient_cache_entries():
    pipeline = make_pipeline({"action": "answer"})
    token = cache_scope.set("browser-one")
    try:
        await pipeline.run(["Question"], "c")
        first = len(pipeline.llm.calls)
        cache_scope.set("browser-two")
        await pipeline.run(["Question"], "c")
        assert len(pipeline.llm.calls) == first * 2
    finally:
        cache_scope.reset(token)


async def test_concurrent_requests_share_work_and_survive_one_cancellation():
    cache = TTLCache()
    started, release = asyncio.Event(), asyncio.Event()
    calls = 0
    async def compute():
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return {"value": 7}
    first = asyncio.create_task(cache.get_or_compute("same", compute))
    await started.wait()
    second = asyncio.create_task(cache.get_or_compute("same", compute))
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    release.set()
    assert await second == {"value": 7}
    assert calls == 1
    assert not cache._pending


async def test_failures_are_not_cached():
    cache = TTLCache()
    async def fail():
        raise ValueError("provider failed")
    for _ in range(2):
        with pytest.raises(ValueError):
            await cache.get_or_compute("same", fail)
    assert not cache._pending
    assert cache.get("same") is None


async def test_medisearch_sse_contract_and_source_validation():
    async def respond(request):
        payload = json.loads(request.content)
        assert payload["conversation"] == ["Question"]
        assert payload["settings"]["model_type"] == "standard"
        events = [
            {"event": "llm_response", "data": "Evidence"},
            {"event": "articles", "data": [{"title": "Study", "url": "https://example.org"}, "invalid"]},
            {"event": "followups", "data": ["Next?", 5]},
        ]
        return httpx.Response(200, text="".join("data: " + json.dumps(event) + "\n\n" for event in events))
    retriever = EvidenceRetriever("test")
    await retriever.client.aclose()
    retriever.client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    try:
        result = await retriever.search(["Question"], "c")
        assert result["response"] == "Evidence"
        assert len(result["articles"]) == 1
        assert result["followups"] == ["Next?"]
    finally:
        await retriever.aclose()
