from __future__ import annotations

import asyncio
import json
import logging

import httpx

logger = logging.getLogger(__name__)


class EvidenceRetriever:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(45, connect=10))

    async def aclose(self):
        await self.client.aclose()

    async def search(self, conversation: list[str], conversation_id: str) -> dict:
        payload = {
            "conversation": conversation, "id": conversation_id, "key": self.api_key,
            "settings": {"language": "English", "model_type": "standard", "followup_count": 3},
        }
        for attempt in range(2):
            result = {"response": "", "articles": [], "followups": []}
            try:
                async with self.client.stream("POST", "https://api.backend.medisearch.io/sse/medichat", json=payload) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        event = json.loads(data)
                        value = event.get("data")
                        if event.get("event") == "error":
                            raise ValueError("Evidence provider could not complete retrieval")
                        if event.get("event") == "llm_response" and isinstance(value, str):
                            result["response"] += value
                        elif event.get("event") == "articles" and isinstance(value, list):
                            result["articles"] = [a for a in value if isinstance(a, dict) and isinstance(a.get("title"), str)]
                        elif event.get("event") == "followups" and isinstance(value, list):
                            result["followups"] = [q for q in value if isinstance(q, str)][:3]
                return result
            except (httpx.HTTPError, ValueError, TypeError) as exc:
                status = getattr(getattr(exc, "response", None), "status_code", None)
                logger.warning("evidence.unavailable kind=%s status=%s", type(exc).__name__, status)
                if attempt == 0 and (status in {429, 500, 502, 503, 504} or isinstance(exc, httpx.TransportError)):
                    await asyncio.sleep(1)
                    continue
                return {"response": "", "articles": [], "followups": []}
        return {"response": "", "articles": [], "followups": []}
