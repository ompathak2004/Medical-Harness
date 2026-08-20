"""Agent pipeline — evidence-first medical QA workflow (async).

Steps:
 1. Triage (emergency / ask / answer) + anatomy detection, run concurrently.
 2. In parallel: clinical tool selection→extraction→execution AND
    MediSearch evidence retrieval.
 3. Answer generation (streamed token-by-token).
 4. Safety review of the full answer (may revise it).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator

from app.evidence import EvidenceRetriever
from app.json_utils import parse_json_response
from app.llm import CerebrasClient
from app.prompts import (
    ANSWER_PROMPT,
    EMERGENCY_GUIDANCE_PROMPT,
    SAFETY_PROMPT,
    TOOL_SELECTION_PROMPT,
    TRIAGE_PROMPT,
    VARIABLE_EXTRACTION_PROMPT,
)
from app.tools.anatomy import detect_anatomy_context
from app.tools.clinical import TOOL_REGISTRY

logger = logging.getLogger(__name__)


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
        "emergency": False,
        "emergency_message": "",
    }
    base.update(overrides)
    return base


class AgentPipeline:
    MAX_CLARIFICATIONS = 2

    def __init__(self, llm: CerebrasClient, evidence: EvidenceRetriever):
        self.llm = llm
        self.evidence = evidence

    # ------------------------------------------------------------------
    # Public entry points
    # ------------------------------------------------------------------

    async def run(self, conversation: list[str], conversation_id: str) -> dict:
        """Execute the pipeline and return only the final result dict."""
        result: dict | None = None
        async for event_type, data in self.run_streaming(conversation, conversation_id):
            if event_type == "result":
                result = data
        assert result is not None
        return result

    async def run_streaming(
        self, conversation: list[str], conversation_id: str
    ) -> AsyncIterator[tuple[str, dict]]:
        """Yield (event_type, data) tuples: step / answer_chunk / result."""
        t0 = time.monotonic()
        conv_text = self._format_conversation(conversation)

        # --- Step 1: triage + anatomy detection concurrently ---
        yield ("step", {"step": "triage", "message": "Analyzing your question…"})
        triage_task = asyncio.create_task(self._triage(conv_text))
        anatomy_task = asyncio.create_task(self._detect_anatomy(conv_text))
        triage = await triage_task

        action = triage.get("action", "answer")

        # --- Emergency short-circuit ---
        if action == "emergency":
            guidance = await self._emergency_guidance(conv_text)
            anatomy_context = await anatomy_task
            logger.info(
                "pipeline.emergency conversation_id=%s elapsed=%.1fs",
                conversation_id, time.monotonic() - t0,
            )
            yield ("result", _empty_result(
                type="emergency",
                emergency=True,
                emergency_message=triage.get("emergency_message", "")
                or "Your symptoms may indicate a medical emergency. Please contact your local emergency services immediately.",
                answer=guidance or None,
                anatomy_context=anatomy_context,
            ))
            return

        # --- Follow-up questions path ---
        prior_asks = self._count_prior_clarifications(conversation)
        if action == "ask" and triage.get("follow_up_questions"):
            if prior_asks >= self.MAX_CLARIFICATIONS:
                logger.info(
                    "pipeline.clarification_limit reached (%d/%d), answering",
                    prior_asks, self.MAX_CLARIFICATIONS,
                )
            else:
                anatomy_context = await anatomy_task
                logger.info(
                    "pipeline.follow_up conversation_id=%s elapsed=%.1fs",
                    conversation_id, time.monotonic() - t0,
                )
                yield ("result", _empty_result(
                    type="follow_up",
                    follow_up_questions=triage["follow_up_questions"],
                    preliminary_info=triage.get("preliminary_info", ""),
                    anatomy_context=anatomy_context,
                ))
                return

        # --- Step 2: clinical tools + evidence retrieval in parallel ---
        yield ("step", {"step": "tools", "message": "Checking clinical calculators…"})
        tools_task = asyncio.create_task(self._run_tools(conv_text))
        evidence_task = asyncio.create_task(
            asyncio.to_thread(self.evidence.search, conversation, conversation_id)
        )
        tool_results = await tools_task

        yield ("step", {"step": "evidence", "message": "Searching medical literature…"})
        evidence_result = await evidence_task

        # --- Step 3: streamed answer generation ---
        yield ("step", {"step": "generating", "message": "Writing your evidence-based answer…"})
        question = conversation[-1]
        prompt = self._build_answer_prompt(question, tool_results, evidence_result)

        answer_parts: list[str] = []
        try:
            async for chunk in self.llm.generate_stream(prompt):
                answer_parts.append(chunk)
                yield ("answer_chunk", {"text": chunk})
        except Exception:
            logger.exception("pipeline.answer_stream failed conversation_id=%s", conversation_id)
            if not answer_parts:
                # Degrade to MediSearch's own summary if we have one.
                fallback = evidence_result.get("response", "")
                if fallback:
                    answer_parts.append(fallback)
                    yield ("answer_chunk", {"text": fallback})
                else:
                    answer_parts.append(
                        "I'm sorry — I couldn't generate an answer right now. "
                        "Please try again in a moment."
                    )
        answer = "".join(answer_parts)

        # --- Step 4: safety review ---
        yield ("step", {"step": "safety", "message": "Verifying answer safety…"})
        answer = await self._safety_check(question, answer, evidence_result)
        anatomy_context = await anatomy_task

        logger.info(
            "pipeline.answer conversation_id=%s tools=%d articles=%d answer_chars=%d elapsed=%.1fs",
            conversation_id,
            len(tool_results),
            len(evidence_result.get("articles", [])),
            len(answer),
            time.monotonic() - t0,
        )
        yield ("result", _empty_result(
            type="answer",
            answer=answer,
            articles=evidence_result.get("articles", []),
            tool_results=tool_results,
            followups=evidence_result.get("followups", []),
            anatomy_context=anatomy_context,
        ))

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _format_conversation(conversation: list[str]) -> str:
        lines = []
        for i, msg in enumerate(conversation):
            role = "Patient" if i % 2 == 0 else "Assistant"
            lines.append(f"{role}: {msg}")
        return "\n".join(lines)

    @staticmethod
    def _count_prior_clarifications(conversation: list[str]) -> int:
        """Count prior assistant follow-up rounds (short, question-bearing turns)."""
        count = 0
        for i in range(1, len(conversation), 2):
            msg = conversation[i]
            if "?" in msg and "[1]" not in msg and len(msg) < 600:
                count += 1
        return count

    async def _triage(self, conv_text: str) -> dict:
        try:
            raw = await self.llm.generate(TRIAGE_PROMPT.format(conversation=conv_text))
            triage = parse_json_response(raw)
            logger.info("pipeline.triage action=%s", triage.get("action"))
            return triage
        except Exception:
            logger.exception("pipeline.triage failed, defaulting to answer")
            return {"action": "answer", "follow_up_questions": []}

    async def _detect_anatomy(self, conv_text: str) -> dict | None:
        try:
            return await detect_anatomy_context(conv_text, self.llm)
        except Exception:
            logger.exception("pipeline.anatomy failed, continuing without it")
            return None

    async def _emergency_guidance(self, conv_text: str) -> str:
        try:
            return await self.llm.generate(
                EMERGENCY_GUIDANCE_PROMPT.format(conversation=conv_text)
            )
        except Exception:
            logger.exception("pipeline.emergency_guidance failed")
            return ""

    async def _run_tools(self, conv_text: str) -> list[dict]:
        desc_lines = [
            f"- {key}: {info['description']}" for key, info in TOOL_REGISTRY.items()
        ]
        prompt = TOOL_SELECTION_PROMPT.format(
            tool_descriptions="\n".join(desc_lines), conversation=conv_text
        )
        try:
            raw = await self.llm.generate(prompt)
            selection = parse_json_response(raw)
            logger.info("pipeline.tools selected=%s", selection.get("selected_tools"))
        except Exception:
            logger.exception("pipeline.tool_selection failed")
            return []

        selected = [k for k in selection.get("selected_tools", []) if k in TOOL_REGISTRY]
        if not selected:
            return []

        # Extract variables for all selected tools concurrently.
        extractions = await asyncio.gather(
            *(
                self._extract_variables(conv_text, key, TOOL_REGISTRY[key]["variables"])
                for key in selected
            )
        )

        results = []
        for tool_key, variables in zip(selected, extractions):
            if variables is None:
                continue
            try:
                result = TOOL_REGISTRY[tool_key]["function"](variables)
                results.append(result)
            except Exception:
                logger.exception("pipeline.tool_execution failed tool=%s", tool_key)
        return results

    async def _extract_variables(
        self, conv_text: str, tool_name: str, variables: list[str]
    ) -> dict | None:
        prompt = VARIABLE_EXTRACTION_PROMPT.format(
            tool_name=tool_name,
            variables=", ".join(variables),
            conversation=conv_text,
        )
        try:
            raw = await self.llm.generate(prompt)
            parsed = parse_json_response(raw)
            return {k: v for k, v in parsed.items() if v is not None}
        except Exception:
            logger.exception("pipeline.variable_extraction failed tool=%s", tool_name)
            return None

    @staticmethod
    def _build_answer_prompt(
        question: str, tool_results: list[dict], evidence: dict
    ) -> str:
        if tool_results:
            tool_lines = []
            for r in tool_results:
                tool_lines.append(f"Tool: {r.get('tool', 'Unknown')}")
                for k, v in r.items():
                    if k != "tool":
                        tool_lines.append(f"  {k}: {v}")
            tool_results_section = "Clinical tool results:\n" + "\n".join(tool_lines)
        else:
            tool_results_section = ""

        articles = evidence.get("articles", [])
        if articles:
            evidence_lines = []
            for i, art in enumerate(articles, 1):
                evidence_lines.append(
                    f"[{i}] {art.get('title', 'Unknown')} ({art.get('year', 'N/A')}). "
                    f"{art.get('journal', '')}. {art.get('tldr', '')} URL: {art.get('url', '')}"
                )
            evidence_text = "\n".join(evidence_lines)
        else:
            evidence_text = (
                "No specific articles retrieved. Answer based on established "
                "medical knowledge only, and note the limitation."
            )

        medi_response = evidence.get("response", "")
        if medi_response:
            evidence_text += f"\n\nMedisearch summary:\n{medi_response}"

        return ANSWER_PROMPT.format(
            question=question,
            tool_results_section=tool_results_section,
            evidence_text=evidence_text,
        )

    async def _safety_check(self, question: str, answer: str, evidence: dict) -> str:
        articles = evidence.get("articles", [])
        citation_lines = [
            f"[{i}] {art.get('title', '')} ({art.get('year', '')})"
            for i, art in enumerate(articles, 1)
        ]
        citations_text = "\n".join(citation_lines) or "No citations available."
        prompt = SAFETY_PROMPT.format(
            question=question, answer=answer, citations=citations_text
        )
        try:
            raw = await self.llm.generate(prompt)
            result = parse_json_response(raw)
            if not result.get("is_safe", True) and result.get("revised_answer"):
                logger.info("pipeline.safety revised answer, issues=%s", result.get("issues"))
                return result["revised_answer"]
        except Exception:
            logger.exception("pipeline.safety failed, keeping original answer")
        return answer
