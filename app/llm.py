from __future__ import annotations

import asyncio
import json
import logging
import random
from collections.abc import AsyncIterator

import httpx

from app.streaming import bounded_json, bounded_lines
from app.telemetry import provider_attempt
from app.transport import CircuitBreaker, CircuitOpen

logger = logging.getLogger(__name__)
_RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def _retry_delay(exc: Exception, attempt: int) -> float:
    response = getattr(exc, "response", None)
    if response is not None:
        try:
            return max(0, min(float(response.headers.get("retry-after", "")), 15)) + random.random()
        except ValueError:
            pass
    return min(2 ** attempt + random.random(), 8)


def _retryable(exc):
    return isinstance(exc, httpx.TransportError) or (
        isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in _RETRYABLE_STATUS
    )


class LLMError(RuntimeError):
    pass


class CerebrasClient:
    def __init__(self, api_key: str, model="gpt-oss-120b", base_url="https://api.cerebras.ai/v1",
                 temperature=0.3, max_tokens=4096, timeout_seconds=45, max_retries=2,
                 prompt_cache_key="", input_usd_per_million=None, output_usd_per_million=None, request_budget=None):
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.max_retries = max_retries
        self.prompt_cache_key = prompt_cache_key
        self.input_usd_per_million = input_usd_per_million
        self.output_usd_per_million = output_usd_per_million
        self.request_budget = request_budget
        self.total_requests = 0
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0
        self.total_cached_tokens = 0
        self.circuit = CircuitBreaker()
        self._client = httpx.AsyncClient(
            base_url=base_url, headers={"Authorization": f"Bearer {api_key}"},
            timeout=httpx.Timeout(timeout_seconds, connect=5, pool=5),
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
        )

    async def aclose(self):
        await self._client.aclose()

    def usage_stats(self):
        return {
            "requests": self.total_requests, "prompt_tokens": self.total_prompt_tokens,
            "completion_tokens": self.total_completion_tokens, "cached_tokens": self.total_cached_tokens,
            "prompt_cache_hit_ratio": round(self.total_cached_tokens / self.total_prompt_tokens, 4) if self.total_prompt_tokens else 0,
            "circuit_open": self.circuit.opened_at is not None,
        }

    def _record_usage(self, usage, span):
        if not isinstance(usage, dict):
            return
        prompt = _token_count(usage.get("prompt_tokens"))
        completion = _token_count(usage.get("completion_tokens"))
        details = usage.get("prompt_tokens_details")
        cached = _token_count(details.get("cached_tokens")) if isinstance(details, dict) else 0
        self.total_prompt_tokens += prompt
        self.total_completion_tokens += completion
        self.total_cached_tokens += min(cached, prompt)
        span.set_attributes({"gen_ai.usage.input_tokens": prompt, "gen_ai.usage.output_tokens": completion})
        if self.input_usd_per_million is not None and self.output_usd_per_million is not None:
            cost = (prompt * self.input_usd_per_million + completion * self.output_usd_per_million) / 1_000_000
            span.set_attribute("medical_harness.estimated_cost_usd", cost)

    def _acquire(self):
        try:
            self.circuit.acquire()
        except CircuitOpen:
            with provider_attempt("cerebras", 0, self.model) as span:
                span.set_attribute("medical_harness.outcome", "circuit_open")
            raise

    def _start_attempt(self):
        if self.request_budget is not None and self.total_requests >= self.request_budget:
            raise LLMError("Request budget exhausted")
        self.total_requests += 1

    def _payload(self, user, system, *, stream=False, max_tokens=None, json_mode=False):
        messages = ([{"role": "system", "content": system}] if system else [])
        messages.append({"role": "user", "content": user})
        payload = {
            "model": self.model, "messages": messages, "temperature": 0 if json_mode else self.temperature,
            "max_tokens": max_tokens or self.max_tokens, "stream": stream,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        if stream:
            payload["stream_options"] = {"include_usage": True}
        if self.prompt_cache_key:
            payload["prompt_cache_key"] = self.prompt_cache_key
        return payload

    async def generate(self, user, system=None, *, max_tokens=None, json_mode=False):
        self._acquire()
        try:
            for attempt in range(self.max_retries):
                try:
                    with provider_attempt("cerebras", attempt + 1, self.model) as span:
                        self._start_attempt()
                        async with self._client.stream("POST", "/chat/completions", json=self._payload(
                            user, system, max_tokens=max_tokens, json_mode=json_mode,
                        )) as response:
                            span.set_attribute("http.response.status_code", response.status_code)
                            response.raise_for_status()
                            data = await bounded_json(response)
                        self._record_usage(data.get("usage"), span)
                        choice = data["choices"][0]
                        if choice.get("finish_reason") != "stop":
                            raise LLMError("Incomplete completion")
                        value = choice["message"]["content"]
                        if not isinstance(value, str) or not value.strip() or len(value) > 64000:
                            raise LLMError("Invalid completion")
                    self.circuit.success()
                    return value
                except httpx.HTTPError as exc:
                    if not _retryable(exc) or attempt + 1 == self.max_retries:
                        raise LLMError("Provider request unavailable") from None
                    await asyncio.sleep(_retry_delay(exc, attempt))
            raise LLMError("Provider request unavailable")
        except asyncio.CancelledError:
            self.circuit.cancel()
            raise
        except Exception:
            self.circuit.failure()
            raise LLMError("Provider response unavailable") from None

    async def generate_stream(self, user, system=None) -> AsyncIterator[str]:
        self._acquire()
        try:
            for attempt in range(self.max_retries):
                emitted = False
                finished = False
                chars = 0
                try:
                    with provider_attempt("cerebras", attempt + 1, self.model) as span:
                        self._start_attempt()
                        async with self._client.stream("POST", "/chat/completions", json=self._payload(user, system, stream=True)) as response:
                            span.set_attribute("http.response.status_code", response.status_code)
                            response.raise_for_status()
                            async for line in bounded_lines(response, max_bytes=2097152):
                                if not line.startswith("data:"):
                                    continue
                                payload = line[5:].strip()
                                if payload == "[DONE]":
                                    break
                                chunk = json.loads(payload)
                                if "error" in chunk:
                                    raise LLMError("Provider stream unavailable")
                                self._record_usage(chunk.get("usage"), span)
                                for choice in chunk.get("choices", []):
                                    reason = choice.get("finish_reason")
                                    if reason is not None:
                                        if reason != "stop":
                                            raise LLMError("Incomplete completion")
                                        finished = True
                                    delta = choice.get("delta", {}).get("content")
                                    if delta:
                                        if not isinstance(delta, str):
                                            raise LLMError("Invalid stream content")
                                        chars += len(delta)
                                        if chars > 64000:
                                            raise LLMError("Completion too long")
                                        emitted = True
                                        yield delta
                        if not finished or not emitted:
                            raise LLMError("Stream ended before completion")
                    self.circuit.success()
                    return
                except httpx.HTTPError as exc:
                    if emitted or not _retryable(exc) or attempt + 1 == self.max_retries:
                        raise LLMError("Provider stream unavailable") from None
                    await asyncio.sleep(_retry_delay(exc, attempt))
        except (asyncio.CancelledError, GeneratorExit):
            self.circuit.cancel()
            raise
        except Exception:
            self.circuit.failure()
            raise LLMError("Provider stream unavailable") from None


def _token_count(value) -> int:
    return value if type(value) is int and 0 <= value <= 2**31 - 1 else 0
