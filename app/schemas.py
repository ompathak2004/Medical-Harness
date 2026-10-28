from __future__ import annotations

from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from app.context import ClientContext, RequestContext
from app.tools.anatomy import AnatomyContext
from app.tools.education import VisualId


class ChatRequest(BaseModel):
    conversation: list[str] = Field(..., min_length=1)
    conversation_id: str | None = Field(default=None, max_length=128)
    context: ClientContext = Field(default_factory=ClientContext)
    user_turn_times: list[AwareDatetime | None] = Field(default_factory=list, max_length=20)


HandoffReason = Literal[
    "user_requested", "evidence_unavailable", "review_unavailable", "clarification_limit",
    "clarification_pending", "emergency", "tool_input_missing", "answer_available",
]
Urgency = Literal["emergency", "routine", "unknown"]


class TraceStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Literal["triage", "tools", "evidence", "draft", "review"]
    status: Literal["ok", "skipped", "failed", "fallback"]
    elapsed_ms: int = Field(ge=0)
    detail: str = ""


class ClaimSupport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    citation_markers: int
    sources_retrieved: int
    sources_cited: int
    uncited_sources: list[int]


class HandoffTrace(BaseModel):
    model_config = ConfigDict(extra="forbid")
    steps: list[TraceStep]
    claim_support: ClaimSupport | None = None


class HandoffCalculation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tool: str
    inputs: dict[str, float | int | bool | str] = {}
    result: str = ""
    units: str = ""
    source: str = ""
    scope: str = ""
    error: str = ""
    missing_inputs: list[str] = []


class HandoffReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tool: str
    status: str
    items: list[dict] = []
    note: str = ""


class HandoffSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    index: int
    title: str
    year: str = ""
    journal: str = ""
    url: str
    kind: str
    cited: bool


class ClinicianQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    heading: Literal["What is my main problem?", "What do I need to do?", "Why is it important?"]
    text: str


class Handoff(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    reason: HandoffReason
    urgency: Urgency
    questions: list[str]
    calculations: list[HandoffCalculation]
    references: list[HandoffReference]
    sources: list[HandoffSource]
    limitations: list[str]
    clinician_questions: list[ClinicianQuestion]
    trace: HandoffTrace


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
    handoff: Handoff | None = None
