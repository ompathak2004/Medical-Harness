from __future__ import annotations

import asyncio
import secrets
import time
import json
import logging
import uuid

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app import __version__
from app.config import get_settings
from app.context import request_context, resolve_context, user_turn_times
from app.handoff import build_handoff
from app.pipeline import ReviewUnavailable, cache_scope
from app.schemas import ChatRequest, ChatResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


def _validate_conversation(req: ChatRequest) -> None:
    settings = get_settings()
    conv = req.conversation
    if req.user_turn_times and len(req.user_turn_times) != len(conv) // 2:
        raise HTTPException(400, "Provide one timestamp per earlier user turn.")
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
    if sum(map(len, conv)) > settings.max_conversation_chars:
        raise HTTPException(413, "Conversation text is too long. Please start a new question.")
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


REVIEW_UNAVAILABLE_DETAIL = "Unable to complete the answer review. Please try again."


def _failure_handoff(req: ChatRequest, exc: BaseException | None = None) -> dict:
    """Handoff for an error payload: the pipeline's own when it set one, else nothing ran."""
    return getattr(exc, "handoff", None) or build_handoff(
        req.conversation, "review_unavailable", None, triage_done=False
    )


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, request: Request) -> ChatResponse:
    _validate_conversation(req)
    conversation_id = req.conversation_id or str(uuid.uuid4())
    pipeline = request.app.state.pipeline
    cache_scope.set(request.state.cache_scope)
    context = resolve_context(req.context, request.headers)
    request_context.set(context)
    user_turn_times.set(req.user_turn_times)
    slots = request.app.state.request_slots
    if slots.locked():
        raise HTTPException(503, "The service is busy. Please try again shortly.", headers={"Retry-After": "10"})
    try:
        async with slots:
            result = await asyncio.wait_for(pipeline.run(
                conversation=req.conversation, conversation_id=conversation_id
            ), timeout=get_settings().request_timeout_seconds)
    except (ReviewUnavailable, asyncio.TimeoutError) as exc:
        return JSONResponse(
            status_code=503,
            content={"detail": REVIEW_UNAVAILABLE_DETAIL, "handoff": _failure_handoff(req, exc)},
        )
    return ChatResponse(conversation_id=conversation_id, request_context=context, **result)


@router.post("/chat/stream")
async def chat_stream(req: ChatRequest, request: Request) -> StreamingResponse:
    _validate_conversation(req)
    conversation_id = req.conversation_id or str(uuid.uuid4())
    pipeline = request.app.state.pipeline

    slots = request.app.state.request_slots
    if slots.locked():
        raise HTTPException(503, "The service is busy. Please try again shortly.", headers={"Retry-After": "10"})

    await slots.acquire()
    context = resolve_context(req.context, request.headers)

    async def event_generator():
        cache_scope.set(request.state.cache_scope)
        request_context.set(context)
        user_turn_times.set(req.user_turn_times)
        pending = None
        stream = pipeline.run_streaming(conversation=req.conversation, conversation_id=conversation_id)
        deadline = time.monotonic() + get_settings().request_timeout_seconds
        try:
            yield _sse("meta", {"conversation_id": conversation_id, "request_context": context.model_dump(mode="json")})
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
                if event_type == "result":
                    data = ChatResponse(conversation_id=conversation_id, request_context=context, **data).model_dump(mode="json")
                yield _sse(event_type, data)
        except Exception as exc:
            logger.warning("chat_stream.failed")
            yield _sse("error", {
                "detail": "Unable to complete your answer safely. Please try again.",
                "handoff": _failure_handoff(req, exc),
            })
        finally:
            slots.release()
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

    token = get_settings().metrics_token
    if not token or not secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {token}"):
        raise HTTPException(404, "Not found")
    pipeline = request.app.state.pipeline
    llm = getattr(request.app.state, "llm", None) or pipeline.llm
    return {
        "llm": llm.usage_stats(),
        "step_cache": pipeline.step_cache.stats(),
        "evidence_cache": pipeline.evidence_cache.stats(),
        "outcomes": pipeline.outcome_stats(),
    }
