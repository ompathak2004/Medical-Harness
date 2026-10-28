from __future__ import annotations

import asyncio
import logging
import time
import inspect
from contextvars import ContextVar
from collections import Counter
from collections.abc import AsyncIterator
from typing import Literal

from app.cache import TTLCache, text_key
from app.answer_format import remove_source_appendix
from app.config import get_settings
from app.context import contextualize
from app.conversation import CONVERSATION_REPLIES, routine_kind
from app.evidence import EvidenceRetriever
from app.handoff import TRACE_DETAILS, TRACE_STEPS, build_handoff, citation_indices, skipped_step
from app.json_utils import parse_json_response
from app.llm import CerebrasClient
from app.prompts import (
    ANSWER_SYSTEM,
    ANSWER_USER,
    SAFETY_SYSTEM,
    SAFETY_USER,
    TOOL_SELECTION_SYSTEM,
    TOOL_SELECTION_USER,
    TRIAGE_SYSTEM,
    TRIAGE_USER,
    VARIABLE_EXTRACTION_SYSTEM,
    VARIABLE_EXTRACTION_USER,
    WHEN_TO_CALL_SYSTEM,
)
from app.tools.anatomy import select_anatomy
from app.tools.education import select_visual
from app.tools.clinical import TOOL_REGISTRY
from app.tools.references import REFERENCE_TOOLS
from app.tools.sheets import build_when_to_call_sheet

logger = logging.getLogger(__name__)
cache_scope = ContextVar("cache_scope", default="internal")
CLARIFICATION_INTRO = (
    "A few details will help me understand your question. "
    "You can write ‘not sure’ for anything you do not know."
)


class ReviewUnavailable(RuntimeError):
    handoff: dict | None = None


class _RunTrace:
    """Per-run recorder: step names, statuses, and milliseconds only. Never text."""

    def __init__(self):
        self._started: dict[str, float] = {}
        self._elapsed: dict[str, int] = {}
        self._steps: dict[str, dict] = {}

    def start(self, name: str) -> None:
        self._started[name] = time.monotonic()

    def stop(self, name: str) -> None:
        if name in self._started and name not in self._elapsed:
            self._elapsed[name] = int((time.monotonic() - self._started[name]) * 1000)

    async def timed(self, name: str, awaitable):
        """Await `awaitable` with the step clock running, whatever the outcome."""
        self.start(name)
        try:
            return await awaitable
        finally:
            self.stop(name)

    def finish(self, name: str, status: str, detail: str = "") -> None:
        if detail not in TRACE_DETAILS:
            raise ValueError("Trace detail must come from the fixed vocabulary")
        self.stop(name)
        self._steps[name] = {"name": name, "status": status,
                             "elapsed_ms": self._elapsed.get(name, 0), "detail": detail}

    def has(self, name: str, status: str) -> bool:
        return self._steps.get(name, {}).get("status") == status

    def steps(self) -> list[dict]:
        return [self._steps.get(name) or skipped_step(name) for name in TRACE_STEPS]


def _empty_result(**overrides) -> dict:
    base = {
        "type": "answer",
        "follow_up_questions": [],
        "preliminary_info": "",
        "answer": None,
        "articles": [],
        "tool_results": [],
        "followups": [],
        "anatomy_context": None,
        "evidence_status": "not_applicable",
        "emergency": False,
        "emergency_message": "",
    }
    base.update(overrides)
    return base


def _truncate(text: str, limit: int) -> str:
    text = text or ""
    if limit <= 0 or len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


