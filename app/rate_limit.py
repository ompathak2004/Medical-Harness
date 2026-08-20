"""Minimal in-memory sliding-window rate limiter (per client IP).

Suitable for a single-instance deployment; swap for a shared store
(e.g. Redis) when scaling horizontally.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

_RATE_LIMITED_PATHS = ("/api/chat",)


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, max_requests: int, window_seconds: int):
        super().__init__(app)
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def _client_key(self, request: Request) -> str:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    async def dispatch(self, request: Request, call_next):
        if request.method == "POST" and request.url.path.startswith(_RATE_LIMITED_PATHS):
            key = self._client_key(request)
            now = time.monotonic()
            hits = self._hits[key]
            cutoff = now - self.window_seconds
            while hits and hits[0] < cutoff:
                hits.popleft()
            if len(hits) >= self.max_requests:
                return JSONResponse(
                    status_code=429,
                    content={
                        "detail": "Too many requests. Please wait a moment and try again."
                    },
                    headers={"Retry-After": str(self.window_seconds)},
                )
            hits.append(now)
            # Opportunistic cleanup of idle clients.
            if len(self._hits) > 10_000:
                stale = [k for k, v in self._hits.items() if not v or v[-1] < cutoff]
                for k in stale:
                    del self._hits[k]
        return await call_next(request)
