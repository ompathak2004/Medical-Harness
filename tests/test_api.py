"""API-level tests with a mocked pipeline."""

import json
import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("CEREBRAS_API_KEY", "test-key")
os.environ.setdefault("MEDISEARCH_API_KEY", "test-key")

from app.main import create_app  # noqa: E402


from app.cache import TTLCache  # noqa: E402


class FakePipeline:
    def __init__(self):
        self.step_cache = TTLCache()
        self.evidence_cache = TTLCache()

    async def run(self, conversation, conversation_id):
        return {
            "type": "answer",
            "follow_up_questions": [],
            "preliminary_info": "",
            "answer": "test answer",
            "articles": [],
            "tool_results": [],
            "followups": [],
            "anatomy_context": None,
            "emergency": False,
            "emergency_message": "",
        }

    async def run_streaming(self, conversation, conversation_id):
        yield ("step", {"step": "triage", "message": "Analyzing…"})
        yield ("answer_chunk", {"text": "hello "})
        result = await self.run(conversation, conversation_id)
        yield ("result", result)


@pytest.fixture
def client():
    app = create_app()
    with TestClient(app) as c:
        c.app.state.pipeline = FakePipeline()
        yield c


def test_health(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_metrics_numbers_only(client, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "metrics_token", "metrics-test")
    resp = client.get("/api/metrics", headers={"Authorization": "Bearer metrics-test"})
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"llm", "step_cache", "evidence_cache"}
    llm = body["llm"]
    assert set(llm) == {
        "requests", "prompt_tokens", "completion_tokens",
        "cached_tokens", "prompt_cache_hit_ratio",
    }
    # PHI-free contract: every value is a plain number.
    for section in body.values():
        for value in section.values():
            assert isinstance(value, (int, float))


def test_index_serves_html(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "<!DOCTYPE html>" in resp.text


def test_chat_valid(client):
    resp = client.post("/api/chat", json={"conversation": ["What is flu?"]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["type"] == "answer"
    assert body["answer"] == "test answer"
    assert body["conversation_id"]


def test_chat_rejects_empty_conversation(client):
    resp = client.post("/api/chat", json={"conversation": []})
    assert resp.status_code == 422  # pydantic min_length


def test_chat_rejects_even_message_count(client):
    resp = client.post("/api/chat", json={"conversation": ["q", "a"]})
    assert resp.status_code == 400


def test_chat_rejects_oversized_message(client):
    resp = client.post("/api/chat", json={"conversation": ["x" * 10_000]})
    assert resp.status_code == 413


def test_chat_rejects_blank_last_message(client):
    resp = client.post("/api/chat", json={"conversation": ["   "]})
    assert resp.status_code == 400


def test_chat_stream_sse_events(client):
    with client.stream(
        "POST", "/api/chat/stream", json={"conversation": ["What is flu?"]}
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        raw = "".join(chunk for chunk in resp.iter_text())
    assert "event: meta" in raw
    assert "event: step" in raw
    assert "event: answer_chunk" in raw
    assert "event: result" in raw
    # result payload parses and matches contract
    for block in raw.split("\n\n"):
        if block.startswith("event: result"):
            data_line = [l for l in block.split("\n") if l.startswith("data:")][0]
            payload = json.loads(data_line[5:])
            assert payload["type"] == "answer"


def test_metrics_private_by_default(client):
    assert client.get("/api/metrics").status_code == 404


def test_health_response_does_not_allow_storage(client):
    response = client.get("/api/health")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "medisearch_session" in client.cookies


def test_spoofed_forwarded_header_does_not_reset_rate_limit(client, monkeypatch):
    from app.config import get_settings
    for i in range(get_settings().rate_limit_requests):
        response = client.post("/api/chat", json={"conversation": ["Question"]}, headers={"X-Forwarded-For": f"192.0.2.{i}"})
        assert response.status_code == 200
    assert client.post("/api/chat", json={"conversation": ["Question"]}, headers={"X-Forwarded-For": "203.0.113.1"}).status_code == 429