class AgentPipeline:
    MAX_CLARIFICATIONS = 1
    MAX_LABEL_SOURCES = 5

    def __init__(
        self,
        llm: CerebrasClient,
        evidence: EvidenceRetriever,
        step_cache: TTLCache | None = None,
        evidence_cache: TTLCache | None = None,
        references=None,
    ):
        self.llm = llm
        self.evidence = evidence
        self.references = references
        self.tools = {**TOOL_REGISTRY, **REFERENCE_TOOLS}
        settings = get_settings()
        self.max_evidence_articles = settings.max_evidence_articles
        self.max_tldr_chars = settings.max_tldr_chars
        self.max_summary_chars = settings.max_summary_chars
        self.max_answer_chars = settings.max_answer_chars
        self.step_cache = step_cache if step_cache is not None else TTLCache(
            max_entries=settings.step_cache_entries,
            ttl_seconds=settings.step_cache_ttl_seconds,
        )
        self.evidence_cache = evidence_cache if evidence_cache is not None else TTLCache(
            max_entries=settings.evidence_cache_entries,
            ttl_seconds=settings.evidence_cache_ttl_seconds,
        )
        self._outcomes: Counter[str] = Counter()
        self.policy_version = text_key(TRIAGE_SYSTEM, TOOL_SELECTION_SYSTEM, VARIABLE_EXTRACTION_SYSTEM, ANSWER_SYSTEM, SAFETY_SYSTEM,
                                       WHEN_TO_CALL_SYSTEM,
                                       *(f"{key}:{info['description']}" for key, info in self.tools.items()))


        self.tool_selection_system = TOOL_SELECTION_SYSTEM.format(
            tool_descriptions="\n".join(
                f"- {key}: {info['description']}" for key, info in self.tools.items()
            )
        )


    async def run(self, conversation: list[str], conversation_id: str,
                  mode: Literal["chat", "when_to_call"] = "chat") -> dict:

        result: dict | None = None
        async for event_type, data in self.run_streaming(conversation, conversation_id, mode):
            if event_type == "result":
                result = data
        assert result is not None
        return result

    async def run_streaming(
        self, conversation: list[str], conversation_id: str,
        mode: Literal["chat", "when_to_call"] = "chat",
    ) -> AsyncIterator[tuple[str, dict]]:

        sheet_mode = mode == "when_to_call"
        t0 = time.monotonic()
        trace = _RunTrace()
        tool_results: list[dict] = []
        articles: list[dict] = []

        def handoff(reason: str, **kwargs) -> dict:
            return build_handoff(conversation, reason, trace.steps(), triage_done=trace.has("triage", "ok"), **kwargs)

        try:
            conv_text = contextualize(conversation)

            yield ("step", {"step": "triage", "message": "Understanding your question…"})
            trace.start("triage")
            triage_info: dict = {}
            try:
                triage = await self._triage(conv_text, triage_info)
            except ReviewUnavailable:
                trace.finish("triage", "failed", triage_info.get("detail", "unavailable"))
                raise
            trace.finish("triage", "ok")
            action = triage["action"]
            if action == "emergency":
                self._outcomes["emergency"] += 1
                yield ("result", _empty_result(
                    type="emergency", emergency=True,
                    emergency_message="Your symptoms may need immediate medical attention. Contact your local emergency services now. Do not wait for an online answer.",
                    answer="If possible, ask someone nearby to stay with you and follow the emergency dispatcher's instructions.",
                    handoff=handoff("emergency"),
                ))
                return


            conversation_kind = routine_kind(conversation[-1]) if len(conversation) == 1 else None
            if conversation_kind is None and action == "conversation":
                conversation_kind = triage["conversation_kind"]
            if conversation_kind is not None:
                self._outcomes["conversation"] += 1
                yield ("result", _empty_result(
                    type="conversation",
                    answer=CONVERSATION_REPLIES[conversation_kind],
                    evidence_status="not_applicable",
                    handoff=handoff("user_requested"),
                ))
                return


            prior_asks = self._count_prior_clarifications(conversation)
            clarification_limit = False
            if action == "ask" and triage.get("follow_up_questions"):
                if prior_asks >= self.MAX_CLARIFICATIONS:
                    clarification_limit = True
                    logger.info(
                        "pipeline.clarification_limit reached (%d/%d), answering",
                        prior_asks, self.MAX_CLARIFICATIONS,
                    )
                else:
                    anatomy_context = select_anatomy(triage.get("anatomy"))
                    logger.info(
                        "pipeline.follow_up elapsed=%.1fs",
                        time.monotonic() - t0,
                    )
                    self._outcomes["follow_up"] += 1
                    yield ("result", _empty_result(
                        type="follow_up",
                        follow_up_questions=triage["follow_up_questions"],
                        preliminary_info=CLARIFICATION_INTRO,
                        anatomy_context=anatomy_context,
                        handoff=handoff("clarification_pending", follow_up_questions=triage["follow_up_questions"]),
                    ))
                    return


            tools_info: dict = {}
            evidence_info: dict = {}
            if sheet_mode:
                # The sheet's tiers are fixed or cited; no calculator or reference lookup is planned.
                yield ("step", {"step": "tools", "message": "Checking relevant sources…"})
                evidence_result = await trace.timed(
                    "evidence", self._retrieve_evidence(conversation, conversation_id, evidence_info))
            else:
                yield ("step", {"step": "tools", "message": "Checking relevant tools and sources…"})
                tool_results, evidence_result = await asyncio.gather(
                    trace.timed("tools", self._run_tools(conv_text, tools_info)),
                    trace.timed("evidence", self._retrieve_evidence(conversation, conversation_id, evidence_info)),
                )
            if sheet_mode:
                trace.finish("tools", "skipped")
            elif tools_info.get("failed"):
                trace.finish("tools", "failed", "selection_failed")
            elif not tools_info.get("selected"):
                trace.finish("tools", "skipped")
            elif len(tool_results) < tools_info["selected"] or any(
                r.get("error") or r.get("status") == "unavailable" for r in tool_results
            ):
                trace.finish("tools", "fallback", "partial")
            else:
                trace.finish("tools", "ok", f"selected={tools_info['selected']}")

            evidence_result = dict(evidence_result)
            primary = list(evidence_result.get("articles", []))
            extras = self._reference_sources(tool_results)
            if extras:
                # Label excerpts share one DailyMed URL per product, so resolve overlaps against the
                # primary list first and only then allocate the remaining slots to primary sources.
                extra_urls = {item["url"] for item in extras}
                primary_kept = [item for item in primary if item.get("url") not in extra_urls]
                sources = primary_kept[:max(0, self.max_evidence_articles - len(extras))]
                evidence_result["articles"] = sources + extras
                evidence_result["response"] = ""
            evidence_result["articles"] = evidence_result.get("articles", [])[:self.max_evidence_articles]
            articles = evidence_result["articles"]
            if primary:
                trace.finish("evidence", "ok")
            elif articles:
                trace.finish("evidence", "fallback", "reference_sources")
            else:
                trace.finish("evidence", "failed", "error" if evidence_info.get("error") else "empty")
            if not articles:
                self._outcomes["evidence_unavailable"] += 1
                yield ("result", _empty_result(
                    answer="I couldn’t retrieve supporting medical sources for this question. Please try again, or discuss your symptoms with a healthcare professional. If symptoms are severe or rapidly worsening, seek urgent care.",
                    evidence_status="unavailable",
                    handoff=handoff("evidence_unavailable", tool_results=tool_results, sheet=sheet_mode),
                    **({"sheet": build_when_to_call_sheet("unavailable")} if sheet_mode else {}),
                ))
                return


            yield ("step", {"step": "generating", "message": "Writing your evidence-based answer…"})
            trace.start("draft")
            question = conv_text
            answer_user = self._build_answer_user(question, tool_results, evidence_result)

            answer_parts: list[str] = []
            answer_chars = 0
            over_budget = False
            try:
                async for chunk in self.llm.generate_stream(answer_user, system=WHEN_TO_CALL_SYSTEM if sheet_mode else ANSWER_SYSTEM):
                    answer_parts.append(chunk)
                    answer_chars += len(chunk)
                    if answer_chars > self.max_answer_chars:
                        over_budget = True
                        raise ReviewUnavailable("Answer exceeded its budget")

            except Exception as exc:
                trace.finish("draft", "failed", "over_budget" if over_budget else "interrupted")
                raise ReviewUnavailable("Answer generation was interrupted. Please try again.") from exc
            answer = remove_source_appendix("".join(answer_parts))
            if not answer.strip():
                trace.finish("draft", "failed", "empty")
                raise ReviewUnavailable("The answer was empty")
            trace.finish("draft", "ok")


            yield ("step", {"step": "safety", "message": "Verifying answer safety…"})
            trace.start("review")
            review_info: dict = {}
            try:
                answer = await self._safety_check(question, answer, evidence_result, tool_results, review_info)
                self._validate_answer(answer, len(articles))
            except ReviewUnavailable:
                trace.finish("review", "failed", "attempts=2")
                raise
            if review_info.get("revised"):
                trace.finish("review", "fallback", "revised_once")
            else:
                trace.finish("review", "ok")
            if sheet_mode:
                visual_context = anatomy_context = None
            else:
                visual_context = select_visual(triage.get("visual"))
                anatomy_context = None if visual_context == "eye_pressure" else select_anatomy(triage.get("anatomy"))
            yield ("answer_chunk", {"text": answer})

            logger.info(
                "pipeline.answer tools=%d articles=%d answer_chars=%d elapsed=%.1fs",
                len(tool_results),
                len(articles),
                len(answer),
                time.monotonic() - t0,
            )
            self._outcomes["answer"] += 1
            if clarification_limit:
                reason = "clarification_limit"
            elif any("items" not in r and (r.get("missing_inputs") or r.get("error")) for r in tool_results):
                reason = "tool_input_missing"
            else:
                reason = "answer_available"
            yield ("result", _empty_result(
                type="answer",
                evidence_status="available",
                answer=answer,
                articles=articles,
                tool_results=tool_results,
                followups=[] if sheet_mode else evidence_result.get("followups", []),
                anatomy_context=anatomy_context,
                visual_context=visual_context,
                handoff=handoff(reason, tool_results=tool_results, articles=articles, answer=answer, sheet=sheet_mode),
                **({"sheet": build_when_to_call_sheet()} if sheet_mode else {}),
            ))
        except ReviewUnavailable as exc:
            exc.handoff = handoff("review_unavailable", tool_results=tool_results, articles=articles)
            raise

    def _reference_sources(self, tool_results: list[dict]) -> list[dict]:
        """Label sections first (capped), then PubMed abstracts: items carrying a `tldr` excerpt."""
        pubmed = REFERENCE_TOOLS["pubmed_search"]["name"]
        labels, papers = [], []
        for result in tool_results:
            for item in result.get("items", []):
                if not item.get("tldr"):
                    continue
                if item.get("evidence_kind") == "label_section":
                    labels.append(item)
                elif result.get("tool") == pubmed:
                    papers.append(item)
        return labels[:self.MAX_LABEL_SOURCES] + papers

    def outcome_stats(self) -> dict[str, int]:

        return {
            key: self._outcomes[key]
            for key in ("conversation", "follow_up", "answer", "emergency", "evidence_unavailable")
        }

    @staticmethod
    def _count_prior_clarifications(conversation: list[str]) -> int:

        count = 0
        for i in range(1, len(conversation), 2):
            msg = conversation[i]
            if msg.startswith(CLARIFICATION_INTRO):
                count += 1
        return count

    _NONE_SENTINEL = object()

    async def _cached_step(self, step: str, conv_text: str, compute):


        key = text_key(self.policy_version, cache_scope.get(), getattr(self.llm, "model", "test"), step, conv_text)
        async def wrapped():
            value = await compute()
            return self._NONE_SENTINEL if value is None else value
        cached = await self.step_cache.get_or_compute(key, wrapped)
        return None if cached is self._NONE_SENTINEL else cached

    async def _retrieve_evidence(self, conversation: list[str], conversation_id: str, info: dict) -> dict:
        key = text_key("evidence-v5", cache_scope.get(), conversation_id, contextualize(conversation))
        async def compute():
            try:
                if inspect.iscoroutinefunction(self.evidence.search):
                    return await self.evidence.search(conversation, conversation_id)
                return await asyncio.to_thread(self.evidence.search, conversation, conversation_id)
            except Exception:
                logger.warning("pipeline.evidence failed")
                info["error"] = True
                return {"response": "", "articles": [], "followups": []}
        return await self.evidence_cache.get_or_compute(
            key, compute, cache_if=lambda value: bool(value.get("articles"))
        )

    async def _triage(self, conv_text: str, info: dict) -> dict:
        async def compute():
            info["detail"] = "unavailable"
            raw = await self.llm.generate(
                TRIAGE_USER.format(conversation=conv_text), system=TRIAGE_SYSTEM,
                max_tokens=800, json_mode=True
            )
            info["detail"] = "invalid_json"
            triage = parse_json_response(raw)
            if triage.get("action") not in {"ask", "answer", "emergency", "conversation"}:
                raise ReviewUnavailable("Unable to assess this question. Please try again.")
            if triage["action"] == "conversation":
                kind = triage.get("conversation_kind")
                if kind not in CONVERSATION_REPLIES:
                    raise ReviewUnavailable("Unable to classify this message. Please try again.")
                triage["conversation_kind"] = kind
            questions = triage.get("follow_up_questions", [])
            if not isinstance(questions, list) or any(not isinstance(q, str) or not q.strip() for q in questions):
                raise ReviewUnavailable("Invalid clarification questions. Please try again.")
            triage["follow_up_questions"] = list(dict.fromkeys(questions))[:3]
            if triage["action"] == "ask" and not triage["follow_up_questions"]:
                raise ReviewUnavailable("Unable to clarify this question. Please try again.")
            return triage

        try:
            return await self._cached_step("triage", conv_text, compute)
        except Exception:
            raise ReviewUnavailable("Unable to assess this question safely. Please try again.") from None

    async def _run_tools(self, conv_text: str, info: dict) -> list[dict]:
        async def compute():
            raw = await self.llm.generate(
                TOOL_SELECTION_USER.format(conversation=conv_text),
                system=self.tool_selection_system, max_tokens=256, json_mode=True,
            )
            selection = parse_json_response(raw)
            if not isinstance(selection.get("selected_tools"), list):
                raise ValueError("Invalid tool selection")
            return selection

        try:
            selection = await self._cached_step("tool_selection", conv_text, compute)
        except Exception:
            logger.warning("pipeline.tool_selection failed")
            info["failed"] = True
            return []

        selected = list(dict.fromkeys(k for k in selection.get("selected_tools", []) if isinstance(k, str) and k in self.tools))[:2]
        info["selected"] = len(selected)
        if not selected:
            return []


        extractions = await asyncio.gather(
            *(
                self._extract_variables(conv_text, key, self.tools[key]["variables"])
                for key in selected
            )
        )

        async def execute(tool_key, variables):
            if variables is None:
                return None
            incomplete = any(k not in variables for k in self.tools[tool_key]["variables"])
            if incomplete and tool_key in REFERENCE_TOOLS:
                return None
            try:
                if tool_key in REFERENCE_TOOLS:
                    if self.references is None:
                        return None
                    key = text_key(self.policy_version, cache_scope.get(), tool_key, conv_text)
                    return await self.step_cache.get_or_compute(key,
                        lambda: self.references.run(tool_key, variables), cache_if=lambda value: value.get("status") == "available")
                return TOOL_REGISTRY[tool_key]["function"](variables)
            except Exception:
                logger.warning("pipeline.tool_execution failed tool=%s", tool_key)
                return None
        results = await asyncio.gather(*(execute(key, variables) for key, variables in zip(selected, extractions)))
        return [result for result in results if result is not None]

    async def _extract_variables(
        self, conv_text: str, tool_name: str, variables: list[str]
    ) -> dict | None:


        system = VARIABLE_EXTRACTION_SYSTEM.format(
            tool_name=tool_name, variables=", ".join(variables)
        )
        try:
            raw = await self.llm.generate(
                VARIABLE_EXTRACTION_USER.format(conversation=conv_text), system=system,
                max_tokens=600, json_mode=True
            )
            parsed = parse_json_response(raw)
            return {k: v for k, v in parsed.items() if v is not None}
        except Exception:
            logger.warning("pipeline.variable_extraction failed tool=%s", tool_name)
            return None

    def _build_answer_user(
        self, question: str, tool_results: list[dict], evidence: dict
    ) -> str:
        if tool_results:
            tool_lines = []
            for r in tool_results:
                tool_lines.append(f"Tool: {r.get('tool', 'Unknown')}")
                for k, v in r.items():
                    if k != "tool":
                        tool_lines.append(f"  {k}: {v}")
            tool_results_section = "Tool results (reference directories are links, not verified clinical claims):\n" + "\n".join(tool_lines)
        else:
            tool_results_section = ""


        return ANSWER_USER.format(
            question=question,
            tool_results_section=tool_results_section,
            evidence_text=self._format_evidence(evidence),
        )

    def _format_evidence(self, evidence: dict) -> str:
        articles = evidence.get("articles", [])[: self.max_evidence_articles]
        lines = [
            f"[{i}] {art.get('title', 'Unknown')} ({art.get('year', 'N/A')}). "
            f"{art.get('journal', '')}. {_truncate(art.get('tldr', ''), self.max_tldr_chars)} "
            f"URL: {art.get('url', '')}"
            for i, art in enumerate(articles, 1)
        ]
        text = "\n".join(lines) or "No source excerpts available. State the evidence limitation."
        summary = _truncate(evidence.get("response", ""), self.max_summary_chars)
        if summary:
            text += (
                "\n\nRetrieval summary (context only, not an independent source; "
                "claims must be supported by the numbered source excerpts):\n" + summary
            )
        return text

    async def _safety_check(self, question: str, answer: str, evidence: dict, tool_results=None, info: dict | None = None) -> str:
        articles = evidence.get("articles", [])[: self.max_evidence_articles]
        citations_text = self._format_evidence(evidence)
        if tool_results:
            import json
            citations_text += "\nTool outputs (label directory entries do not contain label contents):\n" + json.dumps(tool_results, ensure_ascii=False)
        candidate = answer
        for attempt in range(2):
            user = SAFETY_USER.format(question=question, answer=candidate, citations=citations_text)
            try:
                raw = await self.llm.generate(user, system=SAFETY_SYSTEM, max_tokens=4096, json_mode=True)
                result = parse_json_response(raw)
                if result.get("is_safe") is True and not result.get("issues"):
                    return candidate
                revised = result.get("revised_answer")
                if attempt == 0 and result.get("is_safe") is False and isinstance(revised, str) and revised.strip():
                    revised = remove_source_appendix(revised)
                    self._validate_answer(revised, len(articles))
                    candidate = revised
                    if info is not None:
                        info["revised"] = True
                    continue
            except Exception:
                logger.warning("pipeline.safety unavailable")
            break
        raise ReviewUnavailable("I couldn’t complete the answer review. Please try again.")

    def _validate_answer(self, answer: str, source_count: int):
        if not answer.strip() or len(answer) > self.max_answer_chars:
            raise ReviewUnavailable("Invalid reviewed answer")
        references = citation_indices(answer)
        if not references or any(n < 1 or n > source_count for n in references):
            raise ReviewUnavailable("The reviewed answer has invalid citations")

    async def aclose(self):
        await asyncio.gather(self.step_cache.aclose(), self.evidence_cache.aclose())
