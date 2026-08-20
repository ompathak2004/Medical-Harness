"""API routes — chat (buffered + SSE streaming) and health."""

from __future__ import annotations

import json
import logging
import uuid

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app import __version__
from app.config import get_settings
from app.schemas import ChatRequest, ChatResponse
from app.tools.grounding import ground_term

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


def _validate_conversation(req: ChatRequest) -> None:
    settings = get_settings()
    conv = req.conversation
    if len(conv) % 2 == 0:
        raise HTTPException(
            status_code=400,
            detail="Last message in conversation must be from the user.",
        )
    if len(conv) > settings.max_conversation_messages:
        raise HTTPException(
            status_code=413,
            detail=f"Conversation exceeds {settings.max_conversation_messages} messages.",
        )
    for msg in conv:
        if not isinstance(msg, str):
            raise HTTPException(status_code=400, detail="Messages must be strings.")
        if len(msg) > settings.max_message_chars:
            raise HTTPException(
                status_code=413,
                detail=f"A message exceeds {settings.max_message_chars} characters.",
            )
    if not conv[-1].strip():
        raise HTTPException(status_code=400, detail="Last message must not be empty.")


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, request: Request) -> ChatResponse:
    _validate_conversation(req)
    conversation_id = req.conversation_id or str(uuid.uuid4())
    pipeline = request.app.state.pipeline
    result = await pipeline.run(
        conversation=req.conversation, conversation_id=conversation_id
    )
    return ChatResponse(conversation_id=conversation_id, **result)


@router.post("/chat/stream")
async def chat_stream(req: ChatRequest, request: Request) -> StreamingResponse:
    _validate_conversation(req)
    conversation_id = req.conversation_id or str(uuid.uuid4())
    pipeline = request.app.state.pipeline

    async def event_generator():
        yield _sse("meta", {"conversation_id": conversation_id})
        try:
            async for event_type, data in pipeline.run_streaming(
                conversation=req.conversation, conversation_id=conversation_id
            ):
                yield _sse(event_type, data)
        except Exception:
            logger.exception(
                "chat_stream pipeline error conversation_id=%s", conversation_id
            )
            yield _sse(
                "error",
                {"detail": "Something went wrong while processing your question. Please try again."},
            )

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": __version__}


@router.get("/metrics")
async def metrics(request: Request) -> dict:
    """Token-usage and cache statistics. Numbers only — no PHI, no text."""
    pipeline = request.app.state.pipeline
    llm = getattr(request.app.state, "llm", None) or pipeline.llm
    return {
        "llm": llm.usage_stats(),
        "step_cache": pipeline.step_cache.stats(),
        "evidence_cache": pipeline.evidence_cache.stats(),
    }


@router.get("/anatomy/ground")
async def anatomy_ground(term: str) -> dict:
    """Deterministic term -> 3D structure resolution (no LLM, no PHI).

    Resolves a free-text anatomical term against the BodyParts3D/FMA
    grounding index. Returns matched concept name, displayable structure
    ids, and the deep-dive scene that best covers them.
    """
    term = (term or "").strip()
    if not term or len(term) > 200:
        raise HTTPException(status_code=400, detail="term must be 1-200 characters")
    result = ground_term(term)
    return {"query": term, "result": result}
