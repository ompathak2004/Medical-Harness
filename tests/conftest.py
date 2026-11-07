import os

import httpx
import pytest

os.environ["CEREBRAS_API_KEY"] = "test-key"
os.environ["MEDISEARCH_API_KEY"] = "test-key"
os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = ""


@pytest.fixture(autouse=True)
def block_live_provider_calls(monkeypatch):
    async def blocked_async(*args, **kwargs):
        raise AssertionError("Live network requests are forbidden in tests")

    def blocked_sync(*args, **kwargs):
        raise AssertionError("Live network requests are forbidden in tests")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", blocked_async)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", blocked_sync)
