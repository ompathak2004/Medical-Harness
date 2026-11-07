from __future__ import annotations

import asyncio
import json
import logging
from urllib.parse import urlparse

import httpx

from app.transport import CircuitBreaker, CircuitOpen
from app.streaming import bounded_lines
from app.telemetry import provider_attempt

logger = logging.getLogger(__name__)


def normalize_articles(value):
    articles, seen = [], set()
    if not isinstance(value, list):
        return articles
    for item in value[:32]:
        if not isinstance(item, dict):
            continue
        title, url = item.get("title"), item.get("url")
        if not isinstance(title, str) or not title.strip() or not isinstance(url, str):
            continue
        try:
            parsed = urlparse(url)
            if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password:
                continue
        except ValueError:
            continue
        if url in seen:
            continue
        seen.add(url)
        article = {"title": title[:500], "url": url[:2048], "source_type": "research"}
        for key, limit in (("tldr", 2000), ("journal", 200)):
            article[key] = item.get(key, "")[:limit] if isinstance(item.get(key, ""), str) else ""
        article["year"] = str(item["year"])[:4] if isinstance(item.get("year"), (str, int)) else ""
        authors = item.get("authors", [])
        article["authors"] = [author[:100] for author in authors[:12] if isinstance(author, str)] if isinstance(authors, list) else []
        articles.append(article)
        if len(articles) == 16:
            break
    return articles


class EvidenceRetriever:
    def __init__(self, api_key):
        self.api_key = api_key
        self.circuit = CircuitBreaker()
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(35, connect=5, pool=5),
                                      limits=httpx.Limits(max_connections=16, max_keepalive_connections=8))

    async def aclose(self):
        await self.client.aclose()

    async def search(self, conversation, conversation_id):
        empty = {"response": "", "articles": [], "followups": []}
        try:
            self.circuit.acquire()
        except CircuitOpen:
            with provider_attempt("medisearch", 0) as span:
                span.set_attribute("medical_harness.outcome", "circuit_open")
            return empty
        payload = {"conversation": conversation, "id": conversation_id, "key": self.api_key,
                   "settings": {"language": "English", "model_type": "standard", "followup_count": 3}}
        try:
            for attempt in range(2):
                result = {"response": "", "articles": [], "followups": []}
                try:
                    with provider_attempt("medisearch", attempt + 1) as span:
                        async with self.client.stream("POST", "https://api.backend.medisearch.io/sse/medichat", json=payload) as response:
                            span.set_attribute("http.response.status_code", response.status_code)
                            response.raise_for_status()
                            async for line in bounded_lines(response):
                                if not line.startswith("data:"):
                                    continue
                                data = line[5:].strip()
                                if data == "[DONE]":
                                    break
                                event = json.loads(data)
                                if not isinstance(event, dict) or event.get("event") == "error":
                                    raise ValueError("Evidence response invalid")
                                value = event.get("data")
                                if event.get("event") == "llm_response" and isinstance(value, str):
                                    result["response"] = (result["response"] + value)[:4000]
                                elif event.get("event") == "articles":
                                    result["articles"] = normalize_articles(value)
                                elif event.get("event") == "followups" and isinstance(value, list):
                                    result["followups"] = [q[:300] for q in value if isinstance(q, str) and q.strip()][:3]
                        span.set_attribute("medical_harness.source_count", len(result["articles"]))
                    self.circuit.success()
                    return result
                except (httpx.HTTPError, ValueError, TypeError) as exc:
                    status = getattr(getattr(exc, "response", None), "status_code", None)
                    if attempt == 0 and (isinstance(exc, httpx.TransportError) or status in {429, 500, 502, 503, 504}):
                        await asyncio.sleep(0.5)
                        continue
                    self.circuit.failure()
                    logger.warning("evidence.unavailable")
                    return empty
        except asyncio.CancelledError:
            self.circuit.cancel()
            raise
        return empty
