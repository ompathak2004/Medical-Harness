"""Robust JSON extraction from LLM output."""

from __future__ import annotations

import json
import re

_FENCE_RE = re.compile(r"^```[a-zA-Z0-9]*\s*\n(.*?)\n?```\s*$", re.DOTALL)
_BRACE_RE = re.compile(r"\{.*\}", re.DOTALL)


def parse_json_response(text: str) -> dict:
    """Best-effort parse of a JSON object from LLM output.

    Handles markdown fences, leading/trailing prose, and falls back to the
    first balanced ``{...}`` block in the text. Raises ``ValueError`` when no
    JSON object can be recovered.
    """
    cleaned = text.strip()

    fence = _FENCE_RE.match(cleaned)
    if fence:
        cleaned = fence.group(1).strip()

    try:
        result = json.loads(cleaned)
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        pass

    match = _BRACE_RE.search(cleaned)
    if match:
        candidate = match.group(0)
        # Trim to the largest parseable prefix ending in '}'
        for end in range(len(candidate), 1, -1):
            if candidate[end - 1] != "}":
                continue
            try:
                result = json.loads(candidate[:end])
                if isinstance(result, dict):
                    return result
            except json.JSONDecodeError:
                continue

    raise ValueError("No JSON object found in LLM response")
