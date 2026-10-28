from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, limits: list[tuple[str, int]], window_seconds: int):
        super().__init__(app)
        self.limits = list(limits)
        self.window_seconds = window_seconds
        self._hits: dict[str, dict[str, deque[float]]] = {prefix: defaultdict(deque) for prefix, _ in self.limits}

    def _client_key(self, request: Request) -> str:
        return request.client.host if request.client else "unknown"

    async def dispatch(self, request: Request, call_next):
        limit = next(((prefix, maximum) for prefix, maximum in self.limits if request.url.path.startswith(prefix)), None)
        if request.method == "POST" and limit:
            prefix, max_requests = limit
            all_hits = self._hits[prefix]
            key = self._client_key(request)
            now = time.monotonic()
            if len(all_hits) >= 10000 and key not in all_hits:
                cutoff = now - self.window_seconds
                for stale in [k for k, v in all_hits.items() if not v or v[-1] <= cutoff]:
                    del all_hits[stale]
                if len(all_hits) >= 10000:
                    return JSONResponse({"detail": "The service is busy. Please try again shortly."}, status_code=429, headers={"Retry-After": str(self.window_seconds)})
            hits = all_hits[key]
            cutoff = now - self.window_seconds
            while hits and hits[0] < cutoff:
                hits.popleft()
            if len(hits) >= max_requests:
                return JSONResponse(
                    status_code=429,
                    content={
                        "detail": "Too many requests. Please wait a moment and try again."
                    },
                    headers={"Retry-After": str(self.window_seconds)},
                )
            hits.append(now)
        return await call_next(request)
