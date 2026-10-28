from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

from app.context import ClientContext, RequestContext
from app.tools.anatomy import AnatomyContext
from app.tools.education import VisualId


_SHEET_CONDITION = re.compile(r"[^\W_](?:[^\W_]|[ ,.'()/&+-]){2,199}")


class SheetRequest(BaseModel):
    """A when-to-call sheet request. Only the condition leaves the browser; never names, numbers, or thresholds."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    kind: Literal["when_to_call"]
    condition: str = Field(min_length=3, max_length=200)

    @field_validator("condition")
    @classmethod
    def plain_condition(cls, value: str) -> str:
        # Letters, digits, spaces, basic punctuation; no run of four digits (dates, phone numbers, identifiers).
        if not _SHEET_CONDITION.fullmatch(value) or re.search(r"\d{4}", value):
            raise ValueError("Describe the condition in a few plain words, without numbers or identifiers.")
        return value


class ChatRequest(BaseModel):
    conversation: list[str] = Field(default_factory=list)
    conversation_id: str | None = Field(default=None, max_length=128)
    context: ClientContext = Field(default_factory=ClientContext)
    user_turn_times: list[AwareDatetime | None] = Field(default_factory=list, max_length=20)
    sheet: SheetRequest | None = None

    @model_validator(mode="after")
    def conversation_required_without_sheet(self):
        if not self.conversation and self.sheet is None:
            raise ValueError("conversation must contain at least one message")
        return self


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


class WhenToCallSheet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["when_to_call"]
    emergency_signs: list[str]
    emergency_line: str
    routine_lines: list[str]
    middle_tier_source: Literal["answer", "unavailable"]


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
    sheet: WhenToCallSheet | None = None


class ToolRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    inputs: dict[str, Any]


class ToolRunResponse(BaseModel):
    tool_key: str
    result: dict
