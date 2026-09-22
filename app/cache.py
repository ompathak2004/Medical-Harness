"""In-process TTL + LRU cache for pipeline results.

Two layers of caching keep tokens and latency down without external
infrastructure:

- **Evidence cache** — MediSearch lookups keyed by the normalized full
  conversation. Retrieval is the slowest pipeline step and the home-page
  example prompts make repeated identical questions common.
- **Step cache** — deterministic JSON classification steps (triage, tool
  selection, anatomy detection) keyed by the full conversation text, so a
  refresh + resubmit costs zero LLM calls for those steps.

No PHI is stored beyond hashed keys plus the cached values themselves, which
live only in process memory with a short TTL.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections import OrderedDict
from typing import Any


def text_key(*parts: str) -> str:
    """Stable SHA-256 key from normalized text parts (PHI-free log-safe)."""
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()


class TTLCache:
    """Tiny TTL+LRU cache (monotonic clock, no external deps).

    Safe under asyncio's cooperative scheduling: operations do not await, so
    each get/put is atomic with respect to the event loop.
    """

    def __init__(self, max_entries: int = 256, ttl_seconds: float = 600.0):
        self.max_entries = max_entries
        self.ttl_seconds = ttl_seconds
        self._data: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self.hits = 0
        self.misses = 0
        self._pending: dict[str, asyncio.Task] = {}

    async def get_or_compute(self, key, compute, cache_if=lambda value: True):
        cached = self.get(key)
        if cached is not None:
            return cached
        if key not in self._pending:
            async def fill():
                try:
                    value = await compute()
                    if cache_if(value):
                        self.put(key, value)
                    return value
                finally:
                    self._pending.pop(key, None)
            task = asyncio.create_task(fill())
            task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
            self._pending[key] = task
        return await asyncio.shield(self._pending[key])

    def get(self, key: str) -> Any | None:
        entry = self._data.get(key)
        if entry is None:
            self.misses += 1
            return None
        expires_at, value = entry
        if time.monotonic() >= expires_at:
            del self._data[key]
            self.misses += 1
            return None
        self._data.move_to_end(key)
        self.hits += 1
        return value

    def put(self, key: str, value: Any) -> None:
        if key in self._data:
            self._data.move_to_end(key)
        self._data[key] = (time.monotonic() + self.ttl_seconds, value)
        while len(self._data) > self.max_entries:
            self._data.popitem(last=False)

    def stats(self) -> dict:
        return {
            "size": len(self._data),
            "max_entries": self.max_entries,
            "ttl_seconds": self.ttl_seconds,
            "hits": self.hits,
            "misses": self.misses,
        }
