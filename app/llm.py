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
    ):
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.max_retries = max_retries
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=httpx.Timeout(timeout_seconds, connect=10.0),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def _payload(self, prompt: str, *, stream: bool = False) -> dict:
        return {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": stream,
        }

    async def generate(self, prompt: str) -> str:
        """Buffered completion. Retries transient failures with backoff."""
        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                resp = await self._client.post(
                    "/chat/completions", json=self._payload(prompt)
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
                logger.info(
                    "llm.generate ok model=%s prompt_chars=%d response_chars=%d",
                    self.model, len(prompt), len(text),
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

    async def generate_stream(self, prompt: str) -> AsyncIterator[str]:
        """Streaming completion — yields text chunks as they arrive.

        Retries only apply before the first chunk is emitted.
        """
        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            emitted = False
            try:
                async with self._client.stream(
                    "POST", "/chat/completions", json=self._payload(prompt, stream=True)
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
                        delta = (
                            chunk.get("choices", [{}])[0]
                            .get("delta", {})
                            .get("content")
                        )
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
