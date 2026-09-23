"""Bounded replies for messages that do not ask for medical advice."""

from __future__ import annotations

import re


CONVERSATION_REPLIES = {
    "greeting": (
        "Hi! What health question can I help you with? You can ask about a symptom, "
        "condition, medicine, or medical test."
    ),
    "courtesy": "You're welcome. If you have another health question, I can help.",
    "farewell": "Take care. You can come back with another health question anytime.",
    "capabilities": (
        "I can explain health topics, help you understand symptoms and medical terms, "
        "and answer questions using medical sources. When you provide the necessary "
        "details, I can also show certain clinical calculator results. I can't diagnose "
        "you or replace a clinician. What would you like to know?"
    ),
    "unclear": (
        "I'm not sure what you mean yet. What health question or concern would you "
        "like help with? You can describe it in your own words."
    ),
    "off_topic": (
        "I focus on health information. If you have a question about a symptom, "
        "condition, medicine, or medical test, I can help."
    ),
}


def routine_kind(message: str) -> str | None:
    """Match only complete, low-risk utterances; mixed messages go to triage."""
    normalized = re.sub(r"[\s.!?,]+", " ", message.casefold()).strip()
    if re.fullmatch(r"h+i+|h+e+l+o+|h+e+y+", normalized) or normalized in {
        "hello there", "hi there", "hey there", "greetings", "good morning",
        "morning", "good afternoon", "good evening", "good day",
    }:
        return "greeting"
    if normalized in {"thanks", "thank you", "thank you so much", "thx", "ty"}:
        return "courtesy"
    if normalized in {"bye", "goodbye", "see you", "take care", "good night"}:
        return "farewell"
    if normalized in {"how are you", "how are you doing"}:
        return "greeting"
    if normalized in {
        "help", "what can you do", "how can you help", "what do you do",
        "what can i ask you", "how does this work", "who are you",
        "can you help me", "what is this",
    }:
        return "capabilities"
    if normalized in {"ok", "okay", "yes", "no", "sure", "fine", "good", "cool", "lol"}:
        return "unclear"
    return None
