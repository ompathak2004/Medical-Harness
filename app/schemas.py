from __future__ import annotations

from typing import Literal

from pydantic import AwareDatetime, BaseModel, Field

from app.context import ClientContext, RequestContext
from app.tools.anatomy import AnatomyContext
from app.tools.education import VisualId


class ChatRequest(BaseModel):
    conversation: list[str] = Field(..., min_length=1)
    conversation_id: str | None = Field(default=None, max_length=128)
    context: ClientContext = Field(default_factory=ClientContext)
    user_turn_times: list[AwareDatetime | None] = Field(default_factory=list, max_length=20)


class ChatResponse(BaseModel):
    type: Literal["follow_up", "answer", "emergency", "conversation"]
    follow_up_questions: list[str] = []
    preliminary_info: str = ""
    answer: str | None = None
    articles: list[dict] = []
    tool_results: list[dict] = []
    followups: list[str] = []
    conversation_id: str
    anatomy_context: AnatomyContext | None = None
    visual_context: VisualId | None = Field(default=None, description="Allowlisted educational guide, published only with a reviewed answer.")
    request_context: RequestContext | None = None
    evidence_status: str = "available"
    emergency: bool = False
    emergency_message: str = ""
