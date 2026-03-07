"""
Gemini LLM client — calls the Gemini REST API directly via requests.
"""

import logging
import requests

logger = logging.getLogger(__name__)

GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class GeminiClient:
    def __init__(self, api_key: str, model: str = "gemini-2.5-flash"):
        self.api_key = api_key
        self.model = model

    def generate(self, prompt: str) -> str:
        """Send a prompt to Gemini and return the text response."""
        url = GEMINI_API_URL.format(model=self.model)
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.3,
                "maxOutputTokens": 4096,
            },
        }

        logger.info("GEMINI REQUEST  | model=%s | prompt=%s", self.model, prompt)

        try:
            resp = requests.post(
                url,
                params={"key": self.api_key},
                json=payload,
                timeout=120,
            )
            resp.raise_for_status()
            data = resp.json()
            candidates = data.get("candidates", [])
            if not candidates:
                raise ValueError("No candidates in Gemini response")
            parts = candidates[0].get("content", {}).get("parts", [])
            text = "".join(p.get("text", "") for p in parts)

            logger.info("GEMINI RESPONSE | model=%s | response=%s", self.model, text)

            return text
        except Exception:
            logger.exception("Gemini API call failed")
            raise
