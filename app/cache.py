from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections import OrderedDict
from typing import Any

from opentelemetry.trace import get_current_span


def text_key(*parts: str) -> str:
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()


class TTLCache:
    def __init__(self, max_entries: int = 256, ttl_seconds: float = 600.0):
        if max_entries < 0 or ttl_seconds < 0:
            raise ValueError("Cache limits cannot be negative")
        self.max_entries = max_entries
        self.ttl_seconds = ttl_seconds
        self._data: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._pending: dict[str, asyncio.Task] = {}
        self._waiters: dict[str, int] = {}
        self.hits = 0
        self.misses = 0

    async def get_or_compute(self, key, compute, cache_if=lambda value: True):
        cached = self.get(key)
        span = get_current_span()
        span.set_attribute("cache.hit", cached is not None)
        if cached is not None:
            return cached
        task = self._pending.get(key)
        span.set_attribute("cache.coalesced", task is not None)
        if task is None:
            async def fill():
                value = await compute()
                if cache_if(value):
                    self.put(key, value)
                return value

            task = asyncio.create_task(fill())
            self._pending[key] = task
        self._waiters[key] = self._waiters.get(key, 0) + 1
        try:
            return await asyncio.shield(task)
        finally:
            self._waiters[key] -= 1
            if self._waiters[key] == 0:
                self._waiters.pop(key)
                self._pending.pop(key, None)
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    def _expire(self):
        now = time.monotonic()
        for key in [key for key, (expires, _) in self._data.items() if expires <= now]:
            self._data.pop(key, None)

    def get(self, key: str) -> Any | None:
        entry = self._data.get(key)
        if entry is None or entry[0] <= time.monotonic():
            self._data.pop(key, None)
            self.misses += 1
            return None
        self._data.move_to_end(key)
        self.hits += 1
        return entry[1]

    def put(self, key: str, value: Any) -> None:
        if not self.max_entries or not self.ttl_seconds:
            return
        self._expire()
        self._data[key] = (time.monotonic() + self.ttl_seconds, value)
        self._data.move_to_end(key)
        while len(self._data) > self.max_entries:
            self._data.popitem(last=False)

    async def aclose(self):
        tasks = list(self._pending.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._data.clear()

    def stats(self) -> dict:
        self._expire()
        return {"size": len(self._data), "max_entries": self.max_entries,
                "ttl_seconds": self.ttl_seconds, "hits": self.hits, "misses": self.misses}
