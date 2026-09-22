"""API routes — chat (buffered + SSE streaming) and health."""

from __future__ import annotations

import asyncio
import secrets
import time
import json
import logging
import uuid

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app import __version__
from app.config import get_settings
from app.pipeline import ReviewUnavailable, cache_scope
from app.schemas import ChatRequest, ChatResponse

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
    cache_scope.set(request.state.cache_scope)
    slots = request.app.state.request_slots
    if slots.locked():
        raise HTTPException(503, "The service is busy. Please try again shortly.", headers={"Retry-After": "10"})
    try:
        async with slots:
            result = await asyncio.wait_for(pipeline.run(
                conversation=req.conversation, conversation_id=conversation_id
            ), timeout=get_settings().request_timeout_seconds)
    except (ReviewUnavailable, asyncio.TimeoutError):
        raise HTTPException(503, "Unable to complete the answer review. Please try again.") from None
    return ChatResponse(conversation_id=conversation_id, **result)


@router.post("/chat/stream")
async def chat_stream(req: ChatRequest, request: Request) -> StreamingResponse:
    _validate_conversation(req)
    conversation_id = req.conversation_id or str(uuid.uuid4())
    pipeline = request.app.state.pipeline

    slots = request.app.state.request_slots
    if slots.locked():
        raise HTTPException(503, "The service is busy. Please try again shortly.", headers={"Retry-After": "10"})

    async def event_generator():
        cache_scope.set(request.state.cache_scope)
        pending = None
        stream = pipeline.run_streaming(conversation=req.conversation, conversation_id=conversation_id)
        deadline = time.monotonic() + get_settings().request_timeout_seconds
        yield _sse("meta", {"conversation_id": conversation_id})
        try:
            async with slots:
                while True:
                    if pending is None:
                        pending = asyncio.create_task(anext(stream))
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise asyncio.TimeoutError
                    done, _ = await asyncio.wait({pending}, timeout=min(10, remaining))
                    if await request.is_disconnected():
                        return
                    if not done:
                        yield ": keep-alive\n\n"
                        continue
                    try:
                        event_type, data = pending.result()
                    except StopAsyncIteration:
                        break
                    pending = None
                    yield _sse(event_type, data)
        except Exception:
            logger.warning("chat_stream.failed")
            yield _sse("error", {"detail": "Unable to complete your answer safely. Please try again."})
        finally:
            if pending is not None:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            await stream.aclose()

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
    token = get_settings().metrics_token
    if not token or not secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {token}"):
        raise HTTPException(404, "Not found")
    pipeline = request.app.state.pipeline
    llm = getattr(request.app.state, "llm", None) or pipeline.llm
    return {
        "llm": llm.usage_stats(),
        "step_cache": pipeline.step_cache.stats(),
        "evidence_cache": pipeline.evidence_cache.stats(),
    }
