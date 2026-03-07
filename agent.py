"""
Agent pipeline — orchestrates the multi-step evidence-first medical QA workflow.

Steps:
 1. Triage: Decide if we have enough info or need follow-up questions.
 2. Tool selection: Identify which clinical calculators apply.
 3. Variable extraction: Extract required variables from conversation.
 4. Tool execution: Run deterministic clinical calculators.
 5. Evidence retrieval: Fetch cited medical articles via Medisearch.
 6. Answer generation: Synthesize final answer with Gemini.
 7. Safety check: Verify answer is cited and safe.
"""

import json
import logging
from clinical_tools import TOOL_REGISTRY
from evidence_retriever import EvidenceRetriever
from llm_client import GeminiClient

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Prompt templates
# ---------------------------------------------------------------------------

TRIAGE_PROMPT = """You are a medical triage assistant. Given the conversation below, decide whether you have enough information to answer the patient's question, or whether you need to ask follow-up questions first.

Conversation:
{conversation}

Respond with EXACTLY one JSON object (no markdown fences, no extra text):
{{
  "action": "ask" or "answer",
  "follow_up_questions": ["question1", "question2"] or [],
  "reasoning": "brief explanation"
}}

If the patient's question is clear and answerable (even generally), choose "answer".
Only choose "ask" if critical details are missing that would change the medical advice significantly.
Limit follow-up questions to at most 3."""

TOOL_SELECTION_PROMPT = """You are a clinical decision support system. Given the patient conversation below, identify which clinical scoring tools (if any) are relevant.

Available tools:
{tool_descriptions}

Conversation:
{conversation}

Respond with EXACTLY one JSON object (no markdown fences, no extra text):
{{
  "selected_tools": ["tool_key1", "tool_key2"] or [],
  "reasoning": "brief explanation"
}}

Only select tools that are clearly relevant to the patient's presentation. If none apply, return an empty list."""

VARIABLE_EXTRACTION_PROMPT = """You are extracting clinical variables from a patient conversation for the tool: {tool_name}.

Required variables: {variables}

Conversation:
{conversation}

Respond with EXACTLY one JSON object (no markdown fences, no extra text) mapping variable names to their values.
Use 1 for true/yes/present, 0 for false/no/absent.
For numeric variables (age, cholesterol, etc.), use the number.
For sex, use "male" or "female".
If a variable cannot be determined from the conversation, use null.

Example: {{"age": 55, "hypertension": 1, "diabetes": 0, "unknown_var": null}}"""

ANSWER_PROMPT = """You are an evidence-based medical information assistant. Generate a clear, helpful answer using ONLY the provided evidence. You must cite sources for every medical claim.

Patient question: {question}

{tool_results_section}

Medical evidence from peer-reviewed sources:
{evidence_text}

Instructions:
- Use simple, patient-friendly language.
- Structure your answer with clear sections if appropriate.
- Cite sources using [1], [2], etc. matching the article numbers above.
- If clinical tool scores were computed, explain them clearly.
- Include relevant warnings or red flags the patient should watch for.
- End with a reminder that this is informational and not a substitute for professional medical advice.
- Do NOT make claims that are not supported by the provided evidence or tool results.
- Keep the answer concise but thorough."""

SAFETY_PROMPT = """You are a medical safety reviewer. Review the following draft answer and check for problems.

Patient question: {question}

Draft answer:
{answer}

Available citations:
{citations}

Check for:
1. Any medical claims not supported by the provided citations.
2. Dangerous advice or missing emergency warnings (e.g., chest pain, stroke symptoms).
3. Over-promising or definitive diagnostic statements (the system should not diagnose).
4. Missing disclaimer about consulting a healthcare professional.

Respond with EXACTLY one JSON object (no markdown fences, no extra text):
{{
  "is_safe": true or false,
  "issues": ["issue1", "issue2"] or [],
  "revised_answer": "the corrected answer if is_safe is false, otherwise empty string"
}}

If the answer is safe, set is_safe to true and leave revised_answer empty.
If there are issues, set is_safe to false, list the issues, and provide a revised_answer that fixes them."""


