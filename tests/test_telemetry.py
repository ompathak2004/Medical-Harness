import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import httpx
from fastapi.testclient import TestClient
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, StatusCode
from pydantic import AnyHttpUrl, SecretStr

from app import llm as llm_module
from app.config import get_settings
from app.main import create_app
from app.telemetry import Telemetry


def _event(data):
    return "data: " + json.dumps(data) + "\n\ndata: [DONE]\n\n"


def test_stream_trace_records_retry_and_review_failure_without_payloads(monkeypatch, caplog):
    private = "SYNTHETIC-PRIVATE-INPUT"
    exporter = InMemorySpanExporter()
    provider = TracerProvider(shutdown_on_exit=False)
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(Telemetry, "configure", lambda settings: Telemetry(provider))
    monkeypatch.setattr(llm_module, "_retry_delay", lambda exc, attempt: 0)
    calls = 0

    def model(request):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, json={"private": private})
        payload = json.loads(request.content)
        system = payload["messages"][0]["content"]
        usage = {"prompt_tokens": 30, "completion_tokens": 6}
        if payload["stream"]:
            return httpx.Response(200, text=_event({
                "choices": [{"delta": {"content": f"{private} [1]."}, "finish_reason": "stop"}], "usage": usage,
            }))
        if "medical triage assistant" in system:
            output = {"action": "answer"}
        elif "clinical decision support" in system:
            output = {"selected_tools": ["bmi"]}
        elif "extracting clinical variables" in system:
            output = {"age_years": 34, "weight_kg": 70, "height_cm": 175, "private": private}
        else:
            output = {"is_safe": True}
        return httpx.Response(200, json={
            "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(output)}}], "usage": usage,
        })

    def evidence(request):
        return httpx.Response(200, text=_event({
            "event": "articles", "data": [{"title": private, "tldr": private, "url": "https://example.org/source"}],
        }))

    with TestClient(create_app()) as client:
        pipeline = client.app.state.pipeline
        client.portal.call(pipeline.llm._client.aclose)
        client.portal.call(pipeline.evidence.client.aclose)
        pipeline.llm._client = httpx.AsyncClient(transport=httpx.MockTransport(model), base_url="https://model.example")
        pipeline.evidence.client = httpx.AsyncClient(transport=httpx.MockTransport(evidence))
        response = client.post(f"/api/chat/stream?input={private}", json={
            "conversation": [private], "conversation_id": private,
        }, headers={"X-Request-ID": private})
        assert response.status_code == 200
        assert "event: error" in response.text and "event: result" not in response.text
        spans = exporter.get_finished_spans()
        root = next(span for span in spans if span.kind is SpanKind.SERVER)
        request_id = response.headers["X-Request-ID"]
        assert re.fullmatch(r"[0-9a-f]{32}", request_id)
        assert root.attributes["medical_harness.request_id"] == request_id
        assert root.attributes["medical_harness.outcome"] == "review_blocked"
        assert root.attributes["http.response.status_code"] == 200
        assert root.status.status_code is StatusCode.ERROR
        assert {span.name for span in spans} >= {
            "pipeline.triage", "pipeline.tools", "pipeline.evidence", "pipeline.draft", "pipeline.review",
            "tool.plan", "tool.extract", "tool.execute", "provider.cerebras", "provider.medisearch",
        }
        assert {span.context.trace_id for span in spans} == {root.context.trace_id}
        attempts = [span.attributes for span in spans if span.name == "provider.cerebras"]
        assert any(s["medical_harness.attempt"] == 1 and s["http.response.status_code"] == 429 for s in attempts)
        assert any(s["medical_harness.attempt"] == 2 and s["gen_ai.usage.input_tokens"] == 30 for s in attempts)
        assert all(private not in span.to_json() for span in spans)
        assert private not in caplog.text


def test_request_ids_cover_limits_and_release_revision(monkeypatch):
    sha = "a" * 40
    monkeypatch.setattr(get_settings(), "app_release_sha", sha)
    with TestClient(create_app()) as client:
        health = client.get("/api/health")
        assert health.json()["revision"] == sha
        rejected = client.post("/api/chat", json={"conversation": ["x" * 16001]})
        assert rejected.status_code == 413
        assert re.fullmatch(r"[0-9a-f]{32}", rejected.headers["X-Request-ID"])
        assert health.headers["X-Request-ID"] != rejected.headers["X-Request-ID"]


def test_otlp_http_exports_calculator_trace_to_local_receiver(monkeypatch):
    exports = []

    class Receiver(BaseHTTPRequestHandler):
        def do_POST(self):
            content = self.rfile.read(int(self.headers["Content-Length"]))
            exports.append((self.path, self.headers.get("Authorization"), ExportTraceServiceRequest.FromString(content)))
            self.send_response(200)
            self.end_headers()

    with ThreadingHTTPServer(("127.0.0.1", 0), Receiver) as receiver:
        thread = Thread(target=receiver.serve_forever, daemon=True)
        thread.start()
        try:
            settings = get_settings()
            monkeypatch.setenv("VERCEL", "1")
            monkeypatch.setattr(settings, "otel_exporter_otlp_endpoint", AnyHttpUrl(f"http://127.0.0.1:{receiver.server_port}"))
            monkeypatch.setattr(settings, "otel_exporter_otlp_headers", SecretStr("Authorization=Basic%20fixture"))
            monkeypatch.setattr(settings, "otel_traces_sampler_arg", 1.0)
            with TestClient(create_app()) as client:
                response = client.post("/api/tools/bmi", json={"inputs": {"age_years": 34, "weight_kg": 70, "height_cm": 175}})
                assert response.status_code == 200
        finally:
            receiver.shutdown()
            thread.join()

    spans = [
        span for path, auth, payload in exports
        if path == "/v1/traces" and auth == "Basic fixture"
        for resource in payload.resource_spans for scope in resource.scope_spans for span in scope.spans
    ]
    assert {span.name for span in spans} == {"POST /api/tools/{key}", "tool.execute"}
