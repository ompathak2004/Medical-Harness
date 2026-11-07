from __future__ import annotations

import asyncio
import logging
import os
import re
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar

from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
from opentelemetry.trace import NoOpTracer, SpanKind, StatusCode
from opentelemetry.util.re import parse_env_headers
from starlette.datastructures import MutableHeaders

from app import __version__

logger = logging.getLogger(__name__)
tracer_context = ContextVar("tracer_context", default=NoOpTracer())
API_ROUTES = frozenset({"/api/chat", "/api/chat/stream", "/api/tools", "/api/health", "/api/metrics"})
METHODS = frozenset({"GET", "POST", "HEAD", "OPTIONS"})
FAILURES = frozenset({"error", "server_error", "timeout", "triage_unavailable", "review_blocked", "evidence_unavailable"})


def release_revision(settings) -> str:
    sha = settings.app_release_sha or os.getenv("VERCEL_GIT_COMMIT_SHA", "")
    return sha if re.fullmatch(r"[0-9a-f]{40}", sha) else "unknown"


@contextmanager
def operation(name, attributes=None, *, kind=SpanKind.INTERNAL):
    with tracer_context.get().start_as_current_span(
        name, attributes=attributes, kind=kind, record_exception=False, set_status_on_exception=False,
    ) as span:
        try:
            yield span
        except (asyncio.CancelledError, GeneratorExit):
            span.set_attribute("medical_harness.outcome", "cancelled")
            raise
        except Exception:
            span.set_attribute("medical_harness.outcome", "error")
            span.set_status(StatusCode.ERROR)
            raise


def provider_attempt(provider, attempt, model=None):
    attributes = {"gen_ai.provider.name": provider, "medical_harness.attempt": attempt}
    if model:
        attributes["gen_ai.request.model"] = model
    return operation(f"provider.{provider}", attributes, kind=SpanKind.CLIENT)


class Telemetry:
    def __init__(self, provider: TracerProvider | None = None, *, flush_after_response: bool = False):
        self.provider = provider
        self.tracer = provider.get_tracer("medical_harness", __version__) if provider else NoOpTracer()
        self.flush_after_response = flush_after_response
        self.pending_flush: asyncio.Task | None = None

    @classmethod
    def configure(cls, settings):
        if not settings.otel_exporter_otlp_endpoint:
            return cls()
        environment = os.getenv("VERCEL_ENV", "development")
        resource = Resource({
            "service.name": "medical-harness",
            "service.version": __version__,
            "deployment.environment.name": environment if environment in {"production", "preview"} else "development",
            "medical_harness.release": release_revision(settings),
        })
        provider = TracerProvider(resource=resource, sampler=ParentBased(TraceIdRatioBased(settings.otel_traces_sampler_arg)),
                                  shutdown_on_exit=False)
        endpoint = str(settings.otel_exporter_otlp_endpoint).rstrip("/") + "/v1/traces"
        logging.getLogger("opentelemetry.exporter.otlp.proto.http.trace_exporter").setLevel(logging.CRITICAL)
        logging.getLogger("opentelemetry.util.re").setLevel(logging.CRITICAL)
        headers = parse_env_headers(settings.otel_exporter_otlp_headers.get_secret_value(), liberal=True)
        exporter = OTLPSpanExporter(endpoint=endpoint, headers=headers, timeout=1.0)
        provider.add_span_processor(BatchSpanProcessor(exporter, max_queue_size=256, max_export_batch_size=64,
                                                       schedule_delay_millis=1000))
        return cls(provider, flush_after_response=os.getenv("VERCEL") == "1")

    async def flush(self):
        if not self.provider or not self.flush_after_response:
            return
        if self.pending_flush is None or self.pending_flush.done():
            self.pending_flush = asyncio.create_task(asyncio.to_thread(self.provider.force_flush))
        done, _ = await asyncio.wait({self.pending_flush}, timeout=0.25)
        if done:
            try:
                self.pending_flush.result()
            except Exception:
                logger.warning("telemetry.flush_failed")

    async def aclose(self):
        if self.pending_flush is not None:
            await asyncio.gather(self.pending_flush, return_exceptions=True)
        if self.provider is not None:
            await asyncio.to_thread(self.provider.shutdown)


def _outcome(status):
    if status >= 500:
        return "server_error"
    if status == 429:
        return "rate_limited"
    if status >= 400:
        return "rejected"
    return "ok" if status else "cancelled"


class RequestTelemetryMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        path = scope["path"]
        route = path if path in API_ROUTES else "/api/tools/{key}" if path.startswith("/api/tools/") else "/api/{other}"
        method = scope["method"] if scope["method"] in METHODS else "_OTHER"
        request_id = uuid.uuid4().hex
        state = scope.setdefault("state", {})
        state["request_id"] = request_id
        telemetry = scope["app"].state.telemetry
        token = tracer_context.set(telemetry.tracer)
        start = time.monotonic()
        status = 0
        tail = None

        async def capture(message):
            nonlocal status, tail
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message)["X-Request-ID"] = request_id
            if telemetry.flush_after_response and message["type"] == "http.response.body" and not message.get("more_body"):
                tail = message
            else:
                await send(message)

        try:
            with operation(f"{method} {route}", {
                "http.request.method": method, "http.route": route, "medical_harness.request_id": request_id,
            }, kind=SpanKind.SERVER) as span:
                try:
                    await self.app(scope, receive, capture)
                except asyncio.CancelledError:
                    state["telemetry_outcome"] = "cancelled"
                    raise
                except Exception:
                    status = status or 500
                    state["telemetry_outcome"] = "error"
                    raise
                finally:
                    outcome = state.get("telemetry_outcome", _outcome(status))
                    span.set_attribute("medical_harness.outcome", outcome)
                    if status:
                        span.set_attribute("http.response.status_code", status)
                    if outcome in FAILURES:
                        span.set_status(StatusCode.ERROR)
                    logger.info("request.complete id=%s route=%s method=%s status=%d outcome=%s elapsed_ms=%d",
                                request_id, route, method, status, outcome, (time.monotonic() - start) * 1000)
            if tail is not None:
                if span.get_span_context().trace_flags.sampled:
                    await telemetry.flush()
                await send(tail)
        finally:
            tracer_context.reset(token)
