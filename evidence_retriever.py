"""
Medisearch evidence retriever — uses the official medisearch-client package
to fetch peer-reviewed articles and AI-generated medical summaries.
"""

import logging
from medisearch_client import MediSearchClient, Settings

logger = logging.getLogger(__name__)


class EvidenceRetriever:
    def __init__(self, api_key: str):
        self.client = MediSearchClient(api_key=api_key)

    def search(self, conversation: list[str], conversation_id: str) -> dict:
        """
        Query Medisearch with the current conversation.

        Returns a dict with keys:
            - response: str  (the full LLM-generated medical answer)
            - articles: list[dict]  (cited sources)
            - followups: list[str]  (suggested follow-up questions)
        """
        result = {
            "response": "",
            "articles": [],
            "followups": [],
        }

        try:
            responses = self.client.send_message(
                conversation=conversation,
                conversation_id=conversation_id,
                should_stream_response=False,
                settings=Settings(
                    language="English",
                    followup_count=3,
                ),
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
                    logger.warning("Medisearch error: %s", event.get("data"))

        except Exception:
            logger.exception("Medisearch API call failed")

        return result