def _parse_json_response(text: str) -> dict:
    """Best-effort parse JSON from LLM output, stripping markdown fences if present."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        # Remove opening fence (```json or ```)
        first_newline = cleaned.index("\n")
        cleaned = cleaned[first_newline + 1 :]
        if cleaned.endswith("```"):
            cleaned = cleaned[: -3]
        cleaned = cleaned.strip()
    return json.loads(cleaned)


class AgentPipeline:
    MAX_CLARIFICATIONS = 2

    def __init__(self, gemini: GeminiClient, evidence: EvidenceRetriever):
        self.gemini = gemini
        self.evidence = evidence

    def _count_prior_clarifications(self, conversation: list[str]) -> int:
        """Count how many times the assistant already asked follow-up questions.

        Assistant messages are at odd indices (1, 3, 5, ...).  A message that
        starts with a question-like pattern from our triage step counts as a
        clarification round.  We detect these by checking for the bullet-style
        questions the triage step produces (the frontend joins them with spaces).
        """
        count = 0
        for i in range(1, len(conversation), 2):  # assistant turns only
            msg = conversation[i]
            # Triage follow-ups are joined questions; a reliable signal is that
            # the assistant message contains '?' and is relatively short (no
            # citations, no evidence, no article references).
            if "?" in msg and "[1]" not in msg and len(msg) < 600:
                count += 1
        return count

    def run(self, conversation: list[str], conversation_id: str) -> dict:
        """
        Execute the full agent pipeline.

        Args:
            conversation: List of alternating user/AI messages (last is user).
            conversation_id: Unique conversation thread ID.

        Returns:
            dict with:
              - "type": "follow_up" or "answer"
              - "follow_up_questions": list (if type is follow_up)
              - "answer": str (if type is answer)
              - "articles": list of article dicts
              - "tool_results": list of tool output dicts
              - "followups": suggested follow-up questions from Medisearch
        """
        conv_text = self._format_conversation(conversation)

        # --- Step 1: Triage ---
        prior_asks = self._count_prior_clarifications(conversation)
        triage = self._triage(conv_text)
        if triage.get("action") == "ask" and triage.get("follow_up_questions"):
            if prior_asks >= self.MAX_CLARIFICATIONS:
                logger.info(
                    "Clarification limit reached (%d/%d), proceeding to answer",
                    prior_asks,
                    self.MAX_CLARIFICATIONS,
                )
            else:
                return {
                    "type": "follow_up",
                    "follow_up_questions": triage["follow_up_questions"],
                    "answer": None,
                    "articles": [],
                    "tool_results": [],
                    "followups": [],
                }

        # --- Step 2-4: Tool selection, extraction, execution ---
        tool_results = self._run_tools(conv_text)

        # --- Step 5: Evidence retrieval ---
        logger.info("Starting evidence retrieval via MediSearch")
        evidence_result = self.evidence.search(
            conversation=conversation,
            conversation_id=conversation_id,
        )
        logger.info(
            "Evidence retrieval complete: %d articles, response_length=%d",
            len(evidence_result.get("articles", [])),
            len(evidence_result.get("response", "")),
        )

        # --- Step 6: Answer generation ---
        question = conversation[-1]
        logger.info("Generating answer for question: %s", question[:200])
        answer = self._generate_answer(question, tool_results, evidence_result)
        logger.info("Answer generated, length=%d", len(answer))

        # --- Step 7: Safety check ---
        logger.info("Running safety check")
        answer = self._safety_check(question, answer, evidence_result)

        return {
            "type": "answer",
            "follow_up_questions": [],
            "answer": answer,
            "articles": evidence_result.get("articles", []),
            "tool_results": tool_results,
            "followups": evidence_result.get("followups", []),
        }

    def _format_conversation(self, conversation: list[str]) -> str:
        lines = []
        for i, msg in enumerate(conversation):
            role = "Patient" if i % 2 == 0 else "Assistant"
            lines.append(f"{role}: {msg}")
        return "\n".join(lines)

    def _triage(self, conv_text: str) -> dict:
        prompt = TRIAGE_PROMPT.format(conversation=conv_text)
        try:
            raw = self.gemini.generate(prompt)
            triage = _parse_json_response(raw)
            logger.info("Triage result: %s", triage)
            return triage
        except Exception:
            logger.exception("Triage step failed, defaulting to answer")
            return {"action": "answer", "follow_up_questions": []}

    def _run_tools(self, conv_text: str) -> list[dict]:
        # Build tool descriptions for selection prompt
        desc_lines = []
        for key, info in TOOL_REGISTRY.items():
            desc_lines.append(f"- {key}: {info['description']}")
        tool_desc_text = "\n".join(desc_lines)

        prompt = TOOL_SELECTION_PROMPT.format(
            tool_descriptions=tool_desc_text, conversation=conv_text
        )
        try:
            raw = self.gemini.generate(prompt)
            selection = _parse_json_response(raw)
            logger.info("Tool selection result: %s", selection)
        except Exception:
            logger.exception("Tool selection failed")
            return []

        selected = selection.get("selected_tools", [])
        if not selected:
            logger.info("No tools selected")
            return []

        results = []
        for tool_key in selected:
            if tool_key not in TOOL_REGISTRY:
                continue
            tool_info = TOOL_REGISTRY[tool_key]
            # Extract variables
            variables = self._extract_variables(
                conv_text, tool_key, tool_info["variables"]
            )
            if variables is None:
                continue
            # Execute tool
            try:
                result = tool_info["function"](variables)
                logger.info("Tool execution result for %s: %s", tool_key, result)
                results.append(result)
            except Exception:
                logger.exception("Tool execution failed for %s", tool_key)

        return results

    def _extract_variables(
        self, conv_text: str, tool_name: str, variables: list[str]
    ) -> dict | None:
        prompt = VARIABLE_EXTRACTION_PROMPT.format(
            tool_name=tool_name,
            variables=", ".join(variables),
            conversation=conv_text,
        )
        try:
            raw = self.gemini.generate(prompt)
            parsed = _parse_json_response(raw)
            logger.info("Variable extraction for %s: %s", tool_name, parsed)
            # Remove null values — tool functions use .get() with defaults
            return {k: v for k, v in parsed.items() if v is not None}
        except Exception:
            logger.exception("Variable extraction failed for %s", tool_name)
            return None

    def _generate_answer(
        self,
        question: str,
        tool_results: list[dict],
        evidence: dict,
    ) -> str:
        # Build tool results section
        if tool_results:
            tool_lines = []
            for r in tool_results:
                tool_lines.append(f"Tool: {r.get('tool', 'Unknown')}")
                for k, v in r.items():
                    if k != "tool":
                        tool_lines.append(f"  {k}: {v}")
            tool_results_section = (
                "Clinical tool results:\n" + "\n".join(tool_lines)
            )
        else:
            tool_results_section = ""

        # Build evidence text
        articles = evidence.get("articles", [])
        if articles:
            evidence_lines = []
            for i, art in enumerate(articles, 1):
                title = art.get("title", "Unknown")
                year = art.get("year", "N/A")
                journal = art.get("journal", "")
                tldr = art.get("tldr", "")
                url = art.get("url", "")
                evidence_lines.append(
                    f"[{i}] {title} ({year}). {journal}. {tldr} URL: {url}"
                )
            evidence_text = "\n".join(evidence_lines)
        else:
            evidence_text = "No specific articles retrieved. Answer based on established medical knowledge only, and note the limitation."

        # Also include Medisearch's own response as additional context
        medi_response = evidence.get("response", "")
        if medi_response:
            evidence_text += f"\n\nMedisearch summary:\n{medi_response}"

        prompt = ANSWER_PROMPT.format(
            question=question,
            tool_results_section=tool_results_section,
            evidence_text=evidence_text,
        )
        return self.gemini.generate(prompt)

    def _safety_check(self, question: str, answer: str, evidence: dict) -> str:
        articles = evidence.get("articles", [])
        citation_lines = []
        for i, art in enumerate(articles, 1):
            citation_lines.append(f"[{i}] {art.get('title', '')} ({art.get('year', '')})")
        citations_text = "\n".join(citation_lines) if citation_lines else "No citations available."

        prompt = SAFETY_PROMPT.format(
            question=question,
            answer=answer,
            citations=citations_text,
        )
        try:
            raw = self.gemini.generate(prompt)
            result = _parse_json_response(raw)
            if not result.get("is_safe", True) and result.get("revised_answer"):
                logger.info("Safety module revised answer. Issues: %s", result.get("issues"))
                return result["revised_answer"]
        except Exception:
            logger.exception("Safety check failed, using original answer")

        return answer
