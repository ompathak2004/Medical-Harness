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


def test_metrics_numbers_only(client):
    resp = client.get("/api/metrics")
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


# ── /api/anatomy/ground ──────────────────────────────────────────────────


def test_anatomy_ground_resolves_term(client):
    resp = client.get("/api/anatomy/ground", params={"term": "heart artery"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["query"] == "heart artery"
    assert body["result"]["matched_name"] == "coronary artery"
    assert body["result"]["scene"] == "heart"
    assert body["result"]["structure_ids"]


def test_anatomy_ground_unknown_term_returns_null_result(client):
    resp = client.get("/api/anatomy/ground", params={"term": "flux capacitor"})
    assert resp.status_code == 200
    assert resp.json()["result"] is None


def test_anatomy_ground_rejects_empty_term(client):
    resp = client.get("/api/anatomy/ground", params={"term": "   "})
    assert resp.status_code == 400


def test_anatomy_ground_rejects_oversized_term(client):
    resp = client.get("/api/anatomy/ground", params={"term": "x" * 201})
    assert resp.status_code == 400
