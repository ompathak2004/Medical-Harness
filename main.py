"""
FastAPI application — serves the agent pipeline and the frontend.
"""

import os
import uuid
import logging
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from agent import AgentPipeline
from evidence_retriever import EvidenceRetriever
from llm_client import GeminiClient
from logger import setup_logging

load_dotenv()

setup_logging()
logger = logging.getLogger(__name__)

# --- Initialize components ---
gemini = GeminiClient(
    api_key=os.environ["GEMINI_API_KEY"],
    model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
)
evidence = EvidenceRetriever(api_key=os.environ["MEDISEARCH_API_KEY"])
pipeline = AgentPipeline(gemini=gemini, evidence=evidence)

app = FastAPI(title="MediSearch Agent", version="1.0.0")

# Serve static frontend files
static_dir = Path(__file__).parent / "static"
static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


# --- Request / Response models ---

class ChatRequest(BaseModel):
    conversation: list[str]
    conversation_id: str | None = None


class ChatResponse(BaseModel):
    type: str  # "follow_up" or "answer"
    follow_up_questions: list[str]
    answer: str | None
    articles: list[dict]
    tool_results: list[dict]
    followups: list[str]
    conversation_id: str
    anatomy_context: dict | None = None


# --- Routes ---

@app.get("/", response_class=HTMLResponse)
async def index():
    html_path = static_dir / "index.html"
    return HTMLResponse(content=html_path.read_text(encoding="utf-8"))


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    conversation_id = req.conversation_id or str(uuid.uuid4())

    if not req.conversation or len(req.conversation) == 0:
        return JSONResponse(
            status_code=400,
            content={"detail": "Conversation must have at least one message."},
        )

    # Last message must be from the user (odd count = user's turn)
    if len(req.conversation) % 2 == 0:
        return JSONResponse(
            status_code=400,
            content={"detail": "Last message in conversation must be from the user."},
        )

    result = pipeline.run(
        conversation=req.conversation,
        conversation_id=conversation_id,
    )

    return ChatResponse(
        type=result["type"],
        follow_up_questions=result.get("follow_up_questions", []),
        answer=result.get("answer"),
        articles=result.get("articles", []),
        tool_results=result.get("tool_results", []),
        followups=result.get("followups", []),
        conversation_id=conversation_id,
        anatomy_context=result.get("anatomy_context"),
    )


@app.get("/api/health")
async def health():
    return {"status": "ok"}


def run():
    """Entry point for `uv run medisearch-agent`."""
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
