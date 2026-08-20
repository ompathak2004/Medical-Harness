"""MediSearch evidence retriever — peer-reviewed articles + medical summaries.

The medisearch-client SDK is synchronous; callers should run ``search`` in a
thread (``asyncio.to_thread``) from async code.
"""

from __future__ import annotations

import logging

from medisearch_client import MediSearchClient, Settings as MediSettings

logger = logging.getLogger(__name__)


class EvidenceRetriever:
    def __init__(self, api_key: str):
        self.client = MediSearchClient(api_key=api_key)

    def search(self, conversation: list[str], conversation_id: str) -> dict:
        """Query MediSearch with the current conversation.

        Returns dict with keys ``response`` (str), ``articles`` (list[dict]),
        ``followups`` (list[str]). Never raises — degrades to empty results.
        """
        result: dict = {"response": "", "articles": [], "followups": []}
        logger.info(
            "evidence.search start conversation_id=%s messages=%d",
            conversation_id, len(conversation),
        )
        try:
            responses = self.client.send_message(
                conversation=conversation,
                conversation_id=conversation_id,
                should_stream_response=False,
                settings=MediSettings(language="English", followup_count=3),
            )
            for event in responses:
                event_type = event.get("event", "")
                if event_type == "llm_response":
                    result["response"] += event.get("data", "")
                elif event_type == "articles":
                    result["articles"] = event.get("data", [])
                elif event_type == "followups":
                    result["followups"] = event.get("data", [])
                elif event_type == "error":
                    logger.warning("evidence.search api error: %s", event.get("data"))
        except Exception:
            logger.exception("evidence.search failed conversation_id=%s", conversation_id)

        logger.info(
            "evidence.search done conversation_id=%s response_chars=%d articles=%d followups=%d",
            conversation_id,
            len(result["response"]),
            len(result["articles"]),
            len(result["followups"]),
        )
        return result
