import asyncio
import json

import httpx
import pytest

from app.cache import TTLCache
from app.evidence import EvidenceRetriever
from app.pipeline import ReviewUnavailable, cache_scope
from tests.test_pipeline import make_pipeline, collect, FakeEvidence, SAFETY_KEY, TRIAGE_KEY


async def test_only_reviewed_revision_reaches_stream():
    pipeline = make_pipeline({"action": "answer"}, safety={"is_safe": False, "revised_answer": "Reviewed answer."})
    events = await collect(pipeline, ["What is flu?"])
    chunks = [data["text"] for kind, data in events if kind == "answer_chunk"]
    assert chunks == ["Reviewed answer."]
    assert events[-1][1]["answer"] == "Reviewed answer."


@pytest.mark.parametrize("review", [{}, {"is_safe": "true"}, {"is_safe": False}, {"is_safe": False, "revised_answer": ""}])
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
    pipeline = make_pipeline({"action": "emergency"})
    result = await pipeline.run(["I cannot breathe"], "c")
    assert result["emergency"]
    assert len(pipeline.llm.calls) == 1
    assert result["anatomy_context"] is None


async def test_missing_evidence_is_explicit_and_skips_answer_generation():
    pipeline = make_pipeline({"action": "answer"})
    pipeline.evidence = FakeEvidence(articles=[], response="Unverified summary")
    result = await pipeline.run(["Question"], "c")
    assert result["evidence_status"] == "unavailable"
    assert "Unverified summary" not in result["answer"]
    assert not any(SAFETY_KEY in system for _, system in pipeline.llm.calls)


async def test_missing_calculator_inputs_never_become_zero():
    pipeline = make_pipeline({"action": "answer"}, tools={"selected_tools": ["bmi"]}, extract={"weight_kg": 70})
    result = await pipeline.run(["I weigh 70kg"], "c")
    assert result["tool_results"] == []


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
