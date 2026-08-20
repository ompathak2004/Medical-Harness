"""Cerebras LLM client — async, OpenAI-compatible chat completions.

Uses httpx with retry + exponential backoff on transient failures
(429, 5xx, timeouts). Supports both buffered and streaming generation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from collections.abc import AsyncIterator

import httpx

logger = logging.getLogger(__name__)

_RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def _retry_delay(exc: Exception, attempt: int) -> float:
    """Exponential backoff with jitter, honoring Retry-After when present."""
    response = getattr(exc, "response", None)
    if response is not None:
        retry_after = response.headers.get("retry-after")
        if retry_after:
            try:
                return min(float(retry_after) + random.random(), 30.0)
            except ValueError:
                pass
    return min(2 ** attempt + random.random(), 15.0)


class LLMError(RuntimeError):
    """Raised when the LLM call fails after all retries."""


class CerebrasClient:
    def __init__(
        self,
        api_key: str,
        model: str = "gpt-oss-120b",
        base_url: str = "https://api.cerebras.ai/v1",
        temperature: float = 0.3,
        max_tokens: int = 4096,
        timeout_seconds: float = 90.0,
        max_retries: int = 3,
        prompt_cache_key: str = "",
    ):
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.max_retries = max_retries
        self.prompt_cache_key = prompt_cache_key
        # Cumulative usage counters (PHI-free, exposed via /api/metrics).
        self.total_requests = 0
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0
        self.total_cached_tokens = 0
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=httpx.Timeout(timeout_seconds, connect=10.0),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def usage_stats(self) -> dict:
        prompt = self.total_prompt_tokens
        return {
            "requests": self.total_requests,
            "prompt_tokens": prompt,
            "completion_tokens": self.total_completion_tokens,
            "cached_tokens": self.total_cached_tokens,
            "prompt_cache_hit_ratio": (
                round(self.total_cached_tokens / prompt, 4) if prompt else 0.0
            ),
        }

    def _record_usage(self, usage: dict | None) -> None:
        if not usage:
            return
        prompt = usage.get("prompt_tokens") or 0
        completion = usage.get("completion_tokens") or 0
        cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
        self.total_prompt_tokens += prompt
        self.total_completion_tokens += completion
        self.total_cached_tokens += cached
        logger.info(
            "llm.usage prompt_tokens=%d completion_tokens=%d cached_tokens=%d",
            prompt, completion, cached,
        )

    def _payload(self, user: str, system: str | None, *, stream: bool = False) -> dict:
        # Static system message FIRST so Cerebras prefix caching (exact-match,
        # 128-token blocks) can reuse it across requests; dynamic content last.
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": user})
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": stream,
        }
        if stream:
            payload["stream_options"] = {"include_usage": True}
        if self.prompt_cache_key:
            payload["prompt_cache_key"] = self.prompt_cache_key
        return payload

    async def generate(self, user: str, system: str | None = None) -> str:
        """Buffered completion. Retries transient failures with backoff."""
        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                self.total_requests += 1
                resp = await self._client.post(
                    "/chat/completions", json=self._payload(user, system)
                )
                if resp.status_code in _RETRYABLE_STATUS:
                    raise httpx.HTTPStatusError(
                        f"retryable status {resp.status_code}",
                        request=resp.request,
                        response=resp,
                    )
                resp.raise_for_status()
                data = resp.json()
                text = data["choices"][0]["message"]["content"] or ""
                self._record_usage(data.get("usage"))
                logger.info(
                    "llm.generate ok model=%s prompt_chars=%d response_chars=%d",
                    self.model, len(user) + len(system or ""), len(text),
                )
                return text
            except (httpx.TimeoutException, httpx.HTTPStatusError, httpx.TransportError) as exc:
                last_exc = exc
                status = getattr(getattr(exc, "response", None), "status_code", None)
                if status is not None and status not in _RETRYABLE_STATUS:
                    logger.error("llm.generate non-retryable status=%s", status)
                    raise LLMError(f"LLM request failed with status {status}") from exc
                if attempt < self.max_retries:
                    delay = _retry_delay(exc, attempt)
                    logger.warning(
                        "llm.generate retry attempt=%d/%d delay=%.1fs cause=%s",
                        attempt, self.max_retries, delay, type(exc).__name__,
                    )
                    await asyncio.sleep(delay)
        logger.error("llm.generate exhausted retries")
        raise LLMError("LLM request failed after retries") from last_exc

    async def generate_stream(
        self, user: str, system: str | None = None
    ) -> AsyncIterator[str]:
        """Streaming completion — yields text chunks as they arrive.

        Retries only apply before the first chunk is emitted.
        """
        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            emitted = False
            try:
                self.total_requests += 1
                async with self._client.stream(
                    "POST", "/chat/completions",
                    json=self._payload(user, system, stream=True),
                ) as resp:
                    if resp.status_code in _RETRYABLE_STATUS:
                        raise httpx.HTTPStatusError(
                            f"retryable status {resp.status_code}",
                            request=resp.request,
                            response=resp,
                        )
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            return
                        try:
                            chunk = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        if chunk.get("usage"):
                            # Final chunk (stream_options.include_usage).
                            self._record_usage(chunk["usage"])
                        choices = chunk.get("choices") or [{}]
                        delta = choices[0].get("delta", {}).get("content")
                        if delta:
                            emitted = True
                            yield delta
                return
            except (httpx.TimeoutException, httpx.HTTPStatusError, httpx.TransportError) as exc:
                last_exc = exc
                if emitted:
                    # Mid-stream failure: cannot safely retry (would duplicate text).
                    logger.error("llm.generate_stream mid-stream failure: %s", exc)
                    raise LLMError("LLM stream interrupted") from exc
                if attempt < self.max_retries:
                    delay = _retry_delay(exc, attempt)
                    logger.warning(
                        "llm.generate_stream retry attempt=%d/%d delay=%.1fs cause=%s",
                        attempt, self.max_retries, delay, type(exc).__name__,
                    )
                    await asyncio.sleep(delay)
        raise LLMError("LLM stream failed after retries") from last_exc
