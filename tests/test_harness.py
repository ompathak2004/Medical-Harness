import asyncio
import json

import httpx
import pytest
from pydantic import ValidationError

from app.cache import TTLCache
from app.config import Settings
from app.evidence import normalize_articles
from app.llm import CerebrasClient, LLMError
from app.pipeline import ReviewUnavailable
from app.tools.anatomy import select_anatomy
from app.transport import CircuitBreaker, CircuitOpen
from tests.test_pipeline import make_pipeline, collect


async def test_last_cancelled_waiter_stops_provider_work():
    cache = TTLCache()
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def compute():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    task = asyncio.create_task(cache.get_or_compute("key", compute))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cancelled.is_set()
    assert not cache._pending


def test_disabled_cache_and_expired_data_cleanup(monkeypatch):
    cache = TTLCache(max_entries=0)
    cache.put("x", 1)
    assert cache.stats()["size"] == 0
    cache = TTLCache(ttl_seconds=1)
    monkeypatch.setattr("app.cache.time.monotonic", lambda: 1)
    cache.put("x", 1)
    monkeypatch.setattr("app.cache.time.monotonic", lambda: 3)
    assert cache.stats()["size"] == 0


def test_circuit_cooldown_and_one_probe(monkeypatch):
    now = [0]
    monkeypatch.setattr("app.transport.time.monotonic", lambda: now[0])
    circuit = CircuitBreaker(threshold=2, cooldown=10)
    circuit.failure()
    circuit.acquire()
    circuit.failure()
    with pytest.raises(CircuitOpen):
        circuit.acquire()
    now[0] = 11
    circuit.acquire()
    with pytest.raises(CircuitOpen):
        circuit.acquire()
    circuit.cancel()
    circuit.acquire()
    circuit.success()
    circuit.acquire()


@pytest.mark.parametrize("field,value", [("llm_max_retries", 0), ("max_concurrent_requests", 0), ("step_cache_ttl_seconds", -1), ("request_timeout_seconds", 180)])
def test_invalid_configuration_rejected(field, value):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, cerebras_api_key="test", medisearch_api_key="test", **{field: value})


@pytest.mark.parametrize("text", ["No citations", "Bad [0]", "Invented [2]", "Mixed [1, 8]"])
async def test_invalid_reviewed_citations_never_published(text):
    pipeline = make_pipeline({"action": "answer"})
    pipeline.llm.stream_text = text
    emitted = []
    with pytest.raises(ReviewUnavailable):
        async for kind, _ in pipeline.run_streaming(["Question"], "c"):
            emitted.append(kind)
    assert "answer_chunk" not in emitted
    assert "result" not in emitted


async def test_anatomy_selected_by_triage_without_extra_call():
    pipeline = make_pipeline({"action": "answer"}, anatomy={"scene_id": "knee", "reason": "See the bones around your knee."})
    result = await pipeline.run(["Where is the kneecap?"], "c")
    assert result["anatomy_context"]["scene_id"] == "knee"
    assert len(pipeline.llm.calls) == 4


@pytest.mark.parametrize("action", ["emergency", "conversation"])
async def test_nonmedical_or_emergency_path_suppresses_anatomy(action):
    pipeline = make_pipeline({"action": action, "conversation_kind": "greeting"}, anatomy={"scene_id": "chest", "reason": "View"})
    result = await pipeline.run(["Hi"], "c")
    assert result["anatomy_context"] is None


@pytest.mark.parametrize("value", [None, [], {"scene_id": "unknown", "reason": "x"}, {"scene_id": "knee"}, {"scene_id": "knee", "reason": 5}, {"scene_id": [], "reason": "x"}])
def test_invalid_anatomy_is_optional(value):
    assert select_anatomy(value) is None


def test_evidence_sanitizes_urls_metadata_and_duplicates():
    articles = normalize_articles([
        {"title": "Bad", "url": "javascript:alert(1)"},
        {"title": "Bad", "url": "https://user:password@example.com"},
        {"title": "Valid", "url": "https://example.org", "authors": "bad", "tldr": {"bad": True}},
        {"title": "Duplicate", "url": "https://example.org"},
    ])
    assert len(articles) == 1
    assert articles[0]["authors"] == []
    assert articles[0]["tldr"] == ""


async def mock_llm(handler, **kwargs):
    client = CerebrasClient("fake", **kwargs)
    await client._client.aclose()
    client._client = httpx.AsyncClient(base_url="https://example.org", transport=httpx.MockTransport(handler))
    return client


@pytest.mark.parametrize("reason", [None, "length", "content_filter"])
async def test_incomplete_provider_stream_fails(reason):
    def handler(request):
        chunks = [{"choices": [{"delta": {"content": "Partial answer [1]"}, "finish_reason": reason}]}]
        return httpx.Response(200, text="".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n")
    client = await mock_llm(handler)
    try:
        with pytest.raises(LLMError):
            async for _ in client.generate_stream("question"):
                pass
    finally:
        await client.aclose()


async def test_auth_failure_is_not_retried():
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(401)
    client = await mock_llm(handler)
    try:
        with pytest.raises(LLMError):
            async for _ in client.generate_stream("question"):
                pass
        assert len(calls) == 1
    finally:
        await client.aclose()


async def test_live_eval_cap_counts_retry_attempts(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(429)

    monkeypatch.setattr("app.llm._retry_delay", lambda exc, attempt: 0)
    client = await mock_llm(handler, request_budget=1)
    try:
        with pytest.raises(LLMError):
            await client.generate("Synthetic test")
        assert len(calls) == client.usage_stats()["requests"] == 1
    finally:
        await client.aclose()


async def test_json_stage_has_explicit_budget_and_temperature():
    def handler(request):
        payload = json.loads(request.content)
        assert payload["max_tokens"] == 600
        assert payload["temperature"] == 0
        assert payload["response_format"] == {"type": "json_object"}
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": "{}"}}]})
    client = await mock_llm(handler)
    try:
        assert await client.generate("question", max_tokens=600, json_mode=True) == "{}"
    finally:
        await client.aclose()


async def test_rejected_revision_cannot_escape_second_review():
    pipeline = make_pipeline({"action": "answer"})
    pipeline.llm.script["medical safety reviewer"] = json.dumps({"is_safe": False, "revised_answer": "Still unsafe [1]"})
    with pytest.raises(ReviewUnavailable):
        await collect(pipeline, ["Question"])


async def test_accepted_flag_with_issues_is_not_a_pass():
    pipeline = make_pipeline({"action": "answer"}, safety={"is_safe": True, "issues": ["unsafe"]})
    with pytest.raises(ReviewUnavailable):
        await collect(pipeline, ["Question"])
